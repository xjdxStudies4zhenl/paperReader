'use strict';
/**
 * 文献相关 IPC：列表、导入、元数据、缩略图、阅读进度、文件字节流。
 */
const { ipcMain, dialog, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const db = require('../db');
const { libraryDir, ensureDir } = require('../config');
const { absPath, docFilePath, folderDirName, relocateDoc, uniqueRelPath } = require('../library');
const { extractPdfMeta } = require('../pdf-meta');
const { findDoiInPdf } = require('../pdf-text');
const { fetchDoiMeta, normalizeDoi, looksLikeDoi } = require('../openalex');

function ticket(handler) {
  return async (_event, ...args) => {
    try {
      return { ok: true, data: await handler(...args) };
    } catch (err) {
      console.error('[ipc]', err);
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  };
}

const SORT_MAP = {
  recent: 'd.last_read_at IS NULL, d.last_read_at DESC, d.id DESC',
  created: 'd.created_at DESC',
  title: 'd.title ASC',
  starred: 'd.star DESC, d.created_at DESC',
};

async function attachTags(rows) {
  if (!rows.length) return rows;
  const ids = rows.map((r) => r.id);
  const placeholders = ids.map(() => '?').join(',');
  const tagRows = await db.query(
    `SELECT rd.doc_id, t.id, t.name, t.color
       FROM pr_doc_tag_rd rd JOIN pr_tag_info t ON t.id = rd.tag_id
      WHERE rd.doc_id IN (${placeholders})`,
    ids
  );
  const map = new Map();
  for (const t of tagRows) {
    if (!map.has(t.doc_id)) map.set(t.doc_id, []);
    map.get(t.doc_id).push({ id: t.id, name: t.name, color: t.color });
  }
  return rows.map((r) => ({ ...r, tags: map.get(r.id) || [] }));
}

async function listDocs(filter = {}) {
  const where = ['d.is_deleted = 0'];
  const params = [];

  if (filter.folderId === 'none') {
    where.push('d.folder_id IS NULL');
  } else if (filter.folderId) {
    where.push('d.folder_id = ?');
    params.push(filter.folderId);
  }
  if (filter.tagId) {
    where.push('EXISTS (SELECT 1 FROM pr_doc_tag_rd rd WHERE rd.doc_id = d.id AND rd.tag_id = ?)');
    params.push(filter.tagId);
  }
  if (filter.starOnly) where.push('d.star > 0');
  if (filter.recent) where.push('d.last_read_at IS NOT NULL');
  if (filter.hasAnno) where.push('d.anno_count > 0');
  if (filter.keyword) {
    where.push('(d.title LIKE ? OR d.authors LIKE ? OR d.abstract LIKE ? OR d.journal LIKE ? OR d.doi LIKE ?)');
    const kw = `%${filter.keyword}%`;
    params.push(kw, kw, kw, kw, kw);
  }

  const order = SORT_MAP[filter.sort] || SORT_MAP.recent;
  const rows = await db.query(
    `SELECT d.id, d.title, d.authors, d.year, d.journal, d.doi, d.abstract,
            d.file_name, d.stored_path, d.orig_name, d.file_size, d.page_count, d.folder_id, d.star, d.last_page,
            d.last_read_at, d.read_seconds, d.anno_count, d.created_at, d.updated_at,
            (d.thumb_data IS NOT NULL) AS has_thumb,
            f.name AS folder_name
       FROM pr_doc_info d
       LEFT JOIN pr_folder_info f ON f.id = d.folder_id
      WHERE ${where.join(' AND ')}
      ORDER BY ${order}
      LIMIT 800`,
    params
  );
  return attachTags(rows);
}

async function getDoc(id) {
  const row = await db.queryOne(
    `SELECT d.*, (d.thumb_data IS NOT NULL) AS has_thumb, f.name AS folder_name
       FROM pr_doc_info d LEFT JOIN pr_folder_info f ON f.id = d.folder_id
      WHERE d.id = ? AND d.is_deleted = 0`,
    [id]
  );
  if (!row) throw new Error('文献不存在或已被删除');
  delete row.thumb_data;
  const tags = await db.query(
    `SELECT t.id, t.name, t.color FROM pr_doc_tag_rd rd JOIN pr_tag_info t ON t.id = rd.tag_id WHERE rd.doc_id = ?`,
    [id]
  );
  return { ...row, tags };
}

/** 猜测标题与年份：去除常见的前缀序号、arXiv 编号，提取 19xx/20xx */
function guessMeta(baseName) {
  let title = baseName.replace(/[_]+/g, ' ').trim();
  const yearMatch = title.match(/(19|20)\d{2}/);
  const year = yearMatch ? Number(yearMatch[0]) : null;
  title = title
    .replace(/^\s*\d{1,4}[.\-_\s]+/, '')
    .replace(/\.(pdf)$/i, '')
    .trim();
  return { title: title || baseName, year };
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * 把前端传来的分类 id 归一化成可写库的值：
 * 非数字（包括 'none'、空值）= 未分类；数字但已不存在也回落为未分类。
 */
async function resolveFolderId(folderId) {
  const id = Number(folderId);
  if (!Number.isFinite(id) || id <= 0) return null;
  const row = await db.queryOne('SELECT id FROM pr_folder_info WHERE id = ?', [id]);
  return row ? Number(row.id) : null;
}

/** 导入单个文件，返回插入结果 */
/* ------------------------- 网络元数据（OpenAlex / Crossref） ------------------------- */

const WEB_FIELDS = ['title', 'authors', 'year', 'journal', 'abstract'];

function isEmptyValue(value) {
  return value === null || value === undefined || String(value).trim() === '';
}

/**
 * 把网络元数据合入本地 meta：
 * - 空字段直接补
 * - 文件名"猜"出来的标题 / 年份允许被权威数据替换（guess 只是兜底）
 * - PDF 内置解析出的字段不覆盖
 */
function applyWebMeta(meta, web) {
  const out = { ...meta };
  if (!web) return out;
  for (const field of ['authors', 'journal', 'abstract']) {
    if (isEmptyValue(out[field]) && !isEmptyValue(web[field])) out[field] = web[field];
  }
  if (isEmptyValue(out.doi) && !isEmptyValue(web.doi)) out.doi = web.doi;
  if (!isEmptyValue(web.title) && (isEmptyValue(out.title) || out.titleGuessed)) out.title = web.title;
  if (web.year && (!out.year || out.yearGuessed)) out.year = Number(web.year) || out.year;
  if (!isEmptyValue(web.source)) out.metaSource = web.source;
  return out;
}

/** 有 DOI 就查网络（静默失败，不影响主流程） */
async function fetchWebMeta(doi, timeoutMs = 6000) {
  if (!looksLikeDoi(doi)) return null;
  try {
    return await fetchDoiMeta(doi, { timeoutMs });
  } catch {
    return null;
  }
}

async function importOne(srcPath, folderId = null) {
  const buf = await fs.promises.readFile(srcPath);
  const hash = sha256(buf);
  const exists = await db.queryOne('SELECT id, title, authors, is_deleted FROM pr_doc_info WHERE file_hash = ?', [hash]);

  const originalName = path.basename(srcPath);
  const baseName = path.basename(srcPath, path.extname(srcPath));
  // PDF 内置元数据（标题/作者/期刊/DOI）优先，文件名只作兜底
  const extracted = await extractPdfMeta(buf, originalName);
  // 元数据里通常没有 DOI（多数论文把 DOI 印在首页正文），补一次正文扫描
  if (!extracted.doi) {
    try {
      const doiFromText = await findDoiInPdf(buf, 2);
      if (doiFromText) extracted.doi = doiFromText;
    } catch {
      /* 扫描版/加密 PDF 忽略 */
    }
  }
  const guessed = guessMeta(baseName);

  if (exists && !exists.is_deleted) {
    return { status: 'skipped', reason: '文库中已存在同一份文件', id: exists.id, title: exists.title };
  }

  // 保留原始文件名，按分类目录归档：<库根>/<分类名>/<原文件名>.pdf
  const dirName = await folderDirName(folderId);
  const relPath = await uniqueRelPath(dirName, originalName);
  const fileName = path.basename(relPath);
  const target = absPath(relPath);
  ensureDir(path.dirname(target));
  await fs.promises.writeFile(target, buf);

  // 之前删过同一份文件：恢复记录而不是拒绝导入（否则用户会以为“导入没反应”）
  if (exists && exists.is_deleted) {
    const current = await db.queryOne('SELECT * FROM pr_doc_info WHERE id = ?', [exists.id]);
    const patch = {
      is_deleted: 0,
      file_name: fileName,
      stored_path: relPath,
      orig_name: originalName,
      file_size: buf.length,
      folder_id: folderId === null || folderId === undefined ? current.folder_id : folderId,
    };
    if (isPlaceholderTitle(current.title) && (extracted.title || guessed.title)) patch.title = extracted.title || guessed.title;
    if (!current.authors && extracted.authors) patch.authors = extracted.authors;
    if (!current.year && (guessed.year || extracted.year)) patch.year = guessed.year || extracted.year;
    if (!current.journal && extracted.journal) patch.journal = extracted.journal;
    if (!current.doi && extracted.doi) patch.doi = extracted.doi;
    if (!Number(current.page_count) && extracted.pages) patch.page_count = extracted.pages;

    // 有 DOI 就从 OpenAlex/Crossref 顺手补全发行信息（只补空缺，失败不影响导入）
    const web = await fetchWebMeta(patch.doi || current.doi || extracted.doi);
    if (web) {
      for (const field of WEB_FIELDS) {
        if (patch[field] !== undefined) continue;
        const blank = isEmptyValue(current[field]) || (field === 'title' && isPlaceholderTitle(current.title));
        if (blank && !isEmptyValue(web[field])) patch[field] = web[field];
      }
    }

    const fields = Object.keys(patch);
    await db.execute(
      `UPDATE pr_doc_info SET ${fields.map((f) => `${f} = ?`).join(', ')} WHERE id = ?`,
      [...fields.map((f) => patch[f]), exists.id]
    );
    return {
      status: 'imported',
      restored: true,
      id: exists.id,
      title: patch.title || current.title,
      authors: patch.authors || current.authors,
      fileName,
      folderId: patch.folder_id ?? null,
    };
  }

  const meta = {
    title: extracted.title || guessed.title,
    // 标题/年份是否只是文件名猜出来的（网络有权威数据时允许替换）
    titleGuessed: !extracted.title,
    authors: extracted.authors || null,
    // 文件名里的年份通常是发表年，比 PDF 创建时间更可信
    year: guessed.year || extracted.year || null,
    yearGuessed: Boolean(guessed.year) && !extracted.year,
    journal: extracted.journal || null,
    doi: extracted.doi || null,
    abstract: '',
    metaSource: '',
  };
  // 有 DOI 就从 OpenAlex/Crossref 补全发行信息（失败不影响导入）
  const web = await fetchWebMeta(meta.doi);
  const finalMeta = applyWebMeta(meta, web);
  const result = await db.execute(
    `INSERT INTO pr_doc_info
       (title, authors, year, journal, doi, abstract, file_name, stored_path, orig_name, file_hash, file_size, folder_id, page_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      finalMeta.title,
      finalMeta.authors,
      finalMeta.year,
      finalMeta.journal,
      finalMeta.doi,
      finalMeta.abstract || null,
      fileName,
      relPath,
      originalName,
      hash,
      buf.length,
      folderId || null,
      extracted.pages || 0,
    ]
  );
  return {
    status: 'imported',
    id: result.insertId,
    title: finalMeta.title,
    authors: finalMeta.authors,
    fileName,
    storedPath: relPath,
    folderId: folderId || null,
    metaSource: finalMeta.metaSource || '',
  };
}

/* ------------------------- 元数据补全（作者/标题等） ------------------------- */

const META_FIELDS = ['title', 'authors', 'year', 'journal', 'doi'];

/** 库里是否是“文件名/哈希”这类占位标题 */
function isPlaceholderTitle(value) {
  const text = String(value || '').trim();
  if (!text) return true;
  if (/^[0-9a-f]{8,}$/i.test(text)) return true;
  return /\.(pdf|docx?|tex)$/i.test(text);
}

/**
 * 重新解析某篇文献的元数据。
 * 默认只补空字段（含占位标题），overwrite=true 时才整体覆盖。
 */
async function reparseDocMeta(id, options = {}) {
  const overwrite = Boolean(options && options.overwrite);
  const row = await db.queryOne('SELECT * FROM pr_doc_info WHERE id = ? AND is_deleted = 0', [id]);
  if (!row) throw new Error('文献不存在或已被删除');

  const filePath = docFilePath(row);
  const buf = await fs.promises.readFile(filePath);
  const extracted = await extractPdfMeta(buf, row.file_name);
  // 元数据里没有 DOI 时，从正文首页再找一次
  if (!extracted.doi) {
    try {
      const doiFromText = await findDoiInPdf(buf, 2);
      if (doiFromText) extracted.doi = doiFromText;
    } catch {
      /* 忽略 */
    }
  }

  // PDF 解析出 DOI 后顺手从 OpenAlex/Crossref 补全缺字段（网络失败不影响 PDF 解析结果）
  const merged = applyWebMeta(
    {
      title: extracted.title || '',
      authors: extracted.authors || '',
      year: extracted.year || null,
      journal: extracted.journal || '',
      doi: extracted.doi || row.doi || '',
      abstract: '',
    },
    await fetchWebMeta(extracted.doi || row.doi)
  );

  const patch = {};
  for (const field of META_FIELDS) {
    const next = merged[field];
    if (next === null || next === undefined || next === '') continue;
    const current = row[field];
    const isEmpty = current === null || current === undefined || String(current).trim() === '';
    const isPlaceholder = field === 'title' && isPlaceholderTitle(current);
    if (overwrite || isEmpty || isPlaceholder) patch[field] = next;
  }
  if (merged.abstract && (overwrite || isEmptyValue(row.abstract))) patch.abstract = merged.abstract;
  if (extracted.pages && (overwrite || !Number(row.page_count))) patch.page_count = extracted.pages;

  const changed = Object.keys(patch);
  if (!changed.length) return { doc: await getDoc(id), changed: [] };

  const assignments = changed.map((field) => `${field} = ?`).join(', ');
  await db.execute(`UPDATE pr_doc_info SET ${assignments} WHERE id = ?`, [...changed.map((f) => patch[f]), id]);
  return { doc: await getDoc(id), changed };
}

/**
 * 智能 DOI 补全（只查不写）：
 * 1. PDF 内置元数据（标题/作者/期刊/DOI）
 * 2. 元数据没 DOI 就从正文首页找
 * 3. 按 DOI 从 OpenAlex / Crossref 抓发行信息（标题/作者/期刊/年份/摘要）
 * 返回合并后的候选字段，由详情页比对确认后再写库。
 */
async function smartFill(id) {
  const row = await db.queryOne('SELECT * FROM pr_doc_info WHERE id = ? AND is_deleted = 0', [id]);
  if (!row) throw new Error('文献不存在或已被删除');

  const buf = await fs.promises.readFile(docFilePath(row));
  const pdfMeta = await extractPdfMeta(buf, row.file_name);

  // DOI 优先级：库里已有 → PDF 元数据 → PDF 正文
  let doi = normalizeDoi(row.doi);
  let doiSource = doi ? 'db' : '';
  if (!looksLikeDoi(doi)) {
    const fromMeta = normalizeDoi(pdfMeta.doi);
    if (looksLikeDoi(fromMeta)) {
      doi = fromMeta;
      doiSource = 'pdf-meta';
    }
  }
  if (!looksLikeDoi(doi)) {
    let fromText = '';
    try {
      fromText = normalizeDoi(await findDoiInPdf(buf, 2));
    } catch {
      fromText = '';
    }
    if (looksLikeDoi(fromText)) {
      doi = fromText;
      doiSource = 'pdf-text';
    }
  }

  let web = null;
  if (looksLikeDoi(doi)) {
    try {
      web = await fetchDoiMeta(doi, { timeoutMs: 12000 });
    } catch {
      web = null;
    }
  }

  // 网络数据优先（权威），PDF 元数据补空缺
  const meta = {
    title: (web && web.title) || pdfMeta.title || '',
    authors: (web && web.authors) || pdfMeta.authors || '',
    year: (web && web.year) || pdfMeta.year || null,
    journal: (web && web.journal) || pdfMeta.journal || '',
    doi: (web && web.doi) || doi || '',
    abstract: (web && web.abstract) || '',
  };

  return {
    doi: meta.doi,
    doiSource,
    foundDoi: Boolean(looksLikeDoi(doi)),
    hasWeb: Boolean(web),
    source: web ? web.source : 'pdf',
    meta,
  };
}

/** 批量补全：只处理缺作者 / 标题是占位值的文献，一次最多 limit 篇 */
async function backfillDocMeta(limit = 50) {
  const max = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const rows = await db.query(
    `SELECT id FROM pr_doc_info
      WHERE is_deleted = 0
        AND (authors IS NULL OR authors = ''
             OR title IS NULL OR title = '' OR title REGEXP '^[0-9a-f]{8,}$')
      ORDER BY id ASC
      LIMIT ?`,
    [max]
  );
  const updated = [];
  for (const row of rows) {
    try {
      const res = await reparseDocMeta(row.id);
      if (res.changed.length) updated.push({ id: row.id, changed: res.changed });
    } catch (err) {
      console.warn('[meta] 补全失败', row.id, err && err.message);
    }
    // 让出事件循环，避免大批量解析时界面卡顿
    await new Promise((resolve) => setImmediate(resolve));
  }
  return { scanned: rows.length, updated: updated.length, details: updated };
}

async function importFromDialog(ctx, folderId = null) {
  const targetFolder = await resolveFolderId(folderId);
  const win = ctx.getWindow();
  const res = await dialog.showOpenDialog(win, {
    title: '选择要导入的 PDF 文献',
    filters: [{ name: 'PDF 文献', extensions: ['pdf'] }],
    properties: ['openFile', 'multiSelections'],
  });
  if (res.canceled || !res.filePaths.length) return { imported: [], skipped: [], folderId: targetFolder };
  return importFromPaths(res.filePaths, targetFolder);
}

async function importFromPaths(paths = [], folderId = null) {
  const targetFolder = await resolveFolderId(folderId);
  const imported = [];
  const skipped = [];
  for (const p of paths) {
    try {
      if (!/\.pdf$/i.test(p)) {
        skipped.push({ path: p, reason: '仅支持 PDF 文件' });
        continue;
      }
      const r = await importOne(p, targetFolder);
      if (r.status === 'imported') imported.push(r);
      else skipped.push({ path: p, reason: r.reason, id: r.id });
    } catch (err) {
      skipped.push({ path: p, reason: err.message });
    }
  }
  return { imported, skipped, folderId: targetFolder };
}

async function updateDoc(id, patch = {}) {
  const fields = [];
  const params = [];
  const allow = ['title', 'authors', 'year', 'journal', 'doi', 'abstract', 'folder_id', 'star', 'page_count'];
  for (const key of allow) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) {
      fields.push(`${key} = ?`);
      params.push(patch[key] === '' ? null : patch[key]);
    }
  }
  if (!fields.length) return getDoc(id);

  const before = await db.queryOne(
    'SELECT id, title, file_name, stored_path, orig_name, folder_id FROM pr_doc_info WHERE id = ?',
    [id]
  );
  params.push(id);
  await db.execute(`UPDATE pr_doc_info SET ${fields.join(', ')} WHERE id = ?`, params);

  // 换了分类就把文件搬到对应目录（拖拽改分组、详情弹窗改分类都会走这里）
  if (before && Object.prototype.hasOwnProperty.call(patch, 'folder_id')) {
    const nextFolderId = patch.folder_id === '' ? null : patch.folder_id;
    if (String(before.folder_id || '') !== String(nextFolderId || '')) {
      try {
        await relocateDoc(before, nextFolderId);
      } catch (err) {
        console.warn('[docs] 迁移文件失败：', id, err && err.message);
      }
    }
  }
  return getDoc(id);
}

async function removeDoc(id) {
  const row = await db.queryOne('SELECT file_name, stored_path FROM pr_doc_info WHERE id = ?', [id]);
  const result = await db.execute('UPDATE pr_doc_info SET is_deleted = 1 WHERE id = ?', [id]);
  if (row) {
    try {
      await fs.promises.unlink(docFilePath(row)).catch(() => {});
    } catch (err) {
      console.warn('[docs] 删除文件失败：', id, err && err.message);
    }
  }
  return { affected: result.affectedRows };
}

async function readFileBytes(id) {
  const row = await db.queryOne(
    'SELECT file_name, stored_path FROM pr_doc_info WHERE id = ? AND is_deleted = 0',
    [id]
  );
  if (!row) throw new Error('文献不存在');
  const buf = await fs.promises.readFile(docFilePath(row));
  return buf;
}

async function getThumb(id) {
  const row = await db.queryOne('SELECT thumb_data FROM pr_doc_info WHERE id = ?', [id]);
  if (!row || !row.thumb_data) return null;
  const b64 = Buffer.isBuffer(row.thumb_data) ? row.thumb_data.toString('base64') : String(row.thumb_data);
  return `data:image/jpeg;base64,${b64}`;
}

async function saveThumb(id, dataUrl, pageCount) {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) {
    throw new Error('缩略图数据格式不正确');
  }
  const b64 = dataUrl.split(',')[1] || '';
  const buf = Buffer.from(b64, 'base64');
  if (pageCount) {
    await db.execute('UPDATE pr_doc_info SET thumb_data = ?, page_count = ? WHERE id = ?', [buf, pageCount, id]);
  } else {
    await db.execute('UPDATE pr_doc_info SET thumb_data = ? WHERE id = ?', [buf, id]);
  }
  return { size: buf.length };
}

async function saveProgress(id, page, seconds = 0) {
  await db.execute(
    `UPDATE pr_doc_info
        SET last_page = ?, last_read_at = NOW(), read_seconds = read_seconds + ?
      WHERE id = ?`,
    [Math.max(1, Number(page) || 1), Math.max(0, Number(seconds) || 0), id]
  );
  return { ok: true };
}

async function openReadSession(id, page) {
  const result = await db.execute(
    'INSERT INTO pr_read_rd (doc_id, start_page, end_page) VALUES (?, ?, ?)',
    [id, Math.max(1, Number(page) || 1), Math.max(1, Number(page) || 1)]
  );
  return { sessionId: result.insertId };
}

async function closeReadSession(sessionId, endPage, durationSec) {
  await db.execute(
    'UPDATE pr_read_rd SET end_page = ?, duration_sec = ?, closed_at = NOW() WHERE id = ?',
    [Math.max(1, Number(endPage) || 1), Math.max(0, Number(durationSec) || 0), sessionId]
  );
  return { ok: true };
}

async function recentReadStats(id) {
  const rows = await db.query(
    `SELECT id, start_page, end_page, duration_sec, opened_at, closed_at
       FROM pr_read_rd WHERE doc_id = ? ORDER BY opened_at DESC LIMIT 20`,
    [id]
  );
  const total = await db.queryOne(
    'SELECT COUNT(*) AS sessions, COALESCE(SUM(duration_sec),0) AS seconds FROM pr_read_rd WHERE doc_id = ?',
    [id]
  );
  return { rows, summary: { sessions: Number(total.sessions), seconds: Number(total.seconds) } };
}

async function revealDoc(id) {
  const row = await db.queryOne('SELECT file_name, stored_path FROM pr_doc_info WHERE id = ?', [id]);
  if (!row) throw new Error('文献不存在');
  shell.showItemInFolder(docFilePath(row));
  return { ok: true };
}

function registerDocHandlers(ctx) {
  ipcMain.handle('doc:list', ticket((filter) => listDocs(filter)));
  ipcMain.handle('doc:get', ticket((id) => getDoc(id)));
  ipcMain.handle('doc:import', ticket((folderId) => importFromDialog(ctx, folderId)));
  ipcMain.handle('doc:import-paths', ticket((paths, folderId) => importFromPaths(paths, folderId)));
  ipcMain.handle('doc:update', ticket((id, patch) => updateDoc(id, patch)));
  ipcMain.handle('doc:reparse', ticket((id, options) => reparseDocMeta(id, options)));
  ipcMain.handle('doc:smart-fill', ticket((id) => smartFill(id)));
  ipcMain.handle('doc:backfill', ticket((limit) => backfillDocMeta(limit)));
  ipcMain.handle('doc:remove', ticket((id) => removeDoc(id)));
  ipcMain.handle('doc:file', ticket((id) => readFileBytes(id)));
  ipcMain.handle('doc:thumb', ticket((id) => getThumb(id)));
  ipcMain.handle('doc:save-thumb', ticket((id, dataUrl, pageCount) => saveThumb(id, dataUrl, pageCount)));
  ipcMain.handle('doc:progress', ticket((id, page, seconds) => saveProgress(id, page, seconds)));
  ipcMain.handle('read:open', ticket((id, page) => openReadSession(id, page)));
  ipcMain.handle('read:close', ticket((id, endPage, dur) => closeReadSession(id, endPage, dur)));
  ipcMain.handle('read:stats', ticket((id) => recentReadStats(id)));
  ipcMain.handle('doc:reveal', ticket((id) => revealDoc(id)));
}

module.exports = {
  registerDocHandlers,
  listDocs,
  getDoc,
  reparseDocMeta,
  backfillDocMeta,
  importFromPaths,
};
