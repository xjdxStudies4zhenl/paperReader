'use strict';
/**
 * 标注相关 IPC：标注 CRUD、批注回复、书签。
 */
const { ipcMain } = require('electron');
const db = require('../db');

function ticket(handler) {
  return async (_event, ...args) => {
    try {
      return { ok: true, data: await handler(...args) };
    } catch (err) {
      console.error('[ipc:anno]', err);
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  };
}

function parseJson(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function normalizeRow(row) {
  return {
    ...row,
    rects: parseJson(row.rects, []),
    ink_paths: parseJson(row.ink_paths, []),
    opacity: Number(row.opacity),
  };
}

async function listAnnos(docId) {
  const rows = await db.query(
    `SELECT id, doc_id, page_no, anno_type, color, rects, ink_paths, quote, content, opacity, seq_no,
            created_at, updated_at
       FROM pr_anno_info
      WHERE doc_id = ? AND is_deleted = 0
      ORDER BY page_no ASC, id ASC`,
    [docId]
  );
  return rows.map(normalizeRow);
}

async function createAnno(payload = {}) {
  const docId = Number(payload.docId || payload.doc_id);
  if (!docId) throw new Error('缺少文献ID');
  const rects = Array.isArray(payload.rects) ? payload.rects : [];
  const inkPaths = Array.isArray(payload.inkPaths) ? payload.inkPaths : [];
  const result = await db.execute(
    `INSERT INTO pr_anno_info (doc_id, page_no, anno_type, color, rects, ink_paths, quote, content, opacity)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      docId,
      Number(payload.pageNo || payload.page_no) || 1,
      payload.type || payload.anno_type || 'highlight',
      payload.color || '#ffd400',
      rects.length ? JSON.stringify(rects) : null,
      inkPaths.length ? JSON.stringify(inkPaths) : null,
      payload.quote || null,
      payload.content || null,
      Number(payload.opacity) || 0.35,
    ]
  );
  await db.execute('UPDATE pr_doc_info SET anno_count = anno_count + 1 WHERE id = ?', [docId]);
  const row = await db.queryOne('SELECT * FROM pr_anno_info WHERE id = ?', [result.insertId]);
  return normalizeRow(row);
}

async function updateAnno(id, patch = {}) {
  const fields = [];
  const params = [];
  if (patch.content !== undefined) {
    fields.push('content = ?');
    params.push(patch.content || null);
  }
  if (patch.color !== undefined) {
    fields.push('color = ?');
    params.push(patch.color);
  }
  if (patch.opacity !== undefined) {
    fields.push('opacity = ?');
    params.push(Number(patch.opacity) || 0.35);
  }
  if (patch.rects !== undefined) {
    fields.push('rects = ?');
    params.push(patch.rects ? JSON.stringify(patch.rects) : null);
  }
  if (!fields.length) return normalizeRow(await db.queryOne('SELECT * FROM pr_anno_info WHERE id = ?', [id]));
  params.push(id);
  await db.execute(`UPDATE pr_anno_info SET ${fields.join(', ')} WHERE id = ?`, params);
  return normalizeRow(await db.queryOne('SELECT * FROM pr_anno_info WHERE id = ?', [id]));
}

async function removeAnno(id) {
  const row = await db.queryOne('SELECT doc_id FROM pr_anno_info WHERE id = ?', [id]);
  await db.execute('UPDATE pr_anno_info SET is_deleted = 1 WHERE id = ?', [id]);
  if (row) {
    await db.execute(
      'UPDATE pr_doc_info SET anno_count = GREATEST(CAST(anno_count AS SIGNED) - 1, 0) WHERE id = ?',
      [row.doc_id]
    );
  }
  return { ok: true };
}

async function listReplies(annoId) {
  return db.query(
    'SELECT id, anno_id, author, content, created_at FROM pr_anno_reply_rd WHERE anno_id = ? ORDER BY created_at ASC',
    [annoId]
  );
}

async function addReply(annoId, content, author = '我') {
  if (!content || !String(content).trim()) throw new Error('回复内容不能为空');
  const result = await db.execute(
    'INSERT INTO pr_anno_reply_rd (anno_id, author, content) VALUES (?, ?, ?)',
    [annoId, author, String(content).trim()]
  );
  return db.queryOne('SELECT * FROM pr_anno_reply_rd WHERE id = ?', [result.insertId]);
}

async function removeReply(id) {
  await db.execute('DELETE FROM pr_anno_reply_rd WHERE id = ?', [id]);
  return { ok: true };
}

async function listBookmarks(docId) {
  return db.query(
    'SELECT id, doc_id, page_no, label, created_at FROM pr_bookmark_info WHERE doc_id = ? ORDER BY page_no ASC',
    [docId]
  );
}

async function addBookmark(docId, pageNo, label) {
  const result = await db.execute(
    'INSERT INTO pr_bookmark_info (doc_id, page_no, label) VALUES (?, ?, ?)',
    [docId, Number(pageNo) || 1, label || null]
  );
  return db.queryOne('SELECT * FROM pr_bookmark_info WHERE id = ?', [result.insertId]);
}

async function removeBookmark(id) {
  await db.execute('DELETE FROM pr_bookmark_info WHERE id = ?', [id]);
  return { ok: true };
}

function registerAnnoHandlers() {
  ipcMain.handle('anno:list', ticket((docId) => listAnnos(docId)));
  ipcMain.handle('anno:create', ticket((payload) => createAnno(payload)));
  ipcMain.handle('anno:update', ticket((id, patch) => updateAnno(id, patch)));
  ipcMain.handle('anno:remove', ticket((id) => removeAnno(id)));
  ipcMain.handle('anno:reply-list', ticket((annoId) => listReplies(annoId)));
  ipcMain.handle('anno:reply-add', ticket((annoId, content) => addReply(annoId, content)));
  ipcMain.handle('anno:reply-remove', ticket((id) => removeReply(id)));
  ipcMain.handle('bookmark:list', ticket((docId) => listBookmarks(docId)));
  ipcMain.handle('bookmark:add', ticket((docId, page, label) => addBookmark(docId, page, label)));
  ipcMain.handle('bookmark:remove', ticket((id) => removeBookmark(id)));
}

module.exports = { registerAnnoHandlers };
