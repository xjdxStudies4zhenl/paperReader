import React, { useEffect, useRef, useState } from 'react';
import { toast } from '../api.js';
import { translateApi } from '../translate.js';

const DISMISS_KEY = 'pr.modelPrompt';

export function isModelPromptDismissed() {
  try {
    return localStorage.getItem(DISMISS_KEY) === 'dismissed';
  } catch {
    return false;
  }
}

export function dismissModelPromptForever() {
  try {
    localStorage.setItem(DISMISS_KEY, 'dismissed');
  } catch {
    /* 忽略持久化失败 */
  }
}

function formatMB(bytes) {
  return `${(Number(bytes || 0) / 1024 / 1024).toFixed(1)}MB`;
}

function formatSpeed(bytesPerSec) {
  const mb = Number(bytesPerSec || 0) / 1024 / 1024;
  return mb >= 1 ? `${mb.toFixed(1)} MB/s` : `${Math.round(mb * 1024)} KB/s`;
}

/**
 * 首次启动（安装后第一次打开）询问是否安装本地翻译模型。
 * 走国内镜像并自动换源，失败可稍后重试；不装只影响划词翻译。
 */
export default function ModelInstallPrompt({ onClose }) {
  const api = translateApi();
  const [state, setState] = useState(null);
  const [progress, setProgress] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [modelId, setModelId] = useState(null);
  const offRef = useRef(null);

  useEffect(() => {
    let alive = true;
    if (!api) return undefined;
    api
      .modelState()
      .then((info) => {
        if (!alive) return;
        setState(info);
        setModelId(info.defaultModelId);
      })
      .catch((err) => alive && setError(err.message || '读取模型状态失败'));
    offRef.current = api.onDownload((payload) => {
      setProgress(payload);
      if (payload.status === 'done') {
        setBusy(false);
        toast('翻译模型安装完成，可以开始划词翻译了', 'success', 5000);
        onClose(true);
      }
      if (payload.status === 'error') {
        setBusy(false);
        setError(payload.error || '下载失败');
      }
      if (payload.status === 'canceled') setBusy(false);
    });
    return () => {
      alive = false;
      if (offRef.current) offRef.current();
    };
  }, [api, onClose]);

  const installedCount = state ? state.installed : 0;
  const target = state && state.models ? state.models.find((m) => m.id === modelId) : null;
  const downloading = progress && progress.status === 'downloading';
  const percent = progress && progress.percent ? Math.min(100, Math.round(progress.percent)) : 0;

  const start = async () => {
    if (!api) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.download(modelId);
      if (res && res.status === 'done') {
        toast('翻译模型已就绪', 'success');
        onClose(true);
      } else if (res && res.status === 'error') {
        setError(res.error || '下载失败');
      }
    } catch (err) {
      setError(err.message || '下载失败');
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    if (api) await api.cancelDownload().catch(() => {});
    setBusy(false);
  };

  return (
    <div className="modal-mask">
      <div className="modal install-modal">
        <header className="modal-head">
          <h2>安装本地翻译模型</h2>
        </header>

        <div className="modal-body">
          <p className="section-desc">
            划词翻译需要在<b>本机</b>运行 Hy-MT2-1.8B 模型。首次安装后需要下载一次模型文件（约 1.08GB），
            之后完全离线，译文不会离开这台机器。
          </p>

          <div className="install-points">
            <div className="install-point">
              <span className="install-icon">📡</span>
              <div>
                <b className="install-point-title">自动选最快源</b>
                <p>依次尝试 HF 国内镜像 → 魔搭 ModelScope → 官方源，失败自动换下一个，支持断点续传。</p>
              </div>
            </div>
            <div className="install-point">
              <span className="install-icon">📦</span>
              <div>
                <b className="install-point-title">存到哪里</b>
                <p className="install-path">{target ? target.path : '用户数据目录 / models'}</p>
              </div>
            </div>
            <div className="install-point">
              <span className="install-icon">🚫</span>
              <div>
                <b className="install-point-title">不安装的后果</b>
                <p>
                  只有「🌐 划译（划词翻译）」用不了，点击时会提示去装；阅读、高亮/批注、分类标签、导出、数据库等功能
                  <b>完全不受影响</b>，启动速度和占用也不变。装好后也可以随时在「设置 → 翻译」里卸载释放显存。
                </p>
              </div>
            </div>
          </div>

          {installedCount > 0 && (
            <div className="db-result ok">检测到本机已有 {installedCount} 个翻译模型，可直接使用。</div>
          )}
          {error && <div className="db-result error">{error}</div>}
          {downloading && (
            <div className="install-progress">
              <div className="install-bar">
                <span style={{ width: `${percent}%` }} />
              </div>
              <div className="install-progress-meta">
                <span>
                  {formatMB(progress.received)} / {formatMB(progress.total)} · {percent}%
                </span>
                <span>
                  {formatSpeed(progress.speed)}
                  {progress.mirror ? ` · ${progress.mirror}` : ''}
                </span>
              </div>
            </div>
          )}
          {progress && progress.status === 'error' && progress.triedMirrors && progress.triedMirrors.length > 0 && (
            <p className="pane-tip">已尝试的下载源：{progress.triedMirrors.join(' → ')}</p>
          )}
        </div>

        <footer className="modal-foot">
          <button className="ghost-btn" onClick={() => onClose(false)} disabled={Boolean(downloading)}>
            稍后再说
          </button>
          <button
            className="ghost-btn"
            onClick={() => {
              dismissModelPromptForever();
              onClose(false);
            }}
            disabled={Boolean(downloading)}
          >
            不再提示
          </button>
          <div className="spacer" />
          {downloading ? (
            <button className="ghost-btn" onClick={cancel}>
              取消下载
            </button>
          ) : (
            <button className="primary-btn" onClick={start} disabled={busy || installedCount > 0}>
              {busy ? '准备中…' : `下载并安装（约 ${target ? target.approxMB : 1080}MB）`}
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}
