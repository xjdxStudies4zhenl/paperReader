'use strict';
/**
 * 本地「AI 理解」服务（主进程侧）：和 translator-service 完全对称。
 * - 唯一持有 chat 的 UtilityProcess，node-llama-cpp 只在子进程里跑；
 * - 请求 / 响应 + 流式回调桥接（把增量片段累积成完整文本再推给渲染层）；
 * - 崩溃检测、指数退避重启、空闲卸载。
 */
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { utilityProcess, app } = require('electron');
const { resolveModel, findModel, DEFAULT_CHAT_MODEL_ID } = require('./model-registry');

const WORKER_FILE = path.join(__dirname, 'chat-worker.js');
const MAX_RESTARTS = 5;
const LOAD_TIMEOUT = 300000;
/** 本地 7B 模型在 CPU 上生成 1000 token 可能要几分钟，超时给宽一点，用户仍可随时「停止」 */
const CHAT_TIMEOUT = 600000;
const IDLE_UNLOAD_MS = 10 * 60 * 1000;
const DEFAULT_CONTEXT_SIZE = 8192;

class LocalChatService extends EventEmitter {
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
      contextSize: 0,
      lastError: null,
      loadedAt: null,
      restartCount: 0,
      pending: 0,
    };
    this.pending = new Map();
    /** requestId -> 已累积的文本（流式回传给渲染层的是完整快照） */
    this.streams = new Map();
    this.seq = 0;
    this.restartCount = 0;
    this.restartTimer = null;
    this.idleTimer = null;
    this.lastLoad = null;
    this.quitting = false;
  }

  /* --------------------------- 进程生命周期 --------------------------- */

  ensureWorker() {
    if (this.child) return this.child;

    const child = utilityProcess.fork(WORKER_FILE, [], {
      serviceName: 'paper-reader-chat',
      stdio: 'pipe',
    });
    this.child = child;
    this.setStatus({ state: 'starting' });

    child.stdout?.on('data', (chunk) => {
      const text = String(chunk).trim();
      if (text) console.log('[chat:out]', text);
    });
    child.stderr?.on('data', (chunk) => {
      const text = String(chunk).trim();
      if (text) console.warn('[chat:err]', text);
    });

    child.on('message', (message) => this.handleWorkerMessage(message));
    child.on('exit', (code) => {
      console.warn('[chat] 子进程退出，code =', code);
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
      const line = `[chat:worker] ${message.message}`;
      if (message.level === 'warn') console.warn(line);
      else console.log(line);
      return;
    }
    if (type === 'chunk') {
      const full = `${this.streams.get(message.requestId) || ''}${message.text || ''}`;
      this.streams.set(message.requestId, full);
      this.emit('chunk', { requestId: message.requestId, delta: message.text || '', text: full });
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
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error('本地理解进程已退出，请重试'));
    }
    this.pending.clear();
    this.streams.clear();

    if (this.quitting) {
      this.setStatus({ state: 'idle' });
      return;
    }

    this.setStatus({ state: 'error', lastError: `本地理解进程异常退出（code=${code}）` });
    this.emit('crashed', { code });

    if (wasReady || this.lastLoad) this.scheduleRestart();
  }

  scheduleRestart() {
    if (this.restartCount >= MAX_RESTARTS) {
      this.setStatus({ state: 'error', lastError: `本地理解进程连续 ${MAX_RESTARTS} 次异常，已停止自动重启` });
      return;
    }
    this.restartCount += 1;
    const delay = Math.min(1000 * 2 ** (this.restartCount - 1), 15000);
    this.setStatus({ state: 'restarting', restartCount: this.restartCount });
    console.warn(`[chat] ${delay}ms 后重启理解进程（第 ${this.restartCount} 次）`);
    clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(async () => {
      try {
        this.ensureWorker();
        if (this.lastLoad) {
          await this.load(this.lastLoad, { silent: true });
          console.log('[chat] 重启后已恢复模型加载');
        }
      } catch (err) {
        console.warn('[chat] 重启后恢复失败：', err && err.message);
      }
    }, delay);
  }

  /* --------------------------- 请求封装 --------------------------- */

  request(message, timeoutMs = CHAT_TIMEOUT) {
    const child = this.ensureWorker();
    const id = `req-${++this.seq}`;
    const payload = { ...message, id };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('本地理解进程响应超时'));
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
    const { modelPath, modelId, gpu = 'auto', contextSize = DEFAULT_CONTEXT_SIZE } = options;
    if (!modelPath) throw new Error('缺少模型文件路径');
    this.lastLoad = { modelPath, modelId, gpu, contextSize };
    this.clearIdleTimer();
    if (!silent) this.setStatus({ state: 'loading', lastError: null });
    const started = Date.now();
    const result = await this.request({ type: 'load', modelPath, gpu, contextSize }, LOAD_TIMEOUT);
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
      contextSize: status.contextSize || contextSize,
      lastError: null,
      loadedAt: status.loadedAt || new Date().toISOString(),
      restartCount: this.restartCount,
    });
    console.log(`[chat] 模型加载完成，用时 ${Date.now() - started}ms，GPU=${this.status.gpu} (${this.status.gpuDevice || '-'})`);
    return { ...this.status, loadMs: result.loadMs };
  }

  /**
   * 确保「配置里选中的本地模型」已经就绪：没装就报可执行的错，装了没加载就加载。
   * @param {{localModelId?: string, localPath?: string, gpu?: string, contextSize?: number}} provider
   */
  async ensureFor(provider = {}) {
    const modelId = provider.localModelId || DEFAULT_CHAT_MODEL_ID;
    const model = resolveModel(modelId, provider.localPath, 'chat');
    if (!model.exists) {
      throw new Error(
        `还没下载本地理解模型：${model.path}\n请到「设置 → AI 模型 → 本地理解引擎」点「下载所选模型」，或手动放一个 GGUF 到该目录。`
      );
    }
    const status = this.getStatus();
    if (status.state === 'ready' && status.modelPath === model.path) return status;
    return this.load({
      modelPath: model.path,
      modelId: model.id,
      gpu: provider.gpu || 'auto',
      contextSize: Number(provider.contextSize) || model.contextSize || DEFAULT_CONTEXT_SIZE,
    });
  }

  /**
   * 流式对话：结果通过 'done' / 'error-event' 事件回传终态，'chunk' 回传增量。
   * @param {{requestId?: string, messages: Array<{role:string, content:string}>, temperature?: number, maxTokens?: number}} payload
   */
  async chat(payload = {}) {
    if (!this.lastLoad) throw new Error('本地理解模型尚未加载');
    const { messages, temperature } = payload;
    if (!Array.isArray(messages) || !messages.length) throw new Error('没有可理解的内容');
    // 输出长度：调用方没指定时用清单里该模型的建议值（小模型别硬撑长输出）
    const modelDefault = findModel(this.status.modelId || DEFAULT_CHAT_MODEL_ID, 'chat').maxTokens || 1024;
    const maxTokens = Number(payload.maxTokens) || modelDefault;
    const requestId = payload.requestId || `loc-${++this.seq}`;
    this.streams.set(requestId, '');
    this.resetIdleTimer();

    const finalText = await new Promise((resolve, reject) => {
      const onDone = (message) => {
        if (message.requestId !== requestId) return;
        cleanup();
        resolve({ text: message.text, ms: message.ms, model: message.model });
      };
      const onError = (message) => {
        if (message.requestId !== requestId) return;
        cleanup();
        reject(Object.assign(new Error(message.error || '本地理解失败'), { code: message.code }));
      };
      const cleanup = () => {
        this.off('done', onDone);
        this.off('error-event', onError);
      };
      this.on('done', onDone);
      this.on('error-event', onError);
      this.request({ type: 'chat', requestId, messages, temperature, maxTokens }, CHAT_TIMEOUT).catch((err) => {
        cleanup();
        reject(err);
      });
    }).finally(() => {
      this.streams.delete(requestId);
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
      console.log('[chat] 空闲超时，卸载本地理解模型以释放显存');
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
    this.streams.clear();
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

const service = new LocalChatService();

app?.on?.('before-quit', () => {
  service.dispose().catch(() => {});
});

module.exports = { service, WORKER_FILE, DEFAULT_CONTEXT_SIZE };
