'use strict';
/**
 * 外部 AI 供应商配置存储。
 *
 * - 配置文件：userData/ai-providers.json（与数据库配置同目录，跟机器绑定）
 * - API Key 用 Electron safeStorage 加密后落盘（Windows 走 DPAPI），文件里不出现明文
 * - 渲染进程只能拿到打码后的 key（sk-…abcd）
 */
const { app, safeStorage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const CONFIG_VERSION = 1;

/** 内置模板：只是预填表单，不会自动创建 */
const PRESETS = [
  {
    key: 'openai',
    name: 'OpenAI',
    kind: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    hint: '官方 OpenAI；也适用于任何 OpenAI 兼容网关',
  },
  {
    key: 'deepseek',
    name: 'DeepSeek',
    kind: 'openai',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    hint: '性价比高，中文论文理解效果好',
  },
  {
    key: 'moonshot',
    name: 'Moonshot / Kimi',
    kind: 'openai',
    baseUrl: 'https://api.moonshot.cn/v1',
    model: 'moonshot-v1-8k',
    hint: '长上下文，适合整篇摘要',
  },
  {
    key: 'dashscope',
    name: '通义千问（DashScope）',
    kind: 'openai',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
    hint: '阿里云百炼，OpenAI 兼容模式',
  },
  {
    key: 'zhipu',
    name: '智谱 GLM',
    kind: 'openai',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4-flash',
    hint: '国内直连，价格低',
  },
  {
    key: 'openrouter',
    name: 'OpenRouter',
    kind: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'openai/gpt-4o-mini',
    hint: '一个 Key 调多家模型',
  },
  {
    key: 'ollama',
    name: 'Ollama（本地）',
    kind: 'openai',
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: 'qwen2.5:7b',
    hint: '本机跑模型，无需联网、无需 Key',
  },
  {
    key: 'lmstudio',
    name: 'LM Studio（本地）',
    kind: 'openai',
    baseUrl: 'http://127.0.0.1:1234/v1',
    model: 'local-model',
    hint: '本地 OpenAI 兼容服务',
  },
  {
    key: 'anthropic',
    name: 'Anthropic Claude',
    kind: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    model: 'claude-3-5-sonnet-latest',
    hint: '使用 /v1/messages 协议',
  },
  {
    key: 'custom',
    name: '自定义（OpenAI 兼容）',
    kind: 'openai',
    baseUrl: 'https://your-gateway.example.com/v1',
    model: 'your-model',
    hint: '自建 vLLM / OneAPI / 中转站等',
  },
];

function configFile() {
  return path.join(app.getPath('userData'), 'ai-providers.json');
}

function emptyConfig() {
  return { version: CONFIG_VERSION, defaultId: '', providers: [] };
}

/* --------------------------------- 读写 --------------------------------- */

function readRaw() {
  try {
    const text = fs.readFileSync(configFile(), 'utf8').replace(/^\uFEFF/, '');
    const parsed = JSON.parse(text);
    return normalizeConfig(parsed);
  } catch {
    return emptyConfig();
  }
}

function normalizeConfig(input) {
  const cfg = emptyConfig();
  if (!input || typeof input !== 'object') return cfg;
  cfg.version = Number(input.version) || CONFIG_VERSION;
  cfg.defaultId = typeof input.defaultId === 'string' ? input.defaultId : '';
  cfg.providers = Array.isArray(input.providers)
    ? input.providers.filter((p) => p && typeof p === 'object' && p.id).map(normalizeProvider)
    : [];
  if (!cfg.providers.some((p) => p.id === cfg.defaultId)) {
    cfg.defaultId = cfg.providers[0] ? cfg.providers[0].id : '';
  }
  return cfg;
}

function normalizeProvider(input) {
  const kind = input.kind === 'anthropic' ? 'anthropic' : input.kind === 'local' ? 'local' : 'openai';
  return {
    id: String(input.id),
    name: String(input.name || '未命名').slice(0, 60),
    kind,
    baseUrl: String(input.baseUrl || '').trim(),
    model: String(input.model || '').trim(),
    temperature: clamp(Number(input.temperature), 0, 2, 0.3),
    maxTokens: Math.round(clamp(Number(input.maxTokens), 64, 32000, kind === 'local' ? 1024 : 2048)),
    headers: input.headers && typeof input.headers === 'object' ? input.headers : {},
    apiKey: String(input.apiKey || ''),
    apiKeyEnc: Boolean(input.apiKeyEnc),
    disabled: Boolean(input.disabled),
    // 本地模型（kind === 'local'）专用：模型清单 id、自定义 GGUF 路径、推理后端与上下文
    localModelId: String(input.localModelId || ''),
    localPath: String(input.localPath || ''),
    gpu: String(input.gpu || 'auto'),
    contextSize: Math.round(clamp(Number(input.contextSize), 2048, 32768, 8192)),
    createdAt: input.createdAt || new Date().toISOString(),
    updatedAt: input.updatedAt || new Date().toISOString(),
    lastTest: input.lastTest && typeof input.lastTest === 'object' ? input.lastTest : null,
  };
}

function clamp(value, min, max, fallback) {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(value, min), max);
}

