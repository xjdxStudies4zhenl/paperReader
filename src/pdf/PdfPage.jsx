import React, { useEffect, useRef, useState, useCallback } from 'react';
import { pdfjsLib, rectToViewport, pointToNormalized, normalizedToViewport } from './pdfjs.js';

const SELECTION_TOOLS = new Set(['highlight', 'underline', 'strike']);

/** 构建可选中文本层（自己实现，避免依赖 pdf.js 的 viewer 样式）。
 *  返回每个 span 的原始信息，供「译文原位替换」还原 / 替换使用 */
async function buildTextLayer(page, viewport, container) {
  if (!container) return [];
  const textContent = await page.getTextContent();
  container.textContent = '';
  const styles = textContent.styles || {};
  const created = [];
  for (const item of textContent.items) {
    if (!item.str || !item.str.trim()) continue;
    const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
    const angle = Math.atan2(tx[1], tx[0]);
    const fontHeight = Math.hypot(tx[2], tx[3]);
    if (!fontHeight || !Number.isFinite(fontHeight)) continue;
    const span = document.createElement('span');
    span.textContent = item.str;
    span.style.left = `${tx[4] + (angle ? fontHeight * Math.sin(angle) : 0)}px`;
    span.style.top = `${tx[5] - (angle ? fontHeight * Math.cos(angle) : fontHeight)}px`;
    span.style.fontSize = `${fontHeight}px`;
    span.style.fontFamily = (styles[item.fontName] && styles[item.fontName].fontFamily) || 'sans-serif';
    container.appendChild(span);
    created.push({ span, targetWidth: (item.width || 0) * viewport.scale });
  }
  for (const { span, targetWidth } of created) {
    const rect = span.getBoundingClientRect();
    if (rect.width > 0 && targetWidth > 0) {
      const k = targetWidth / rect.width;
      if (Number.isFinite(k) && Math.abs(k - 1) > 0.01) span.style.transform = `scaleX(${k})`;
    }
  }
  return created.map(({ span }) => ({
    span,
    text: span.textContent,
    fontSize: span.style.fontSize,
    transform: span.style.transform,
  }));
}

