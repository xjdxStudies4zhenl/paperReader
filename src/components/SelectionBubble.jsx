import React, { useEffect, useRef, useState } from 'react';

/**
 * 选区浮条：拖选文字后出现在选区旁，提供「翻译 / 理解 / 高亮 / 复制」。
 * 不改变阅读器当前工具，选完即走。
 */
export default function SelectionBubble({ anchor, quote, onTranslate, onExplain, onHighlight, onCopy, onClose }) {
  const boxRef = useRef(null);
  const [pos, setPos] = useState(null);

  useEffect(() => {
    const box = boxRef.current;
    if (!box || !anchor) return;
    const width = box.offsetWidth || 220;
    const height = box.offsetHeight || 36;
    const margin = 8;
    const headerSafe = 52;

    let left = anchor.right - width;
    let top = anchor.top - height - 6;
    if (top < headerSafe) top = anchor.bottom + 6;
    if (left + width + margin > window.innerWidth) left = window.innerWidth - width - margin;
    if (left < margin) left = margin;
    if (top + height + margin > window.innerHeight) top = Math.max(headerSafe, window.innerHeight - height - margin);

    setPos({ left, top });
  }, [anchor]);

  if (!anchor) return null;

  const guard = (fn) => (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (fn) fn();
  };

  return (
    <div
      className="sel-bubble"
      ref={boxRef}
      style={{ left: pos ? pos.left : anchor.right, top: pos ? pos.top : anchor.top, visibility: pos ? 'visible' : 'hidden' }}
      onMouseDown={(e) => e.preventDefault()}
      title={quote ? quote.slice(0, 120) : ''}
    >
      <button className="sel-btn" onMouseDown={guard(onTranslate)} title="用本地模型翻译这段">
        🌐 翻译
      </button>
      <span className="sel-sep" />
      <button className="sel-btn" onMouseDown={guard(onExplain)} title="交给外部 AI 解释 / 追问">
        🧠 理解
      </button>
      <span className="sel-sep" />
      <button className="sel-btn" onMouseDown={guard(onHighlight)} title="按当前颜色高亮">
        🖍 高亮
      </button>
      <span className="sel-sep" />
      <button className="sel-btn" onMouseDown={guard(onCopy)} title="复制选中文字">
        ⧉
      </button>
      <button className="sel-close" onMouseDown={guard(onClose)} title="关闭">
        ✕
      </button>
    </div>
  );
}
