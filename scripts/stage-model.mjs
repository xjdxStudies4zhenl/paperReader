/**
 * 把已下载到 userData 的模型复制到仓库根 ./models/，
 * 供 electron-builder 的 extraResources 打进安装包。
 *
 * 用法：
 *   npm run model:stage              # 默认 Q4_K_M（翻译）
 *   npm run model:stage -- 1.25bit   # 指定翻译模型
 *   npm run model:stage -- qwen3b    # 指定「AI 理解」模型
 *   npm run model:stage -- --clean   # 清空 ./models 里的 gguf
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const MODELS = {
  // 翻译模型
  q4km: { file: 'Hy-MT2-1.8B-Q4_K_M.gguf', sizeMB: 1081 },
  q6k: { file: 'Hy-MT2-1.8B-Q6_K.gguf', sizeMB: 1406 },
  '1.25bit': { file: 'Hy-MT2-1.8B-1.25bit-v2.gguf', sizeMB: 440 },
  // 「AI 理解」模型（国内开源量化模型）
  'qwen1.5b': { file: 'qwen2.5-1.5b-instruct-q4_k_m.gguf', sizeMB: 1065 },
  qwen3b: { file: 'qwen2.5-3b-instruct-q4_k_m.gguf', sizeMB: 2007 },
  qwen7b: { file: 'Qwen2.5-7B-Instruct-Q4_K_M.gguf', sizeMB: 4466 },
};

function userDataModels() {
  if (process.env.PR_MODEL_DIR) return path.resolve(process.env.PR_MODEL_DIR);
  const appData =
    process.platform === 'win32'
      ? process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
      : process.platform === 'darwin'
        ? path.join(os.homedir(), 'Library', 'Application Support')
        : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(appData, 'paper-reader', 'models');
}

const outDir = path.join(process.cwd(), 'models');
fs.mkdirSync(outDir, { recursive: true });

const args = process.argv.slice(2);
if (args.includes('--clean')) {
  for (const name of fs.readdirSync(outDir)) {
    if (name.toLowerCase().endsWith('.gguf')) {
      fs.rmSync(path.join(outDir, name), { force: true });
      console.log(`[stage] 已删除 models/${name}`);
    }
  }
  process.exit(0);
}

const key = args.find((a) => !a.startsWith('--')) || 'q4km';
const model = MODELS[key];
if (!model) {
  console.error(`[stage] 未知模型 ${key}，可选：${Object.keys(MODELS).join(', ')}`);
  process.exit(1);
}

const from = path.join(userDataModels(), model.file);
if (!fs.existsSync(from)) {
  console.error(`[stage] 没找到 ${from}\n        先跑 npm run model:download -- ${key}`);
  process.exit(1);
}

const to = path.join(outDir, model.file);
const sizeMB = +(fs.statSync(from).size / 1024 / 1024).toFixed(1);
console.log(`[stage] 复制 ${model.file}（${sizeMB}MB）→ models/`);
fs.copyFileSync(from, to);
console.log(`[stage] 完成：${to}\n        接下来执行 npm run dist:win（或 dist:mac / dist:linux）即可把模型打进 resources/models`);
