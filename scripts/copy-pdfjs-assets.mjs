/**
 * 把 pdfjs-dist 的 cmaps / standard_fonts 复制到 public/pdfjs/，
 * 否则中文、日文等需要 CMap 的 PDF 会渲染缺字。
 * 在 postinstall 与 prebuild 阶段执行。
 */
import { cp, mkdir, access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const src = join(root, 'node_modules', 'pdfjs-dist');
const dest = join(root, 'public', 'pdfjs');

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  if (!(await exists(src))) {
    console.warn('[copy-pdfjs-assets] 未找到 pdfjs-dist，跳过资源复制');
    return;
  }
  await mkdir(dest, { recursive: true });
  for (const dir of ['cmaps', 'standard_fonts']) {
    const from = join(src, dir);
    if (!(await exists(from))) continue;
    await cp(from, join(dest, dir), { recursive: true });
    console.log(`[copy-pdfjs-assets] 已复制 ${dir}`);
  }
}

main().catch((err) => {
  console.error('[copy-pdfjs-assets] 失败：', err);
});
