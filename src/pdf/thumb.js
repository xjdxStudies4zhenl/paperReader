import { loadPdfDocument } from './pdfjs.js';

/** 渲染 PDF 首页为 JPEG DataURL，用于文献卡片缩略图 */
export async function generateThumbnail(bytes, maxWidth = 260) {
  const pdf = await loadPdfDocument(bytes);
  const pageCount = pdf.numPages;
  const page = await pdf.getPage(1);
  const base = page.getViewport({ scale: 1 });
  const scale = Math.min(1.5, maxWidth / base.width);
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.floor(viewport.width));
  canvas.height = Math.max(1, Math.floor(viewport.height));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport }).promise;
  const url = canvas.toDataURL('image/jpeg', 0.74);
  try {
    await pdf.destroy();
  } catch {
    /* ignore */
  }
  return { url, pageCount };
}

/** 取库内 PDF → 生成缩略图 → 落库（供导入后自动补图使用） */
export async function buildThumbForDoc(docId) {
  const bytes = await window.pr.docs.fileBytes(docId);
  const { url, pageCount } = await generateThumbnail(bytes);
  await window.pr.docs.saveThumb(docId, url, pageCount);
  return { pageCount };
}
