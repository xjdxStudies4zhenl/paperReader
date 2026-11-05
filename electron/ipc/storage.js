'use strict';
/**
 * 存储位置相关 IPC：查看当前文库目录、让用户选择新目录、把已有 PDF 迁移过去。
 * 文库布局是「库根/<分类名>/<原文件名>.pdf」，所以换目录要整棵树搬（含子目录）。
 */
const { ipcMain, dialog, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { readConfig, writeConfig, libraryDir, defaultLibraryDir, ensureDir } = require('../config');
const { reorganizeLibrary } = require('../library');
const { syncLibrary } = require('../library-sync');

function ticket(handler) {
  return async (_event, ...args) => {
    try {
      return { ok: true, data: await handler(...args) };
    } catch (err) {
      console.error('[ipc:storage]', err);
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  };
}

function samePath(a, b) {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

/** 统一成真实路径，避免 Windows 8.3 短路径（如 ADMINI~1）写进配置 */
function realPath(target) {
  try {
    return fs.realpathSync.native(target);
  } catch {
    return path.resolve(target);
  }
}

/** 递归统计目录里的 PDF 数量与占用（含分类子目录） */
async function dirStats(dir) {
  let fileCount = 0;
  let totalSize = 0;
  async function walk(current) {
    let entries = [];
    try {
      entries = await fs.promises.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      fileCount += 1;
      try {
        totalSize += (await fs.promises.stat(full)).size;
      } catch {
        /* 单个文件统计失败不影响整体 */
      }
    }
  }
  await walk(dir);
  return { fileCount, totalSize };
}

async function storageInfo() {
  const dir = realPath(ensureDir(libraryDir()));
  const defaultDir = defaultLibraryDir();
  const stats = await dirStats(dir);
  return { dir, defaultDir: realPath(defaultDir), isDefault: samePath(dir, defaultDir), ...stats };
}

/** 弹出系统目录选择框 */
async function pickDir(ctx) {
  const win = ctx.getWindow();
  const res = await dialog.showOpenDialog(win, {
    title: '选择文献库存储文件夹',
    defaultPath: libraryDir(),
    buttonLabel: '使用此文件夹',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (res.canceled || !res.filePaths.length) return { canceled: true, path: null };
  return { canceled: false, path: res.filePaths[0] };
}

/** 把 src 移到 dst，跨盘（EXDEV）时退化为复制后删除 */
async function moveFile(src, dst) {
  try {
    await fs.promises.rename(src, dst);
  } catch (err) {
    if (err && err.code === 'EXDEV') {
      await fs.promises.copyFile(src, dst);
      await fs.promises.unlink(src);
      return;
    }
    throw err;
  }
}

/** 递归搬运目录内容（换文库位置时用） */
async function moveTree(from, to, result) {
  let entries = [];
  try {
    entries = await fs.promises.readdir(from, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    try {
      if (entry.isDirectory()) {
        ensureDir(dst);
        await moveTree(src, dst, result);
        try {
          await fs.promises.rmdir(src);
        } catch {
          /* 目录非空（有跳过/失败的文件）就保留 */
        }
        continue;
      }
      if (!entry.isFile()) continue;
      if (fs.existsSync(dst)) {
        const [a, b] = await Promise.all([fs.promises.stat(src), fs.promises.stat(dst)]);
        if (a.size === b.size) {
          // 目标位置已有一模一样的文件，直接清掉源文件即可
          await fs.promises.unlink(src).catch(() => {});
          result.moved += 1;
        } else {
          result.skipped += 1;
          result.failed.push({ name: entry.name, reason: '目标目录已存在同名但内容不同的文件' });
        }
        continue;
      }
      await moveFile(src, dst);
      result.moved += 1;
    } catch (err) {
      result.failed.push({ name: entry.name, reason: err && err.message ? err.message : String(err) });
    }
  }
}

/**
 * 应用新的存储位置。
 * @param {{ targetPath?: string, moveFiles?: boolean }} payload targetPath 为空表示恢复默认目录
 */
async function applyStorage(ctx, payload = {}) {
  const from = realPath(ensureDir(libraryDir()));
  const raw = payload && payload.targetPath ? String(payload.targetPath).trim() : '';
  const target = raw ? realPath(ensureDir(path.resolve(raw))) : realPath(ensureDir(defaultLibraryDir()));
  if (!path.isAbsolute(target)) throw new Error('目标目录必须是绝对路径');
  if (target.startsWith(from + path.sep)) {
    throw new Error('新目录不能位于当前文库目录内部，请另选一个文件夹');
  }

  const unchanged = samePath(from, target);
  const moveFiles = payload.moveFiles !== false;
  const result = { dir: target, moved: 0, skipped: 0, failed: [], unchanged };

  if (!unchanged && moveFiles) {
    await moveTree(from, target, result);
  }

  writeConfig({
    ...readConfig(),
    libraryPath: samePath(target, defaultLibraryDir()) ? '' : target,
  });

  const stats = await dirStats(target);
  return { ...result, ...stats, isDefault: samePath(target, defaultLibraryDir()) };
}

async function openStorage(payload = {}) {
  const dir = payload && payload.dir ? path.resolve(String(payload.dir)) : libraryDir();
  ensureDir(dir);
  const err = await shell.openPath(dir);
  if (err) throw new Error(err);
  return { dir };
}

/** 在文件资源管理器中定位某个目录（父级打开并选中） */
async function revealStorage(payload = {}) {
  const dir = payload && payload.dir ? path.resolve(String(payload.dir)) : libraryDir();
  if (fs.existsSync(dir)) shell.showItemInFolder(dir);
  else shell.openPath(path.dirname(dir));
  return { ok: true };
}

function registerStorageHandlers(ctx) {
  ipcMain.handle('storage:info', ticket(() => storageInfo()));
  ipcMain.handle('storage:pick', ticket(() => pickDir(ctx)));
  ipcMain.handle('storage:apply', ticket((payload) => applyStorage(ctx, payload)));
  ipcMain.handle('storage:open', ticket((payload) => openStorage(payload)));
  ipcMain.handle('storage:reveal', ticket((payload) => revealStorage(payload)));
  // 把文库整理成「分类目录 + 原始文件名」布局（幂等，可重复执行）
  ipcMain.handle('storage:reorganize', ticket((payload) => reorganizeLibrary(payload || {})));
  // 扫描文库目录，把用户手工拖进来的 PDF / 新建的目录同步进数据库（目录名即分类）
  ipcMain.handle('storage:sync', ticket(() => syncLibrary()));
}

module.exports = { registerStorageHandlers };