function writeRaw(cfg) {
  const dir = path.dirname(configFile());
  fs.mkdirSync(dir, { recursive: true });
  // 落盘时加密 key
  const out = {
    version: CONFIG_VERSION,
    defaultId: cfg.defaultId,
    providers: cfg.providers.map((p) => {
      const encrypted = encryptKey(p.apiKey);
      return { ...p, apiKey: encrypted.value, apiKeyEnc: encrypted.enc };
    }),
  };
  fs.writeFileSync(configFile(), JSON.stringify(out, null, 2), 'utf8');
  return readRaw();
}

function encryptKey(plain) {
  const value = String(plain || '');
  if (!value) return { value: '', enc: false };
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return { value: safeStorage.encryptString(value).toString('base64'), enc: true };
    }
  } catch {
    /* 加密不可用时退化为明文（仍只存在本机） */
  }
  return { value, enc: false };
}

function decryptKey(provider) {
  const raw = String(provider.apiKey || '');
  if (!raw) return '';
  if (!provider.apiKeyEnc) return raw;
  try {
    return safeStorage.decryptString(Buffer.from(raw, 'base64'));
  } catch {
    return '';
  }
}

/** key 打码：sk-abcd…wxyz */
function maskKey(provider) {
  const plain = decryptKey(provider);
  if (!plain) return '';
  if (plain.length <= 8) return `${plain.slice(0, 2)}…`;
  return `${plain.slice(0, 4)}…${plain.slice(-4)}`;
}

/* --------------------------------- 对外 API --------------------------------- */

function listProviders() {
  const cfg = readRaw();
  return {
    defaultId: cfg.defaultId,
    providers: cfg.providers.map((p) => ({
      id: p.id,
      name: p.name,
      kind: p.kind,
      isLocal: p.kind === 'local',
      baseUrl: p.baseUrl,
      model: p.model,
      temperature: p.temperature,
      maxTokens: p.maxTokens,
      disabled: p.disabled,
      localModelId: p.localModelId,
      localPath: p.localPath,
      gpu: p.gpu,
      contextSize: p.contextSize,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
      lastTest: p.lastTest,
      hasKey: Boolean(decryptKey(p)),
      keyMasked: maskKey(p),
      headers: p.headers || {},
      file: configFile(),
    })),
    presets: PRESETS,
  };
}

