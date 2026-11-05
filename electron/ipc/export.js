'use strict';
/**
 * 导出 IPC：
 * 1) Markdown 标注清单（含原文引用、批注、回复）
 * 2) 扁平化 PDF（把标注直接绘制进 PDF 副本）
 */
const { ipcMain, dialog, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
const db = require('../db');
const { docFilePath } = require('../library');

function ticket(handler) {
  return async (_event, ...args) => {
    try {
      return { ok: true, data: await handler(...args) };
    } catch (err) {
      console.error('[ipc:export]', err);
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  };
}

const TYPE_LABEL = {
  highlight: '高亮',
  underline: '下划线',
  strike: '删除线',
  box: '框选',
  ink: '手绘',
  note: '便签',
};

function parseJson(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

async function loadDocBundle(docId) {
  const doc = await db.queryOne('SELECT * FROM pr_doc_info WHERE id = ? AND is_deleted = 0', [docId]);
  if (!doc) throw new Error('文献不存在');
  const annos = await db.query(
    `SELECT * FROM pr_anno_info WHERE doc_id = ? AND is_deleted = 0 ORDER BY page_no ASC, id ASC`,
    [docId]
  );
  const replies = await db.query(
    `SELECT r.* FROM pr_anno_reply_rd r
       JOIN pr_anno_info a ON a.id = r.anno_id
      WHERE a.doc_id = ? AND a.is_deleted = 0
      ORDER BY r.created_at ASC`,
    [docId]
  );
  const tags = await db.query(
    `SELECT t.name FROM pr_doc_tag_rd rd JOIN pr_tag_info t ON t.id = rd.tag_id WHERE rd.doc_id = ?`,
    [docId]
  );
  return {
    doc,
    tags: tags.map((t) => t.name),
    annos: annos.map((a) => ({
      ...a,
      rects: parseJson(a.rects, []),
      ink_paths: parseJson(a.ink_paths, []),
      replies: replies.filter((r) => r.anno_id === a.id),
    })),
  };
}

function buildMarkdown({ doc, tags, annos }) {
  const lines = [];
  lines.push(`# ${doc.title}`);
  lines.push('');
  const meta = [];
  if (doc.authors) meta.push(`作者：${doc.authors}`);
  if (doc.year) meta.push(`年份：${doc.year}`);
  if (doc.journal) meta.push(`期刊/会议：${doc.journal}`);
  if (doc.doi) meta.push(`DOI：${doc.doi}`);
  if (tags.length) meta.push(`标签：${tags.join('、')}`);
  meta.push(`页数：${doc.page_count || '-'}`);
  meta.push(`批注数：${annos.length}`);
  if (doc.last_read_at) meta.push(`最近阅读：${doc.last_read_at}`);
  for (const m of meta) lines.push(`- ${m}`);
  lines.push('');

  if (doc.abstract) {
    lines.push('## 摘要');
    lines.push('');
    lines.push(doc.abstract.trim());
    lines.push('');
  }

  if (!annos.length) {
    lines.push('> 该文献暂无标注。');
  }

  let lastPage = null;
  let index = 0;
  for (const a of annos) {
    if (a.page_no !== lastPage) {
      lines.push('');
      lines.push(`## 第 ${a.page_no} 页`);
      lines.push('');
      lastPage = a.page_no;
    }
    index += 1;
    const label = TYPE_LABEL[a.anno_type] || a.anno_type;
    lines.push(`### ${index}. [${label}] ${a.color || ''}`.trim());
    lines.push('');
    if (a.quote && a.quote.trim()) {
      lines.push('> ' + a.quote.trim().replace(/\n+/g, '\n> '));
      lines.push('');
    }
    if (a.content && a.content.trim()) {
      lines.push(`**批注：** ${a.content.trim()}`);
      lines.push('');
    }
    for (const r of a.replies || []) {
      lines.push(`- 回复（${r.author}，${r.created_at}）：${r.content}`);
    }
    if ((a.replies || []).length) lines.push('');
  }

  lines.push('');
  lines.push('---');
  lines.push(`由 Paper Reader 于 ${new Date().toLocaleString('zh-CN')} 导出`);
  return lines.join('\n');
}

function hexToRgb(hex) {
  const value = String(hex || '#ffd400').replace('#', '');
  const full = value.length === 3 ? value.split('').map((c) => c + c).join('') : value;
  const num = parseInt(full || 'ffd400', 16);
  return rgb(((num >> 16) & 255) / 255, ((num >> 8) & 255) / 255, (num & 255) / 255);
}

async function exportMarkdown(docId) {
  const bundle = await loadDocBundle(docId);
  const win = require('electron').BrowserWindow.getFocusedWindow();
  const res = await dialog.showSaveDialog(win, {
    title: '导出标注清单',
    defaultPath: `${bundle.doc.title.replace(/[\\/:*?"<>|]/g, '_')}-标注.md`,
    filters: [{ name: 'Markdown', extensions: ['md'] }],
  });
  if (res.canceled || !res.filePath) return { canceled: true };
  const md = buildMarkdown(bundle);
  await fs.promises.writeFile(res.filePath, md, 'utf8');
  await db.execute(
    'INSERT INTO pr_export_rd (doc_id, export_type, file_path, anno_count) VALUES (?, ?, ?, ?)',
    [docId, 'markdown', res.filePath, bundle.annos.length]
  );
  shell.showItemInFolder(res.filePath);
  return { filePath: res.filePath, annoCount: bundle.annos.length };
}

async function exportFlattenPdf(docId) {
  const bundle = await loadDocBundle(docId);
  const filePath = docFilePath(bundle.doc);
  const bytes = await fs.promises.readFile(filePath);
  const out = await renderAnnotatedPdf(bytes, bundle);

  const win = require('electron').BrowserWindow.getFocusedWindow();
  const res = await dialog.showSaveDialog(win, {
    title: '导出标注版 PDF',
    defaultPath: `${bundle.doc.title.replace(/[\\/:*?"<>|]/g, '_')}-已标注.pdf`,
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  });
  if (res.canceled || !res.filePath) return { canceled: true };
  await fs.promises.writeFile(res.filePath, out);
  await db.execute(
    'INSERT INTO pr_export_rd (doc_id, export_type, file_path, anno_count) VALUES (?, ?, ?, ?)',
    [docId, 'pdf', res.filePath, bundle.annos.length]
  );
  shell.showItemInFolder(res.filePath);
  return { filePath: res.filePath, annoCount: bundle.annos.length };
}

/** 把标注绘制进 PDF 副本（纯函数，便于测试） */
async function renderAnnotatedPdf(bytes, bundle) {
  const pdf = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const font = await pdf.embedFont(StandardFonts.HelveticaBold);
  const pages = pdf.getPages();

  let noteIndex = 0;
  for (const anno of bundle.annos) {
    const page = pages[anno.page_no - 1];
    if (!page) continue;
    const { width, height } = page.getSize();
    const color = hexToRgb(anno.color);
    const opacity = Number(anno.opacity) || 0.35;

    for (const rect of anno.rects || []) {
      const x = rect.x * width;
      const y = rect.y * height;
      const w = rect.w * width;
      const h = rect.h * height;
      if (w <= 0 || h <= 0) continue;
      if (anno.anno_type === 'highlight') {
        page.drawRectangle({ x, y, width: w, height: h, color, opacity });
      } else if (anno.anno_type === 'underline') {
        page.drawLine({
          start: { x, y: y + 1 },
          end: { x: x + w, y: y + 1 },
          thickness: 1.2,
          color,
          opacity: 0.95,
        });
      } else if (anno.anno_type === 'strike') {
        page.drawLine({
          start: { x, y: y + h / 2 },
          end: { x: x + w, y: y + h / 2 },
          thickness: 1.1,
          color,
          opacity: 0.95,
        });
      } else if (anno.anno_type === 'box') {
        page.drawRectangle({ x, y, width: w, height: h, borderColor: color, borderWidth: 1.6, opacity: 0 });
      }
    }

    if (anno.anno_type === 'ink') {
      for (const stroke of anno.ink_paths || []) {
        for (let i = 1; i < stroke.length; i += 1) {
          const p0 = stroke[i - 1];
          const p1 = stroke[i];
          page.drawLine({
            start: { x: p0.x * width, y: p0.y * height },
            end: { x: p1.x * width, y: p1.y * height },
            thickness: 1.6,
            color,
            opacity: 0.9,
          });
        }
      }
    }

    if (anno.anno_type === 'note') {
      noteIndex += 1;
      const rect = (anno.rects || [])[0];
      const cx = (rect ? rect.x + rect.w : 0.94) * width;
      const cy = (rect ? rect.y + rect.h : 0.94) * height;
      page.drawCircle({ x: cx, y: cy, size: 9, color, opacity: 0.92 });
      const text = String(noteIndex);
      page.drawText(text, {
        x: cx - font.widthOfTextAtSize(text, 10) / 2,
        y: cy - 3.5,
        size: 10,
        font,
        color: rgb(1, 1, 1),
      });
      if (anno.content) {
        page.drawText(`#${noteIndex}`, {
          x: Math.min(width - 40, cx + 12),
          y: cy - 3,
          size: 8,
          font,
          color: rgb(0.35, 0.35, 0.35),
          opacity: 0.8,
        });
      }
    }
  }

  // 附页：批注清单（编号 + 页码 + 英文摘要；中文正文请用 Markdown 导出）
  const notes = bundle.annos.filter((a) => a.content && a.content.trim());
  if (notes.length) {
    const summary = pdf.addPage([595.28, 841.89]);
    const fontRegular = await pdf.embedFont(StandardFonts.Helvetica);
    summary.drawText('Annotated comments', { x: 56, y: 780, size: 16, font, color: rgb(0.1, 0.1, 0.1) });
    let y = 748;
    notes.forEach((a, i) => {
      if (y < 60) return;
      const head = `#${i + 1}  p.${a.page_no}  [${a.anno_type}]`;
      summary.drawText(head, { x: 56, y, size: 10, font, color: rgb(0.15, 0.15, 0.15) });
      y -= 14;
      const ascii = String(a.content || '')
        .replace(/[^\x20-\x7E]/g, '?')
        .slice(0, 96);
      summary.drawText(ascii || '-', { x: 68, y, size: 9, font: fontRegular, color: rgb(0.35, 0.35, 0.35) });
      y -= 20;
    });
  }

  return pdf.save();
}

function registerExportHandlers() {
  ipcMain.handle('export:markdown', ticket((docId) => exportMarkdown(docId)));
  ipcMain.handle('export:flatten', ticket((docId) => exportFlattenPdf(docId)));
}

module.exports = { registerExportHandlers, buildMarkdown, renderAnnotatedPdf, loadDocBundle, TYPE_LABEL };
