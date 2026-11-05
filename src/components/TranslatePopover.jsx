import React, { useEffect, useRef, useState } from 'react';
import { toast } from '../api.js';
import { TARGET_LANGS } from '../translate.js';

/**
 * 划词翻译浮层：跟随选区定位，展示流式译文，可复制或存为批注。
 * 模型推理在主进程的 UtilityProcess 里，这里只负责展示。
 */
export default function TranslatePopover({
  anchor,
  quote,
  state,
  target,
  modelState,
  onTargetChange,
  onClose,
  onRetry,
  onSaveAnno,
}) {
  const boxRef = useRef(null);
  const [pos, setPos] = useState({ left: 80, top: 120 });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const width = box.offsetWidth || 380;
    const height = box.offsetHeight || 220;
    const margin = 12;
    // 顶部让出阅读器工具条的高度，避免浮层压住工具栏
    const headerSafe = 52;
    let left = anchor ? anchor.left : 120;
    let top = anchor ? anchor.bottom + 8 : 140;
    if (left + width + margin > window.innerWidth) left = window.innerWidth - width - margin;
    if (left < margin) left = margin;
    if (top + height + margin > window.innerHeight) {
      top = anchor ? anchor.top - height - 8 : window.innerHeight - height - margin;
    }
    if (top < headerSafe) top = headerSafe;
    setPos({ left, top });
  }, [anchor, state.status, state.text]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(state.text || '');
      toast('译文已复制', 'success');
    } catch {
      toast('复制失败，请手动选择文本', 'warn');
    }
  };

  const save = async () => {
    if (!state.text) return;
    setSaving(true);
    try {
      await onSaveAnno();
    } finally {
      setSaving(false);
    }
  };

  const modelReady = modelState && modelState.state === 'ready';
  const loading = state.status === 'loading';
  const streaming = state.status === 'streaming';
  const backend = modelState && modelState.gpu;

  return (
    <div className="translate-pop" ref={boxRef} style={{ left: pos.left, top: pos.top }} onMouseDown={(e) => e.stopPropagation()}>
      <header className="translate-head">
        <span className="translate-title">🌐 划词翻译</span>
        <span className="translate-model" title={modelState && modelState.modelPath ? modelState.modelPath : ''}>
          Hy-MT2 1.8B{backend ? ` · ${backend}` : ''}
        </span>
        <select
          className="translate-lang"
          value={target}
          onChange={(e) => onTargetChange(e.target.value)}
          title="目标语言"
        >
          {TARGET_LANGS.map((lang) => (
            <option key={lang.value} value={lang.value}>
              {lang.label}
            </option>
          ))}
        </select>
        <button className="icon-btn" title="关闭" onClick={onClose}>
          ✕
        </button>
      </header>

      <div className="translate-body">
        <div className="translate-quote" title={quote}>
          {quote}
        </div>

        {state.status === 'error' ? (
          <div className="translate-error">
            <p>{state.error}</p>
            <p className="translate-hint">
              模型设置：设置中心 → 翻译。本地推理只在这台机器上运行，不会联网。
            </p>
          </div>
        ) : (
          <div className={`translate-result ${streaming ? 'streaming' : ''}`}>
            {state.text || (loading ? '正在加载模型 / 准备推理…' : '等待结果…')}
            {streaming && <span className="translate-caret">▍</span>}
          </div>
        )}
      </div>

      <footer className="translate-foot">
        <span className="translate-meta">
          {state.ms ? `${(state.ms / 1000).toFixed(2)}s` : ''}
          {state.text ? ` · ${state.text.length} 字` : ''}
          {!modelReady && loading ? ' · 首次加载模型稍慢' : ''}
        </span>
        <div className="spacer" />
        <button className="ghost-btn tiny" onClick={onRetry} disabled={loading || streaming}>
          重译
        </button>
        <button className="ghost-btn tiny" onClick={copy} disabled={!state.text}>
          复制
        </button>
        <button className="primary-btn tiny-btn" onClick={save} disabled={!state.text || saving}>
          {saving ? '保存中…' : '存为批注'}
        </button>
      </footer>
    </div>
  );
}
