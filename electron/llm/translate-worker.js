'use strict';
/**
 * 翻译推理进程（Electron UtilityProcess 入口）。
 *
 * 这个文件只在 UtilityProcess 里跑：
 * - node-llama-cpp 是 ESM-only，用动态 import() 在 CJS 里加载；
 * - 渲染进程永远不 import 这里，只通过主进程 IPC 拿结果；
 * - 崩溃由主进程的 translator-service 负责重启。
 */
const path = require('node:path');
const { importLlama, createBackend } = require('./llama-core');

/** @type {any} */
let llama = null;
/** @type {any} */
let model = null;
/** @type {any} */
let context = null;
const aborter = new Map();

const state = {
  loaded: false,
  loading: false,
  modelPath: null,
  gpu: null,
  gpuDevice: null,
  contextSize: 0,
  vram: null,
  lastError: null,
  loadedAt: null,
};

function send(message) {
  try {
    process.parentPort.postMessage(message);
  } catch {
    /* 主进程已销毁，忽略 */
  }
}

function status() {
  return { ...state };
}

async function handleLoad(payload) {
  const { modelPath, gpu = 'auto', contextSize = 4096 } = payload || {};
  if (state.loading) return { ok: false, error: '模型正在加载中' };
  if (!modelPath) return { ok: false, error: '缺少模型路径' };

  state.loading = true;
  state.lastError = null;
  const started = Date.now();
  try {
    if (!llama) {
      // 后端探测逻辑与「AI 理解」进程共用 llama-core，避免两边各自实现导致降级行为不一致
      const created = await createBackend(gpu, (message, level = 'info') => send({ type: 'log', level, message }));
      llama = created.llama;
      state.gpu = created.used;
      state.gpuDevice = created.deviceName;
      state.backend = {
        requested: created.requested,
        used: created.used,
        deviceName: created.deviceName,
        availableGpuTypes: created.availableGpuTypes,
        fellBack: created.fellBack,
      };
    }

    if (model && state.modelPath === modelPath) {
      state.loaded = true;
      state.loading = false;
      return { ok: true, status: status(), loadMs: Date.now() - started };
    }

    if (context) {
      await context.dispose();
      context = null;
    }
    if (model) {
      await model.dispose();
      model = null;
    }

    const { LlamaLogLevel } = await importLlama();
    model = await llama.loadModel({
      modelPath: path.resolve(modelPath),
      // GPU 层全部上显存；CPU 后端时显式 0
      gpuLayers: state.gpu === 'cpu' ? 0 : 'auto',
      logLevel: LlamaLogLevel.warn,
    });
    context = await model.createContext({ contextSize: Number(contextSize) || 4096 });

    state.loaded = true;
    state.modelPath = path.resolve(modelPath);
    state.contextSize = Number(contextSize) || 4096;
    state.loadedAt = new Date().toISOString();
    try {
      state.vram = await llama.getVramState();
    } catch {
      state.vram = null;
    }
    return { ok: true, status: status(), loadMs: Date.now() - started };
  } catch (err) {
    state.lastError = err && err.message ? err.message : String(err);
    return { ok: false, error: state.lastError };
  } finally {
    state.loading = false;
  }
}

const LANG_NAMES = {
  zh: '简体中文',
  'zh-Hant': '繁体中文',
  en: '英语',
  ja: '日语',
  ko: '韩语',
  de: '德语',
  fr: '法语',
  ru: '俄语',
  es: '西班牙语',
  pt: '葡萄牙语',
  it: '意大利语',
  ar: '阿拉伯语',
};

/** Hy-MT2 官方推荐的指令式 prompt（不要加额外解释） */
function buildInstruction(text, target, extra = {}) {
  const langName = LANG_NAMES[target] || target || '简体中文';
  const style = extra.style ? `翻译风格：${extra.style}。` : '';
  return `将以下文本翻译成${langName}，注意只需要输出翻译后的结果，不要额外解释：${style}\n\n${text}`;
}

