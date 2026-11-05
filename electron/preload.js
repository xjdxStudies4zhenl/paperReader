'use strict';
/**
 * 预加载脚本：通过 contextBridge 暴露受控 API，渲染进程不接触 Node。
 */
const { contextBridge, ipcRenderer, webUtils } = require('electron');

async function call(channel, ...args) {
  const res = await ipcRenderer.invoke(channel, ...args);
  if (!res) throw new Error('主进程无响应');
  if (!res.ok) throw new Error(res.error || '调用失败');
  return res.data;
}

const api = {
  db: {
    status: () => call('db:status'),
    save: (cfg) => call('db:save', cfg),
    test: (cfg) => call('db:test', cfg),
    init: (cfg) => call('db:init', cfg),
  },
  docs: {
    list: (filter) => call('doc:list', filter),
    get: (id) => call('doc:get', id),
    importFiles: (folderId) => call('doc:import', folderId),
    importPaths: (paths, folderId) => call('doc:import-paths', paths, folderId),
    update: (id, patch) => call('doc:update', id, patch),
    reparse: (id, options) => call('doc:reparse', id, options),
    smartFill: (id) => call('doc:smart-fill', id),
    backfill: (limit) => call('doc:backfill', limit),
    remove: (id) => call('doc:remove', id),
    fileBytes: (id) => call('doc:file', id),
    thumb: (id) => call('doc:thumb', id),
    saveThumb: (id, dataUrl, pageCount) => call('doc:save-thumb', id, dataUrl, pageCount),
    saveProgress: (id, page, seconds) => call('doc:progress', id, page, seconds),
    reveal: (id) => call('doc:reveal', id),
    readStats: (id) => call('read:stats', id),
    openSession: (id, page) => call('read:open', id, page),
    closeSession: (id, page, duration) => call('read:close', id, page, duration),
  },
  annos: {
    list: (docId) => call('anno:list', docId),
    create: (payload) => call('anno:create', payload),
    update: (id, patch) => call('anno:update', id, patch),
    remove: (id) => call('anno:remove', id),
    replies: (annoId) => call('anno:reply-list', annoId),
    addReply: (annoId, content) => call('anno:reply-add', annoId, content),
    removeReply: (id) => call('anno:reply-remove', id),
  },
  bookmarks: {
    list: (docId) => call('bookmark:list', docId),
    add: (docId, page, label) => call('bookmark:add', docId, page, label),
    remove: (id) => call('bookmark:remove', id),
  },
  folders: {
    list: () => call('folder:list'),
    create: (name, parentId) => call('folder:create', name, parentId),
    rename: (id, name) => call('folder:rename', id, name),
    remove: (id) => call('folder:remove', id),
  },
  tags: {
    list: () => call('tag:list'),
    create: (name, color) => call('tag:create', name, color),
    rename: (id, name, color) => call('tag:rename', id, name, color),
    remove: (id) => call('tag:remove', id),
    attach: (docId, name) => call('tag:attach', docId, name),
    detach: (docId, tagId) => call('tag:detach', docId, tagId),
  },
  settings: {
    all: () => call('setting:all'),
    set: (key, value) => call('setting:set', key, value),
  },
  storage: {
    info: () => call('storage:info'),
    pick: () => call('storage:pick'),
    apply: (payload) => call('storage:apply', payload),
    open: (dir) => call('storage:open', dir ? { dir } : {}),
    reveal: (dir) => call('storage:reveal', dir ? { dir } : {}),
    reorganize: (payload) => call('storage:reorganize', payload || {}),
    /** 扫描文库目录：把手工拖进去的 PDF / 新目录同步进数据库（目录名 = 分类） */
    syncLibrary: () => call('storage:sync'),
  },
  exporter: {
    markdown: (docId) => call('export:markdown', docId),
    flatten: (docId) => call('export:flatten', docId),
  },
  /** 本地翻译（Hy-MT2 1.8B）：推理在主进程的 UtilityProcess 里，渲染进程只见 IPC */
  translate: {
    status: () => call('translate:status'),
    models: () => call('translate:models'),
    settings: () => call('translate:settings'),
    saveSettings: (patch) => call('translate:save-settings', patch),
    load: (overrides) => call('translate:load', overrides || {}),
    unload: () => call('translate:unload'),
    /** 不依赖数据库的模型磁盘状态（首启安装引导用） */
    modelState: () => call('translate:model-state'),
    download: (modelId) => call('translate:download', modelId ? { modelId } : {}),
    cancelDownload: () => call('translate:download-cancel'),
    downloadState: () => call('translate:download-state'),
    onDownload: (handler) => {
      const listener = (_event, payload) => handler(payload);
      ipcRenderer.on('translate:download', listener);
      return () => ipcRenderer.removeListener('translate:download', listener);
    },
    pickModel: () => call('translate:pick-model'),
    openModelsDir: () => call('translate:open-models-dir'),
    text: (payload) => call('translate:text', payload),
    abort: (requestId) => call('translate:abort', requestId),
    /** 页面译文缓存（一键翻译持久化） */
    pageList: (docId, lang) => call('translate:page-list', docId, lang),
    pageSave: (payload) => call('translate:page-save', payload),
    pageClear: (docId, lang) => call('translate:page-clear', docId, lang),
    /** 订阅流式片段 / 状态变化，返回取消订阅函数 */
    onChunk: (handler) => {
      const listener = (_event, payload) => handler(payload);
      ipcRenderer.on('translate:chunk', listener);
      return () => ipcRenderer.removeListener('translate:chunk', listener);
    },
    onStatus: (handler) => {
      const listener = (_event, payload) => handler(payload);
      ipcRenderer.on('translate:status', listener);
      return () => ipcRenderer.removeListener('translate:status', listener);
    },
  },
  /** AI 理解：外部 API 配置 + 本地 GGUF 量化模型（同一套 ai:chat 通道） */
  ai: {
    providers: () => call('ai:providers'),
    modes: () => call('ai:modes'),
    saveProvider: (input) => call('ai:provider-save', input),
    removeProvider: (id) => call('ai:provider-remove', id),
    setDefault: (id) => call('ai:default-set', id),
    testProvider: (payload) => call('ai:provider-test', payload || {}),
    chat: (payload) => call('ai:chat', payload),
    abort: (requestId) => call('ai:abort', requestId),
    /** 本地理解模型：清单 / 下载 / 加载 / 卸载 / 状态（与翻译模型同一套思路） */
    local: {
      models: () => call('ai:local-models'),
      status: () => call('ai:local-status'),
      load: (overrides) => call('ai:local-load', overrides || {}),
      unload: () => call('ai:local-unload'),
      download: (modelId) => call('ai:local-download', modelId ? { modelId } : {}),
      cancelDownload: () => call('ai:local-download-cancel'),
      downloadState: () => call('ai:local-download-state'),
      pickModel: () => call('ai:local-pick-model'),
      openDir: () => call('ai:local-open-dir'),
      onDownload: (handler) => {
        const listener = (_event, payload) => handler(payload);
        ipcRenderer.on('ai:local-download', listener);
        return () => ipcRenderer.removeListener('ai:local-download', listener);
      },
      onStatus: (handler) => {
        const listener = (_event, payload) => handler(payload);
        ipcRenderer.on('ai:local-state', listener);
        return () => ipcRenderer.removeListener('ai:local-state', listener);
      },
    },
    onChunk: (handler) => {
      const listener = (_event, payload) => handler(payload);
      ipcRenderer.on('ai:chunk', listener);
      return () => ipcRenderer.removeListener('ai:chunk', listener);
    },
  },
  notes: {
    list: (docId) => call('note:list', docId),
    get: (id) => call('note:get', id),
    create: (payload) => call('note:create', payload),
    update: (id, patch) => call('note:update', id, patch),
    remove: (id) => call('note:remove', id),
  },
  app: {
    openLibrary: () => call('app:open-library'),
    /** 拖拽文件时获取真实路径（Electron 32+ 已移除 File.path） */
    pathForFile: (file) => {
      try {
        return webUtils.getPathForFile(file);
      } catch {
        return '';
      }
    },
    versions: () => ({
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
    }),
    platform: process.platform,
  },
};

contextBridge.exposeInMainWorld('pr', api);
