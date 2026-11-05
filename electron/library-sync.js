'use strict';
/**
 * 文库目录 ↔ 数据库 对齐（扫描同步）。
 *
 * 场景：用户直接在资源管理器里把 PDF 拖进文库目录、或新建 / 改名了分类目录，
 * 这些文件和目录在数据库里没有任何记录，界面上看不到。
 *
 * 同步时按「目录即分类」的规则对齐：
 *  1) `<库根>/<分类>/<子分类>/*.pdf` 里缺失的分类会自动补建分类记录；
 *  2) 没入库的 PDF 按内容哈希查重后导入（不复制文件，直接接管现有路径）；
 *  3) 已入库但被用户挪了目录 / 改了名的文件，靠哈希认出来并更新 stored_path 与所属分类；
 *  4) 内容完全重复的文件跳过并报告，交给用户自己清理；
 *  5) 库根下的文件（或 `未分类/` 里的）统一挂到「未分类」。
 *
 * 全程只做「补齐」，不会删除任何文件。
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const db = require('./db');
const { libraryDir, ensureDir } = require('./config');
const { UNCATEGORIZED_DIR, folderDirName } = require('./library');
const { extractPdfMeta, guessFromFileName } = require('./pdf-meta');
const { findDoiInPdf } = require('./pdf-text');

/** 扫描时跳过的目录 */
const SKIP_DIRS = new Set(['.git', '.svn', 'node_modules', '$RECYCLE.BIN']);

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** 递归收集文库里的 PDF（相对路径统一用 / 分隔） */
async function walkPdfs(root) {
  const out = [];
  async function walk(dir, prefix) {
    let entries = [];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
        await walk(abs, rel);
        continue;
      }
      if (entry.isFile() && /\.pdf$/i.test(entry.name)) out.push({ abs, rel });
    }
  }
  await walk(root, '');
  return out;
}

function dirOf(rel) {
  const idx = String(rel).lastIndexOf('/');
  return idx < 0 ? '' : String(rel).slice(0, idx);
}

/** 按目录层级补建分类记录，返回最末级分类 id（空目录返回 null） */
async function ensureFolderChain(segments, created) {
  let parentId = null;
  for (const segment of segments) {
    const name = String(segment || '').trim();
    if (!name) continue;
    const rows =
      parentId === null
        ? await db.query('SELECT id FROM pr_folder_info WHERE name = ? AND parent_id IS NULL', [name])
        : await db.query('SELECT id FROM pr_folder_info WHERE name = ? AND parent_id = ?', [name, parentId]);
    if (rows.length) {
      parentId = Number(rows[0].id);
      continue;
    }
    const res = await db.execute('INSERT INTO pr_folder_info (name, parent_id, sort_no) VALUES (?, ?, 0)', [name, parentId]);
    parentId = Number(res.insertId);
    created.push(name);
  }
  return parentId;
}

/** 现有分类 → 磁盘相对目录（与 library.js 的目录命名规则保持一致） */
async function folderDirMap() {
  const rows = await db.query('SELECT id FROM pr_folder_info ORDER BY id ASC');
  const map = new Map();
  for (const row of rows) {
    try {
      const dir = await folderDirName(row.id);
      if (dir && dir !== UNCATEGORIZED_DIR) map.set(String(dir).toLowerCase(), Number(row.id));
    } catch {
      /* 单个分类算不出来不影响整体 */
    }
  }
  return map;
}

/**
 * 执行同步。
 * @returns {Promise<{dir:string, scanned:number, imported:number, restored:number, moved:number,
 *   folderFixed:number, duplicates:number, unchanged:number, createdFolders:string[],
 *   failed:{path:string, reason:string}[], newDocs:{id:number,title:string,path:string}[]}>}
 */
