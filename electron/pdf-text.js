'use strict';
/**
 * 从 PDF 正文里找 DOI。
 *
 * 背景：论文的 DOI 基本都印在首页（如 "https://doi.org/10.1016/j.jcde.2018.04.003"），
 * 但 PDF 的 Info / XMP 元数据里往往没有。所以除了 pdf-lib 读元数据，
 * 还需要用 pdfjs 抽取前几页正文再匹配一次。
 */

let pdfjsPromise = null;

const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

/** 打包后 pdfjs 被解包到 app.asar.unpacked，优先从这里加载（asar 内 ESM 不可靠） */
function unpackedPdfjsPath() {
  const root = path.resolve(__dirname, '..');
  if (!/app\.asar(?=$|[\\/])/.test(root)) return '';
  const unpackedRoot = root.replace(/app\.asar(?=$|[\\/])/, 'app.asar.unpacked');
  return path.join(unpackedRoot, 'node_modules', 'pdfjs-dist', 'legacy', 'build', 'pdf.mjs');
}

/** 懒加载 pdfjs（legacy 构建，Node 环境可用），只加载一次 */
function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      const unpacked = unpackedPdfjsPath();
      if (unpacked && fs.existsSync(unpacked)) {
        try {
          return await import(pathToFileURL(unpacked).href);
        } catch {
          /* 回落到裸模块名 */
        }
      }
      return import('pdfjs-dist/legacy/build/pdf.mjs');
    })().catch((err) => {
      pdfjsPromise = null;
      throw err;
    });
  }
  return pdfjsPromise;
}

/**
 * 抽取前几页正文（纯文本，空格压缩）。
 * @param {Buffer|Uint8Array} buf PDF 字节
 * @param {number} maxPages 最多解析多少页
 */
async function extractPdfText(buf, maxPages = 2) {
  const pdfjs = await loadPdfjs();
  // pdfjs 明确拒绝 Node 的 Buffer，必须传纯 Uint8Array（new Uint8Array 会拷贝一份）
  const data = Buffer.isBuffer(buf) ? new Uint8Array(buf) : buf;
  const task = pdfjs.getDocument({
    data,
    useWorkerFetch: false,
    isEvalSupported: false,
    useSystemFonts: false,
    // 不加载字体/CMap 资源，纯文本抽取用不到
    disableFontFace: true,
  });
  let doc = null;
  try {
    doc = await task.promise;
    const pages = Math.min(Math.max(Number(maxPages) || 2, 1), doc.numPages || 1);
    const parts = [];
    for (let i = 1; i <= pages; i += 1) {
      try {
        const page = await doc.getPage(i);
        const content = await page.getTextContent();
        const text = content.items
          .map((item) => (typeof item.str === 'string' ? item.str : ''))
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim();
        if (text) parts.push(text);
        page.cleanup();
      } catch {
        /* 单页失败跳过 */
      }
    }
    return parts.join(' ');
  } finally {
    try {
      if (doc && doc.cleanup) doc.cleanup();
      await task.destroy();
    } catch {
      /* ignore */
    }
  }
}

/** DOI 结尾常见的标点，需要剥掉 */
function trimDoiTail(value) {
  return String(value || '')
    .replace(/[.,;:!?)\]}>'"]+$/g, '')
    .trim();
}

/**
 * 从文本里找 DOI。
 * 会修补「被换行/空格截断」的情况，如 "10.1016/j.jcde. 2018.04.003"。
 */
function findDoiInText(text) {
  const clean = String(text || '').replace(/\s+/g, ' ');
  if (!clean) return '';
  const re = /10\.\d{4,9}\/[^\s"']+/g;
  const candidates = [];
  let match;
  while ((match = re.exec(clean)) !== null) {
    let cand = match[0];
    // 修补被空格截断的 DOI：断点前是 . - / 且断点后紧跟 DOI 字符时才拼接
    for (let guard = 0; guard < 4; guard += 1) {
      const nextSpace = clean.indexOf(' ', match.index + cand.length);
      if (nextSpace < 0) break;
      const rest = clean.slice(nextSpace + 1).match(/^[^\s"']+/);
      if (!rest) break;
      if (!/[.\-/]$/.test(cand)) break;
      if (!/^[0-9A-Za-z(]/.test(rest[0])) break;
      if (cand.length + rest[0].length > 160) break;
      cand += rest[0];
    }
    cand = trimDoiTail(cand);
    if (/^10\.\d{4,9}\/\S+$/.test(cand) && cand.length <= 160) candidates.push(cand);
  }
  if (!candidates.length) return '';
  // 优先选最长的（通常最完整），并去掉明显的噪声尾巴
  candidates.sort((a, b) => b.length - a.length);
  return candidates[0];
}

/**
 * 直接从一个 PDF 里找 DOI：抽前几页正文 → 匹配。
 * 失败（加密、扫描版、解析异常）返回空串。
 */
async function findDoiInPdf(buf, maxPages = 2) {
  try {
    const text = await extractPdfText(buf, maxPages);
    return findDoiInText(text);
  } catch {
    return '';
  }
}

module.exports = {
  extractPdfText,
  findDoiInText,
  findDoiInPdf,
};
