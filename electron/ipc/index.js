'use strict';
/**
 * IPC 装配：所有渲染进程能力都通过 ipcMain.handle 暴露，命名格式 `域:动作`。
 */
const { registerDocHandlers } = require('./docs');
const { registerAnnoHandlers } = require('./annos');
const { registerMetaHandlers } = require('./meta');
const { registerExportHandlers } = require('./export');
const { registerStorageHandlers } = require('./storage');
const { registerTranslateHandlers } = require('./translate');
const { registerAiHandlers } = require('./ai');
const { registerNoteHandlers } = require('./notes');

function registerIpc(getWindow) {
  const ctx = { getWindow };
  registerDocHandlers(ctx);
  registerAnnoHandlers(ctx);
  registerMetaHandlers(ctx);
  registerExportHandlers(ctx);
  registerStorageHandlers(ctx);
  registerTranslateHandlers(ctx);
  registerAiHandlers(ctx);
  registerNoteHandlers(ctx);
}

module.exports = { registerIpc };