export default function PdfPage({
  pdf,
  pageNumber,
  scale,
  annotations,
  searchHits,
  searchActiveId,
  translateMode,
  translationSegments,
  tool,
  color,
  selectedId,
  onCreate,
  onPick,
  onSelectText,
  registerRef,
  onVisible,
}) {
  const wrapRef = useRef(null);
  const canvasRef = useRef(null);
  const textRef = useRef(null);
  const renderTaskRef = useRef(null);
  const strokeRef = useRef([]);
  const dragStartRef = useRef(null);

  const [page, setPage] = useState(null);
  const [viewport, setViewport] = useState(null);
  const [inView, setInView] = useState(pageNumber <= 2);
  const [draft, setDraft] = useState(null);
  const [error, setError] = useState(null);

  // 注册 DOM，便于跳页
  useEffect(() => {
    if (registerRef) registerRef(pageNumber, wrapRef.current);
    return () => {
      if (registerRef) registerRef(pageNumber, null);
    };
  }, [pageNumber, registerRef]);

  // 加载页面
  useEffect(() => {
    let alive = true;
    if (!pdf) return undefined;
    setPage(null);
    pdf
      .getPage(pageNumber)
      .then((p) => {
        if (alive) setPage(p);
      })
      .catch((err) => {
        if (alive) setError(err && err.message ? err.message : '页面加载失败');
      });
    return () => {
      alive = false;
    };
  }, [pdf, pageNumber]);

  // 计算视口
  useEffect(() => {
    if (!page) return;
    setViewport(page.getViewport({ scale }));
  }, [page, scale]);

  // 可见性
  useEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return undefined;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setInView(true);
            if (onVisible) onVisible(pageNumber);
          }
        }
      },
      { root: null, rootMargin: '600px 0px', threshold: 0.01 }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [pageNumber, onVisible]);

  // 渲染 canvas + 文本层
  useEffect(() => {
    if (!page || !viewport || !inView) return undefined;
    let cancelled = false;
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const renderViewport = page.getViewport({ scale: scale * dpr });
    canvas.width = Math.floor(renderViewport.width);
    canvas.height = Math.floor(renderViewport.height);
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
    const ctx = canvas.getContext('2d', { alpha: false });

    if (renderTaskRef.current) {
      try {
        renderTaskRef.current.cancel();
      } catch {
        /* ignore */
      }
    }
    const task = page.render({ canvasContext: ctx, viewport: renderViewport });
    renderTaskRef.current = task;
    task.promise
      .then(() => {
        if (!cancelled) return buildTextLayer(page, viewport, textRef.current);
        return undefined;
      })
      .catch((err) => {
        if (err && err.name === 'RenderingCancelledException') return;
        if (!cancelled) setError(err && err.message ? err.message : '渲染失败');
      });
    return () => {
      cancelled = true;
    };
  }, [page, viewport, inView, scale]);

  /** 客户端坐标 → 归一化 PDF 用户坐标 */
  const toNormalized = useCallback(
    (x, y) => {
      if (!page || !viewport) return null;
      return pointToNormalized(page, viewport, x, y);
    },
    [page, viewport]
  );

  const localPoint = (event) => {
    const box = wrapRef.current.getBoundingClientRect();
    return { x: event.clientX - box.left, y: event.clientY - box.top };
  };

  /* ------------------- 文本选中：纯选择时交给浮条，其余直接落标注 ------------------- */
  const handleMouseUp = () => {
    const isPlain = tool === 'text';
    if (!SELECTION_TOOLS.has(tool) && !isPlain) return;
    if (!page || !viewport) return;
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    const wrap = wrapRef.current;
    if (!wrap || !wrap.contains(range.commonAncestorContainer)) return;
    const box = wrap.getBoundingClientRect();
    const rects = [];
    let anchor = null;
    let last = null;
    for (const r of range.getClientRects()) {
      const left = Math.max(r.left, box.left);
      const right = Math.min(r.right, box.right);
      const top = Math.max(r.top, box.top);
      const bottom = Math.min(r.bottom, box.bottom);
      if (right - left < 2 || bottom - top < 2) continue;
      const p1 = toNormalized(left - box.left, top - box.top);
      const p2 = toNormalized(right - box.left, bottom - box.top);
      if (!p1 || !p2) continue;
      rects.push({
        x: Math.min(p1.x, p2.x),
        y: Math.min(p1.y, p2.y),
        w: Math.abs(p2.x - p1.x),
        h: Math.abs(p2.y - p1.y),
      });
      // 第一行作为浮条锚点，最后一行用于判断选区是否跨页
      if (!anchor) anchor = { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
      last = { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    }
    const quote = selection.toString().replace(/\s+/g, ' ').trim();
    if (!rects.length || !quote) return;

    // 纯选择模式：保留选区高亮，弹出「翻译 / 理解」浮条
    if (isPlain) {
      if (onSelectText) onSelectText({ quote, rects, pageNo: pageNumber, anchor, last });
      return;
    }

    selection.removeAllRanges();
    onCreate({ type: tool, color, rects, quote, pageNo: pageNumber });
  };

  /* --------------------------- 框选 / 手绘 / 便签 --------------------------- */
  const handlePointerDown = (event) => {
    if (!page || !viewport) return;
    const point = localPoint(event);
    if (tool === 'box') {
      dragStartRef.current = point;
      setDraft({ kind: 'box', x: point.x, y: point.y, width: 0, height: 0 });
      event.currentTarget.setPointerCapture(event.pointerId);
    } else if (tool === 'ink') {
      strokeRef.current = [point];
      setDraft({ kind: 'ink', points: [point] });
      event.currentTarget.setPointerCapture(event.pointerId);
    } else if (tool === 'note') {
      const normalized = toNormalized(point.x, point.y);
      if (normalized) {
        onCreate({
          type: 'note',
          color,
          rects: [{ x: normalized.x, y: normalized.y, w: 0.016, h: 0.022 }],
          quote: '',
          pageNo: pageNumber,
          editNow: true,
        });
      }
    } else if (tool === 'anno') {
      // 点击空白处取消选择
      onPick && onPick(null);
    }
  };

  const handlePointerMove = (event) => {
    const point = localPoint(event);
    if (tool === 'box' && dragStartRef.current) {
      const start = dragStartRef.current;
      setDraft({
        kind: 'box',
        x: Math.min(start.x, point.x),
        y: Math.min(start.y, point.y),
        width: Math.abs(point.x - start.x),
        height: Math.abs(point.y - start.y),
      });
    } else if (tool === 'ink' && strokeRef.current.length) {
      strokeRef.current.push(point);
      setDraft({ kind: 'ink', points: [...strokeRef.current] });
    }
  };

  const handlePointerUp = () => {
    if (!page || !viewport) {
      setDraft(null);
      return;
    }
    if (tool === 'box' && draft && draft.width > 3 && draft.height > 3) {
      const p1 = toNormalized(draft.x, draft.y);
      const p2 = toNormalized(draft.x + draft.width, draft.y + draft.height);
      if (p1 && p2) {
        onCreate({
          type: 'box',
          color,
          rects: [
            {
              x: Math.min(p1.x, p2.x),
              y: Math.min(p1.y, p2.y),
              w: Math.abs(p2.x - p1.x),
              h: Math.abs(p2.y - p1.y),
            },
          ],
          quote: '',
          pageNo: pageNumber,
        });
      }
    } else if (tool === 'ink' && strokeRef.current.length > 1) {
      const points = strokeRef.current
        .map((p) => toNormalized(p.x, p.y))
        .filter(Boolean);
      if (points.length > 1) {
        onCreate({ type: 'ink', color, inkPaths: [points], quote: '', pageNo: pageNumber });
      }
    }
    dragStartRef.current = null;
    strokeRef.current = [];
    setDraft(null);
  };

  /* ------------------------------- 标注渲染 ------------------------------- */
  const renderAnnotation = (anno) => {
    if (!page || !viewport) return null;
    const selected = String(anno.id) === String(selectedId);
    const opacity = Number(anno.opacity) || 0.35;
    const pointer = tool === 'anno' ? 'auto' : 'none';
    const stroke = selected ? 'var(--accent)' : 'none';
    const elements = [];

    if (anno.anno_type === 'highlight') {
      (anno.rects || []).forEach((rect, i) => {
        const box = rectToViewport(page, viewport, rect);
        elements.push(
          <rect
            key={`h${i}`}
            x={box.x}
            y={box.y}
            width={box.width}
            height={box.height}
            fill={anno.color}
            fillOpacity={opacity}
            stroke={stroke}
            strokeWidth={selected ? 1.5 : 0}
            style={{ pointerEvents: pointer }}
            onClick={() => tool === 'anno' && onPick && onPick(anno)}
          />
        );
      });
    } else if (anno.anno_type === 'underline' || anno.anno_type === 'strike') {
      (anno.rects || []).forEach((rect, i) => {
        const box = rectToViewport(page, viewport, rect);
        const y = anno.anno_type === 'underline' ? box.y + box.height - 1.5 : box.y + box.height / 2;
        elements.push(
          <rect
            key={`u${i}`}
            x={box.x}
            y={y}
            width={box.width}
            height={2}
            fill={anno.color}
            style={{ pointerEvents: pointer }}
            onClick={() => tool === 'anno' && onPick && onPick(anno)}
          />
        );
      });
    } else if (anno.anno_type === 'box') {
      (anno.rects || []).forEach((rect, i) => {
        const box = rectToViewport(page, viewport, rect);
        elements.push(
          <rect
            key={`b${i}`}
            x={box.x}
            y={box.y}
            width={box.width}
            height={box.height}
            fill="none"
            stroke={anno.color}
            strokeWidth={selected ? 2.5 : 1.8}
            style={{ pointerEvents: pointer }}
            onClick={() => tool === 'anno' && onPick && onPick(anno)}
          />
        );
      });
    } else if (anno.anno_type === 'ink') {
      (anno.ink_paths || []).forEach((path, i) => {
        const points = (path || [])
          .map((p) => {
            const [px, py] = normalizedToViewport(page, viewport, p);
            return `${px},${py}`;
          })
          .join(' ');
        elements.push(
          <polyline
            key={`k${i}`}
            points={points}
            fill="none"
            stroke={anno.color}
            strokeWidth={selected ? 3 : 2}
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ pointerEvents: pointer }}
            onClick={() => tool === 'anno' && onPick && onPick(anno)}
          />
        );
      });
    } else if (anno.anno_type === 'note') {
      const rect = (anno.rects || [])[0] || { x: 0.94, y: 0.94, w: 0.02, h: 0.02 };
      const [cx, cy] = normalizedToViewport(page, viewport, {
        x: rect.x + rect.w / 2,
        y: rect.y + rect.h,
      });
      elements.push(
        <g
          key="note"
          style={{ pointerEvents: pointer, cursor: 'pointer' }}
          onClick={() => tool === 'anno' && onPick && onPick(anno)}
        >
          <circle cx={cx} cy={cy} r={9} fill={anno.color} fillOpacity={0.92} stroke={selected ? '#fff' : 'rgba(0,0,0,0.25)'} strokeWidth={1.5} />
          <text x={cx} y={cy + 3.5} textAnchor="middle" fontSize={10} fill="#1b1d23" fontWeight={700}>
            {'✎'}
          </text>
          {anno.content ? <circle cx={cx + 9} cy={cy - 9} r={3.2} fill="#fff" /> : null}
        </g>
      );
    }
    return elements;
  };

  return (
    <div
      className={`pdf-page ${tool === 'box' ? 'cursor-crosshair' : ''} ${tool === 'ink' ? 'cursor-pen' : ''} ${
        tool === 'note' ? 'cursor-note' : ''
      }`}
      ref={wrapRef}
      data-page={pageNumber}
      style={viewport ? { width: viewport.width, height: viewport.height } : undefined}
      onMouseUp={handleMouseUp}
    >
      {!viewport && (
        <div className="pdf-page-placeholder">
          <span>第 {pageNumber} 页</span>
        </div>
      )}
      <canvas ref={canvasRef} className="pdf-canvas" />
      <div className="text-layer" ref={textRef} />
      {/* 译文原位替换层：整段盖同色补丁，译文在块内自动换行（块的位置/大小沿用原文） */}
      {viewport && translateMode && translationSegments && translationSegments.length > 0 && (
        <div className="tr-layer">
          {translationSegments.map((blk) => {
            const box = rectToViewport(page, viewport, blk.rect);
            const px = Math.max((blk.fontSize || 10) * (viewport.scale || 1), 3);
            return (
              <div
                key={blk.id}
                className="tr-block"
                style={{ left: box.x, top: box.y, width: box.width, height: box.height }}
              >
                <div className="tr-body" style={{ fontSize: `${px}px`, lineHeight: blk.lineHeight || 1.32 }}>
                  {blk.text}
                </div>
              </div>
            );
          })}
        </div>
      )}
      <svg
        className="anno-layer"
        width={viewport ? viewport.width : 0}
        height={viewport ? viewport.height : 0}
        viewBox={viewport ? `0 0 ${viewport.width} ${viewport.height}` : undefined}
      >
        {viewport &&
          (searchHits || []).map((hit) => {
            const active = String(hit.id) === String(searchActiveId);
            return hit.rects.map((rect, i) => {
              const box = rectToViewport(page, viewport, rect);
              return (
                <rect
                  key={`s-${hit.id}-${i}`}
                  data-hit-id={hit.id}
                  x={box.x}
                  y={box.y}
                  width={box.width}
                  height={box.height}
                  rx={2}
                  fill={active ? 'rgba(255,150,0,0.72)' : 'rgba(255,212,0,0.38)'}
                  stroke={active ? 'rgba(255,120,0,0.95)' : 'none'}
                  strokeWidth={active ? 1.5 : 0}
                  style={{ pointerEvents: 'none' }}
                />
              );
            });
          })}
        {viewport && annotations.map((anno) => <g key={anno.id}>{renderAnnotation(anno)}</g>)}
        {draft && draft.kind === 'box' && (
          <rect
            x={draft.x}
            y={draft.y}
            width={draft.width}
            height={draft.height}
            fill="none"
            stroke={color}
            strokeWidth={1.8}
            strokeDasharray="6 4"
          />
        )}
        {draft && draft.kind === 'ink' && (
          <polyline
            points={draft.points.map((p) => `${p.x},${p.y}`).join(' ')}
            fill="none"
            stroke={color}
            strokeWidth={2}
            strokeLinecap="round"
          />
        )}
      </svg>
      {(tool === 'box' || tool === 'ink' || tool === 'note' || tool === 'anno') && viewport && (
        <div
          className="hit-layer"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
        />
      )}
      <div className="pdf-page-no">{pageNumber}</div>
      {error && <div className="pdf-page-error">{error}</div>}
    </div>
  );
}
