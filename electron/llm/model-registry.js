'use strict';
/**
 * 本地模型清单与路径解析（两种用途：划词翻译 / AI 理解）。
 *
 * 模型只在主进程 / UtilityProcess 里使用，渲染进程永远不碰 node-llama-cpp。
 * 查找顺序：配置里自定义的绝对路径 → userData/models → 打包后的 resources/models → 开发目录 models/。
 *
 * kind：
 *  - translate —— Hy-MT2 专用翻译模型，只给「划译」用；
 *  - chat      —— 国内开源指令模型的量化版（Qwen2.5 等），给「AI 理解 / 整篇摘要 / 追问」用。
 */
const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

/** 翻译模型：官方量化版本，体积 / 质量权衡不同。默认 Q4_K_M */
const TRANSLATE_MODELS = [
  {
    kind: 'translate',
    id: 'hy-mt2-1.8b-q4km',
    label: 'Hy-MT2-1.8B Q4_K_M（推荐质量 1.08GB）',
    shortLabel: 'Hy-MT2-1.8B Q4_K_M',
    fileName: 'Hy-MT2-1.8B-Q4_K_M.gguf',
    altFileNames: [],
    approxMB: 1081,
    repo: 'tencent/Hy-MT2-1.8B-GGUF',
    scope: 'Tencent-Hunyuan/Hy-MT2-1.8B-GGUF',
    maxTokens: 1024,
    contextSize: 4096,
    note: '官方 llama.cpp 量化，质量最稳；显存占用约 1.5GB。实测 RTX 4070 上 GPU 推理约 0.6s/句。',
  },
  {
    kind: 'translate',
    id: 'hy-mt2-1.8b-1.25bit',
    label: 'Hy-MT2-1.8B 1.25bit（极致量化 440MB）',
    shortLabel: 'Hy-MT2-1.8B 1.25bit',
    fileName: 'Hy-MT2-1.8B-1.25bit-v2.gguf',
    altFileNames: ['Hy-MT2-1.8B-1.25bit-v1.gguf', 'Hy-MT2-1.8B-1.25bit.gguf', 'Hy-MT2-1.8B-1.25Bit.gguf'],
    approxMB: 440,
    repo: 'AngelSlim/Hy-MT2-1.8B-1.25Bit-GGUF',
    scope: 'AngelSlim/Hy-MT2-1.8B-1.25Bit-GGUF',
    maxTokens: 1024,
    contextSize: 4096,
    note: '官方 AngelSlim 极致量化，体积最小、速度最快。注意：当前 node-llama-cpp 3.22.2 自带的 llama.cpp 会拒绝该 GGUF（tensor offset 校验失败），需要更新的推理后端；加载失败时请切回 Q4_K_M。',
  },
  {
    kind: 'translate',
    id: 'hy-mt2-1.8b-q6k',
    label: 'Hy-MT2-1.8B Q6_K（高质量 1.4GB）',
    shortLabel: 'Hy-MT2-1.8B Q6_K',
    fileName: 'Hy-MT2-1.8B-Q6_K.gguf',
    altFileNames: [],
    approxMB: 1406,
    repo: 'tencent/Hy-MT2-1.8B-GGUF',
    scope: 'Tencent-Hunyuan/Hy-MT2-1.8B-GGUF',
    maxTokens: 1024,
    contextSize: 4096,
    note: '质量更高、加载更慢，适合台式机 / 大显存。',
  },
];

/**
 * 「AI 理解」用的本地量化模型（国内开源指令模型 + GGUF 量化）。
 * 全部是单文件 GGUF，便于断点续传；分片仓库（如 Qwen 官方 7B）另选单文件量化版。
 */
