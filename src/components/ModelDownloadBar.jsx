import React, { useEffect, useRef, useState } from 'react';
import { toast } from '../api.js';
import { translateApi } from '../translate.js';
import { aiApi } from '../ai.js';

const KIND_LABEL = { translate: '翻译模型', chat: '本地理解模型' };
const KIND_ORDER = ['translate', 'chat'];

function formatMB(bytes) {
  const mb = Number(bytes || 0) / 1024 / 1024;
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)}GB` : `${mb.toFixed(1)}MB`;
}

function formatSpeed(bytesPerSec) {
  const mb = Number(bytesPerSec || 0) / 1024 / 1024;
  return mb >= 1 ? `${mb.toFixed(1)} MB/s` : `${Math.round(mb * 1024)} KB/s`;
}

/**
 * 全局模型下载 / 装载进度条。
 *
 * 不管模型是从「设置 → 翻译」「设置 → AI 模型」还是首启安装引导里点的下载，
 * 也不管用户之后跳到哪个页面（甚至关掉设置弹窗），右下角都会常驻一条进度条：
 * 百分比、已下载/总量、速度、当前镜像源，以及取消下载与失败原因。
 * 下载完成后紧接着的「装载进显存」阶段也有不确定进度条提示。
 */
export default function ModelDownloadBar() {
  /** kind -> 下载状态 */
  const [downloads, setDownloads] = useState({});
  /** kind -> 是否正在把模型装进显存 */
  const [loading, setLoading] = useState({});
  const seenRef = useRef({});
  const cancelRef = useRef({});

  useEffect(() => {
    const translate = translateApi();
    const ai = aiApi();
    const local = ai && ai.local;
    const offs = [];

    /** 只在状态真正变化时提示一次，避免每次进度 tick 都刷屏 */
    const applyDownload = (kind, payload, { silent = false } = {}) => {
      if (!payload) return;
      setDownloads((prev) => ({ ...prev, [kind]: payload }));
      const before = seenRef.current[kind];
      const prevStatus = before ? before.status : null;
      seenRef.current[kind] = payload;
      if (payload.status === prevStatus) return;
      const kindName = KIND_LABEL[kind] || '模型';
      const name = payload.label || payload.fileName || '';
      if (silent) return;
      if (payload.status === 'downloading') {
        toast(`开始下载${kindName}${name ? `：${name}` : ''}`, 'info', 4000);
      } else if (payload.status === 'done') {
        toast(`${kindName}下载完成${name ? `：${name}` : ''}`, 'success', 5000);
      } else if (payload.status === 'error') {
        toast(`${kindName}下载失败：${payload.error || '请稍后重试'}`, 'error', 8000);
      } else if (payload.status === 'canceled') {
        toast(`已取消${kindName}下载`, 'warn', 3000);
      }
    };

    const applyStatus = (kind, status) => {
      if (!status || !status.state) return;
      const next = status.state === 'loading';
      setLoading((prev) => (prev[kind] === next ? prev : { ...prev, [kind]: next }));
    };

    if (translate) {
      cancelRef.current.translate = () => translate.cancelDownload().catch(() => {});
      // 先取一次当前状态：应用刚启动时若已有任务在跑，进度条也能接上
      translate.downloadState?.().then((state) => state && applyDownload('translate', state, { silent: true })).catch(() => {});
      translate.status?.().then((info) => info && applyStatus('translate', info)).catch(() => {});
      offs.push(translate.onDownload((payload) => applyDownload('translate', payload)));
      offs.push(translate.onStatus((next) => applyStatus('translate', next)));
    }
    if (local) {
      cancelRef.current.chat = () => local.cancelDownload().catch(() => {});
      local.downloadState?.().then((state) => state && applyDownload('chat', state, { silent: true })).catch(() => {});
      local.status?.().then((info) => info && applyStatus('chat', info)).catch(() => {});
      offs.push(local.onDownload((payload) => applyDownload('chat', payload)));
      offs.push(local.onStatus((next) => applyStatus('chat', next)));
    }

    return () => {
      for (const off of offs) {
        if (typeof off === 'function') off();
      }
    };
  }, []);

  const visible = KIND_ORDER.filter((kind) => {
    const job = downloads[kind];
    return Boolean((job && job.status === 'downloading') || loading[kind]);
  });
  if (!visible.length) return null;

  return (
    <div className="model-bars">
      {visible.map((kind) => {
        const job = downloads[kind];
        const downloading = Boolean(job && job.status === 'downloading');
        const percent = downloading ? Math.min(100, Math.round(job.percent || 0)) : 0;
        const name = job ? job.label || job.fileName || '' : '';
        return (
          <div className={`model-bar ${downloading ? 'downloading' : 'loading'}`} key={kind}>
            <div className="model-bar-head">
              <span className="model-bar-title">
                {downloading ? `正在下载${KIND_LABEL[kind]}` : `正在装载${KIND_LABEL[kind]}到显存`}
                {name ? ` · ${name}` : ''}
              </span>
              {downloading && (
                <button className="model-bar-cancel" onClick={() => cancelRef.current[kind] && cancelRef.current[kind]()}>
                  取消
                </button>
              )}
            </div>
            <div className={`install-bar ${downloading ? '' : 'indeterminate'}`}>
              <span style={downloading ? { width: `${percent}%` } : undefined} />
            </div>
            <div className="model-bar-meta">
              {downloading ? (
                <>
                  <span>
                    {percent}% · {formatMB(job.received)} / {job.total ? formatMB(job.total) : '—'}
                  </span>
                  <span className="spacer" />
                  <span>
                    {formatSpeed(job.speed)}
                    {job.mirror ? ` · ${job.mirror}` : ''}
                  </span>
                </>
              ) : (
                <span>首次装载要几秒到几十秒；下载可随时取消，支持断点续传</span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