function newId() {
  return `ai_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * 新增或更新；apiKey 为空字符串表示“保持原 key 不变”。
 * kind === 'local' 时不需要 Base URL / Key，改为校验本地模型（清单 id 或自定义 GGUF 路径）。
 */
function saveProvider(input = {}) {
  const cfg = readRaw();
  const id = input.id ? String(input.id) : newId();
  const index = cfg.providers.findIndex((p) => p.id === id);
  const previous = index >= 0 ? cfg.providers[index] : null;

  const kind = input.kind || (previous && previous.kind) || 'openai';
  const name = String(input.name || (previous && previous.name) || '').trim();
  let baseUrl = String(input.baseUrl || (previous && previous.baseUrl) || '').trim().replace(/\/+$/, '');
  let model = String(input.model || (previous && previous.model) || '').trim();
  const localModelId = String(input.localModelId !== undefined ? input.localModelId : (previous && previous.localModelId) || '').trim();
  const localPath = String(input.localPath !== undefined ? input.localPath : (previous && previous.localPath) || '').trim();

  if (!name) throw new Error('请填写配置名称');

  if (kind === 'local') {
    // 本地模型：不联网、不需要 Key
    if (!localModelId && !localPath) throw new Error('请选择要使用的本地模型（或指定一个 GGUF 文件）');
    if (!model) model = localModelId || '本地 GGUF';
    baseUrl = '';
  } else {
    if (!baseUrl) throw new Error('请填写 Base URL，例如 https://api.deepseek.com/v1');
    if (!model) throw new Error('请填写模型名，例如 deepseek-chat');
    if (!/^https?:\/\//i.test(baseUrl)) throw new Error('Base URL 需要以 http:// 或 https:// 开头');
  }

  const apiKeyInput = input.apiKey === undefined ? null : String(input.apiKey);
  let apiKey = previous ? previous.apiKey : '';
  let apiKeyEnc = previous ? previous.apiKeyEnc : false;
  if (apiKeyInput !== null && apiKeyInput.trim() !== '') {
    apiKey = apiKeyInput.trim();
    apiKeyEnc = false; // 先存明文，写盘时统一加密
  }

  const next = normalizeProvider({
    ...(previous || {}),
    id,
    name,
    kind,
    baseUrl,
    model,
    apiKey,
    apiKeyEnc,
    localModelId,
    localPath,
    gpu: input.gpu === undefined ? previous && previous.gpu : input.gpu,
    contextSize: input.contextSize === undefined ? previous && previous.contextSize : input.contextSize,
    temperature: input.temperature === undefined ? previous && previous.temperature : input.temperature,
    maxTokens: input.maxTokens === undefined ? previous && previous.maxTokens : input.maxTokens,
    headers: input.headers === undefined ? previous && previous.headers : input.headers,
    disabled: input.disabled === undefined ? previous && previous.disabled : Boolean(input.disabled),
    updatedAt: new Date().toISOString(),
  });
  next.apiKey = apiKey;
  next.apiKeyEnc = apiKeyEnc;

  if (index >= 0) cfg.providers[index] = next;
  else cfg.providers.push(next);
  if (!cfg.defaultId) cfg.defaultId = next.id;

  writeRaw(cfg);
  return listProviders();
}

function removeProvider(id) {
  const cfg = readRaw();
  const before = cfg.providers.length;
  cfg.providers = cfg.providers.filter((p) => p.id !== id);
  if (cfg.providers.length === before) throw new Error('配置不存在或已被删除');
  if (cfg.defaultId === id) cfg.defaultId = cfg.providers[0] ? cfg.providers[0].id : '';
  writeRaw(cfg);
  return listProviders();
}

function setDefaultProvider(id) {
  const cfg = readRaw();
  if (!cfg.providers.some((p) => p.id === id)) throw new Error('配置不存在');
  cfg.defaultId = id;
  writeRaw(cfg);
  return listProviders();
}

/** 内部使用：拿到含明文 key 的完整配置 */
function resolveProvider(id) {
  const cfg = readRaw();
  const target = id ? cfg.providers.find((p) => p.id === id) : cfg.providers.find((p) => p.id === cfg.defaultId);
  if (!target) {
    throw new Error(cfg.providers.length ? '没有选中有效的 AI 配置' : '还没有配置 AI：可以在 设置 → AI 模型 里下载本地模型，或添加一套外部 API');
  }
  if (target.disabled) throw new Error(`AI 配置「${target.name}」已被停用`);
  return { ...target, apiKeyPlain: decryptKey(target) };
}

function recordTest(id, result) {
  const cfg = readRaw();
  const target = cfg.providers.find((p) => p.id === id);
  if (!target) return;
  target.lastTest = { ...result, at: new Date().toISOString() };
  writeRaw(cfg);
}

module.exports = {
  PRESETS,
  configFile,
  listProviders,
  saveProvider,
  removeProvider,
  setDefaultProvider,
  resolveProvider,
  recordTest,
};
