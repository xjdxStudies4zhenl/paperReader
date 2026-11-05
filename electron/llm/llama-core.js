'use strict';
/**
 * llama.cpp 运行时的公共封装（只允许在 UtilityProcess 里 require）。
 *
 * 抽出来的原因：翻译进程和「AI 理解」进程要做完全一样的三件事——
 * 1) 把 ESM-only 的 node-llama-cpp 动态 import 进 CJS；
 * 2) 按用户指定探测 GPU 后端，失败分级降级并把真实后端回报给界面；
 * 3) 装载 / 卸载 GGUF 模型与上下文。
 *
 * 这里只做「运行时」，prompt 拼装、流式输出、崩溃重启仍在各自 worker / service 里。
 */
const path = require('node:path');

let modulePromise = null;

/** node-llama-cpp 3.x 只有 ESM 产物，CJS 里必须走动态 import 并缓存 */
function importLlama() {
  if (!modulePromise) modulePromise = import('node-llama-cpp');
  return modulePromise;
}

/**
 * 初始化 llama.cpp 后端。
 * @param {string} gpuPreference 'auto' | 'cpu' | 'cuda' | 'vulkan' | 'metal'
 * @param {(message: string, level?: 'info'|'warn') => void} log
 */
async function createBackend(gpuPreference, log = () => {}) {
  const { getLlama, getLlamaGpuTypes } = await importLlama();
  let available = [];
  try {
    available = await getLlamaGpuTypes('auto');
  } catch {
    available = [];
  }

  const wanted = gpuPreference || 'auto';
  const attempts = [];
  if (wanted === 'cpu') {
    attempts.push({ gpu: false, label: 'cpu' });
  } else if (wanted === 'auto') {
    attempts.push({ gpu: 'auto', label: 'auto' });
  } else {
    // 用户明确要求 cuda / metal / vulkan：先按指定后端，失败再降级，便于界面显示真实情况
    attempts.push({ gpu: wanted, label: wanted });
    attempts.push({ gpu: 'auto', label: 'auto(降级)' });
    attempts.push({ gpu: false, label: 'cpu(降级)' });
  }

  let lastError = null;
  for (const attempt of attempts) {
    try {
      const instance = await getLlama({ gpu: attempt.gpu, build: 'never' });
      let deviceName = null;
      try {
        const names = await instance.getGpuDeviceNames();
        deviceName = (names && names[0]) || null;
      } catch {
        deviceName = null;
      }
      const fellBack = attempt.gpu !== wanted && wanted !== 'auto' && wanted !== 'cpu';
      log(
        `llama.cpp 后端就绪：requested=${wanted} used=${instance.gpu === false ? 'cpu' : instance.gpu} device=${deviceName || '-'} available=${available.join(',') || '-'}${fellBack ? '（已降级）' : ''}`
      );
      return {
        llama: instance,
        requested: wanted,
        used: instance.gpu === false ? 'cpu' : instance.gpu,
        deviceName,
        availableGpuTypes: available,
        fellBack,
      };
    } catch (err) {
      lastError = err;
      log(`GPU 后端 ${attempt.label} 初始化失败：${err && err.message}`, 'warn');
    }
  }
  throw lastError || new Error('无法初始化 llama.cpp 后端');
}

/**
 * 一个「模型 + 上下文」的持有者：装载、卸载、状态查询。
 * 上下文按需创建，方便不同请求用不同 contextSize。
 */
class LocalModelRuntime {
  /** @param {{ log?: (message: string, level?: string) => void }} [options] */
  constructor(options = {}) {
    this.log = options.log || (() => {});
    /** @type {any} */
    this.llama = null;
    /** @type {any} */
    this.model = null;
    /** @type {any} */
    this.context = null;
    this.loading = false;
    this.state = {
      loaded: false,
      modelPath: null,
      gpu: null,
      gpuDevice: null,
      backend: null,
      contextSize: 0,
      vram: null,
      lastError: null,
      loadedAt: null,
    };
  }

  status() {
    return { ...this.state };
  }

  /**
   * 装载模型（同一模型重复调用是幂等的）。
   * @returns {Promise<{ok:boolean, status:object, loadMs:number, error?:string}>}
   */
  async load({ modelPath, gpu = 'auto', contextSize = 8192 } = {}) {
    if (this.loading) return { ok: false, error: '模型正在加载中' };
    if (!modelPath) return { ok: false, error: '缺少模型路径' };

    const absPath = path.resolve(modelPath);
    const started = Date.now();
    this.loading = true;
    this.state.lastError = null;
    try {
      if (!this.llama) {
        const backend = await createBackend(gpu, this.log);
        this.llama = backend.llama;
        this.state.gpu = backend.used;
        this.state.gpuDevice = backend.deviceName;
        this.state.backend = {
          requested: backend.requested,
          used: backend.used,
          deviceName: backend.deviceName,
          availableGpuTypes: backend.availableGpuTypes,
          fellBack: backend.fellBack,
        };
      }

      const size = Number(contextSize) || 8192;
      if (this.model && this.state.modelPath === absPath) {
        // 同一个模型：只在上下文大小变了才重建
        if (this.context && this.state.contextSize !== size) {
          await this.context.dispose().catch(() => {});
          this.context = null;
        }
        if (!this.context) {
          this.context = await this.model.createContext({ contextSize: size });
          this.state.contextSize = size;
        }
        this.state.loaded = true;
        return { ok: true, status: this.status(), loadMs: Date.now() - started };
      }

      if (this.context) {
        await this.context.dispose().catch(() => {});
        this.context = null;
      }
      if (this.model) {
        await this.model.dispose().catch(() => {});
        this.model = null;
      }

      const { LlamaLogLevel } = await importLlama();
      this.model = await this.llama.loadModel({
        modelPath: absPath,
        // GPU 层全部上显存；CPU 后端时显式 0
        gpuLayers: this.state.gpu === 'cpu' ? 0 : 'auto',
        logLevel: LlamaLogLevel.warn,
      });
      this.context = await this.model.createContext({ contextSize: size });

      this.state.loaded = true;
      this.state.modelPath = absPath;
      this.state.contextSize = size;
      this.state.loadedAt = new Date().toISOString();
      try {
        this.state.vram = await this.llama.getVramState();
      } catch {
        this.state.vram = null;
      }
      return { ok: true, status: this.status(), loadMs: Date.now() - started };
    } catch (err) {
      this.state.lastError = err && err.message ? err.message : String(err);
      this.state.loaded = false;
      return { ok: false, error: this.state.lastError };
    } finally {
      this.loading = false;
    }
  }

  async unload() {
    if (this.context) {
      await this.context.dispose().catch(() => {});
      this.context = null;
    }
    if (this.model) {
      await this.model.dispose().catch(() => {});
      this.model = null;
    }
    this.state.loaded = false;
    this.state.modelPath = null;
    this.state.loadedAt = null;
    return { ok: true, status: this.status() };
  }

  get ready() {
    return Boolean(this.state.loaded && this.model && this.context);
  }
}

module.exports = { importLlama, createBackend, LocalModelRuntime };
