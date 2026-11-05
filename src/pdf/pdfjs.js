import * as pdfjsLib from 'pdfjs-dist';
import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

// Worker 通过 app:// 自定义协议加载（主进程已注册为特权协议）
pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrc;

export { pdfjsLib };

const base = new URL('.', document.baseURI);

export const PDF_ASSET_PATHS = {
  cMapUrl: new URL('pdfjs/cmaps/', base).href,
  standardFontDataUrl: new URL('pdfjs/standard_fonts/', base).href,
};

/** 载入 PDF：接受 Uint8Array / Buffer */
export async function loadPdfDocument(bytes) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const task = pdfjsLib.getDocument({
    data,
    cMapUrl: PDF_ASSET_PATHS.cMapUrl,
    cMapPacked: true,
    standardFontDataUrl: PDF_ASSET_PATHS.standardFontDataUrl,
    // 本地文件无需校验（也不去联网）
    isEvalSupported: false,
  });
  return task.promise;
}

/** 把 PDF 用户坐标（未旋转、左下原点）归一化区间换算为视口像素坐标 */
export function pageUserBox(page) {
  const view = page.view || [0, 0, page.getViewport({ scale: 1 }).width, page.getViewport({ scale: 1 }).height];
  const [x0, y0, x1, y1] = view;
  return { x0, y0, width: x1 - x0, height: y1 - y0 };
}

/** 归一化矩形 → 视口像素矩形 */
export function rectToViewport(page, viewport, rect) {
  const box = pageUserBox(page);
  const [ax, ay] = viewport.convertToViewportPoint(box.x0 + rect.x * box.width, box.y0 + rect.y * box.height);
  const [bx, by] = viewport.convertToViewportPoint(
    box.x0 + (rect.x + rect.w) * box.width,
    box.y0 + (rect.y + rect.h) * box.height
  );
  return {
    x: Math.min(ax, bx),
    y: Math.min(ay, by),
    width: Math.abs(bx - ax),
    height: Math.abs(by - ay),
  };
}

/** 视口像素点 → 归一化用户坐标 */
export function pointToNormalized(page, viewport, x, y) {
  const box = pageUserBox(page);
  const [px, py] = viewport.convertToPdfPoint(x, y);
  return { x: (px - box.x0) / box.width, y: (py - box.y0) / box.height };
}

/** 归一化点 → 视口像素点 */
export function normalizedToViewport(page, viewport, point) {
  const box = pageUserBox(page);
  return viewport.convertToViewportPoint(box.x0 + point.x * box.width, box.y0 + point.y * box.height);
}