async function syncLibrary() {
  const root = path.resolve(ensureDir(libraryDir()));
  const summary = {
    dir: root,
    scanned: 0,
    imported: 0,
    restored: 0,
    moved: 0,
    folderFixed: 0,
    duplicates: 0,
    unchanged: 0,
    createdFolders: [],
    failed: [],
    newDocs: [],
  };

  const files = await walkPdfs(root);
  summary.scanned = files.length;
  if (!files.length) return summary;

  /* ---------- 1) 目录 → 分类：缺的分类补建 ---------- */
  let dirMap = await folderDirMap();
  const dirs = new Set(files.map((f) => dirOf(f.rel)));
  const createdNames = [];
  for (const dir of dirs) {
    if (!dir) continue; // 库根 = 未分类
    if (dirMap.has(dir.toLowerCase())) continue;
    const segments = dir.split('/').filter((s) => s && s !== UNCATEGORIZED_DIR);
    if (!segments.length) continue;
    await ensureFolderChain(segments, createdNames);
  }
  if (createdNames.length) {
    dirMap = await folderDirMap();
    summary.createdFolders = [...new Set(createdNames)];
  }
  const folderOfDir = (dir) => (dir ? dirMap.get(dir.toLowerCase()) ?? null : null);

  /* ---------- 2) 现有记录索引 ---------- */
  const docs = await db.query(
    'SELECT id, title, file_name, stored_path, orig_name, file_hash, folder_id, is_deleted FROM pr_doc_info'
  );
  // 同名哈希优先取未删除的记录
  docs.sort((a, b) => Number(a.is_deleted || 0) - Number(b.is_deleted || 0));
  const byRel = new Map();
  const byHash = new Map();
  for (const doc of docs) {
    if (doc.stored_path) byRel.set(String(doc.stored_path).replace(/\\/g, '/').toLowerCase(), doc);
    if (doc.file_hash && !byHash.has(doc.file_hash)) byHash.set(doc.file_hash, doc);
  }

  /* ---------- 3) 逐个文件对齐 ---------- */
  const handledHashes = new Set();
  for (const file of files) {
    try {
      const rel = file.rel;
      const fileName = path.basename(rel);
      const folderId = folderOfDir(dirOf(rel));
      const known = byRel.get(rel.toLowerCase());

      // 3a. 路径没变：只校正分类
      if (known && !known.is_deleted) {
        if (String(known.folder_id ?? '') !== String(folderId ?? '')) {
          await db.execute('UPDATE pr_doc_info SET folder_id = ? WHERE id = ?', [folderId, known.id]);
          summary.folderFixed += 1;
        } else {
          summary.unchanged += 1;
        }
        // 这份内容已经认过了，后面再出现相同内容的就是重复文件
        if (known.file_hash) handledHashes.add(known.file_hash);
        continue;
      }

      // 3b. 路径变了 / 新文件：读内容算哈希
      const buf = await fs.promises.readFile(file.abs);
      const hash = sha256(buf);
      const existing = byHash.get(hash);

      if (existing && !existing.is_deleted) {
        // 同一份内容：如果库里记录的原路径还在，说明这是用户另外复制的一份，判为重复
        const recordedRel = existing.stored_path ? String(existing.stored_path).replace(/\\/g, '/') : '';
        const recordedAbs = recordedRel ? path.resolve(root, recordedRel) : '';
        const recordedAlive = recordedAbs && fs.existsSync(recordedAbs);
        if (handledHashes.has(hash) || (recordedAlive && recordedAbs.toLowerCase() !== file.abs.toLowerCase())) {
          summary.duplicates += 1;
          continue;
        }
        handledHashes.add(hash);
        // 用户手工挪了目录 / 改了名：跟着文件走
        await db.execute(
          'UPDATE pr_doc_info SET stored_path = ?, file_name = ?, orig_name = ?, folder_id = ? WHERE id = ?',
          [rel, fileName, fileName, folderId, existing.id]
        );
        summary.moved += 1;
        byRel.set(rel.toLowerCase(), { ...existing, stored_path: rel, folder_id: folderId, is_deleted: 0 });
        continue;
      }

      if (existing) {
        // 记录之前被删过：恢复并接管当前路径
        if (handledHashes.has(hash)) {
          summary.duplicates += 1;
          continue;
        }
        handledHashes.add(hash);
        await db.execute(
          `UPDATE pr_doc_info
              SET is_deleted = 0, stored_path = ?, file_name = ?, orig_name = ?,
                  folder_id = ?, file_size = ?
            WHERE id = ?`,
          [rel, fileName, fileName, folderId, buf.length, existing.id]
        );
        summary.restored += 1;
        byRel.set(rel.toLowerCase(), { ...existing, stored_path: rel, folder_id: folderId, is_deleted: 0 });
        continue;
      }

      // 3c. 全新的 PDF：直接接管（不复制），元数据从 PDF + 文件名解析
      let extracted = { title: '', authors: '', journal: '', doi: '', year: null, pages: null };
      try {
        extracted = await extractPdfMeta(buf, fileName);
      } catch {
        /* 解析失败就用文件名兜底 */
      }
      if (!extracted.doi) {
        try {
          const doi = await findDoiInPdf(buf, 2);
          if (doi) extracted.doi = doi;
        } catch {
          /* 扫描版 / 加密 PDF 忽略 */
        }
      }
      const guessed = guessFromFileName(fileName);
      const title =
        String(extracted.title || '').trim() ||
        String(guessed.title || '').trim() ||
        fileName.replace(/\.pdf$/i, '');
      const authors = String(extracted.authors || guessed.authors || '').trim() || null;
      const year = guessed.year || extracted.year || null;

      const insert = await db.execute(
        `INSERT INTO pr_doc_info
           (title, authors, year, journal, doi, abstract, file_name, stored_path, orig_name,
            file_hash, file_size, folder_id, page_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          title,
          authors,
          year,
          extracted.journal || null,
          extracted.doi || null,
          null,
          fileName,
          rel,
          fileName,
          hash,
          buf.length,
          folderId,
          extracted.pages || 0,
        ]
      );
      const doc = { id: Number(insert.insertId), title, stored_path: rel, file_hash: hash, folder_id: folderId, is_deleted: 0 };
      byHash.set(hash, doc);
      byRel.set(rel.toLowerCase(), doc);
      handledHashes.add(hash);
      summary.imported += 1;
      summary.newDocs.push({ id: doc.id, title, path: rel });
    } catch (err) {
      summary.failed.push({ path: file.rel, reason: err && err.message ? err.message : String(err) });
    }
  }

  return summary;
}

module.exports = { syncLibrary, walkPdfs };
