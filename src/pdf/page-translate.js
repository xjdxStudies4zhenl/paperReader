/**
 * 页面「段落块级」切分 + 批量翻译 → 原位替换所需数据。
 *
 * 为什么是块级而不是行级：
 * 行级替换只能单行不换行，中文稍长就会溢出压到相邻内容，且补丁盖不全原文会「重影」。
 * 块级做法：把连续同栏同字号的正文行聚成段落块 → 整块盖同色补丁 → 译文按块宽自动换行、
 * 字号自适应填满块高。重排只发生在块内部，块的位置/大小沿用原文，所以版式不动。
 */
import { pageUserBox, pdfjsLib } from './pdfjs.js';

const CJK_RE = /[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/;
const LATIN_RE = /[A-Za-z\u00c0-\u024f\u0370-\u03ff\u0400-\u04ff]/;

/** 强数学记号（出现即判定为公式） */
const MATH_TOKEN_RE = /\b(exp|log|ln|sin|cos|tan|cot|argmin|argmax|min|max|softmax|sigmoid|norm|var|cov|det|dim|tr)\s*[([{]/i;
const MATH_SYMBOL_RE = /[∑∏∫∈√∂∇∮≤≥≈≠≡±∓⊗⊕ˆˇ˜¯˙¨∗⋅∙∘°′″]/;
const MATH_CHAR_RE = /[=<>^_{}()[\]|+−\-*/·\\/]/g;

/** 块内行高倍数 */
const LINE_HEIGHT = 1.32;
/** 块框相对字号的上下留白（覆盖 ascent/descent，同时避免与相邻块重叠） */
const PAD_TOP = 0.88;
const PAD_BOTTOM = 0.22;

/** 粗略估算文本宽度（以字号为单位）：CJK 约 1em，拉丁约 0.52em */
export function estimateWidth(text, fontSize) {
  let width = 0;
  for (const ch of String(text || '')) {
    if (CJK_RE.test(ch)) width += fontSize;
    else if (ch === ' ') width += fontSize * 0.28;
    else if (/[A-Z]/.test(ch)) width += fontSize * 0.62;
    else width += fontSize * 0.52;
  }
  return width;
}

/** 公式检测：命中任意强特征，或数学符号密度超标就不翻（保留原样） */
export function looksLikeMath(text) {
  const value = String(text || '');
  if (!value.trim()) return false;
  const trimmed0 = value.trim();
  // 以标点开头的短片段：多半是公式/排版被打断的残片
  if (/^[,.;:)\]}]/.test(trimmed0) && trimmed0.length < 24) return true;
  if (MATH_TOKEN_RE.test(value)) return true;
  if (MATH_SYMBOL_RE.test(value)) return true;
  // LaTeX 残留：^Mvis、_{vis}、\frac 之类
  if (/\^[A-Za-z{]/.test(value) || /_\{/.test(value) || /\\(frac|left|right|sum|int)/.test(value)) return true;
  const trimmed = value.trim();
  const total = Math.max(1, trimmed.length);
  const mathChars = (trimmed.match(MATH_CHAR_RE) || []).length;
  const letters = (trimmed.match(/[A-Za-z]/g) || []).length;
  // 数学字符密度高、且字母占比不高（区分「p < 0.05」这种顺带提到的句子）
  if (mathChars / total > 0.1 && letters / total < 0.45) return true;
  if (mathChars >= 6 && mathChars / total > 0.18) return true;
  // 变量堆：短行里大量 单字母/字母数字 混合 token（Mvis yi、b*、tz+）
  const tokens = trimmed.split(/\s+/).filter(Boolean);
  if (tokens.length >= 3) {
    const varish = tokens.filter((t) => /^[A-Za-z]?[A-Za-z]*[0-9*^_]*$/.test(t) && t.length <= 6 && !/^(the|and|of|in|is|we|to|for)$/i.test(t)).length;
    if (varish / tokens.length > 0.7 && letters / total < 0.6) return true;
  }
  return false;
}

/** 这一行值得翻译吗：有拉丁字母、长度够、不是纯数字/公式碎片 */
export function shouldTranslate(text) {
  const value = String(text || '').trim();
  if (value.length < 4) return false;
  if (!LATIN_RE.test(value)) return false;
  if (looksLikeMath(value)) return false;
  if (/^[\d\s.,;:%°±×÷=<>≤≥()\[\]{}\-–—_/\\|'"`~^*+#&@$!?]+$/.test(value)) return false;
  const letters = (value.match(/[A-Za-z]/g) || []).length;
  if (letters / value.length < 0.25) return false;
  return true;
}

/** 稳定的小哈希（djb2），用于判断缓存是否对应当前原文 */
export function hashText(text) {
  let hash = 5381;
  const value = String(text || '');
  for (let i = 0; i < value.length; i += 1) {
    hash = ((hash << 5) + hash + value.charCodeAt(i)) & 0xffffffff;
  }
  return (hash >>> 0).toString(16);
}

/**
 * 收集页面上的图形区域（归一化坐标）。
 * - kind='image'：位图（照片、截图型图表）
 * - kind='path'：矢量图元（图表的框线、箭头、填充块）
 * 用于判断哪些文字属于公式 / 插图，避免把补丁盖到图片上。
 */
export async function collectGraphics(page) {
  const box = pageUserBox(page);
  const out = [];
  let ops;
  try {
    ops = await page.getOperatorList();
  } catch {
    return out;
  }
  const O = pdfjsLib.OPS || {};
  const IMAGE_OPS = new Set(
    [
      O.paintImageXObject,
      O.paintImageXObjectRepeat,
      O.paintInlineImageXObject,
      O.paintInlineImageXObjectGroup,
      O.paintImageMaskXObject,
      O.paintImageMaskXObjectGroup,
      O.paintImageMaskXObjectRepeat,
      O.paintJpegXObject,
    ].filter((v) => typeof v === 'number')
  );
  const PATH_OP = typeof O.constructPath === 'number' ? O.constructPath : -1;
  const SAVE = typeof O.save === 'number' ? O.save : -1;
  const RESTORE = typeof O.restore === 'number' ? O.restore : -1;
  const TRANSFORM = typeof O.transform === 'number' ? O.transform : -1;

  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [];
  const point = (x, y) => [ctm[0] * x + ctm[2] * y + ctm[4], ctm[1] * x + ctm[3] * y + ctm[5]];

  const push = (ax, ay, bx, by, kind) => {
    // 细线（图表框线/箭头）的包围盒可能厚度为 0，先撑开一点再判断
    const pad = kind === 'path' ? 0.6 : 0;
    const minX = Math.min(ax, bx) - pad;
    const maxX = Math.max(ax, bx) + pad;
    const minY = Math.min(ay, by) - pad;
    const maxY = Math.max(ay, by) + pad;
    const w = (maxX - minX) / box.width;
    const h = (maxY - minY) / box.height;
    if (kind === 'path' ? w < 0.0002 || h < 0.0002 : w < 0.001 || h < 0.001) return;
    if (w > 0.92 && h > 0.92) return; // 整页背景色块，不算图形
    out.push({ kind, x: (minX - box.x0) / box.width, y: (minY - box.y0) / box.height, w, h });
  };

  for (let i = 0; i < ops.fnArray.length; i += 1) {
    const fn = ops.fnArray[i];
    if (fn === SAVE) {
      stack.push(ctm.slice());
      continue;
    }
    if (fn === RESTORE) {
      if (stack.length) ctm = stack.pop();
      continue;
    }
    if (fn === TRANSFORM) {
      ctm = pdfjsLib.Util.transform(ctm, ops.argsArray[i]);
      continue;
    }
    if (IMAGE_OPS.has(fn)) {
      // 图片画在当前 CTM 下的单位方块里
      const p1 = point(0, 0);
      const p2 = point(1, 1);
      push(p1[0], p1[1], p2[0], p2[1], 'image');
      continue;
    }
    if (fn === PATH_OP) {
      const args = ops.argsArray[i] || [];
      const coords = args[1];
      const minMax = args[2];
      try {
        // pdfjs 6 的 minMax 是 Float32Array（不能用 Array.isArray 判断）
        if (minMax && minMax.length >= 4) {
          const p1 = point(minMax[0], minMax[1]);
          const p2 = point(minMax[2], minMax[3]);
          push(p1[0], p1[1], p2[0], p2[1], 'path');
        } else if (Array.isArray(coords)) {
          let minX = Infinity;
          let minY = Infinity;
          let maxX = -Infinity;
          let maxY = -Infinity;
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
          walk(coords);
          if (Number.isFinite(minX)) push(minX, minY, maxX, maxY, 'path');
        }
      } catch {
        /* 坐标异常的路径忽略 */
      }
    }
  }
  return out;
}

/** 抽取一页文本项（过滤规则与 PdfPage.buildTextLayer 一致） */
export function collectItems(content) {
  const items = [];
  for (const item of content.items) {
    const str = typeof item.str === 'string' ? item.str : '';
    if (!str || !str.trim()) continue;
    const t = item.transform || [1, 0, 0, 1, 0, 0];
    const fontHeight = Math.hypot(t[2], t[3]);
    if (!fontHeight || !Number.isFinite(fontHeight)) continue;
    items.push({ str, x: t[4], y: t[5], width: Number(item.width) || 0, fontHeight });
  }
  return items;
}

/** 按基线聚成行 */
export function groupLines(items) {
  const lines = [];
  let current = null;
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    const tol = Math.max(1.5, item.fontHeight * 0.45);
    const gap = current ? item.x - current.lastEnd : 0;
    // 同一行：基线接近 + 不回跳 + 不是跨栏的大跳跃（双栏论文关键）
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
  for (const line of lines) {
    line.text = line.text.replace(/\s+/g, ' ').trim();
    delete line.lastEnd;
  }
  return lines.filter((line) => line.text);
}

/**
 * 把上标 / 脚注编号（字号明显更小、基线略高、横向落在本行范围内）并回所属行，
 * 否则它们会自成一个「行」，翻译后变成压在正文上的小色块。
 */
export function mergeSuperScripts(lines) {
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

/** 行 → 段落块（连续、同栏、字号接近） */
export function groupBlocks(lines) {
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
    const gapY = prev.baseline - line.baseline; // PDF 里 y 向上，下一行基线更小
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

/** 块内行拼成段落文本（处理行末连字符断词） */
function blockText(block) {
  let text = '';
  for (const line of block.lines) {
    if (!text) {
      text = line.text;
      continue;
    }
    if (/[A-Za-z]-$/.test(text)) text = text.slice(0, -1) + line.text;
    else text = `${text} ${line.text}`;
  }
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * 计算块内字号：让译文按块宽换行后刚好填满块高。
 * @returns {{fontSize:number, lines:number}}
 */
function fitFontSize(text, width, height, baseFontSize) {
  const length = Math.max(1, text.length);
  const avgEm = estimateWidth(text, 1) / length; // 平均每个字符占多少 em
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

/** 块 → 用户坐标矩形（y 向上，rect.y 为下边界） */
function blockRect(block, box, lines) {
  const maxBaseline = Math.max(...block.lines.map((l) => l.baseline));
  const minBaseline = Math.min(...block.lines.map((l) => l.baseline));
  const fontHeight = block.fontHeight;
  const left = block.left;
  let width = Math.max(block.right - block.left, fontHeight * 2);
  // 单行块（标题/图注等）右侧通常还有页边空白，允许借用一点，免得标题被压得过小；
  // 但不能跨过相邻栏/相邻内容的左边界，否则补丁会盖到旁边那一栏
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

/**
 * 合并「同一视觉行被公式/符号打断」产生的碎片块：
 * 纵向基本齐平、横向紧邻或重叠的块合成一块（文本按 x 顺序拼接），
 * 否则它们的补丁会互相压盖。
 */
function mergeSameLineBlocks(items, box) {
  const sorted = items.slice().sort((a, b) => b.rect.y - a.rect.y || a.rect.x - b.rect.x);
  const maxWidth = box && box.width ? box.width * 0.70 : Infinity;
  const out = [];
  for (const item of sorted) {
    const host = out.find((o) => {
      const oy = Math.min(o.rect.y + o.rect.h, item.rect.y + item.rect.h) - Math.max(o.rect.y, item.rect.y);
      const minH = Math.min(o.rect.h, item.rect.h);
      // 横向必须紧邻（碎片），不能隔着栏间距
      const gapX = Math.max(o.rect.x, item.rect.x) - Math.min(o.rect.x + o.rect.w, item.rect.x + item.rect.w);
      const mergedWidth = Math.max(o.rect.x + o.rect.w, item.rect.x + item.rect.w) - Math.min(o.rect.x, item.rect.x);
      return oy > minH * 0.55 && gapX < Math.max(o.block.fontHeight, item.block.fontHeight) * 1.2 && mergedWidth <= maxWidth;
    });
    if (!host) {
      out.push({ ...item });
      continue;
    }
    const left = Math.min(host.rect.x, item.rect.x);
    const right = Math.max(host.rect.x + host.rect.w, item.rect.x + item.rect.w);
    const bottom = Math.min(host.rect.y, item.rect.y);
    const top = Math.max(host.rect.y + host.rect.h, item.rect.y + item.rect.h);
    const leftFirst = host.rect.x <= item.rect.x;
    host.translated = leftFirst
      ? `${host.translated} ${item.translated}`.trim()
      : `${item.translated} ${host.translated}`.trim();
    host.rect = { x: left, y: bottom, w: right - left, h: top - bottom };
    host.block = {
      ...host.block,
      fontHeight: Math.max(host.block.fontHeight, item.block.fontHeight),
      lines: host.block.lines.concat(item.block.lines),
    };
  }
  return out;
}

/** 最后一道保险：仍有重叠就按面积从大到小保留，重叠的小块丢弃（那块留英文原文） */
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

/**
 * 解决同栏块之间的纵向重叠：优先压较低那块的上沿；压得太狠就反过来压较高那块的下沿。
 */
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
      // 方案 A：把较低那块的上沿压到较高块的下沿
      const trimmed = upper.y - lower.y;
      if (trimmed >= lower.h * 0.5 && trimmed > 0) {
        lower.h = trimmed;
      } else {
        // 方案 B：反过来把较高块的下沿压到较低块的上沿
        const newBottom = lower.y + lower.h;
        const newH = upper.y + upper.h - newBottom;
        if (newH > upper.h * 0.5 && newH > 0) {
          upper.y = newBottom;
          upper.h = newH;
        }
      }
    }
  }
  function upperTopOf(rect) {
    return rect.y + rect.h;
  }
}

/**
 * 生成一页的替换块（归一化 PDF 用户坐标，缩放无关）。
 * @returns {Promise<{blocks:Array, hash:string, blockCount:number, sourceText:string}>}
 */
export async function buildPageBlocks(page, translate, options = {}) {
  const content = await page.getTextContent();
  const items = collectItems(content);
  if (!items.length) return { blocks: [], hash: hashText(''), blockCount: 0, sourceText: '' };

  const box = pageUserBox(page);
  const lines = mergeSuperScripts(groupLines(items));
  const sourceText = lines.map((line) => line.text).join('\n');
  const hash = hashText(sourceText);
  const blocks = groupBlocks(lines);
  if (!blocks.length) return { blocks: [], hash, blockCount: 0, sourceText };

  const maxChars = Math.max(200, Number(options.maxChars) || 1400);

  // 公式 / 插图区域检测：这些区域整块跳过（不翻译、不打补丁，保留原样）
  const graphics = await collectGraphics(page);
  const imageRects = graphics.filter((g) => g.kind === 'image' && g.w * g.h > 0.0008);
  const vectorRects = graphics.filter((g) => g.kind === 'path');

  /** 块是否落在插图 / 图表区域里（注意：块框是用户坐标，图形框是归一化坐标） */
  const isFigureArea = (normRect) => {
    const area = Math.max(normRect.w * normRect.h, 1e-9);
    for (const img of imageRects) {
      const ix = Math.min(normRect.x + normRect.w, img.x + img.w) - Math.max(normRect.x, img.x);
      const iy = Math.min(normRect.y + normRect.h, img.y + img.h) - Math.max(normRect.y, img.y);
      if (ix > 0 && iy > 0 && (ix * iy) / area > 0.22) return true;
    }
    let hits = 0;
    for (const v of vectorRects) {
      const cx = v.x + v.w / 2;
      const cy = v.y + v.h / 2;
      if (cx >= normRect.x && cx <= normRect.x + normRect.w && cy >= normRect.y && cy <= normRect.y + normRect.h) {
        hits += 1;
        if (hits >= 5) return true;
      }
    }
    return false;
  };

  // 1) 先翻译（拿到译文才好算字号）；公式 / 插图块直接跳过
  const pending = [];
  let skippedMath = 0;
  let skippedFigure = 0;
  for (const block of blocks) {
    const text = blockText(block);
    if (!text || !shouldTranslate(text) || looksLikeMath(text)) {
      skippedMath += 1;
      continue;
    }
    const rect = blockRect(block, box, lines);
    // 图形区域判定用归一化坐标，与 collectGraphics 的输出一致
    const normRect = {
      x: (rect.x - box.x0) / box.width,
      y: (rect.y - box.y0) / box.height,
      w: rect.w / box.width,
      h: rect.h / box.height,
    };
    if (isFigureArea(normRect)) {
      skippedFigure += 1;
      continue;
    }
    let out = '';
    try {
      out = await translate(text.slice(0, maxChars));
    } catch {
      out = '';
    }
    const translated = String(out || '')
      .replace(/\r/g, '')
      .replace(/\n{2,}/g, '\n')
      .replace(/[ \t]+/g, ' ')
      .trim();
    if (!translated) continue;
    pending.push({ block, translated, rect });
  }
  if (!pending.length) return { blocks: [], hash, blockCount: 0, sourceText, skippedMath, skippedFigure };

  // 2) 合并同行碎片 + 消重叠
  const merged = mergeSameLineBlocks(pending, box);
  resolveOverlaps(merged);
  const finalItems = dropOverlappingBlocks(merged);

  // 3) 字号自适应 + 归一化；实在放不下的块直接跳过（宁可留英文，也不要挤压变形）
  const result = [];
  let skippedOverflow = 0;
  finalItems.forEach((item) => {
    const { rect, block, translated } = item;
    const fit = fitFontSize(translated, rect.w, rect.h, block.fontHeight);
    const need = fit.lines * fit.fontSize * LINE_HEIGHT;
    if (need > rect.h * 1.05) {
      skippedOverflow += 1;
      return;
    }
    // 裁进页面边界，避免个别超宽行把补丁画到页面外
    const cx0 = Math.max(rect.x, box.x0);
    const cx1 = Math.min(rect.x + rect.w, box.x0 + box.width);
    const cy0 = Math.max(rect.y, box.y0);
    const cy1 = Math.min(rect.y + rect.h, box.y0 + box.height);
    if (cx1 - cx0 <= 1 || cy1 - cy0 <= 1) return;
    result.push({
      id: `b${result.length + 1}`,
      text: translated,
      rect: {
        x: (cx0 - box.x0) / box.width,
        y: (cy0 - box.y0) / box.height,
        w: (cx1 - cx0) / box.width,
        h: (cy1 - cy0) / box.height,
      },
      fontSize: Number(fit.fontSize.toFixed(2)),
      lineHeight: LINE_HEIGHT,
      srcLines: block.lines.length,
    });
  });

  return { blocks: result, hash, blockCount: result.length, sourceText, skippedMath, skippedFigure, skippedOverflow };
}

/** 兼容旧调用名（只返回块数组） */
export const buildPageSegments = async (page, translate, options) => {
  const res = await buildPageBlocks(page, translate, options);
  return res.blocks;
};
