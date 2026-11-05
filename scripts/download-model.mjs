/**
 * 下载本地模型（GGUF）：翻译模型 + 「AI 理解」用的国内开源量化模型。
 *
 * 用法：
 *   npm run model:download                    # 默认下 Hy-MT2 Q4_K_M（翻译，约 1.08GB）
 *   npm run model:download -- 1.25bit         # 下翻译 1.25bit 极致量化版（约 440MB）
 *   npm run model:download -- qwen3b          # 下 Qwen2.5-3B-Instruct Q4_K_M（AI 理解，约 2.0GB）
 *   npm run model:download:chat               # 下全部「AI 理解」模型
 *   npm run model:download -- --all           # 全部下载
 *   npm run model:download -- --list          # 只看清单
 *
 * 国内网络默认走 hf-mirror.com，失败再试魔搭 ModelScope；
 * 也可用 PR_MODEL_MIRROR 覆盖首个源（如 https://hf-mirror.com 或 https://www.modelscope.cn）。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const MIRROR = process.env.PR_MODEL_MIRROR || 'https://hf-mirror.com';

const MODELS = {
  // —— 翻译（划词翻译用）——
  q4km: {
    family: 'translate',
    repo: 'tencent/Hy-MT2-1.8B-GGUF',
    scope: 'Tencent-Hunyuan/Hy-MT2-1.8B-GGUF',
    file: 'Hy-MT2-1.8B-Q4_K_M.gguf',
    sizeMB: 1081,
  },
  '1.25bit': {
    family: 'translate',
    repo: 'AngelSlim/Hy-MT2-1.8B-1.25Bit-GGUF',
    scope: 'AngelSlim/Hy-MT2-1.8B-1.25Bit-GGUF',
    file: 'Hy-MT2-1.8B-1.25bit-v2.gguf',
    sizeMB: 440,
  },
  q6k: {
    family: 'translate',
    repo: 'tencent/Hy-MT2-1.8B-GGUF',
    scope: 'Tencent-Hunyuan/Hy-MT2-1.8B-GGUF',
    file: 'Hy-MT2-1.8B-Q6_K.gguf',
    sizeMB: 1406,
  },
  // —— AI 理解（本地量化对话模型）——
  'qwen1.5b': {
    family: 'chat',
    repo: 'Qwen/Qwen2.5-1.5B-Instruct-GGUF',
    scope: 'Qwen/Qwen2.5-1.5B-Instruct-GGUF',
    file: 'qwen2.5-1.5b-instruct-q4_k_m.gguf',
    sizeMB: 1065,
  },
  qwen3b: {
    family: 'chat',
    repo: 'Qwen/Qwen2.5-3B-Instruct-GGUF',
    scope: 'Qwen/Qwen2.5-3B-Instruct-GGUF',
    file: 'qwen2.5-3b-instruct-q4_k_m.gguf',
    sizeMB: 2007,
  },
  qwen7b: {
    family: 'chat',
    repo: 'bartowski/Qwen2.5-7B-Instruct-GGUF',
    scope: '',
    file: 'Qwen2.5-7B-Instruct-Q4_K_M.gguf',
    sizeMB: 4466,
  },
};

/** 与主进程 model-registry 保持一致的目录：userData/models */
function targetDir() {
  if (process.env.PR_MODEL_DIR) return path.resolve(process.env.PR_MODEL_DIR);
  const appData =
    process.platform === 'win32'
      ? process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
      : process.platform === 'darwin'
        ? path.join(os.homedir(), 'Library', 'Application Support')
        : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(appData, 'paper-reader', 'models');
}

function list() {
  for (const [key, model] of Object.entries(MODELS)) {
    console.log(`  ${key.padEnd(9)} ${model.family === 'chat' ? '[理解]' : '[翻译]'} ${model.file}  ~${model.sizeMB}MB  (${model.repo})`);
  }
}

/** 依次尝试的下载地址：环境变量镜像 → ModelScope（有 scope 才有）→ 官方镜像 */
function urlsOf(model) {
  const list = [`${MIRROR}/${model.repo}/resolve/main/${model.file}`];
  if (model.scope) list.push(`https://www.modelscope.cn/models/${model.scope}/resolve/master/${model.file}`);
  if (!MIRROR.includes('hf-mirror.com')) list.push(`https://hf-mirror.com/${model.repo}/resolve/main/${model.file}`);
  return list;
}

async function downloadOne(key, model, outFile) {
  let lastError = null;
  for (const url of urlsOf(model)) {
    console.log(`[model] 下载 ${model.file}（约 ${model.sizeMB}MB）\n        ${url}`);
    try {
      const res = await fetch(url, { redirect: 'follow' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const total = Number(res.headers.get('content-length') || 0);
      const tmp = `${outFile}.part`;
      const file = fs.createWriteStream(tmp);
      let received = 0;
      let lastTick = 0;
      for await (const chunk of res.body) {
        received += chunk.length;
        if (!file.write(chunk)) await new Promise((r) => file.once('drain', r));
        const now = Date.now();
        if (now - lastTick > 1000) {
          lastTick = now;
          const pct = total ? ((received / total) * 100).toFixed(1) : '?';
          process.stdout.write(`\r[model] ${(received / 1024 / 1024).toFixed(1)}MB / ${(total / 1024 / 1024).toFixed(1)}MB (${pct}%)`);
        }
      }
      await new Promise((r) => file.end(r));
      process.stdout.write('\n');
      if (received < model.sizeMB * 1024 * 1024 * 0.9) throw new Error(`下载不完整（${(received / 1024 / 1024).toFixed(1)}MB）`);
      fs.renameSync(tmp, outFile);
      console.log(`[model] 完成：${outFile}`);
      return outFile;
    } catch (err) {
      lastError = err;
      console.warn(`[model] 源失败：${err && err.message}`);
    }
  }
  throw lastError || new Error('所有下载源都失败了');
}

async function download(key) {
  const model = MODELS[key];
  if (!model) throw new Error(`未知模型 ${key}，可用：${Object.keys(MODELS).join(', ')}`);
  const dir = targetDir();
  fs.mkdirSync(dir, { recursive: true });
  const outFile = path.join(dir, model.file);
  if (fs.existsSync(outFile) && fs.statSync(outFile).size > model.sizeMB * 1024 * 1024 * 0.9) {
    console.log(`[model] 已存在，跳过：${outFile}`);
    return outFile;
  }
  return downloadOne(key, model, outFile);
}

const args = process.argv.slice(2);
const keys = args.filter((a) => !a.startsWith('--'));
const all = args.includes('--all');
const chatOnly = args.includes('--chat');

if (args.includes('--list') || args.includes('--help')) {
  console.log('[model] 可用模型：');
  list();
} else {
  const targets = all
    ? Object.keys(MODELS)
    : keys.length
      ? keys
      : chatOnly
        ? Object.keys(MODELS).filter((key) => MODELS[key].family === 'chat')
        : ['q4km'];
  for (const key of targets) {
    // 顺序下载，避免并发抢带宽
    // eslint-disable-next-line no-await-in-loop
    await download(key);
  }
  console.log('[model] 全部完成。模型目录：', targetDir());
}
