'use strict';
/**
 * 笔记相关 IPC：列表、新建、读取、更新、删除。
 * 笔记支持 Markdown 格式，可关联文献。
 */
const { ipcMain } = require('electron');
const db = require('../db');

function ticket(handler) {
  return async (_event, ...args) => {
    try {
      return { ok: true, data: await handler(...args) };
    } catch (err) {
      console.error('[ipc:notes]', err);
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  };
}

const NOTE_FIELDS = `n.id, n.title, n.content, n.html_content, n.doc_id,
  n.created_at, n.updated_at,
  d.title AS doc_title`;

const NOTE_JOIN = `FROM pr_note_info n
  LEFT JOIN pr_doc_info d ON d.id = n.doc_id AND d.is_deleted = 0`;

async function listNotes(docId) {
  if (docId) {
    return db.query(
      `SELECT ${NOTE_FIELDS} ${NOTE_JOIN}
       WHERE n.doc_id = ? AND n.is_deleted = 0
       ORDER BY n.updated_at DESC`,
      [docId]
    );
  }
  return db.query(
    `SELECT ${NOTE_FIELDS} ${NOTE_JOIN}
     WHERE n.is_deleted = 0
     ORDER BY n.updated_at DESC`
  );
}

async function getNote(id) {
  return db.queryOne(
    `SELECT ${NOTE_FIELDS} ${NOTE_JOIN}
     WHERE n.id = ? AND n.is_deleted = 0`,
    [id]
  );
}

async function createNote({ title, content, htmlContent, docId }) {
  const noteTitle = String(title || '').trim().slice(0, 256) || '无标题笔记';
  const noteContent = content != null ? String(content) : '';
  const noteHtml = htmlContent != null ? String(htmlContent) : null;
  const noteDocId = docId ? Number(docId) : null;

  if (noteDocId) {
    const doc = await db.queryOne('SELECT id FROM pr_doc_info WHERE id = ? AND is_deleted = 0', [noteDocId]);
    if (!doc) throw new Error('关联的文献不存在或已被删除');
  }

  const result = await db.execute(
    'INSERT INTO pr_note_info (title, content, html_content, doc_id) VALUES (?, ?, ?, ?)',
    [noteTitle, noteContent, noteHtml, noteDocId]
  );
  return getNote(result.insertId);
}

async function updateNote(id, patch) {
  const current = await db.queryOne('SELECT id FROM pr_note_info WHERE id = ? AND is_deleted = 0', [id]);
  if (!current) throw new Error('笔记不存在或已被删除');

  const fields = [];
  const params = [];

  if (patch.title !== undefined) {
    fields.push('title = ?');
    params.push(String(patch.title || '').trim().slice(0, 256) || '无标题笔记');
  }
  if (patch.content !== undefined) {
    fields.push('content = ?');
    params.push(String(patch.content));
  }
  if (patch.htmlContent !== undefined) {
    fields.push('html_content = ?');
    params.push(patch.htmlContent);
  }
  if (patch.docId !== undefined) {
    const noteDocId = patch.docId ? Number(patch.docId) : null;
    if (noteDocId) {
      const doc = await db.queryOne('SELECT id FROM pr_doc_info WHERE id = ? AND is_deleted = 0', [noteDocId]);
      if (!doc) throw new Error('关联的文献不存在或已被删除');
    }
    fields.push('doc_id = ?');
    params.push(noteDocId);
  }

  if (!fields.length) return getNote(id);
  params.push(id);
  await db.execute(`UPDATE pr_note_info SET ${fields.join(', ')} WHERE id = ?`, params);
  return getNote(id);
}

async function removeNote(id) {
  const current = await db.queryOne('SELECT id FROM pr_note_info WHERE id = ? AND is_deleted = 0', [id]);
  if (!current) throw new Error('笔记不存在或已被删除');
  await db.execute('UPDATE pr_note_info SET is_deleted = 1 WHERE id = ?', [id]);
  return { ok: true, id: Number(id) };
}

function registerNoteHandlers() {
  ipcMain.handle('note:list', ticket((docId) => listNotes(docId)));
  ipcMain.handle('note:get', ticket((id) => getNote(id)));
  ipcMain.handle('note:create', ticket((payload) => createNote(payload)));
  ipcMain.handle('note:update', ticket((id, patch) => updateNote(id, patch)));
  ipcMain.handle('note:remove', ticket((id) => removeNote(id)));
}

module.exports = {
  registerNoteHandlers,
  listNotes,
  getNote,
  createNote,
  updateNote,
  removeNote,
};
