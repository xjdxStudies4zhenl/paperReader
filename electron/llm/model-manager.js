'use strict';
/**
 * 模型下载管理器（主进程）：
 * 国内优先走镜像，失败自动换源，支持断点续传与取消；进度通过事件推给渲染进程。
 *
 * 源顺序：HuggingFace 镜像（hf-mirror） → 魔搭 ModelScope → HuggingFace 官方
 * 魔搭的仓库路径不一定和 HF 一致，所以模型清单里可以用 scope 字段单独指定；没给 scope 就跳过魔搭。
 *
 * 翻译模型和「AI 理解」模型共用同一个目录，但各有独立的下载实例，互不影响进度与取消。
 */
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { app } = require('electron');
const { findModel } = require('./model-registry');

const MIRRORS = [
  {
    id: 'hf-mirror',
    label: 'HF 镜像（国内最快）',
    url: (model) => `https://hf-mirror.com/${model.repo}/resolve/main/${model.fileName}`,
  },
  {
    id: 'modelscope',
    label: '魔搭 ModelScope',
    // 没有 scope 的仓库在魔搭上路径未知，直接跳过
    url: (model) => (model.scope ? `https://www.modelscope.cn/models/${model.scope}/resolve/master/${model.fileName}` : null),
  },
  {
    id: 'huggingface',
    label: 'HuggingFace 官方',
    url: (model) => `https://huggingface.co/${model.repo}/resolve/main/${model.fileName}`,
  },
];

function modelsDir() {
  const dir = path.join(app.getPath('userData'), 'models');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

class ModelDownloadManager extends EventEmitter {
  /** @param {string} name 实例名，只用于日志与默认清单 */
  constructor(name = 'model') {
    super();
    this.name = name;
    /** @type {'translate'|'chat'|null} 目前只做提示，start 时按 id 全局查找 */
    this.kind = null;
    this.state = {
      modelId: null,
      fileName: null,
      /** 给界面用的友好名称（含体积提示），渲染层不查清单也能显示 */
      label: null,
      kind: null,
      status: 'idle', // idle | downloading | done | error | canceled
      received: 0,
      total: 0,
      percent: 0,
      speed: 0,
      mirror: null,
      triedMirrors: [],
      error: null,
      targetPath: null,
    };
    this.controller = null;
    this.startedAt = 0;
    this.lastTick = 0;
    this.lastBytes = 0;
  }

  getState() {
    return { ...this.state };
  }

  setState(patch) {
    this.state = { ...this.state, ...patch };
    this.emit('progress', this.getState());
  }

  cancel() {
    if (this.controller) {
      this.controller.abort();
      this.controller = null;
    }
    if (this.state.status === 'downloading') this.setState({ status: 'canceled', speed: 0 });
    return { ok: true };
  }

  /**
   * 开始下载（同一实例同一时刻只允许一个任务）
   * @param {string} modelId
   * @param {'translate'|'chat'} [kind] 指定用途，防止 id 撞车
   */
  async start(modelId, kind) {
    if (this.state.status === 'downloading') throw new Error('已有下载任务在进行中');
    const model = findModel(modelId, kind);
    this.kind = model.kind;
    const dir = modelsDir();
    const targetPath = path.join(dir, model.fileName);
    const partPath = `${targetPath}.part`;

    if (fs.existsSync(targetPath) && fs.statSync(targetPath).size > model.approxMB * 1024 * 1024 * 0.9) {
      this.setState({
        modelId: model.id,
        fileName: model.fileName,
        label: model.shortLabel || model.label,
        kind: model.kind,
        status: 'done',
        percent: 100,
        targetPath,
        error: null,
      });
      return this.getState();
    }

    this.setState({
      modelId: model.id,
      fileName: model.fileName,
      label: model.shortLabel || model.label,
      kind: model.kind,
      status: 'downloading',
      received: fs.existsSync(partPath) ? fs.statSync(partPath).size : 0,
      total: model.approxMB * 1024 * 1024,
      percent: 0,
      speed: 0,
      error: null,
      triedMirrors: [],
      mirror: null,
      targetPath,
    });
    this.startedAt = Date.now();
    this.lastTick = Date.now();
    this.lastBytes = this.state.received;

    let lastError = null;
    for (const mirror of MIRRORS) {
      if (this.state.status === 'canceled') break;
      const url = mirror.url(model);
      if (!url) continue;
      try {
        this.setState({ mirror: mirror.label, triedMirrors: [...this.state.triedMirrors, mirror.label] });
        await this.downloadFrom(url, model, partPath);
        // 校验大小，避免镜像返回的 HTML 错误页被当成模型
        const size = fs.existsSync(partPath) ? fs.statSync(partPath).size : 0;
        if (size < model.approxMB * 1024 * 1024 * 0.9) throw new Error(`下载不完整（${(size / 1024 / 1024).toFixed(1)}MB）`);
        fs.renameSync(partPath, targetPath);
        this.setState({ status: 'done', percent: 100, received: size, total: size, speed: 0 });
        console.log(`[model:${this.name}] 下载完成：`, targetPath, `来自 ${mirror.label}`);
        return this.getState();
      } catch (err) {
        lastError = err;
        if (this.state.status === 'canceled') {
          console.warn(`[model:${this.name}] 已取消`);
          return this.getState();
        }
        console.warn(`[model:${this.name}] 源 ${mirror.label} 失败：${err && err.message}`);
      }
    }

    const message = lastError && lastError.message ? lastError.message : '未知错误';
    this.setState({ status: 'error', speed: 0, error: `所有下载源都失败了：${message}` });
    return this.getState();
  }

  /** 单源下载：有 .part 就从断点继续 */
  async downloadFrom(url, model, partPath) {
    const controller = new AbortController();
    this.controller = controller;

    const existing = fs.existsSync(partPath) ? fs.statSync(partPath).size : 0;
    const headers = existing > 0 ? { Range: `bytes=${existing}-` } : {};
    const res = await fetch(url, { headers, redirect: 'follow', signal: controller.signal });
    if (!res.ok && res.status !== 206) throw new Error(`HTTP ${res.status}`);

    const contentLength = Number(res.headers.get('content-length') || 0);
    const total = res.status === 206 ? existing + contentLength : contentLength || model.approxMB * 1024 * 1024;
    let received = existing;
    this.setState({ received, total, percent: total ? Math.min(100, (received / total) * 100) : 0 });

    const file = fs.createWriteStream(partPath, { flags: existing > 0 ? 'a' : 'w' });
    try {
      for await (const chunk of res.body) {
        if (controller.signal.aborted) break;
        received += chunk.length;
        if (!file.write(chunk)) await new Promise((r) => file.once('drain', r));
        const now = Date.now();
        if (now - this.lastTick > 400) {
          const speed = (received - this.lastBytes) / ((now - this.lastTick) / 1000);
          this.lastTick = now;
          this.lastBytes = received;
          this.setState({
            received,
            total,
            percent: total ? Math.min(100, (received / total) * 100) : 0,
            speed,
          });
        }
      }
    } finally {
      await new Promise((resolve) => file.end(resolve));
      this.controller = null;
    }
    if (controller.signal.aborted) {
      const err = new Error('已取消');
      err.name = 'AbortError';
      throw err;
    }
  }
}

/** 翻译模型下载（「设置 → 翻译」用） */
const manager = new ModelDownloadManager('translate');
/** 「AI 理解」本地模型下载（「设置 → AI 模型」用） */
const chatManager = new ModelDownloadManager('chat');

module.exports = { manager, chatManager, ModelDownloadManager, MIRRORS };
