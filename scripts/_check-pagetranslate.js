// 段落块切分 + 字号自适应 自检（逻辑与 src/pdf/page-translate.js 保持一致）
const fs = require('node:fs');
const path = require('node:path');

const CJK_RE = /[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/;
const LATIN_RE = /[A-Za-z\u00c0-\u024f\u0370-\u03ff\u0400-\u04ff]/;
const LINE_HEIGHT = 1.32;
const PAD_TOP = 0.88;
const PAD_BOTTOM = 0.22;

function estimateWidth(text, fontSize) {
  let width = 0;
  for (const ch of String(text || '')) {
    if (CJK_RE.test(ch)) width += fontSize;
    else if (ch === ' ') width += fontSize * 0.28;
    else if (/[A-Z]/.test(ch)) width += fontSize * 0.62;
    else width += fontSize * 0.52;
  }
  return width;
}

const MATH_TOKEN_RE = /\b(exp|log|ln|sin|cos|tan|cot|argmin|argmax|min|max|softmax|sigmoid|norm|var|cov|det|dim|tr)\s*[([{]/i;
const MATH_SYMBOL_RE = /[∑∏∫∈√∂∇∮≤≥≈≠≡±∓⊗⊕ˆˇ˜¯˙¨∗⋅∙∘°′″]/;
const MATH_CHAR_RE = /[=<>^_{}()[\]|+−\-*/·\\/]/g;

function looksLikeMath(text) {
  const value = String(text || '');
  if (!value.trim()) return false;
  const t0 = value.trim();
  if (/^[,.;:)\]}]/.test(t0) && t0.length < 24) return true;
  if (MATH_TOKEN_RE.test(value)) return true;
  if (MATH_SYMBOL_RE.test(value)) return true;
  if (/\^[A-Za-z{]/.test(value) || /_\{/.test(value) || /\\(frac|left|right|sum|int)/.test(value)) return true;
  const trimmed = value.trim();
  const total = Math.max(1, trimmed.length);
  const mathChars = (trimmed.match(MATH_CHAR_RE) || []).length;
  const letters = (trimmed.match(/[A-Za-z]/g) || []).length;
  if (mathChars / total > 0.1 && letters / total < 0.45) return true;
  if (mathChars >= 6 && mathChars / total > 0.18) return true;
  const tokens = trimmed.split(/\s+/).filter(Boolean);
  if (tokens.length >= 3) {
    const varish = tokens.filter((t) => /^[A-Za-z]?[A-Za-z]*[0-9*^_]*$/.test(t) && t.length <= 6 && !/^(the|and|of|in|is|we|to|for)$/i.test(t)).length;
    if (varish / tokens.length > 0.7 && letters / total < 0.6) return true;
  }
  return false;
}

function shouldTranslate(text) {
  const value = String(text || '').trim();
  if (value.length < 4) return false;
  if (!LATIN_RE.test(value)) return false;
  if (looksLikeMath(value)) return false;
  if (/^[\d\s.,;:%°±×÷=<>≤≥()\[\]{}\-–—_/\\|'"`~^*+#&@$!?]+$/.test(value)) return false;
  const letters = (value.match(/[A-Za-z]/g) || []).length;
  if (letters / value.length < 0.25) return false;
  return true;
}

/** 与 page-translate.js 的 collectGraphics 一致：收集图片框与矢量图元 */
async function collectGraphics(page, pdfjsLib) {
  const view = page.view;
  const box = { x0: view[0], y0: view[1], width: view[2] - view[0], height: view[3] - view[1] };
  const out = [];
  const ops = await page.getOperatorList();
  const O = pdfjsLib.OPS || {};
  const IMAGE_OPS = new Set(
    [O.paintImageXObject, O.paintImageXObjectRepeat, O.paintInlineImageXObject, O.paintInlineImageXObjectGroup, O.paintImageMaskXObject, O.paintImageMaskXObjectGroup, O.paintImageMaskXObjectRepeat, O.paintJpegXObject].filter((v) => typeof v === 'number')
  );
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [];
  const point = (x, y) => [ctm[0] * x + ctm[2] * y + ctm[4], ctm[1] * x + ctm[3] * y + ctm[5]];
  const push = (ax, ay, bx, by, kind) => {
    const pad = kind === 'path' ? 0.6 : 0;
    const minX = Math.min(ax, bx) - pad, maxX = Math.max(ax, bx) + pad;
    const minY = Math.min(ay, by) - pad, maxY = Math.max(ay, by) + pad;
    const w = (maxX - minX) / box.width, h = (maxY - minY) / box.height;
    if (kind === 'path' ? w < 0.0002 || h < 0.0002 : w < 0.001 || h < 0.001) return;
    if (w > 0.92 && h > 0.92) return;
    out.push({ kind, x: (minX - box.x0) / box.width, y: (minY - box.y0) / box.height, w, h });
  };
  for (let i = 0; i < ops.fnArray.length; i += 1) {
    const fn = ops.fnArray[i];
    if (fn === O.save) { stack.push(ctm.slice()); continue; }
    if (fn === O.restore) { if (stack.length) ctm = stack.pop(); continue; }
    if (fn === O.transform) { ctm = pdfjsLib.Util.transform(ctm, ops.argsArray[i]); continue; }
    if (IMAGE_OPS.has(fn)) {
      const p1 = point(0, 0), p2 = point(1, 1);
      push(p1[0], p1[1], p2[0], p2[1], 'image');
      continue;
    }
    if (fn === O.constructPath) {
      const args = ops.argsArray[i] || [];
      const minMax = args[2];
      try {
        // pdfjs 6 的 minMax 是 Float32Array
        if (minMax && minMax.length >= 4) {
          const p1 = point(minMax[0], minMax[1]);
          const p2 = point(minMax[2], minMax[3]);
          push(p1[0], p1[1], p2[0], p2[1], 'path');
        } else if (Array.isArray(args[1])) {
          let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
          const walk = (arr) => {
            if (!arr) return;
            if (typeof arr[0] === 'number') {
              for (let k = 0; k + 1 < arr.length; k += 2) {
                const p = point(arr[k], arr[k + 1]);
                if (p[0] < minX) minX = p[0];
                if (p[0] > maxX) maxX = p[0];
                if (p[1] < minY) minY = p[1];
                if (p[1] > maxY) maxY = p[1];
              }
              return;
            }
            for (const sub of arr) walk(sub);
          };
          walk(args[1]);
          if (Number.isFinite(minX)) push(minX, minY, maxX, maxY, 'path');
        }
      } catch { /* ignore */ }
    }
  }
  return { graphics: out, box };
}

function groupLines(items) {
  const lines = [];
  let current = null;
  for (const item of items) {
    const tol = Math.max(1.5, item.fontHeight * 0.45);
    const gap = current ? item.x - current.lastEnd : 0;
    const sameLine =
      current &&
      Math.abs(current.baseline - item.y) <= tol &&
      item.x >= current.left - item.fontHeight * 2 &&
      gap <= item.fontHeight * 3.2;
    if (!sameLine) {
      current = {
        text: '',
        left: item.x,
        right: item.x + item.width,
        baseline: item.y,
        fontHeight: item.fontHeight,
        lastEnd: item.x,
      };
      lines.push(current);
    }
    const spacing = item.x - current.lastEnd;
    if (current.text && spacing > item.fontHeight * 0.18) current.text += ' ';
    current.text += item.str;
    current.left = Math.min(current.left, item.x);
    current.right = Math.max(current.right, item.x + item.width);
    current.lastEnd = item.x + item.width;
    current.fontHeight = Math.max(current.fontHeight, item.fontHeight);
  }
  for (const line of lines) line.text = line.text.replace(/\s+/g, ' ').trim();
  return lines.filter((l) => l.text);
}

function mergeSuperScripts(lines) {
  const out = [];
  for (const line of lines) {
    const host = out[out.length - 1];
    if (host) {
      const smaller = line.fontHeight <= host.fontHeight * 0.86;
      const above = line.baseline - host.baseline;
      const near = above >= -host.fontHeight * 0.25 && above <= host.fontHeight * 0.7;
      const insideX = line.left >= host.left - host.fontHeight && line.right <= host.right + host.fontHeight * 6;
      if (smaller && near && insideX) {
        host.text = `${host.text}${line.text}`;
        host.right = Math.max(host.right, line.right);
        host.left = Math.min(host.left, line.left);
        continue;
      }
    }
    out.push({ ...line });
  }
  return out;
}

function groupBlocks(lines) {
  const blocks = [];
  let current = null;
  const flush = () => {
    if (current && current.lines.length) blocks.push(current);
    current = null;
  };
  for (const line of lines) {
    if (!shouldTranslate(line.text)) {
      flush();
      continue;
    }
    if (!current) {
      current = { lines: [line], left: line.left, right: line.right, fontHeight: line.fontHeight };
      continue;
    }
    const prev = current.lines[current.lines.length - 1];
    const gapY = prev.baseline - line.baseline;
    const sameColumn = Math.abs(line.left - current.left) <= Math.max(prev.fontHeight * 2.2, 6);
    const similarSize = Math.abs(line.fontHeight - prev.fontHeight) <= prev.fontHeight * 0.12;
    const consecutive = gapY > 0 && gapY <= prev.fontHeight * 1.7;
    const notTooLong = current.lines.length < 14;
    if (sameColumn && similarSize && consecutive && notTooLong) {
      current.lines.push(line);
      current.left = Math.min(current.left, line.left);
      current.right = Math.max(current.right, line.right);
      current.fontHeight = Math.max(current.fontHeight, line.fontHeight);
    } else {
      flush();
      current = { lines: [line], left: line.left, right: line.right, fontHeight: line.fontHeight };
    }
  }
  flush();
  return blocks;
}

function fitFontSize(text, width, height, baseFontSize) {
  const length = Math.max(1, text.length);
  const avgEm = estimateWidth(text, 1) / length;
  let fontSize = baseFontSize;
  const minSize = baseFontSize * 0.62;
  let lines = 1;
  for (let i = 0; i < 10; i += 1) {
    const perLine = Math.max(1, Math.floor(width / (fontSize * avgEm)));
    lines = Math.max(1, Math.ceil(length / perLine));
    const need = lines * fontSize * LINE_HEIGHT;
    if (need <= height * 0.96) break;
    const next = Math.max(minSize, fontSize * Math.min(0.96, Math.sqrt((height * 0.96) / need)));
    if (next >= fontSize - 0.01) break;
    fontSize = next;
  }
  return { fontSize, lines };
}

function blockRect(block, box, lines) {
  const maxBaseline = Math.max(...block.lines.map((l) => l.baseline));
  const minBaseline = Math.min(...block.lines.map((l) => l.baseline));
  const fontHeight = block.fontHeight;
  const left = block.left;
  let width = Math.max(block.right - block.left, fontHeight * 2);
  if (block.lines.length === 1 && box) {
    let limit = box.x0 + box.width - 8;
    if (Array.isArray(lines)) {
      const top = maxBaseline + fontHeight;
      const bottom = minBaseline - fontHeight;
      for (const line of lines) {
        if (line.baseline > top || line.baseline < bottom) continue;
        if (line.left > block.right + 2) limit = Math.min(limit, line.left - 2);
      }
    }
    const room = Math.max(0, limit - (left + width));
    width += Math.min(box.width * 0.12, room);
  }
  const top = maxBaseline + fontHeight * PAD_TOP;
  const bottom = minBaseline - fontHeight * PAD_BOTTOM;
  return { x: left, y: bottom, w: width, h: Math.max(top - bottom, fontHeight * 0.8) };
}

function mergeSameLineBlocks(items, box) {
  const maxWidth = box && box.width ? box.width * 0.70 : Infinity;
  const sorted = items.slice().sort((a, b) => b.rect.y - a.rect.y || a.rect.x - b.rect.x);
  const out = [];
  for (const item of sorted) {
    const host = out.find((o) => {
      const oy = Math.min(o.rect.y + o.rect.h, item.rect.y + item.rect.h) - Math.max(o.rect.y, item.rect.y);
      const minH = Math.min(o.rect.h, item.rect.h);
      const gapX = Math.max(o.rect.x, item.rect.x) - Math.min(o.rect.x + o.rect.w, item.rect.x + item.rect.w);
      const mergedWidth = Math.max(o.rect.x + o.rect.w, item.rect.x + item.rect.w) - Math.min(o.rect.x, item.rect.x);
      return oy > minH * 0.55 && gapX < Math.max(o.block.fontHeight, item.block.fontHeight) * 1.2 && mergedWidth <= maxWidth;
    });
    if (!host) { out.push({ ...item }); continue; }
    const left = Math.min(host.rect.x, item.rect.x);
    const right = Math.max(host.rect.x + host.rect.w, item.rect.x + item.rect.w);
    const bottom = Math.min(host.rect.y, item.rect.y);
    const top = Math.max(host.rect.y + host.rect.h, item.rect.y + item.rect.h);
    const leftFirst = host.rect.x <= item.rect.x;
    host.translated = leftFirst ? `${host.translated} ${item.translated}`.trim() : `${item.translated} ${host.translated}`.trim();
    host.rect = { x: left, y: bottom, w: right - left, h: top - bottom };
    host.block = { ...host.block, fontHeight: Math.max(host.block.fontHeight, item.block.fontHeight), lines: host.block.lines.concat(item.block.lines) };
  }
  return out;
}
function dropOverlappingBlocks(items) {
  const kept = [];
  const sorted = items.slice().sort((a, b) => b.rect.w * b.rect.h - a.rect.w * a.rect.h);
  for (const item of sorted) {
    const clash = kept.some((o) => {
      const oy = Math.min(o.rect.y + o.rect.h, item.rect.y + item.rect.h) - Math.max(o.rect.y, item.rect.y);
      const ox = Math.min(o.rect.x + o.rect.w, item.rect.x + item.rect.w) - Math.max(o.rect.x, item.rect.x);
      return oy > 1 && ox > 1;
    });
    if (!clash) kept.push(item);
  }
  return kept;
}
function resolveOverlaps(items) {
  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) {
      const a = items[i].rect;
      const b = items[j].rect;
      const xOverlap = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      if (xOverlap <= 1) continue;
      const aTop = a.y + a.h;
      const bTop = b.y + b.h;
      const overlap = Math.min(aTop, bTop) - Math.max(a.y, b.y);
      if (overlap <= 0.8) continue;
      const upper = aTop >= bTop ? a : b;
      const lower = aTop >= bTop ? b : a;
      const trimmed = upper.y - lower.y;
      if (trimmed >= lower.h * 0.5 && trimmed > 0) lower.h = trimmed;
      else {
        const newBottom = lower.y + lower.h;
        const newH = upper.y + upper.h - newBottom;
        if (newH > upper.h * 0.5 && newH > 0) {
          upper.y = newBottom;
          upper.h = newH;
        }
      }
    }
  }
}

function fakeTranslate(text) {
  // 保守估计：中文约英文 0.55 字符数
  const n = Math.max(2, Math.round(text.length * 0.55));
  return '译文'.repeat(Math.ceil(n / 2)).slice(0, n);
}

(async () => {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const root = process.argv[2] || 'D:/workspace/4papers';
  const pagesArg = (process.argv[3] || '1,3').split(',').map((n) => Number(n)).filter(Boolean);
  const walk = (dir, out = []) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, out);
      else if (/\.pdf$/i.test(entry.name)) out.push(full);
    }
    return out;
  };
  const file = fs.statSync(root).isDirectory() ? walk(root)[0] : root;
  console.log('测试文件:', path.basename(file), '| 页:', pagesArg.join(','));

  const data = new Uint8Array(fs.readFileSync(file));
  const doc = await pdfjs.getDocument({ data, useWorkerFetch: false, isEvalSupported: false, useSystemFonts: false }).promise;

  for (const pageNo of pagesArg) {
    if (pageNo > doc.numPages) continue;
    const page = await doc.getPage(pageNo);
    const content = await page.getTextContent();
    const items = [];
    for (const item of content.items) {
      const str = typeof item.str === 'string' ? item.str : '';
      if (!str || !str.trim()) continue;
      const t = item.transform || [1, 0, 0, 1, 0, 0];
      const fontHeight = Math.hypot(t[2], t[3]);
      if (!fontHeight || !Number.isFinite(fontHeight)) continue;
      items.push({ str, x: t[4], y: t[5], width: Number(item.width) || 0, fontHeight });
    }

    const { graphics, box } = await collectGraphics(page, pdfjs);
    const imageRects = graphics.filter((g) => g.kind === 'image' && g.w * g.h > 0.0008);
    const vectorRects = graphics.filter((g) => g.kind === 'path');
    console.log(`\n== 第 ${pageNo} 页: 文本项 ${items.length} | 图片框 ${imageRects.length} | 矢量图元 ${vectorRects.length}`);
    for (const img of imageRects.slice(0, 4)) {
      console.log(`   image: (${img.x.toFixed(3)},${img.y.toFixed(3)}) ${img.w.toFixed(3)}×${img.h.toFixed(3)}`);
    }

    const isFigureArea = (normRect) => {
      const area = Math.max(normRect.w * normRect.h, 1e-9);
      for (const img of imageRects) {
        const ix = Math.min(normRect.x + normRect.w, img.x + img.w) - Math.max(normRect.x, img.x);
        const iy = Math.min(normRect.y + normRect.h, img.y + img.h) - Math.max(normRect.y, img.y);
        if (ix > 0 && iy > 0 && (ix * iy) / area > 0.22) return true;
      }
      let hits = 0;
      for (const v of vectorRects) {
        const cx = v.x + v.w / 2, cy = v.y + v.h / 2;
        if (cx >= normRect.x && cx <= normRect.x + normRect.w && cy >= normRect.y && cy <= normRect.y + normRect.h) {
          hits += 1;
          if (hits >= 5) return true;
        }
      }
      return false;
    };

    const rawLines = groupLines(items);
    const lines = mergeSuperScripts(rawLines);
    const blocks = groupBlocks(lines);
    // 行级：被排除的公式行（这些根本不会进入块，所以不计入块级统计）
    const mathLines = lines.filter((l) => looksLikeMath(l.text));
    console.log(`   行级公式行: ${mathLines.length}（示例：${mathLines.slice(0, 2).map((l) => '「' + l.text.slice(0, 34) + '」').join(' ') || '无'}）`);
    let skippedMath = 0;
    let skippedOverflow = 0;
    let skippedFigure = 0;
    const mathSamples = [];
    const figureSamples = [];
    const pending = [];
    for (const block of blocks) {
      const srcText = block.lines.map((l) => l.text).join(' ');
      const text = block.lines.map((l) => l.text).join(' ').replace(/\s+/g, ' ').trim();
      const rect = blockRect(block, box, lines);
      if (!text || !shouldTranslate(text) || looksLikeMath(text)) {
        skippedMath += 1;
        if (mathSamples.length < 4) mathSamples.push(text.slice(0, 60));
        continue;
      }
      if (isFigureArea({
        x: (rect.x - box.x0) / box.width,
        y: (rect.y - box.y0) / box.height,
        w: rect.w / box.width,
        h: rect.h / box.height,
      })) {
        skippedFigure += 1;
        if (figureSamples.length < 3) figureSamples.push(text.slice(0, 40));
        continue;
      }
      pending.push({ block, translated: fakeTranslate(srcText), rect, srcText });
    }
    const merged = mergeSameLineBlocks(pending, box);
    resolveOverlaps(merged);
    const finalItems = dropOverlappingBlocks(merged);
    pending.length = 0;
    pending.push(...finalItems);
    console.log(`   块 ${blocks.length} → 候选 ${pending.length} | 跳过公式 ${skippedMath} | 跳过插图 ${skippedFigure}`);

    // 与生产代码一致：放不下的块直接丢弃，最终只检查真正输出的块
    const problems = [];
    const emitted = [];
    pending.forEach((item, idx) => {
      const { rect, block, translated } = item;
      const fit = fitFontSize(translated, rect.w, rect.h, block.fontHeight);
      const need = fit.lines * fit.fontSize * LINE_HEIGHT;
      if (need > rect.h * 1.05) {
        skippedOverflow += 1;
        return;
      }
      if (rect.x < box.x0 - 2 || rect.x + rect.w > box.x0 + box.width + 2) problems.push(`块${idx} 横向出界`);
      if (rect.y < box.y0 - 2 || rect.y + rect.h > box.y0 + box.height + 2) problems.push(`块${idx} 纵向出界`);
      if (fit.fontSize < block.fontHeight * 0.6) problems.push(`块${idx} 缩字过多`);
      emitted.push({ idx, rect, text: block.lines.map((l) => l.text).join(' ').slice(0, 30) });
    });
    for (let i = 0; i < emitted.length; i += 1) {
      for (let j = i + 1; j < emitted.length; j += 1) {
        const a = emitted[i].rect, b = emitted[j].rect;
        const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
        const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
        if (oy > 1 && ox > 1) {
          problems.push(`块${emitted[i].idx} 与 块${emitted[j].idx} 重叠`);
          if (problems.length <= 4) {
            const f = (r) => `x=${r.x.toFixed(1)} y=${r.y.toFixed(1)} w=${r.w.toFixed(1)} h=${r.h.toFixed(1)}`;
            console.log(`      [重叠] #${emitted[i].idx}「${emitted[i].text}」${f(a)}  <->  #${emitted[j].idx}「${emitted[j].text}」${f(b)}`);
          }
        }
      }
    }
    console.log(`   实际输出 ${emitted.length} 块 | 放不下丢弃 ${skippedOverflow}`);
    console.log('   跳过的公式块示例:', mathSamples.map((s) => `「${s}」`).join(' ') || '无');
    console.log('   跳过的插图块示例:', figureSamples.map((s) => `「${s}」`).join(' ') || '无');
    console.log('   问题:', problems.length ? problems.slice(0, 5).join(' | ') : '无');
  }
  process.exit(0);
})();
