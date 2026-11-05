'use strict';
/**
 * 翻译服务（主进程侧）：
 * - 唯一持有 UtilityProcess 的地方，node-llama-cpp 只在子进程里跑；
 * - 提供请求/响应 + 流式回调桥接；
 * - 负责崩溃检测、指数退避重启、空闲卸载，避免主窗口被拖死。
 */
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { utilityProcess, app } = require('electron');

const WORKER_FILE = path.join(__dirname, 'translate-worker.js');
const MAX_RESTARTS = 5;
const REQUEST_TIMEOUT = 120000;
const IDLE_UNLOAD_MS = 10 * 60 * 1000;

class TranslatorService extends EventEmitter {
  constructor() {
    super();
    /** @type {import('electron').UtilityProcess | null} */
    this.child = null;
    this.ready = false;
    this.state = 'idle'; // idle | starting | loading | ready | error | restarting
    this.status = {
      state: 'idle',
      modelPath: null,
      modelId: null,
      gpu: null,
      gpuDevice: null,
      vram: null,
      backend: null,
      lastError: null,
      loadedAt: null,
      restartCount: 0,
      pending: 0,
    };
    this.pending = new Map();
    this.seq = 0;
    this.restartCount = 0;
    this.restartTimer = null;
    this.idleTimer = null;
    /** 上次加载参数，崩溃重启后自动恢复 */
    this.lastLoad = null;
    this.quitting = false;
  }

  /* --------------------------- 进程生命周期 --------------------------- */

  ensureWorker() {
    if (this.child && this.ready) return this.child;
    if (this.child) return this.child;

    const child = utilityProcess.fork(WORKER_FILE, [], {
      serviceName: 'paper-reader-translate',
      stdio: 'pipe',
    });
    this.child = child;
    this.setStatus({ state: 'starting' });

    child.stdout?.on('data', (chunk) => {
      const text = String(chunk).trim();
      if (text) console.log('[translate:out]', text);
    });
    child.stderr?.on('data', (chunk) => {
      const text = String(chunk).trim();
      if (text) console.warn('[translate:err]', text);
    });

    child.on('message', (message) => this.handleWorkerMessage(message));

    child.on('exit', (code) => {
      console.warn('[translate] 子进程退出，code =', code);
      this.handleWorkerExit(code);
    });

    return child;
  }

