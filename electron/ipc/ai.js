'use strict';
/**
 * AI 的 IPC：供应商配置 CRUD、连通性测试、流式理解请求，以及本地量化模型的下载 / 加载。
 *
 * 两条推理路径共用同一套通道（ai:chat / ai:chunk）：
 *  - kind = 'openai' | 'anthropic' → electron/ai/chat.js，HTTP 调外部接口；
 *  - kind = 'local'                → electron/llm/local-chat-service.js，本机 llama.cpp（GGUF 量化模型），
 *                                    和划词翻译同一套思路：不联网、不需要 Key、文本不出机器。
 * 渲染进程只接触这些接口，API Key 不会以明文回传。
 */
const { ipcMain, dialog, shell } = require('electron');
const fs = require('node:fs');
const store = require('../ai/provider-store');
const { chat, testProvider } = require('../ai/chat');
const { buildMessages, listModes } = require('../ai/prompts');
const { service: localChat } = require('../llm/local-chat-service');
const { listModels, resolveModel, DEFAULT_CHAT_MODEL_ID, modelDirs } = require('../llm/model-registry');
const { chatManager, MIRRORS } = require('../llm/model-manager');

function ticket(handler) {
  return async (_event, ...args) => {
    try {
      return { ok: true, data: await handler(...args) };
    } catch (err) {
      console.error('[ipc:ai]', err);
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  };
}

/** 正在进行的请求：requestId -> AbortController（外部接口）或 { local: true }（本地推理） */
const inflight = new Map();

function send(ctx, channel, payload) {
  const win = ctx.getWindow && ctx.getWindow();
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

/** 本地模型清单 + 磁盘状态（设置页 / 首启用） */
function localModelState() {
  const models = listModels('', 'chat');
  return {
    models,
    installed: models.filter((m) => m.exists).length,
    defaultModelId: DEFAULT_CHAT_MODEL_ID,
    download: chatManager.getState(),
    status: localChat.getStatus(),
    mirrors: MIRRORS.map((m) => ({ id: m.id, label: m.label })),
    dir: modelDirs()[0],
  };
}

function registerAiHandlers(ctx) {
  /* ------------------------------ 供应商配置 ------------------------------ */
  ipcMain.handle('ai:providers', ticket(() => store.listProviders()));
  ipcMain.handle('ai:modes', ticket(() => listModes()));
  ipcMain.handle('ai:provider-save', ticket((input) => store.saveProvider(input || {})));
  ipcMain.handle('ai:provider-remove', ticket((id) => store.removeProvider(id)));
  ipcMain.handle('ai:default-set', ticket((id) => store.setDefaultProvider(id)));

  ipcMain.handle(
    'ai:provider-test',
    ticket(async (payload) => {
      const id = payload && payload.id;
      const provider = store.resolveProvider(id);
      try {
        let result;
        if (provider.kind === 'local') {
          // 本地模型：真的加载一遍再生成两个 token，比只查文件存在更能反映问题
          const started = Date.now();
          await localChat.ensureFor(provider);
          const answer = await localChat.chat({
            requestId: `test-${Date.now()}`,
            messages: [
              { role: 'system', content: '你是连通性测试助手。' },
              { role: 'user', content: '只回复两个字：可用' },
            ],
            maxTokens: 16,
            temperature: 0,
          });
          result = {
            ok: Boolean(answer.text),
            ms: Date.now() - started,
            model: provider.model,
            sample: String(answer.text || '').slice(0, 40),
            local: true,
          };
        } else {
          result = await testProvider(provider);
        }
        store.recordTest(provider.id, result);
        return { ...result, providerId: provider.id, name: provider.name };
      } catch (err) {
        const failure = { ok: false, message: err && err.message ? err.message : String(err) };
        store.recordTest(provider.id, failure);
        throw err;
      }
    })
  );

  /* ------------------------------ 理解请求 ------------------------------ */

  // 本地推理的流式片段：把累积后的完整文本推给渲染层，和外部接口的 ai:chunk 结构保持一致
  localChat.on('chunk', (payload) => {
    send(ctx, 'ai:chunk', { requestId: payload.requestId, delta: payload.delta, text: payload.text, local: true });
  });
  localChat.on('status', (status) => send(ctx, 'ai:local-state', status));
  chatManager.on('progress', (progress) => send(ctx, 'ai:local-download', progress));

  ipcMain.handle(
    'ai:chat',
    ticket(async (payload = {}) => {
      const requestId = payload.requestId || `ai-${Date.now()}`;
      const provider = store.resolveProvider(payload.providerId);
      const messages = payload.messages && Array.isArray(payload.messages)
        ? payload.messages
        : buildMessages(payload);

      if (provider.kind === 'local') {
        inflight.set(requestId, { local: true });
        try {
          await localChat.ensureFor(provider);
          const result = await localChat.chat({
            requestId,
            messages,
            temperature: payload.temperature === undefined ? provider.temperature : payload.temperature,
            // 没指定就交给服务按模型清单的建议值决定
            maxTokens: payload.maxTokens,
          });
          return {
            requestId,
            providerId: provider.id,
            providerName: provider.name,
            model: provider.model,
            text: result.text,
            usage: null,
            ms: result.ms,
            local: true,
          };
        } finally {
          inflight.delete(requestId);
        }
      }

      const controller = new AbortController();
      inflight.set(requestId, { controller });
      try {
        const result = await chat(provider, {
          messages,
          temperature: payload.temperature,
          maxTokens: payload.maxTokens,
          signal: controller.signal,
          onDelta: (piece, full) => send(ctx, 'ai:chunk', { requestId, delta: piece, text: full }),
        });
        return {
          requestId,
          providerId: provider.id,
          providerName: provider.name,
          model: result.model,
          text: result.text,
          usage: result.usage,
          ms: result.ms,
          aborted: Boolean(result.aborted),
        };
      } finally {
        inflight.delete(requestId);
      }
    })
  );

  ipcMain.handle(
    'ai:abort',
    ticket(async (requestId) => {
      const entry = inflight.get(requestId);
      if (!entry) return { aborted: false };
      if (entry.local) {
        const res = await localChat.abort(requestId).catch(() => ({ aborted: false }));
        inflight.delete(requestId);
        return { aborted: Boolean(res && res.aborted) };
      }
      entry.controller.abort();
      inflight.delete(requestId);
      return { aborted: true };
    })
  );

  /* ------------------------------ 本地模型管理 ------------------------------ */

  ipcMain.handle('ai:local-models', ticket(async () => localModelState()));
  ipcMain.handle('ai:local-status', ticket(async () => localChat.getStatus()));
  ipcMain.handle(
    'ai:local-load',
    ticket(async (overrides = {}) => {
      const modelId = overrides.localModelId || DEFAULT_CHAT_MODEL_ID;
      const model = resolveModel(modelId, overrides.localPath, 'chat');
      if (!model.exists) {
        throw new Error(`模型文件不存在：${model.path}\n请先点「下载所选模型」，或把 GGUF 放进该目录。`);
      }
      return localChat.load({
        modelPath: model.path,
        modelId: model.id,
        gpu: overrides.gpu || 'auto',
        contextSize: Number(overrides.contextSize) || model.contextSize || 8192,
      });
    })
  );
  ipcMain.handle('ai:local-unload', ticket(() => localChat.unload()));
  ipcMain.handle('ai:local-download', ticket((payload) => chatManager.start((payload && payload.modelId) || DEFAULT_CHAT_MODEL_ID, 'chat')));
  ipcMain.handle('ai:local-download-cancel', ticket(() => chatManager.cancel()));
  ipcMain.handle('ai:local-download-state', ticket(async () => chatManager.getState()));
  ipcMain.handle(
    'ai:local-pick-model',
    ticket(async () => {
      const win = ctx.getWindow && ctx.getWindow();
      const res = await dialog.showOpenDialog(win, {
        title: '选择 GGUF 理解模型',
        filters: [{ name: 'GGUF 模型', extensions: ['gguf'] }],
        properties: ['openFile'],
      });
      if (res.canceled || !res.filePaths.length) return { canceled: true, path: null };
      return { canceled: false, path: res.filePaths[0] };
    })
  );
  ipcMain.handle(
    'ai:local-open-dir',
    ticket(async () => {
      const dir = modelDirs()[0];
      fs.mkdirSync(dir, { recursive: true });
      const err = await shell.openPath(dir);
      if (err) throw new Error(err);
      return { dir };
    })
  );
}

module.exports = { registerAiHandlers };