/** 长文本按句切块，避免超出上下文 */
function splitChunks(text, limit = 900) {
  const clean = String(text || '').replace(/\r\n/g, '\n').trim();
  if (clean.length <= limit) return [clean];
  const parts = [];
  let buffer = '';
  const sentences = clean.split(/(?<=[。！？!?.;；\n])/);
  for (const sentence of sentences) {
    if ((buffer + sentence).length > limit && buffer) {
      parts.push(buffer.trim());
      buffer = '';
    }
    buffer += sentence;
  }
  if (buffer.trim()) parts.push(buffer.trim());
  return parts;
}

/** 清掉模型偶尔自带的“译文：”“翻译如下”等前缀 */
function cleanOutput(text) {
  return String(text || '')
    .replace(/^\s*(译文|翻译|Translation|Translated)[:：]\s*/i, '')
    .replace(/^\s*["“'](.+)["”']\s*$/s, '$1')
    .trim();
}

async function handleTranslate(payload) {
  const { requestId, text, target = 'zh', maxTokens = 1024, temperature = 0.2, style } = payload || {};
  if (!state.loaded || !model || !context) {
    return { ok: false, error: '模型尚未加载', code: 'NOT_LOADED' };
  }
  const source = String(text || '').trim();
  if (!source) return { ok: false, error: '没有可翻译的文本' };

  const { LlamaChatSession } = await importLlama();
  const chunks = splitChunks(source);
  const controller = new AbortController();
  aborter.set(requestId, controller);

  const started = Date.now();
  let output = '';
  try {
    for (let index = 0; index < chunks.length; index += 1) {
      const sequence = context.getSequence();
      const session = new LlamaChatSession({ contextSequence: sequence, systemPrompt: '' });
      try {
        const instruction = buildInstruction(chunks[index], target, { style });
        const answer = await session.prompt(instruction, {
          maxTokens: Math.min(Number(maxTokens) || 1024, 4096),
          temperature: Number(temperature) || 0.2,
          topP: 0.9,
          signal: controller.signal,
          stopOnAbortSignal: true,
          onTextChunk(chunk) {
            send({ type: 'chunk', requestId, text: chunk, index, total: chunks.length });
          },
        });
        const piece = cleanOutput(answer);
        output += (output && chunks.length > 1 ? '\n' : '') + piece;
      } finally {
        try {
          session.dispose({ disposeSequence: true });
        } catch {
          try {
            sequence.dispose();
          } catch {
            /* ignore */
          }
        }
      }
    }
    return { ok: true, text: output, source, ms: Date.now() - started, chunks: chunks.length };
  } catch (err) {
    if (controller.signal.aborted) {
      return { ok: false, error: '已取消', code: 'ABORTED', text: output };
    }
    return { ok: false, error: err && err.message ? err.message : String(err) };
  } finally {
    aborter.delete(requestId);
  }
}

async function handleUnload() {
  if (context) {
    await context.dispose().catch(() => {});
    context = null;
  }
  if (model) {
    await model.dispose().catch(() => {});
    model = null;
  }
  state.loaded = false;
  state.modelPath = null;
  state.loadedAt = null;
  return { ok: true, status: status() };
}

process.parentPort.on('message', async (event) => {
  const msg = event && event.data ? event.data : {};
  const { id, type } = msg;
  try {
    if (type === 'load') {
      send({ id, type: 'result', result: await handleLoad(msg) });
    } else if (type === 'translate') {
      const result = await handleTranslate(msg);
      if (result.ok) send({ type: 'done', requestId: msg.requestId, ...result });
      else send({ type: 'error', requestId: msg.requestId, ...result });
      send({ id, type: 'result', result });
    } else if (type === 'abort') {
      const controller = aborter.get(msg.requestId);
      if (controller) controller.abort();
      send({ id, type: 'result', result: { ok: true, aborted: Boolean(controller) } });
    } else if (type === 'unload') {
      send({ id, type: 'result', result: await handleUnload() });
    } else if (type === 'status') {
      send({ id, type: 'result', result: { ok: true, status: status() } });
    } else {
      send({ id, type: 'result', result: { ok: false, error: `未知指令 ${type}` } });
    }
  } catch (err) {
    send({ id, type: 'result', result: { ok: false, error: err && err.message ? err.message : String(err) } });
  }
});

send({ type: 'log', level: 'info', message: 'translate-worker 已启动' });
send({ type: 'ready' });
