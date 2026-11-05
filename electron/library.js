'use strict';
/**
 * 文库文件布局：`库根/<分类名>/<原始文件名>.pdf`，未分类的放 `未分类/` 子目录。
 *
 * 数据库里用 stored_path 保存相对库根的路径（统一用 / 分隔），file_name 保存文件名本体，
 * orig_name 保存用户导入时的原始文件名。旧数据（只有哈希名 file_name、stored_path 为空）
 * 由 reorganizeLibrary() 一次性整理。
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const db = require('./db');
const { libraryDir, ensureDir } = require('./config');

/** 未分类文献的目录名 */
const UNCATEGORIZED_DIR = '未分类';
/** Windows 保留设备名，不能直接做文件名 */
const RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const ILLEGAL_CHARS = /[<>:"/\\|?*\u0000-\u001f]/g;

/** 目录名清洗：去掉非法字符，保留中文与空格 */
function safeDirName(input, fallback = UNCATEGORIZED_DIR) {
  let name = String(input == null ? '' : input)
    .replace(ILLEGAL_CHARS, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '');
  if (!name) name = fallback;
  if (RESERVED_NAMES.test(name)) name = `_${name}`;
  if (name.length > 80) name = name.slice(0, 80).trim().replace(/[. ]+$/g, '') || fallback;
  return name;
}

/** 文件名清洗：保留原始名称（含空格、大小写），只处理非法字符与扩展名 */
function safeFileName(input, fallback = '未命名.pdf') {
  const raw = String(input == null ? '' : input);
  const ext = path.extname(raw).toLowerCase();
  const base = ext === '.pdf' ? raw.slice(0, -ext.length) : raw;
  let name = base
    .replace(ILLEGAL_CHARS, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '');
  if (!name) name = path.basename(fallback, path.extname(fallback));
  if (RESERVED_NAMES.test(name)) name = `_${name}`;
  // Windows 整个路径上限 260 字符，给库根和分类目录留出余量
  if (name.length > 120) name = name.slice(0, 120).trim().replace(/[. ]+$/g, '') || '未命名';
  return `${name}.pdf`;
}

/**
 * 分类的目录链路（根 → 自身），找不到分类返回空数组。
 * 供 folderDirName / 前端展示「父 / 子」路径时复用。
 */
function buildChain(rows, folderId) {
  const byId = new Map();
  for (const row of rows) byId.set(Number(row.id), row);
  const chain = [];
  const seen = new Set();
  let cursor = byId.get(Number(folderId));
  while (cursor && !seen.has(Number(cursor.id))) {
    seen.add(Number(cursor.id));
    chain.unshift(cursor);
    const parentId = cursor.parent_id === null || cursor.parent_id === undefined ? null : Number(cursor.parent_id);
    cursor = parentId ? byId.get(parentId) : null;
  }
  return chain;
}

/**
 * 分类对应的相对目录（支持多级）：父分类/子分类，/ 分隔。
 * 同一父级下清洗后重名时用 id 后缀区分，保证一个分类一个目录。
 */
async function folderDirName(folderId) {
  if (folderId === null || folderId === undefined) return UNCATEGORIZED_DIR;
  const id = Number(folderId);
  if (!Number.isFinite(id) || id <= 0) return UNCATEGORIZED_DIR;
  const rows = await db.query('SELECT id, name, parent_id FROM pr_folder_info ORDER BY id ASC');
  const chain = buildChain(rows, id);
  if (!chain.length) return UNCATEGORIZED_DIR;
  return chain
    .map((node) => {
      const base = safeDirName(node.name);
      const parentId = node.parent_id === null || node.parent_id === undefined ? null : Number(node.parent_id);
      const clash = rows.some((row) => {
        if (Number(row.id) >= Number(node.id)) return false;
        const rowParent = row.parent_id === null || row.parent_id === undefined ? null : Number(row.parent_id);
        return rowParent === parentId && safeDirName(row.name) === base;
      });
      return clash ? `${base}_${node.id}` : base;
    })
    .join('/');
}

/** 分类的完整链路（含自身），给上层算「改父级/删除子树」用 */
async function folderChain(folderId) {
  const rows = await db.query('SELECT id, name, parent_id FROM pr_folder_info ORDER BY id ASC');
  return buildChain(rows, folderId).map((row) => ({
    id: Number(row.id),
    name: row.name,
    parent_id: row.parent_id === null || row.parent_id === undefined ? null : Number(row.parent_id),
  }));
}

/** 相对库根的绝对路径，带越界防护 */
function absPath(relPath) {
  const root = path.resolve(libraryDir());
  const target = path.resolve(root, String(relPath || '').replace(/^[\\/]+/, ''));
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error('文库路径越界');
  }
  return target;
}

