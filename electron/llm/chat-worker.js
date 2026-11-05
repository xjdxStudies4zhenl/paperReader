'use strict';
/**
 * 「AI 理解」本地推理进程（Electron UtilityProcess 入口）。
 *
 * 和翻译进程同一套约束：
 * - node-llama-cpp 只在这里跑（ESM-only，用 llama-core 里的动态 import）；
 * - 渲染进程永远不碰原生模块，只经主进程 IPC 拿结果；
 * - 崩溃由主进程的 local-chat-service 负责指数退避重启。
 *
 * 与翻译不同的一点：这里吃「对话消息数组」，支持 system 提示词与多轮追问，
 * 并且按上下文长度自动裁剪过长正文，避免整篇摘要把上下文塞爆。
 */
const { importLlama, LocalModelRuntime } = require('./llama-core');

const aborter = new Map();

function send(message) {
  try {
    process.parentPort.postMessage(message);
  } catch {
    /* 主进程已销毁，忽略 */
  }
}

const runtime = new LocalModelRuntime({
  log: (message, level = 'info') => send({ type: 'log', level, message }),
});

/** 粗略估计 prompt 能塞多少字符：中文约 1 字 ≈ 1 token，英文约 4 字符 ≈ 1 token，取保守值 */
function charBudget(contextSize, maxTokens) {
  const inputTokens = Math.max(512, Number(contextSize || 8192) - Number(maxTokens || 1024) - 256);
  return Math.max(1200, Math.floor(inputTokens * 1.2));
}

/** 超长正文按段落截断，并在末尾标注，避免模型读到半句还以为读完了 */
function clampText(text, budget) {
  const clean = String(text || '');
  if (clean.length <= budget) return clean;
  const head = clean.slice(0, budget);
  const cut = Math.max(head.lastIndexOf('\n'), head.lastIndexOf('。'), head.lastIndexOf('. '));
  const body = cut > budget * 0.6 ? head.slice(0, cut) : head;
  return `${body}\n\n（正文过长，已按上下文长度截断，仅依据以上内容作答）`;
}

/** 把 [{role, content}] 拆成 systemPrompt + 可写入 history 的对话 */
function splitMessages(messages = []) {
  const list = Array.isArray(messages) ? messages.filter((m) => m && m.content) : [];
  const systemPrompt = list
    .filter((m) => m.role === 'system')
    .map((m) => String(m.content))
    .join('\n\n')
    .trim();
  const dialogue = list.filter((m) => m.role !== 'system');
  return { systemPrompt, dialogue };
}

async function handleLoad(payload = {}) {
  const { modelPath, gpu = 'auto', contextSize = 8192 } = payload;
  return runtime.load({ modelPath, gpu, contextSize });
}

async function handleChat(payload = {}) {
  const { requestId, messages, temperature = 0.3, maxTokens = 1024 } = payload;
  if (!runtime.ready) return { ok: false, error: '本地模型尚未加载', code: 'NOT_LOADED' };
  if (!requestId) return { ok: false, error: '缺少 requestId' };

  const { systemPrompt, dialogue } = splitMessages(messages);
  if (!dialogue.length) return { ok: false, error: '没有可理解的内容' };

  const budget = charBudget(runtime.state.contextSize, maxTokens);
  // 多轮（追问）时把前面的问答压成纯文本一并塞进 prompt：小模型上比 setChatHistory 更稳
  const history = dialogue.slice(0, -1);
  const last = dialogue[dialogue.length - 1];
  const historyText = history
    .map((m) => `${m.role === 'assistant' ? '此前的回答' : '此前的问题'}：\n${String(m.content).trim()}`)
    .join('\n\n');
  const question = clampText(last.content, historyText ? Math.max(800, budget - historyText.length) : budget);
  const prompt = historyText ? `${historyText}\n\n${question}` : question;

  const { LlamaChatSession } = await importLlama();
  const controller = new AbortController();
  aborter.set(requestId, controller);
  const started = Date.now();
  let output = '';

  const sequence = runtime.context.getSequence();
  let session = null;
  try {
    session = new LlamaChatSession({ contextSequence: sequence, systemPrompt: systemPrompt || '' });
    const answer = await session.prompt(prompt, {
      maxTokens: Math.min(Number(maxTokens) || 1024, 4096),
      temperature: Number.isFinite(Number(temperature)) ? Number(temperature) : 0.3,
      topP: 0.9,
      signal: controller.signal,
      stopOnAbortSignal: true,
      onTextChunk(chunk) {
        output += chunk;
        send({ type: 'chunk', requestId, text: chunk });
      },
    });
    return {
      ok: true,
      text: String(answer || output || '').trim(),
      ms: Date.now() - started,
      model: runtime.state.modelPath,
    };
  } catch (err) {
    if (controller.signal.aborted) {
      return { ok: false, error: '已取消', code: 'ABORTED', text: output };
    }
    return { ok: false, error: err && err.message ? err.message : String(err), text: output };
  } finally {
    aborter.delete(requestId);
    try {
      session && session.dispose({ disposeSequence: true });
    } catch {
      try {
        sequence.dispose();
      } catch {
        /* ignore */
      }
    }
  }
}

process.parentPort.on('message', async (event) => {
  const msg = event && event.data ? event.data : {};
  const { id, type } = msg;
  try {
    if (type === 'load') {
      send({ id, type: 'result', result: await handleLoad(msg) });
    } else if (type === 'chat') {
      const result = await handleChat(msg);
      if (result.ok) send({ type: 'done', requestId: msg.requestId, ...result });
      else send({ type: 'error', requestId: msg.requestId, ...result });
      send({ id, type: 'result', result });
    } else if (type === 'abort') {
      const controller = aborter.get(msg.requestId);
      if (controller) controller.abort();
      send({ id, type: 'result', result: { ok: true, aborted: Boolean(controller) } });
    } else if (type === 'unload') {
      send({ id, type: 'result', result: await runtime.unload() });
    } else if (type === 'status') {
      send({ id, type: 'result', result: { ok: true, status: runtime.status() } });
    } else {
      send({ id, type: 'result', result: { ok: false, error: `未知指令 ${type}` } });
    }
  } catch (err) {
    send({ id, type: 'result', result: { ok: false, error: err && err.message ? err.message : String(err) } });
  }
});

send({ type: 'log', level: 'info', message: 'chat-worker 已启动' });
send({ type: 'ready' });

// 便于在非 UtilityProcess 环境做单元自检（正常运行时这些导出不会被使用）
module.exports = { splitMessages, clampText, charBudget, handleChat, handleLoad };
