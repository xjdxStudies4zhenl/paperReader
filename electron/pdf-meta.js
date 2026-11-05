'use strict';
/**
 * PDF 元数据解析：标题 / 作者 / 期刊 / DOI / 年份。
 *
 * 顺序：先读 PDF 内置信息字典（Info / XMP，绝大多数正式出版的 PDF 都有），
 * 读不到再退回文件名启发式。解析结果会做清洗，避免把 "Microsoft Word - 草稿.docx"
 * 这类噪声当成作者或标题写进库。
 */
const path = require('node:path');
const { PDFDocument } = require('pdf-lib');

const MAX = { title: 512, authors: 512, journal: 256, doi: 191 };

/** 统一清洗：去控制字符、压缩空白、去首尾引号 */
function cleanText(value, limit = 0) {
  if (value === null || value === undefined) return '';
  let text = String(value)
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  text = text.replace(/^["'“”‘’《]+|["'“”‘’》]+$/g, '').trim();
  if (limit && text.length > limit) text = text.slice(0, limit).trim();
  return text;
}

/** 作者字段常见垃圾值过滤 */
function normalizeAuthors(value) {
  const text = cleanText(value, MAX.authors);
  if (!text || text.length < 2) return '';
  if (/^(unknown|anonymous|author|authors|untitled|n\/?a|none|admin|user|administrator|作者)$/i.test(text)) return '';
  if (/^[0-9a-f]{8,}$/i.test(text)) return '';
  if (/@/.test(text) && !/\s/.test(text)) return '';
  if (/\.(docx?|pdf|tex|indd|dvi)$/i.test(text)) return '';
  if (!/[A-Za-z\u4e00-\u9fa5]/.test(text)) return '';
  return text;
}

/** 标题是否是文件名 / 哈希之类的无意义值 */
function looksLikeFileNameTitle(title, fileName = '') {
  const text = cleanText(title).toLowerCase();
  if (!text) return true;
  const stem = cleanText(path.basename(String(fileName || ''), path.extname(String(fileName || '')))).toLowerCase();
  if (stem && text === stem) return true;
  if (/^[0-9a-f]{8,}$/.test(text)) return true;
  if (/\.(pdf|docx?|tex|indd)$/.test(text)) return true;
  if (text.length < 6) return true;
  return false;
}

/** 从任意文本里捞 DOI */
function extractDoi(...sources) {
  for (const source of sources) {
    const text = cleanText(source);
    const match = text.match(/10\.\d{4,9}\/[^\s,;]+/);
    if (match) return cleanText(match[0].replace(/[.。]+$/, ''), MAX.doi);
  }
  return '';
}

/** 从 Subject 字段里还原期刊名，如 "SoftwareX, 32 (2025) 102444. doi:10.1016" → SoftwareX */
function extractJournal(subject) {
  let text = cleanText(subject, MAX.journal * 2);
  if (!text) return '';
  if (/^10\.\d{4,9}\//.test(text)) return '';
  if (/^https?:/i.test(text)) return '';
  text = text
    .replace(/doi\s*:.*$/i, '')
    .replace(/[,;]?\s*\d+\s*\(\d{4}\)[\s\S]*$/, '')
    .replace(/[,;]?\s*(19|20)\d{2}\s*$/, '')
    .replace(/[.,;:]+$/, '')
    .trim();
  if (text.length < 3 || text.length > 120) return '';
  if (!/[A-Za-z\u4e00-\u9fa5]/.test(text)) return '';
  return text;
}

function yearOf(date) {
  if (!date) return null;
  const year = date instanceof Date ? date.getUTCFullYear() : Number.NaN;
  return Number.isFinite(year) && year >= 1900 && year <= 2100 ? year : null;
}

/* ------------------------- 文件名启发式（兜底用） ------------------------- */

function looksLikePersonName(text) {
  const value = String(text || '').trim();
  if (value.length < 2 || value.length > 60) return false;
  if (/\d/.test(value)) return false;
  if (!/^[A-Z\u4e00-\u9fa5]/.test(value)) return false;
  const words = value.split(/\s+/);
  if (words.length > 4) return false;
  return words.every((word) => /^[A-Z\u4e00-\u9fa5][\w.'’\-]*$/.test(word));
}

/** 判断某个片段像不像“作者串”：保守策略，宁可漏判也不要把标题当作者 */
function looksLikeAuthors(text) {
  const value = String(text || '').trim();
  if (!value || value.length > 160) return false;
  if (/et\s+al\.?/i.test(value)) return true;
  const persons = value.split(/\s*(?:,|;|&|\band\b)\s*/).filter(Boolean);
  if (persons.length >= 2 && persons.every(looksLikePersonName)) return true;
  // "J. Smith" / "张 三" 这类带首字母缩写的单人
  if (/^[A-Z]\.\s?([A-Z]\.\s?)*[A-Z][\w'’\-]+$/.test(value)) return true;
  return false;
}

function guessFromFileName(fileName) {
  const base = path.basename(String(fileName || ''));
  const stem = path.basename(base, path.extname(base));
  let text = stem.replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();

  const yearMatch = text.match(/(19|20)\d{2}/);
  const year = yearMatch ? Number(yearMatch[0]) : null;

  text = text
    .replace(/^\s*\d{4}\.\d{4,5}(v\d+)?\s*[-–—]?\s*/, '') // arXiv 编号前缀
    .replace(/^\s*\d{1,4}[.\-—–\s]+/, '') // 下载工具加的序号
    .replace(/\((19|20)\d{2}\)/g, '')
    .replace(/\[(19|20)\d{2}\]/g, '')
    .trim();

  const parts = text
    .split(/\s+[-–—]\s+|\s*\|\s*/)
    .map((part) => part.trim())
    .filter(Boolean);

  let authors = '';
  let title = '';
  if (parts.length >= 2) {
    const authorIdx = parts.findIndex((part) => looksLikeAuthors(part));
    if (authorIdx >= 0) {
      authors = parts[authorIdx];
      title = parts
        .filter((_, idx) => idx !== authorIdx)
        .sort((a, b) => b.length - a.length)[0] || '';
    } else {
      // 没有识别出作者片段时，把整段当作标题，避免“主标题 - 副标题”被截断
      title = text;
    }
  } else {
    title = parts[0] || text;
  }

  // 哈希文件名（文库内部命名）没有语义，不作为标题
  if (/^[0-9a-f]{8,}$/i.test(title)) title = '';

  return {
    title: cleanText(title, MAX.title),
    authors: normalizeAuthors(authors),
    year,
  };
}

/* ------------------------------- 对外入口 ------------------------------- */

/**
 * 解析 PDF 元数据。
 * @param {Buffer} buf PDF 字节
 * @param {string} fileName 原始文件名（用于兜底与噪声判断）
 * @returns {{title:string, authors:string, journal:string, doi:string, year:number|null, pages:number|null, fromPdf:boolean}}
 */
async function extractPdfMeta(buf, fileName = '') {
  const result = { title: '', authors: '', journal: '', doi: '', year: null, pages: null, fromPdf: false };

  let doc = null;
  try {
    doc = await PDFDocument.load(buf, {
      ignoreEncryption: true,
      updateMetadata: false,
      throwOnInvalidObject: false,
      capNumbers: true,
    });
  } catch {
    doc = null;
  }

  if (doc) {
    const rawTitle = cleanText(doc.getTitle(), MAX.title);
    if (!looksLikeFileNameTitle(rawTitle, fileName)) result.title = rawTitle;
    result.authors = normalizeAuthors(doc.getAuthor());
    const subject = cleanText(doc.getSubject());
    result.journal = extractJournal(subject);
    result.doi = extractDoi(subject, doc.getKeywords(), doc.getTitle());
    result.year = yearOf(doc.getCreationDate()) || yearOf(doc.getModificationDate());
    try {
      result.pages = doc.getPageCount() || null;
    } catch {
      result.pages = null;
    }
    result.fromPdf = Boolean(result.title || result.authors || result.journal || result.doi || result.year);
  }

  // 文件名兜底：只填空缺，不覆盖 PDF 里的值
  const guessed = guessFromFileName(fileName);
  if (!result.title || looksLikeFileNameTitle(result.title, fileName)) {
    if (guessed.title) result.title = guessed.title;
  }
  if (!result.authors && guessed.authors) result.authors = guessed.authors;
  if (!result.year && guessed.year) result.year = guessed.year;

  return result;
}

module.exports = { extractPdfMeta, guessFromFileName, normalizeAuthors, extractJournal, extractDoi, cleanText };