/** 文献的磁盘路径：优先 stored_path，旧数据回落到库根的 file_name */
function docFilePath(row) {
  if (!row) throw new Error('文献记录为空');
  return absPath(row.stored_path || row.file_name);
}

/** 把文件名里的扩展名去掉，返回 basename */
function baseNameOf(fileName) {
  const ext = path.extname(String(fileName || ''));
  return ext ? String(fileName).slice(0, -ext.length) : String(fileName || '');
}

/** 标题 → 文件名；占位标题（哈希串）返回空 */
function titleToFileName(title) {
  const text = String(title == null ? '' : title).trim();
  if (!text) return '';
  if (/^[0-9a-f]{8,}$/i.test(text)) return '';
  return `${text}.pdf`;
}

/** 计算文件 SHA-256（流式，避免大文件占内存） */
function fileHash(absFile) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(absFile);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/**
 * 在指定分类目录下求一个不冲突的相对路径。
 * ignoreRel 传入当前路径时，若目标就是它自己则原样返回。
 */
async function uniqueRelPath(dirName, fileName, options = {}) {
  const dir = ensureDir(path.join(libraryDir(), dirName));
  const ignore = options.ignoreRel ? options.ignoreRel.replace(/\\/g, '/') : null;
  const safe = safeFileName(fileName);
  const base = baseNameOf(safe);
  for (let index = 1; index <= 999; index += 1) {
    const name = index === 1 ? safe : `${base} (${index}).pdf`;
    const rel = `${dirName}/${name}`;
    if (ignore && rel.toLowerCase() === ignore.toLowerCase()) return rel;
    if (!fs.existsSync(path.join(dir, name))) return rel;
  }
  throw new Error(`目录「${dirName}」下同名文件过多，请先整理文库`);
}

/** 移动文件，跨盘（EXDEV）退化为复制后删除 */
async function moveFile(from, to) {
  ensureDir(path.dirname(to));
  if (path.resolve(from).toLowerCase() === path.resolve(to).toLowerCase()) return;
  try {
    await fs.promises.rename(from, to);
  } catch (err) {
    if (err && err.code === 'EXDEV') {
      await fs.promises.copyFile(from, to);
      await fs.promises.unlink(from).catch(() => {});
      return;
    }
    throw err;
  }
}

/** 把某篇文献的文件搬到目标分类目录，并同步数据库里的 stored_path / file_name */
async function relocateDoc(doc, folderId, options = {}) {
  const dirName = await folderDirName(folderId);
  const currentRel = (doc.stored_path || doc.file_name || '').replace(/\\/g, '/');
  const fileName = options.fileName || doc.orig_name || path.basename(currentRel) || `${doc.title || '未命名'}.pdf`;
  const rel = await uniqueRelPath(dirName, fileName, { ignoreRel: currentRel });
  const from = absPath(currentRel);
  const to = absPath(rel);
  if (path.resolve(from).toLowerCase() !== path.resolve(to).toLowerCase()) {
    if (!fs.existsSync(from)) throw new Error(`源文件不存在：${currentRel}`);
    await moveFile(from, to);
  }
  await db.execute(
    'UPDATE pr_doc_info SET stored_path = ?, file_name = ? WHERE id = ?',
    [rel, path.basename(rel), doc.id]
  );
  return { id: doc.id, from: currentRel, to: rel, moved: rel !== currentRel };
}

/** 清理空的分类目录（迁移、删分类后留下空壳时用）；多级目录会逐级向上清理 */
async function removeEmptyDir(dirName) {
  if (!dirName || dirName === UNCATEGORIZED_DIR) return;
  const root = path.resolve(libraryDir());
  let rel = String(dirName).replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  while (rel) {
    const abs = path.join(root, rel);
    if (path.resolve(abs) === root) break;
    try {
      const entries = await fs.promises.readdir(abs);
      if (entries.length) break;
      await fs.promises.rmdir(abs);
    } catch {
      /* 目录不存在或非空，忽略 */
    }
    const cut = rel.lastIndexOf('/');
    if (cut < 0) break;
    rel = rel.slice(0, cut);
  }
}

