'use strict';
/**
 * 翻译相关 IPC：模型清单、加载 / 卸载、划词翻译（流式）、设置读写。
 * 渲染进程只能看到这些接口，node-llama-cpp 始终留在 UtilityProcess 里。
 */
const { ipcMain, dialog, shell } = require('electron');
const db = require('../db');
const { service } = require('../llm/translator-service');
const { listModels, resolveModel, DEFAULT_MODEL_ID } = require('../llm/model-registry');
const { manager: modelManager, MIRRORS } = require('../llm/model-manager');

const SETTING_KEYS = {
  modelId: 'translate.modelId',
  gpu: 'translate.gpu',
  target: 'translate.target',
  customPath: 'translate.customPath',
  autoLoad: 'translate.autoLoad',
};

function ticket(handler) {
  return async (_event, ...args) => {
    try {
      return { ok: true, data: await handler(...args) };
    } catch (err) {
      console.error('[ipc:translate]', err);
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  };
}

/** 读取翻译设置；与设置页共用 pr_setting_info */async function readSettings() {
  const rows = await db.query('SELECT setting_key, setting_value FROM pr_setting_info WHERE setting_key LIKE ?', [
    'translate.%',
  ]);
  const map = new Map(rows.map((row) => [row.setting_key, row.setting_value]));
  const modelId = map.get(SETTING_KEYS.modelId) || DEFAULT_MODEL_ID;
  const customPath = map.get(SETTING_KEYS.customPath) || '';
  const model = resolveModel(modelId, customPath, 'translate');
  return {
    modelId,
    gpu: map.get(SETTING_KEYS.gpu) || 'auto',
    target: map.get(SETTING_KEYS.target) || 'zh',
    customPath,
    autoLoad: map.get(SETTING_KEYS.autoLoad) === '1',
    model: {
      id: model.id,
      label: model.label,
      path: model.path,
      exists: model.exists,
      sizeMB: model.sizeMB,
      approxMB: model.approxMB,
      repo: model.repo,
      note: model.note,
    },
  };
}

async function writeSetting(key, value) {
  await db.execute(
    `INSERT INTO pr_setting_info (setting_key, setting_value) VALUES (?, ?)
     ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`,
    [key, value == null ? null : String(value)]
  );
}

async function saveSettings(patch = {}) {
  const entries = [
    ['modelId', SETTING_KEYS.modelId],
    ['gpu', SETTING_KEYS.gpu],
    ['target', SETTING_KEYS.target],
    ['customPath', SETTING_KEYS.customPath],
    ['autoLoad', SETTING_KEYS.autoLoad],
  ];
  for (const [field, key] of entries) {
    if (Object.prototype.hasOwnProperty.call(patch, field)) {
      const raw = patch[field];
      const value = typeof raw === 'boolean' ? (raw ? '1' : '0') : raw;
      await writeSetting(key, value);
    }
  }
  return readSettings();
}

/** 加载模型（使用当前设置，或调用方指定） */
async function loadModel(overrides = {}) {
  const settings = await readSettings();
  const modelId = overrides.modelId || settings.modelId;
  const customPath = overrides.customPath !== undefined ? overrides.customPath : settings.customPath;
  const model = resolveModel(modelId, customPath, 'translate');
  if (!model.exists) {
    throw new Error(
      `模型文件不存在：${model.path}\n请把 ${model.fileName} 放到该目录，或在设置里指定模型文件路径。`
    );
  }
  try {
    const status = await service.load({
      modelPath: model.path,
      modelId: model.id,
      gpu: overrides.gpu || settings.gpu,
      contextSize: overrides.contextSize || 4096,
    });
    return { ...status, model: { id: model.id, label: model.label, path: model.path } };
  } catch (err) {
    // 极低比特量化可能不被当前 llama.cpp 预编译包支持，给出可执行的替代建议
    const alternatives = listModels(customPath, 'translate').filter((item) => item.exists && item.id !== model.id);
    const hint = alternatives.length
      ? `\n可以改用在值的模型：${alternatives.map((item) => `${item.label}（${item.sizeMB}MB）`).join('、')}。`
      : '\n可以先执行 npm run model:download -- q4km 下载官方 Q4_K_M 再试。';
    throw new Error(`${(err && err.message) || '模型加载失败'}\n当前模型：${model.label}${hint}`);
  }
}

/* ------------------ 页面译文缓存（pr_page_translate_rd） ------------------ */

/** JSON 列取回来可能是字符串或已解析对象 */
function parseBlocks(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** 读取某篇文献已缓存的页面译文 */
async function listPageTranslations(docId, targetLang = 'zh') {
  const id = Number(docId);
  if (!id) throw new Error('缺少文献ID');
  const rows = await db.query(
    `SELECT page_no, source_hash, payload, block_count, updated_at
       FROM pr_page_translate_rd
      WHERE doc_id = ? AND target_lang = ?
      ORDER BY page_no ASC, updated_at ASC`,
    [id, String(targetLang || 'zh')]
  );
  return rows.map((row) => ({
    pageNo: Number(row.page_no),
    hash: row.source_hash,
    blocks: parseBlocks(row.payload),
    blockCount: Number(row.block_count) || 0,
    updatedAt: row.updated_at,
  }));
}

/** 保存单页译文（同一 文献/页/语言/指纹 只保留一条） */
async function savePageTranslation(payload = {}) {
  const docId = Number(payload.docId || payload.doc_id);
  const pageNo = Number(payload.pageNo || payload.page_no);
  if (!docId || !pageNo) throw new Error('缺少文献ID或页码');
  const targetLang = String(payload.targetLang || payload.target_lang || 'zh').slice(0, 16);
  const hash = String(payload.hash || 'unknown').slice(0, 32);
  const blocks = Array.isArray(payload.blocks) ? payload.blocks : [];
  await db.execute(
    `INSERT INTO pr_page_translate_rd (doc_id, page_no, target_lang, source_hash, payload, block_count)
     VALUES (?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE payload = VALUES(payload), block_count = VALUES(block_count)`,
    [docId, pageNo, targetLang, hash, JSON.stringify(blocks), blocks.length]
  );
  return { ok: true, pageNo, blockCount: blocks.length };
}

/** 清空某篇文献的译文缓存（重新翻译时用） */
async function clearPageTranslations(docId, targetLang = 'zh') {
  const id = Number(docId);
  if (!id) throw new Error('缺少文献ID');
  const result = await db.execute('DELETE FROM pr_page_translate_rd WHERE doc_id = ? AND target_lang = ?', [
    id,
    String(targetLang || 'zh'),
  ]);
  return { ok: true, removed: Number(result.affectedRows) || 0 };
}

function registerTranslateHandlers(ctx) {
  // 流式片段转发给渲染进程
  service.on('chunk', (payload) => {
    const win = ctx.getWindow && ctx.getWindow();
    if (win && !win.isDestroyed()) win.webContents.send('translate:chunk', payload);
  });
  service.on('status', (status) => {
    const win = ctx.getWindow && ctx.getWindow();
    if (win && !win.isDestroyed()) win.webContents.send('translate:status', status);
  });
  // 模型下载进度
  modelManager.on('progress', (progress) => {
    const win = ctx.getWindow && ctx.getWindow();
    if (win && !win.isDestroyed()) win.webContents.send('translate:download', progress);
  });

  ipcMain.handle('translate:status', ticket(async () => ({ ...service.getStatus(), settings: await readSettings() })));
  ipcMain.handle('translate:models', ticket(async () => ({ models: listModels((await readSettings()).customPath, 'translate') })));
  // 不需要数据库也能查（首启安装引导用）：只看磁盘上有没有模型
  ipcMain.handle(
    'translate:model-state',
    ticket(async () => {
      const models = listModels('', 'translate');
      const installed = models.filter((m) => m.exists);
      return {
        models,
        installed: installed.length,
        defaultModelId: DEFAULT_MODEL_ID,
        download: modelManager.getState(),
        mirrors: MIRRORS.map((m) => ({ id: m.id, label: m.label })),
      };
    })
  );
  ipcMain.handle('translate:download', ticket((payload) => modelManager.start((payload && payload.modelId) || DEFAULT_MODEL_ID, 'translate')));
  ipcMain.handle('translate:download-cancel', ticket(() => modelManager.cancel()));
  ipcMain.handle('translate:download-state', ticket(async () => modelManager.getState()));
  ipcMain.handle('translate:settings', ticket(() => readSettings()));
  ipcMain.handle('translate:save-settings', ticket((patch) => saveSettings(patch)));
  ipcMain.handle('translate:load', ticket((overrides) => loadModel(overrides || {})));
  ipcMain.handle(
    'translate:pick-model',
    ticket(async () => {
      const win = ctx.getWindow && ctx.getWindow();
      const res = await dialog.showOpenDialog(win, {
        title: '选择 GGUF 翻译模型',
        filters: [{ name: 'GGUF 模型', extensions: ['gguf'] }],
        properties: ['openFile'],
      });
      if (res.canceled || !res.filePaths.length) return { canceled: true, path: null };
      return { canceled: false, path: res.filePaths[0] };
    })
  );
  ipcMain.handle(
    'translate:open-models-dir',
    ticket(async () => {
      const { modelDirs } = require('../llm/model-registry');
      const dir = modelDirs()[0];
      require('node:fs').mkdirSync(dir, { recursive: true });
      const err = await shell.openPath(dir);
      if (err) throw new Error(err);
      return { dir };
    })
  );
  ipcMain.handle('translate:unload', ticket(() => service.unload()));
  ipcMain.handle('translate:abort', ticket((requestId) => service.abort(requestId)));
  ipcMain.handle(
    'translate:text',
    ticket(async (payload) => {
      const settings = await readSettings();
      const result = await service.translate({
        requestId: payload && payload.requestId,
        text: payload && payload.text,
        target: (payload && payload.target) || settings.target,
        style: payload && payload.style,
        maxTokens: payload && payload.maxTokens,
      });
      return { ...result, target: (payload && payload.target) || settings.target };
    })
  );
  // 页面译文缓存（一键翻译持久化）
  ipcMain.handle('translate:page-list', ticket((docId, lang) => listPageTranslations(docId, lang)));
  ipcMain.handle('translate:page-save', ticket((payload) => savePageTranslation(payload)));
  ipcMain.handle('translate:page-clear', ticket((docId, lang) => clearPageTranslations(docId, lang)));
}

module.exports = { registerTranslateHandlers, readSettings, saveSettings, loadModel };
