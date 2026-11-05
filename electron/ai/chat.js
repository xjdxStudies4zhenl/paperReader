'use strict';
/**
 * 外部 AI 调用层（只在主进程执行，渲染进程通过 IPC 使用）。
 *
 * 支持两种协议：
 *  - openai   ：POST {baseUrl}/chat/completions（OpenAI / DeepSeek / 通义 / 智谱 /
 *               OpenRouter / Ollama / vLLM / OneAPI 等所有 OpenAI 兼容服务）
 *  - anthropic：POST {baseUrl}/v1/messages
 *
 * 流式通过 SSE 解析，逐段回调 onDelta；支持 AbortSignal 中止。
 */

const DEFAULT_TIMEOUT_MS = 120000;

/** 把用户填的 Base URL 拼成完整的 endpoint，已经写了完整路径的就不重复拼 */
function endpointOf(provider, suffix) {
  const base = String(provider.baseUrl || '').trim().replace(/\/+$/, '');
  if (!base) throw new Error('Base URL 为空');
  if (base.endsWith(suffix)) return base;
  return `${base}${suffix}`;
}

function headersFor(provider) {
  const headers = { 'Content-Type': 'application/json' };
  if (provider.kind === 'anthropic') {
    if (provider.apiKeyPlain) headers['x-api-key'] = provider.apiKeyPlain;
    headers['anthropic-version'] = '2023-06-01';
  } else if (provider.apiKeyPlain) {
    headers.Authorization = `Bearer ${provider.apiKeyPlain}`;
  }
  for (const [key, value] of Object.entries(provider.headers || {})) {
    if (key && value !== undefined && value !== null && String(value).trim() !== '') {
      headers[key] = String(value);
    }
  }
  return headers;
}

/** 把 [{role, content}] 转成各协议的结构；system 单独抽出（Anthropic 要求） */
function splitSystem(messages = []) {
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n')
    .trim();
  const rest = messages.filter((m) => m.role !== 'system');
  return { system, rest };
}

function buildBody(provider, { messages, temperature, maxTokens, stream }) {
  const { system, rest } = splitSystem(messages);
  if (provider.kind === 'anthropic') {
    const body = {
      model: provider.model,
      max_tokens: maxTokens || provider.maxTokens || 2048,
      messages: rest.map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content })),
      stream: Boolean(stream),
    };
    if (system) body.system = system;
    if (Number.isFinite(temperature)) body.temperature = temperature;
    return body;
  }
  return {
    model: provider.model,
    messages,
    temperature: Number.isFinite(temperature) ? temperature : provider.temperature,
    max_tokens: maxTokens || provider.maxTokens || 2048,
    stream: Boolean(stream),
  };
}

/** 从各家风格的响应里抠出增量文本 */
function deltaOf(provider, payload) {
  if (!payload) return '';
  if (provider.kind === 'anthropic') {
    if (payload.type === 'content_block_delta') {
      return (payload.delta && (payload.delta.text || payload.delta.partial_json)) || '';
    }
    return '';
  }
  const choice = payload.choices && payload.choices[0];
  if (!choice) return '';
  const delta = choice.delta || {};
  if (typeof delta.content === 'string') return delta.content;
  if (Array.isArray(delta.content)) {
    return delta.content.map((part) => (typeof part === 'string' ? part : part && part.text) || '').join('');
  }
  if (typeof choice.text === 'string') return choice.text;
  return '';
}

/** 友好错误：把 HTTP 4xx/5xx 的返回体压缩成一句能看懂的话 */
async function describeHttpError(res) {
  let detail = '';
  try {
    const text = await res.text();
    try {
      const json = JSON.parse(text);
      detail = (json.error && (json.error.message || json.error)) || json.message || text;
    } catch {
      detail = text;
    }
  } catch {
    detail = '';
  }
  detail = String(detail || '').replace(/\s+/g, ' ').slice(0, 300);
  const hint =
    res.status === 401
      ? '（Key 无效或未授权）'
      : res.status === 403
        ? '（无权限，检查 Key 的模型权限）'
        : res.status === 404
          ? '（接口路径不对，Base URL 通常以 /v1 结尾）'
          : res.status === 429
            ? '（触发限流，稍后再试或换配置）'
            : '';
  return new Error(`AI 接口返回 ${res.status}${hint}${detail ? `：${detail}` : ''}`);
}

/**
 * 发起一次对话。
 * @returns {Promise<{text:string, model:string, usage:object|null, ms:number}>}
 */
async function chat(provider, { messages, temperature, maxTokens, signal, onDelta }) {
  const started = Date.now();
  const stream = typeof onDelta === 'function';
  const body = buildBody(provider, { messages, temperature, maxTokens, stream });
  const suffix = provider.kind === 'anthropic' ? '/v1/messages' : '/chat/completions';

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('请求超时（120s）')), DEFAULT_TIMEOUT_MS);
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  let res;
  try {
    res = await fetch(endpointOf(provider, suffix), {
      method: 'POST',
      headers: headersFor(provider),
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeout);
    if (err && (err.name === 'AbortError' || controller.signal.aborted)) {
      throw new Error('请求已中止');
    }
    throw new Error(
      `连不上 AI 接口：${err && err.message ? err.message : err}\n请检查 Base URL、网络代理，或本机服务是否已启动。`
    );
  }

  if (!res.ok) {
    clearTimeout(timeout);
    throw await describeHttpError(res);
  }

  // 非流式：一次性读完
  if (!stream) {
    try {
      const json = await res.json();
      const text =
        provider.kind === 'anthropic'
          ? (json.content || []).map((part) => part.text || '').join('')
          : (json.choices && json.choices[0] && (json.choices[0].message?.content || json.choices[0].text)) || '';
      clearTimeout(timeout);
      return { text, model: json.model || provider.model, usage: json.usage || null, ms: Date.now() - started };
    } finally {
      clearTimeout(timeout);
    }
  }

  // 流式：逐行解析 SSE
  let text = '';
  let usage = null;
  let model = provider.model;
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  try {
    const reader = res.body.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const raw of lines) {
        const line = raw.trim();
        if (!line || line.startsWith(':') || line.startsWith('event:')) continue;
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        let payload;
        try {
          payload = JSON.parse(data);
        } catch {
          continue;
        }
        if (payload.model) model = payload.model;
        if (payload.usage) usage = payload.usage;
        if (payload.error) {
          throw new Error(`AI 接口报错：${payload.error.message || JSON.stringify(payload.error)}`);
        }
        const piece = deltaOf(provider, payload);
        if (piece) {
          text += piece;
          onDelta(piece, text);
        }
      }
    }
  } catch (err) {
    clearTimeout(timeout);
    if (err && (err.name === 'AbortError' || controller.signal.aborted)) {
      if (text) return { text, model, usage, ms: Date.now() - started, aborted: true };
      throw new Error('请求已中止');
    }
    throw err;
  }
  clearTimeout(timeout);
  return { text, model, usage, ms: Date.now() - started };
}

/** 连通性测试：发一条极短的请求 */
async function testProvider(provider) {
  const started = Date.now();
  const result = await chat(provider, {
    messages: [
      { role: 'system', content: '你是连通性测试助手。' },
      { role: 'user', content: '只回复两个字：可用' },
    ],
    maxTokens: 16,
    temperature: 0,
  });
  return {
    ok: Boolean(result.text),
    ms: Date.now() - started,
    model: result.model,
    sample: String(result.text || '').slice(0, 40),
  };
}

module.exports = { chat, testProvider, endpointOf };
