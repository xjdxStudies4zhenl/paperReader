/**
 * 打包入口：默认走国内镜像（npmmirror），无需每次手动 export 环境变量。
 *
 *   node scripts/dist.mjs --win --x64 --publish never
 *   node scripts/dist.mjs --dir                       # 只出 win-unpacked，验证用
 *
 * 说明：
 * - ELECTRON_MIRROR 给 @electron/get 用（下 electron-v<ver>-win32-x64.zip）；
 *   npmmirror 的目录就是 <mirror>/<version>/<file>，与 @electron/get 默认 customDir 一致，无需额外配置。
 * - ELECTRON_BUILDER_BINARIES_MIRROR 给 electron-builder 自己用（nsis / winCodeSign 等）。
 * - 已经手动设置过同名环境变量的，脚本不会覆盖，方便临时切回官方源排查。
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

const MIRRORS = {
  ELECTRON_MIRROR: 'https://npmmirror.com/mirrors/electron/',
  ELECTRON_BUILDER_BINARIES_MIRROR: 'https://npmmirror.com/mirrors/electron-builder-binaries/',
};

for (const [key, value] of Object.entries(MIRRORS)) {
  if (!process.env[key]) {
    process.env[key] = value;
  }
}

const args = process.argv.slice(2);
const cli = path.join(process.cwd(), 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js');

console.log('[dist] 使用镜像：');
for (const [key, value] of Object.entries(MIRRORS)) {
  console.log(`         ${key} = ${process.env[key]}${process.env[key] === value ? '' : '（来自环境变量覆盖）'}`);
}
console.log(`[dist] electron-builder ${args.join(' ') || '(默认目标)'}`);

const child = spawn(process.execPath, [cli, ...args], {
  stdio: 'inherit',
  env: process.env,
  cwd: process.cwd(),
});

child.on('exit', (code, signal) => {
  if (signal) {
    console.error(`[dist] 被信号 ${signal} 终止`);
    process.exit(1);
  }
  process.exit(code ?? 1);
});