  handleWorkerMessage(message) {
    if (!message || typeof message !== 'object') return;
    const { type } = message;

    if (type === 'ready') {
      this.ready = true;
      if (this.state === 'starting' || this.state === 'restarting') this.setStatus({ state: 'idle' });
      return;
    }
    if (type === 'log') {
      const line = `[translate:worker] ${message.message}`;
      if (message.level === 'warn') console.warn(line);
      else console.log(line);
      return;
    }
    if (type === 'chunk') {
      this.emit('chunk', { requestId: message.requestId, text: message.text, index: message.index, total: message.total });
      return;
    }
    if (type === 'done') {
      this.emit('done', message);
      return;
    }
    if (type === 'error') {
      this.emit('error-event', message);
      return;
    }
    if (type === 'result' && message.id && this.pending.has(message.id)) {
      const entry = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.result && message.result.ok === false && message.result.error) {
        entry.reject(Object.assign(new Error(message.result.error), { code: message.result.code }));
      } else {
        entry.resolve(message.result);
      }
    }
  }

  handleWorkerExit(code) {
    const wasReady = this.ready;
    this.child = null;
    this.ready = false;
    // 所有在途请求立即失败，避免界面一直转圈
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error('翻译进程已退出，请重试'));
    }
    this.pending.clear();

    if (this.quitting) {
      this.setStatus({ state: 'idle' });
      return;
    }

    this.setStatus({ state: 'error', lastError: `翻译进程异常退出（code=${code}）` });
    this.emit('crashed', { code });

    if (wasReady || this.lastLoad) this.scheduleRestart();
  }

  scheduleRestart() {
    if (this.restartCount >= MAX_RESTARTS) {
      this.setStatus({ state: 'error', lastError: `翻译进程连续 ${MAX_RESTARTS} 次异常，已停止自动重启` });
      return;
    }
    this.restartCount += 1;
    const delay = Math.min(1000 * 2 ** (this.restartCount - 1), 15000);
    this.setStatus({ state: 'restarting', restartCount: this.restartCount });
    console.warn(`[translate] ${delay}ms 后重启翻译进程（第 ${this.restartCount} 次）`);
    clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(async () => {
      try {
        this.ensureWorker();
        if (this.lastLoad) {
          await this.load(this.lastLoad, { silent: true });
          console.log('[translate] 重启后已恢复模型加载');
        }
      } catch (err) {
        console.warn('[translate] 重启后恢复失败：', err && err.message);
      }
    }, delay);
  }

  /* --------------------------- 请求封装 --------------------------- */

  request(message, timeoutMs = REQUEST_TIMEOUT) {
    const child = this.ensureWorker();
    const id = `req-${++this.seq}`;
    const payload = { ...message, id };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('翻译进程响应超时'));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        child.postMessage(payload);
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  setStatus(patch) {
    this.status = { ...this.status, ...patch, pending: this.pending.size };
    this.state = this.status.state;
    this.emit('status', this.status);
  }

  /* --------------------------- 对外能力 --------------------------- */

  async load(options = {}, { silent = false } = {}) {
    const { modelPath, modelId, gpu = 'auto', contextSize = 4096 } = options;
    if (!modelPath) throw new Error('缺少模型文件路径');
    this.lastLoad = { modelPath, modelId, gpu, contextSize };
    this.clearIdleTimer();
    if (!silent) this.setStatus({ state: 'loading', lastError: null });
    const started = Date.now();
    const result = await this.request({ type: 'load', modelPath, gpu, contextSize }, 180000);
    if (!result || result.ok === false) {
      this.setStatus({ state: 'error', lastError: (result && result.error) || '模型加载失败' });
      throw new Error((result && result.error) || '模型加载失败');
    }
    this.restartCount = 0;
    const status = result.status || {};
    this.setStatus({
      state: 'ready',
      modelPath: status.modelPath || modelPath,
      modelId: modelId || null,
      gpu: status.gpu || null,
      gpuDevice: status.gpuDevice || null,
      vram: status.vram || null,
      backend: status.backend || null,
      lastError: null,
      loadedAt: status.loadedAt || new Date().toISOString(),
      restartCount: this.restartCount,
    });
    console.log(`[translate] 模型加载完成，用时 ${Date.now() - started}ms，GPU=${this.status.gpu} (${this.status.gpuDevice || '-'})`);
    return { ...this.status, loadMs: result.loadMs };
  }

  /**
   * @param {{ text: string, target?: string, style?: string, maxTokens?: number }} payload
   */
  async translate(payload) {
    if (!this.lastLoad) throw new Error('尚未加载翻译模型');
    const { text, target = 'zh', style, maxTokens = 1024 } = payload || {};
    if (!String(text || '').trim()) throw new Error('没有可翻译的文本');
    // requestId 由渲染进程生成，方便它先订阅流式片段再发请求
    const requestId = (payload && payload.requestId) || `tr-${++this.seq}`;
    this.resetIdleTimer();

    // 结果通过 'done'/'error-event' 事件流式回传，这里等待终态
    const finalText = await new Promise(async (resolve, reject) => {
      const onDone = (message) => {
        if (message.requestId !== requestId) return;
        cleanup();
        resolve({ text: message.text, ms: message.ms, chunks: message.chunks });
      };
      const onError = (message) => {
        if (message.requestId !== requestId) return;
        cleanup();
        reject(Object.assign(new Error(message.error || '翻译失败'), { code: message.code }));
      };
      const cleanup = () => {
        this.off('done', onDone);
        this.off('error-event', onError);
      };
      this.on('done', onDone);
      this.on('error-event', onError);
      try {
        await this.request({ type: 'translate', requestId, text, target, style, maxTokens }, 180000);
      } catch (err) {
        cleanup();
        reject(err);
      }
    });

    this.resetIdleTimer();
    return { requestId, ...finalText };
  }

  async abort(requestId) {
    return this.request({ type: 'abort', requestId }, 10000).catch(() => ({ ok: false }));
  }

  async unload() {
    this.clearIdleTimer();
    this.lastLoad = null;
    if (!this.child) {
      this.setStatus({ state: 'idle', modelPath: null });
      return { ok: true };
    }
    const result = await this.request({ type: 'unload' }, 30000).catch((err) => ({ ok: false, error: err.message }));
    this.setStatus({ state: 'idle', modelPath: null, gpu: null, gpuDevice: null, vram: null, loadedAt: null });
    return result;
  }

  resetIdleTimer() {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      console.log('[translate] 空闲超时，卸载模型以释放显存');
      this.unload().catch(() => {});
    }, IDLE_UNLOAD_MS);
    this.idleTimer.unref?.();
  }

  clearIdleTimer() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  getStatus() {
    return { ...this.status, pending: this.pending.size, workerAlive: Boolean(this.child), ready: this.ready };
  }

  async dispose() {
    this.quitting = true;
    this.clearIdleTimer();
    clearTimeout(this.restartTimer);
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error('应用正在退出'));
    }
    this.pending.clear();
    if (this.child) {
      try {
        this.child.kill();
      } catch {
        /* ignore */
      }
      this.child = null;
    }
    this.ready = false;
  }
}

const service = new TranslatorService();

app?.on?.('before-quit', () => {
  service.dispose().catch(() => {});
});

module.exports = { service, WORKER_FILE };