/**
 * 把整个文库整理成「分类目录 + 原始文件名」的布局（幂等）。
 * 旧数据没有 orig_name，只能用标题作为文件名。
 */
async function reorganizeLibrary(options = {}) {
  const dryRun = Boolean(options && options.dryRun);
  const docs = await db.query(
    `SELECT d.id, d.title, d.file_name, d.file_hash, d.folder_id, d.orig_name, d.stored_path
       FROM pr_doc_info d
      WHERE d.is_deleted = 0
      ORDER BY d.id ASC`
  );
  const summary = {
    total: docs.length,
    moved: 0,
    unchanged: 0,
    failed: [],
    details: [],
  };

  for (const doc of docs) {
    let reused = false;
    try {
      const dirName = await folderDirName(doc.folder_id);
      const currentRel = (doc.stored_path || doc.file_name || '').replace(/\\/g, '/');
      const currentAbs = absPath(currentRel);
      if (!fs.existsSync(currentAbs)) {
        summary.failed.push({ id: doc.id, reason: `文件不存在：${currentRel}` });
        continue;
      }
      const wanted = doc.orig_name || titleToFileName(doc.title) || path.basename(currentRel);
      const rel = await uniqueRelPath(dirName, wanted, { ignoreRel: currentRel });

      // 目标位置若已有内容完全相同的文件（用户手工改名/搬过去的情况），直接复用，不产生副本
      const candidates = [
        `${dirName}/${safeFileName(wanted)}`,
        safeFileName(wanted),
        currentRel,
      ];
      for (const candidate of candidates) {
        if (candidate.toLowerCase() === currentRel.toLowerCase()) continue;
        if (!fs.existsSync(absPath(candidate))) continue;
        const sameFile = doc.file_hash ? (await fileHash(absPath(candidate))) === doc.file_hash : false;
        if (!sameFile) continue;
        // 保留这份内容相同的文件，但统一挪到目标分类目录，并清掉原来的哈希副本
        const keepName = path.basename(candidate);
        const targetRel = await uniqueRelPath(dirName, keepName, { ignoreRel: candidate });
        summary.details.push({ id: doc.id, from: currentRel, to: targetRel, reused: true, dedupedFrom: candidate });
        if (!dryRun) {
          if (targetRel.toLowerCase() !== candidate.toLowerCase()) {
            await moveFile(absPath(candidate), absPath(targetRel));
          }
          await fs.promises.unlink(currentAbs).catch(() => {});
          await db.execute(
            'UPDATE pr_doc_info SET stored_path = ?, file_name = ?, orig_name = COALESCE(orig_name, ?) WHERE id = ?',
            [targetRel, path.basename(targetRel), keepName, doc.id]
          );
        }
        summary.moved += 1;
        reused = true;
        break;
      }
      if (reused) continue;

      if (rel.toLowerCase() === currentRel.toLowerCase()) {
        // 路径没变，只补一次 stored_path / orig_name
        if (!doc.stored_path || !doc.orig_name) {
          if (!dryRun) {
            await db.execute('UPDATE pr_doc_info SET stored_path = ?, orig_name = ? WHERE id = ?', [
              rel,
              doc.orig_name || path.basename(rel),
              doc.id,
            ]);
          }
        }
        summary.unchanged += 1;
        continue;
      }
      summary.details.push({ id: doc.id, from: currentRel, to: rel });
      if (!dryRun) {
        await moveFile(currentAbs, absPath(rel));
        await db.execute(
          'UPDATE pr_doc_info SET stored_path = ?, file_name = ?, orig_name = COALESCE(orig_name, ?) WHERE id = ?',
          [rel, path.basename(rel), path.basename(rel), doc.id]
        );
      }
      summary.moved += 1;
    } catch (err) {
      summary.failed.push({ id: doc.id, reason: err && err.message ? err.message : String(err) });
    }
  }

  return summary;
}

module.exports = {
  UNCATEGORIZED_DIR,
  safeDirName,
  safeFileName,
  folderDirName,
  folderChain,
  absPath,
  docFilePath,
  uniqueRelPath,
  moveFile,
  relocateDoc,
  removeEmptyDir,
  reorganizeLibrary,
  baseNameOf,
  titleToFileName,
};
