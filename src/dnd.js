/**
 * 文献卡片拖拽：与「把 PDF 文件拖进窗口导入」共用拖放通道，所以用自定义 MIME 区分。
 * 拖动过程中 dragover 阶段读不到数据，只能看 types；drop 阶段才用 readDocId 取 id。
 */
export const DOC_DRAG_TYPE = 'application/x-pr-doc';

function typesOf(event) {
  const dt = event && event.dataTransfer;
  if (!dt || !dt.types) return [];
  return Array.from(dt.types);
}

/** 是否是「拖动文献卡片」，用于跳过文件导入逻辑 */
export function isDocDrag(event) {
  return typesOf(event).includes(DOC_DRAG_TYPE);
}

export function startDocDrag(event, doc) {
  const dt = event.dataTransfer;
  if (!dt) return;
  dt.effectAllowed = 'move';
  dt.setData(DOC_DRAG_TYPE, String(doc.id));
  // 兼容：某些环境（或调试时）只认 text/plain
  dt.setData('text/plain', doc.title || String(doc.id));
}

export function readDocId(event) {
  const dt = event && event.dataTransfer;
  if (!dt) return null;
  const raw = dt.getData(DOC_DRAG_TYPE);
  const id = Number(raw);
  return Number.isFinite(id) && id > 0 ? id : null;
}