const CHAT_MODELS = [
  {
    kind: 'chat',
    id: 'qwen2.5-3b-instruct-q4km',
    label: 'Qwen2.5-3B-Instruct Q4_K_M（推荐 2.0GB）',
    shortLabel: 'Qwen2.5-3B-Instruct Q4_K_M',
    fileName: 'qwen2.5-3b-instruct-q4_k_m.gguf',
    altFileNames: [],
    approxMB: 2007,
    repo: 'Qwen/Qwen2.5-3B-Instruct-GGUF',
    scope: 'Qwen/Qwen2.5-3B-Instruct-GGUF',
    maxTokens: 1024,
    contextSize: 8192,
    note: '阿里通义千问官方量化：中文论文理解质量与速度最平衡，显存约 2.6GB；集显 / 纯 CPU 也能跑，只是慢一些。',
  },
  {
    kind: 'chat',
    id: 'qwen2.5-1.5b-instruct-q4km',
    label: 'Qwen2.5-1.5B-Instruct Q4_K_M（轻量 1.06GB）',
    shortLabel: 'Qwen2.5-1.5B-Instruct Q4_K_M',
    fileName: 'qwen2.5-1.5b-instruct-q4_k_m.gguf',
    altFileNames: [],
    approxMB: 1065,
    repo: 'Qwen/Qwen2.5-1.5B-Instruct-GGUF',
    scope: 'Qwen/Qwen2.5-1.5B-Instruct-GGUF',
    maxTokens: 768,
    contextSize: 8192,
    note: '最轻量可用版：老笔记本 / 纯 CPU 首选，长公式和整篇摘要的质量弱于 3B。',
  },
  {
    kind: 'chat',
    id: 'qwen2.5-7b-instruct-q4km',
    label: 'Qwen2.5-7B-Instruct Q4_K_M（质量最好 4.4GB）',
    shortLabel: 'Qwen2.5-7B-Instruct Q4_K_M',
    fileName: 'Qwen2.5-7B-Instruct-Q4_K_M.gguf',
    altFileNames: [],
    approxMB: 4466,
    repo: 'bartowski/Qwen2.5-7B-Instruct-GGUF',
    scope: '',
    maxTokens: 1536,
    contextSize: 8192,
    note: '7B 量化版，拆公式、写结构化摘要明显更稳；建议 6GB 以上显存，否则会退回 CPU 慢跑。官方仓库是分片 GGUF，这里用单文件量化版方便断点续传。',
  },
];

const ALL_MODELS = [...TRANSLATE_MODELS, ...CHAT_MODELS];

/** 兼容：老代码里的 MODELS 指翻译模型 */
const MODELS = TRANSLATE_MODELS;

const DEFAULT_MODEL_ID = 'hy-mt2-1.8b-q4km';
const DEFAULT_CHAT_MODEL_ID = 'qwen2.5-3b-instruct-q4km';

/**
 * 按 id 找模型。
 * @param {string} id
 * @param {'translate'|'chat'} [kind] 指定用途时只在对应清单里找，找不到回落到该用途的默认模型
 */
function findModel(id, kind) {
  const pool = kind === 'chat' ? CHAT_MODELS : kind === 'translate' ? TRANSLATE_MODELS : ALL_MODELS;
  const found = pool.find((m) => m.id === id);
  if (found) return found;
  if (kind === 'chat') return CHAT_MODELS[0];
  if (kind === 'translate') return TRANSLATE_MODELS[0];
  return ALL_MODELS.find((m) => m.id === id) || TRANSLATE_MODELS[0];
}

/** 所有可能放模型的目录（绝对路径）；两种模型共用同一个目录 */
function modelDirs() {
  const dirs = [path.join(app.getPath('userData'), 'models')];
  if (process.resourcesPath) dirs.push(path.join(process.resourcesPath, 'models'));
  dirs.push(path.join(__dirname, '..', '..', 'models'));
  return dirs.map((dir) => path.resolve(dir));
}

function fileInfo(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return { exists: true, sizeMB: Math.round((stat.size / 1024 / 1024) * 10) / 10 };
  } catch {
    return { exists: false, sizeMB: 0 };
  }
}

/**
 * 解析模型文件位置。
 * @param {string} id 模型 id
 * @param {string} [customPath] 用户自定义的绝对路径（可选，任意 GGUF 都行）
 * @param {'translate'|'chat'} [kind]
 */
function resolveModel(id, customPath, kind) {
  const model = findModel(id, kind);
  const names = [model.fileName, ...(model.altFileNames || [])];

  if (customPath && String(customPath).trim()) {
    const abs = path.resolve(String(customPath).trim());
    const info = fileInfo(abs);
    if (info.exists) return { ...model, path: abs, ...info, source: 'custom' };
    return {
      ...model,
      path: abs,
      exists: false,
      sizeMB: 0,
      source: 'custom',
      hint: '自定义路径下没有找到模型文件',
    };
  }

  const searchDirs = modelDirs();
  for (const dir of searchDirs) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      const info = fileInfo(candidate);
      if (info.exists) return { ...model, path: candidate, ...info, source: dir };
    }
  }

  return {
    ...model,
    path: path.join(searchDirs[0], model.fileName),
    exists: false,
    sizeMB: 0,
    searchedDirs: searchDirs,
  };
}

/**
 * 供设置页展示：每个模型是否就绪
 * @param {string} [customPath]
 * @param {'translate'|'chat'} [kind]
 */
function listModels(customPath, kind = 'translate') {
  const pool = kind === 'chat' ? CHAT_MODELS : TRANSLATE_MODELS;
  return pool.map((model) => resolveModel(model.id, customPath, kind));
}

module.exports = {
  MODELS,
  TRANSLATE_MODELS,
  CHAT_MODELS,
  ALL_MODELS,
  DEFAULT_MODEL_ID,
  DEFAULT_CHAT_MODEL_ID,
  findModel,
  resolveModel,
  listModels,
  modelDirs,
};
