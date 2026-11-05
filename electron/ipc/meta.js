'use strict';
/**
 * 分类 / 标签 / 设置 / 数据库连接 相关 IPC。
 */
const { ipcMain, shell } = require('electron');
const db = require('../db');
const { readConfig, writeConfig, publicConfig, libraryDir, ensureDir } = require('../config');
const { folderDirName, relocateDoc, removeEmptyDir } = require('../library');
function ticket(handler) {
  return async (_event, ...args) => {
    try {
      return { ok: true, data: await handler(...args) };
    } catch (err) {
      console.error('[ipc:meta]', err);
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  };
}

/** 统一名称清洗：去空白、限长，保证写库前数据是干净的 */
function normalizeName(value, label, maxLength) {
  const name = String(value == null ? '' : value).trim().replace(/\s+/g, ' ');
  if (!name) throw new Error(`${label}不能为空`);
  if (name.length > maxLength) throw new Error(`${label}不能超过 ${maxLength} 个字符`);
  return name;
}

/* ------------------------------- 分类 ------------------------------- */

const FOLDER_FIELDS = `f.id, f.name, f.parent_id, f.sort_no,
            (SELECT COUNT(*) FROM pr_doc_info d WHERE d.folder_id = f.id AND d.is_deleted = 0) AS doc_count`;

async function listFolders() {
  return db.query(`SELECT ${FOLDER_FIELDS} FROM pr_folder_info f ORDER BY f.sort_no ASC, f.id ASC`);
}

async function getFolder(id) {
  return db.queryOne(`SELECT ${FOLDER_FIELDS} FROM pr_folder_info f WHERE f.id = ?`, [id]);
}

async function createFolder(name, parentId = null) {
  const folderName = normalizeName(name, '分类名称', 128);
  let parent = null;
  if (parentId !== null && parentId !== undefined && parentId !== '') {
    parent = Number(parentId);
    if (!Number.isFinite(parent) || parent <= 0) throw new Error('上级分类无效');
    const parentRow = await db.queryOne('SELECT id FROM pr_folder_info WHERE id = ?', [parent]);
    if (!parentRow) throw new Error('上级分类不存在或已被删除');
  }
  const duplicated = parent
    ? await db.queryOne('SELECT id FROM pr_folder_info WHERE parent_id = ? AND name = ?', [parent, folderName])
    : await db.queryOne('SELECT id FROM pr_folder_info WHERE parent_id IS NULL AND name = ?', [folderName]);
  if (duplicated) throw new Error(`同级下已存在分类「${folderName}」`);

  const next = await db.queryOne('SELECT COALESCE(MAX(sort_no), 0) + 1 AS next_no FROM pr_folder_info');
  const result = await db.execute(
    'INSERT INTO pr_folder_info (name, parent_id, sort_no) VALUES (?, ?, ?)',
    [folderName, parent, Number(next && next.next_no) || 1]
  );
  return getFolder(result.insertId);
}

/** 某分类的全部子孙 id（含自身），按层级由浅到深 */
async function folderSubtreeIds(id) {
  const rows = await db.query('SELECT id, parent_id FROM pr_folder_info');
  const childrenOf = new Map();
  for (const row of rows) {
    const parent = row.parent_id === null || row.parent_id === undefined ? null : Number(row.parent_id);
    if (!parent) continue;
    if (!childrenOf.has(parent)) childrenOf.set(parent, []);
    childrenOf.get(parent).push(Number(row.id));
  }
  const out = [];
  const queue = [Number(id)];
  const seen = new Set();
  while (queue.length) {
    const current = queue.shift();
    if (seen.has(current)) continue;
    seen.add(current);
    out.push(current);
    for (const child of childrenOf.get(current) || []) queue.push(child);
  }
  return out;
}

/** 取多个分类下所有文献的文件信息 */
async function docsInFolders(folderIds) {
  const ids = (folderIds || []).map(Number).filter((n) => Number.isFinite(n) && n > 0);
  if (!ids.length) return [];
  const placeholders = ids.map(() => '?').join(',');
  return db.query(
    `SELECT id, title, file_name, stored_path, orig_name, folder_id
       FROM pr_doc_info WHERE folder_id IN (${placeholders}) AND is_deleted = 0`,
    ids
  );
}

/** 取某分类下所有文献的文件信息（分类改名 / 删除前先记下来） */
async function docsInFolder(folderId) {
  return db.query(
    `SELECT id, title, file_name, stored_path, orig_name, folder_id
       FROM pr_doc_info WHERE folder_id = ? AND is_deleted = 0`,
    [folderId]
  );
}

/** 批量把文献文件搬到目标分类目录，单个失败不影响其它 */
async function relocateAll(docs, targetFolderId) {
  const failed = [];
  for (const doc of docs) {
    try {
      await relocateDoc({ ...doc, folder_id: targetFolderId }, targetFolderId);
    } catch (err) {
      failed.push({ id: doc.id, reason: err && err.message ? err.message : String(err) });
    }
  }
  return failed;
}

async function renameFolder(id, name) {
  const folderName = normalizeName(name, '分类名称', 128);
  const current = await db.queryOne('SELECT id, parent_id FROM pr_folder_info WHERE id = ?', [id]);
  if (!current) throw new Error('分类不存在或已被删除');
  const duplicated = current.parent_id
    ? await db.queryOne('SELECT id FROM pr_folder_info WHERE parent_id = ? AND name = ? AND id <> ?', [
        current.parent_id,
        folderName,
        id,
      ])
    : await db.queryOne('SELECT id FROM pr_folder_info WHERE parent_id IS NULL AND name = ? AND id <> ?', [
        folderName,
        id,
      ]);
  if (duplicated) throw new Error(`分类「${folderName}」已存在`);

  const oldDir = await folderDirName(id);
  const subtree = await folderSubtreeIds(id);
  const oldDirs = [];
  for (const fid of subtree) {
    try {
      oldDirs.push(await folderDirName(fid));
    } catch {
      /* 忽略 */
    }
  }
  await db.execute('UPDATE pr_folder_info SET name = ? WHERE id = ?', [folderName, id]);
  // 目录路径里带着父级名称，所以子分类的文献也要一起搬
  const failed = [];
  for (const doc of await docsInFolders(subtree)) {
    try {
      await relocateDoc(doc, doc.folder_id);
    } catch (err) {
      failed.push({ id: doc.id, reason: err && err.message ? err.message : String(err) });
    }
  }
  if (!failed.length) {
    for (const dir of oldDirs.sort((a, b) => b.length - a.length)) await removeEmptyDir(dir);
  }
  const folder = await getFolder(id);
  return { ...folder, movedFailed: failed, oldDir };
}

async function removeFolder(id) {
  const existed = await db.queryOne('SELECT id FROM pr_folder_info WHERE id = ?', [id]);
  if (!existed) throw new Error('分类不存在或已被删除');
  const subtree = await folderSubtreeIds(id);
  const docs = await docsInFolders(subtree);
  const oldDirs = [];
  for (const fid of subtree) {
    try {
      oldDirs.push(await folderDirName(fid));
    } catch {
      /* 忽略 */
    }
  }
  const placeholders = subtree.map(() => '?').join(',');
  await db.transaction(async (conn) => {
    // 分类（含子分类）删除后文献回到“未分类”，不做级联删文献
    await conn.execute(`UPDATE pr_doc_info SET folder_id = NULL WHERE folder_id IN (${placeholders})`, subtree);
    await conn.execute(`DELETE FROM pr_folder_info WHERE id IN (${placeholders})`, subtree);
  });
  // 文件从「分类目录」挪回「未分类」
  const failed = await relocateAll(docs, null);
  if (!failed.length) {
    for (const dir of oldDirs.sort((a, b) => b.length - a.length)) await removeEmptyDir(dir);
  }
  return {
    ok: true,
    id: Number(id),
    /** 被删除的分类 id 列表（含子孙），前端据此复位筛选 */
    removedFolders: subtree.map(Number),
    removedCount: subtree.length,
    relocated: docs.length,
    movedFailed: failed,
  };
}

/* ------------------------------- 标签 ------------------------------- */

const TAG_COLORS = ['#5b8def', '#37c98b', '#ffb020', '#ff5f6d', '#a78bfa', '#22d3ee', '#f472b6', '#84cc16'];

const TAG_FIELDS = `t.id, t.name, t.color,
            (SELECT COUNT(*) FROM pr_doc_tag_rd rd JOIN pr_doc_info d ON d.id = rd.doc_id
              WHERE rd.tag_id = t.id AND d.is_deleted = 0) AS doc_count`;

async function listTags() {
  return db.query(`SELECT ${TAG_FIELDS} FROM pr_tag_info t ORDER BY t.name ASC`);
}

async function getTag(id) {
  return db.queryOne(`SELECT ${TAG_FIELDS} FROM pr_tag_info t WHERE t.id = ?`, [id]);
}

/** 新建标签时优先挑一个没被占用的调色板颜色，避免全是同色 */
async function pickTagColor() {
  const rows = await db.query('SELECT color FROM pr_tag_info');
  const used = new Set(rows.map((r) => String(r.color || '').toLowerCase()));
  const free = TAG_COLORS.find((c) => !used.has(c.toLowerCase()));
  return free || TAG_COLORS[rows.length % TAG_COLORS.length];
}

/** 存在即复用、不存在则创建（打标签场景用） */
async function ensureTag(name, color) {
  const tagName = normalizeName(name, '标签名', 64);
  const existed = await db.queryOne('SELECT id FROM pr_tag_info WHERE name = ?', [tagName]);
  if (existed) return getTag(existed.id);
  const tagColor = String(color || '').trim() || (await pickTagColor());
  const result = await db.execute('INSERT INTO pr_tag_info (name, color) VALUES (?, ?)', [tagName, tagColor]);
  return getTag(result.insertId);
}

/** 显式新建（重名直接报错，避免用户以为创建成功却复用了旧标签） */
async function createTag(name, color) {
  const tagName = normalizeName(name, '标签名', 64);
  const existed = await db.queryOne('SELECT id FROM pr_tag_info WHERE name = ?', [tagName]);
  if (existed) throw new Error(`标签「${tagName}」已存在`);
  return ensureTag(tagName, color);
}

async function renameTag(id, name, color) {
  const current = await db.queryOne('SELECT id FROM pr_tag_info WHERE id = ?', [id]);
  if (!current) throw new Error('标签不存在或已被删除');

  const fields = [];
  const params = [];
  if (name !== undefined && name !== null) {
    const tagName = normalizeName(name, '标签名', 64);
    const duplicated = await db.queryOne('SELECT id FROM pr_tag_info WHERE name = ? AND id <> ?', [tagName, id]);
    if (duplicated) throw new Error(`标签「${tagName}」已存在`);
    fields.push('name = ?');
    params.push(tagName);
  }
  if (color !== undefined && color !== null && String(color).trim() !== '') {
    fields.push('color = ?');
    params.push(String(color).trim());
  }
  if (!fields.length) return getTag(id);
  params.push(id);
  await db.execute(`UPDATE pr_tag_info SET ${fields.join(', ')} WHERE id = ?`, params);
  return getTag(id);
}

async function removeTag(id) {
  const existed = await db.queryOne('SELECT id FROM pr_tag_info WHERE id = ?', [id]);
  if (!existed) throw new Error('标签不存在或已被删除');
  // pr_doc_tag_rd 上的外键是 ON DELETE CASCADE，关联记录随标签一起清理
  await db.execute('DELETE FROM pr_tag_info WHERE id = ?', [id]);
  return { ok: true, id: Number(id) };
}

async function attachTag(docId, tagName) {
  const tag = await ensureTag(tagName);
  await db.execute(
    'INSERT IGNORE INTO pr_doc_tag_rd (doc_id, tag_id) VALUES (?, ?)',
    [docId, tag.id]
  );
  return getTag(tag.id);
}

async function detachTag(docId, tagId) {
  await db.execute('DELETE FROM pr_doc_tag_rd WHERE doc_id = ? AND tag_id = ?', [docId, tagId]);
  return { ok: true };
}

/* ------------------------------- 设置 ------------------------------- */

async function listSettings() {
  const rows = await db.query('SELECT setting_key, setting_value FROM pr_setting_info');
  return rows.reduce((acc, r) => {
    acc[r.setting_key] = r.setting_value;
    return acc;
  }, {});
}

async function setSetting(key, value) {
  if (!key) throw new Error('缺少设置键');
  await db.execute(
    `INSERT INTO pr_setting_info (setting_key, setting_value) VALUES (?, ?)
     ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`,
    [key, value == null ? null : String(value)]
  );
  return { ok: true };
}

/* ---------------------------- 数据库连接 ---------------------------- */

async function dbStatus() {
  return { ...db.status(), config: publicConfig(), library: ensureDir(libraryDir()) };
}

/**
 * 合并已保存配置与本次表单提交。
 * 密码留空 = 沿用已保存的密码（设置页密码框不会回填明文，避免一保存就把密码清空）。
 */
function mergedConfig(input) {
  const saved = readConfig();
  const merged = { ...saved, ...(input || {}) };
  if (merged.password === undefined || merged.password === null || merged.password === '') {
    merged.password = saved.password || '';
  }
  return merged;
}

async function dbSave(cfg) {
  const saved = writeConfig(mergedConfig(cfg));
  return { ...publicConfig(saved) };
}

async function dbTest(cfg) {
  const merged = mergedConfig(cfg);
  const res = await db.test(merged);
  // 顺带检查数据库是否已存在（仅在已连接成功时才有意义）
  let databaseExists = false;
  try {
    const rows = await db.query('SELECT 1');
    databaseExists = Array.isArray(rows);
  } catch {
    databaseExists = false;
  }
  return { ...res, databaseExists };
}

async function dbInit(cfg) {
  const merged = mergedConfig(cfg);
  const info = await db.init(merged);
  writeConfig(merged);
  return { ...info, config: publicConfig(merged) };
}

async function openLibraryDir() {
  const dir = ensureDir(libraryDir());
  await shell.openPath(dir);
  return { dir };
}

function registerMetaHandlers() {
  ipcMain.handle('folder:list', ticket(() => listFolders()));
  ipcMain.handle('folder:create', ticket((name, parentId) => createFolder(name, parentId)));
  ipcMain.handle('folder:rename', ticket((id, name) => renameFolder(id, name)));
  ipcMain.handle('folder:remove', ticket((id) => removeFolder(id)));

  ipcMain.handle('tag:list', ticket(() => listTags()));
  ipcMain.handle('tag:create', ticket((name, color) => createTag(name, color)));
  ipcMain.handle('tag:rename', ticket((id, name, color) => renameTag(id, name, color)));
  ipcMain.handle('tag:remove', ticket((id) => removeTag(id)));
  ipcMain.handle('tag:attach', ticket((docId, tagName) => attachTag(docId, tagName)));
  ipcMain.handle('tag:detach', ticket((docId, tagId) => detachTag(docId, tagId)));

  ipcMain.handle('setting:all', ticket(() => listSettings()));
  ipcMain.handle('setting:set', ticket((key, value) => setSetting(key, value)));

  ipcMain.handle('db:status', ticket(() => dbStatus()));
  ipcMain.handle('db:save', ticket((cfg) => dbSave(cfg)));
  ipcMain.handle('db:test', ticket((cfg) => dbTest(cfg)));
  ipcMain.handle('db:init', ticket((cfg) => dbInit(cfg)));
  ipcMain.handle('app:open-library', ticket(() => openLibraryDir()));
}

// 除 IPC 注册外，把分类 / 标签的纯函数也导出，便于命令行自检与回归测试
module.exports = {
  registerMetaHandlers,
  listFolders,
  createFolder,
  renameFolder,
  removeFolder,
  listTags,
  createTag,
  renameTag,
  removeTag,
  attachTag,
  detachTag,
};
