'use strict';
/**
 * 文献「代码仓库」IPC：解析论文里的仓库地址、绑定本地仓库、从远程克隆、解绑。
 * 所有耗时操作都通过 `repo:progress` 单向事件回报进度，渲染进程只订阅。
 */
const { ipcMain, dialog } = require('electron');
const path = require('node:path');
const repo = require('../repo');
const { libraryDir } = require('../config');

function ticket(handler) {
  return async (_event, ...args) => {
    try {
      return { ok: true, data: await handler(...args) };
    } catch (err) {
      console.error('[ipc:repo]', err);
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  };
}

/** 进度回传：窗口还在就发，避免退出时报错 */
function progressSender(ctx) {
  return (payload) => {
    const win = ctx.getWindow();
    if (win && !win.isDestroyed()) win.webContents.send('repo:progress', payload);
  };
}

async function pickAndBindLocal(ctx, payload = {}) {
  const docId = Number(payload.docId);
  if (!docId) throw new Error('缺少文献 ID');
  const win = ctx.getWindow();
  const res = await dialog.showOpenDialog(win, {
    title: '选择要绑定的本地代码仓库文件夹',
    defaultPath: libraryDir(),
    buttonLabel: '绑定这个文件夹',
    properties: ['openDirectory'],
  });
  if (res.canceled || !res.filePaths.length) return { canceled: true };
  const data = await repo.bindLocal(docId, res.filePaths[0], {
    remoteUrl: payload.remoteUrl,
    onProgress: progressSender(ctx),
  });
  return { canceled: false, repo: data };
}

/** 只选目录、不绑定：给「仅记录路径」用 */
async function pickRepoDir(ctx) {
  const win = ctx.getWindow();
  const res = await dialog.showOpenDialog(win, {
    title: '选择代码仓库文件夹（只记录路径，不复制）',
    defaultPath: libraryDir(),
    buttonLabel: '记录这个文件夹',
    properties: ['openDirectory'],
  });
  if (res.canceled || !res.filePaths.length) return { canceled: true, path: null };
  return { canceled: false, path: res.filePaths[0] };
}

/**
 * 克隆时用户可能先要选「克隆到哪」——这里固定克隆进 `<库根>/repos/`，
 * 与「复制进文库」保持同一套目录，换文库位置时一起搬走。
 */
async function clone(ctx, payload = {}) {
  const docId = Number(payload.docId);
  if (!docId) throw new Error('缺少文献 ID');
  return repo.cloneRepo(docId, {
    url: payload.url,
    depth: payload.depth,
    onProgress: progressSender(ctx),
  });
}

function registerRepoHandlers(ctx) {
  ipcMain.handle('repo:get', ticket((docId) => repo.getRepo(Number(docId))));
  ipcMain.handle('repo:detect', ticket((docId) => repo.detectRepoUrl(Number(docId))));
  ipcMain.handle('repo:bind-local', ticket((payload) => pickAndBindLocal(ctx, payload || {})));
  ipcMain.handle('repo:pick-dir', ticket(() => pickRepoDir(ctx)));
  // 只把地址存下来（还没落本地文件），用户填完地址就立刻持久化
  ipcMain.handle('repo:save-remote', ticket((payload = {}) => repo.saveRemoteUrl(Number(payload.docId), payload.url)));
  ipcMain.handle(
    'repo:bind-path',
    ticket((payload = {}) => {
      const target = String(payload.path || '').trim();
      if (!target) throw new Error('缺少仓库目录路径');
      return repo.bindPath(Number(payload.docId), path.resolve(target), { remoteUrl: payload.remoteUrl });
    })
  );
  ipcMain.handle('repo:clone', ticket((payload) => clone(ctx, payload || {})));
  ipcMain.handle('repo:cancel', ticket((docId) => repo.cancelClone(Number(docId))));
  ipcMain.handle('repo:remove', ticket((payload = {}) => repo.removeRepo(Number(payload.docId), { deleteFiles: Boolean(payload.deleteFiles) })));
  ipcMain.handle('repo:open', ticket((docId) => repo.openRepo(Number(docId))));
  ipcMain.handle('repo:reveal', ticket((docId) => repo.revealRepo(Number(docId))));
  // 浏览仓库文件：树 + 单个文件预览
  ipcMain.handle('repo:tree', ticket((docId, options) => repo.listTree(Number(docId), options || {})));
  ipcMain.handle('repo:file', ticket((docId, relPath) => repo.readRepoFile(Number(docId), relPath)));
  // 给「AI 解析」用的仓库上下文（目录树 / README / 依赖清单 / 论文摘要）
  ipcMain.handle('repo:context', ticket((docId) => repo.buildContext(Number(docId))));
}

module.exports = { registerRepoHandlers };
