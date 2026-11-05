import { pdfjsLib, pageUserBox } from './pdfjs.js';

/**
 * PDF 全文检索：
 * - 按页抽取文本项，拼成整页纯文本（item 边界记入集合）
 * - 匹配时空白可跨 item 边界（PDF 里词间距常常不带空格字符，靠定位拉开）
 * - 命中位置换算为「归一化用户坐标」矩形（与标注同一坐标系，缩放无关）
 */

/** pdf 文档 → 每页文本缓存（WeakMap，文档释放后自动回收） */
const pageTextCache = new WeakMap();

function isSpace(ch) {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v' || ch === '\u00a0' || ch === '\u3000';
}

/** 折叠大小写 + 全角空格，便于比较 */
function foldChar(ch) {
  if (ch === '\u00a0' || ch === '\u3000') return ' ';
  return ch.toLowerCase();
}

/** 抽取单页文本：plain（无分隔拼接）+ item 边界 + 每项在 plain 中的偏移 */
async function getPageText(pdf, pageNo) {
  let cache = pageTextCache.get(pdf);
  if (!cache) {
    cache = new Map();
    pageTextCache.set(pdf, cache);
  }
  if (cache.has(pageNo)) return cache.get(pageNo);

  const page = await pdf.getPage(pageNo);
  const content = await page.getTextContent();
  const items = [];
  const offsets = [];
  const boundaries = new Set();
  let plain = '';
  for (const item of content.items) {
    const str = typeof item.str === 'string' ? item.str : '';
    if (!str) continue;
    if (plain.length > 0) boundaries.add(plain.length);
    offsets.push(plain.length);
    items.push({
      str,
      transform: item.transform,
      width: Number(item.width) || 0,
      height: Number(item.height) || 0,
    });
    plain += str;
    // 有换行标记时补一个空格，让「上一行末词 下一行首词」也能被短语搜到
    if (item.hasEOL) {
      plain += ' ';
    }
  }
  const entry = { page, box: pageUserBox(page), items, offsets, boundaries, plain };
  // 预折叠大小写，避免每次搜索重复整页 toLowerCase
  entry.folded = plain.split('').map(foldChar);
  cache.set(pageNo, entry);
  return entry;
}

/**
 * 在整页文本里找所有匹配。
 * 语义（不区分大小写）：
 * - 查询里的连续空白 ≥1 个空白字符，或恰好落在 item 之间（词被 PDF 拆成两项、无空格字符）
 * - 其余字符逐个相等
 */
function findMatches(entry, query) {
  const { plain, boundaries, folded: textFold } = entry;
  const q = query
    .split('')
    .map(foldChar)
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  if (!q) return [];
  const text = plain;
  const matches = [];
  const n = text.length;
  const m = q.length;

  for (let i = 0; i < n; i += 1) {
    let ti = i;
    let qi = 0;
    let ok = true;
    while (qi < m) {
      const qc = q[qi];
      if (qc === ' ') {
        // 查询空白：吃掉一段空白字符；零宽仅允许恰好在 item 边界上
        let tj = ti;
        while (tj < n && isSpace(text[tj])) tj += 1;
        if (tj > ti) {
          ti = tj;
        } else if (boundaries.has(ti)) {
          /* item 之间没有空格字符：允许零宽跨越 */
        } else {
          ok = false;
          break;
        }
        qi += 1;
        continue;
      }
      if (ti >= n || textFold[ti] !== qc) {
        ok = false;
        break;
      }
      ti += 1;
      qi += 1;
    }
    if (ok && ti > i) {
      matches.push({ start: i, end: ti });
      i = ti - 1; // 非重叠推进（下一轮 i+1 即 ti）
    }
  }
  return matches;
}

/** 命中区间 [start,end) → 一组归一化矩形（每段 item 一个） */
function rectsForMatch(entry, match) {
  const { items, offsets, box } = entry;
  const rects = [];
  for (let k = 0; k < items.length; k += 1) {
    const item = items[k];
    const off = offsets[k];
    const len = item.str.length;
    const c0 = Math.max(0, match.start - off);
    const c1 = Math.min(len, match.end - off);
    if (c1 <= c0) continue;
    // 跳过纯空白段
    let onlySpace = true;
    for (let c = c0; c < c1; c += 1) {
      if (!isSpace(item.str[c])) {
        onlySpace = false;
        break;
      }
    }
    if (onlySpace) continue;

    const t = item.transform;
    const dirLen = Math.hypot(t[0], t[1]) || 1;
    const ux = t[0] / dirLen;
    const uy = t[1] / dirLen;
    // 字体"向上"向量（模长≈字号），比固定 0.8 系数更贴合旋转/缩放文本
    const vx = t[2];
    const vy = t[3];
    const fontH = Math.hypot(vx, vy) || item.height || 10;
    const charW = len > 0 ? item.width / len : fontH * 0.5;
    const pointAt = (charIdx) => [t[4] + ux * charW * charIdx, t[5] + uy * charW * charIdx];
    const [ax, ay] = pointAt(c0);
    const [bx, by] = pointAt(c1);
    const kTop = 1.12;
    const kBot = -0.22;
    const xs = [ax + vx * kBot, ax + vx * kTop, bx + vx * kBot, bx + vx * kTop];
    const ys = [ay + vy * kBot, ay + vy * kTop, by + vy * kBot, by + vy * kTop];
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);

    rects.push({
      x: (minX - box.x0) / box.width,
      y: (minY - box.y0) / box.height,
      w: (maxX - minX) / box.width,
      h: (maxY - minY) / box.height,
    });
  }
  return rects;
}

/**
 * 搜索整份 PDF。
 * @param {object} pdf pdf.js 文档
 * @param {string} query 关键词
 * @param {object} [opts] { onProgress(hitsSoFar) } 逐页回调，便于渐进显示
 * @returns {Promise<Array<{id:string, pageNo:number, rects:Array}>>}
 */
export async function searchInPdf(pdf, query, opts = {}) {
  const q = String(query || '').trim();
  if (!pdf || !q) return [];
  const hits = [];
  for (let pageNo = 1; pageNo <= pdf.numPages; pageNo += 1) {
    try {
      const entry = await getPageText(pdf, pageNo);
      const matches = findMatches(entry, q);
      for (const match of matches) {
        const rects = rectsForMatch(entry, match);
        if (!rects.length) continue;
        hits.push({ id: `${pageNo}:${match.start}`, pageNo, rects });
      }
    } catch {
      /* 单页失败忽略 */
    }
    if (opts.onProgress) opts.onProgress(hits.slice());
    // 让出主线程，避免长文档卡住输入
    if (pageNo % 4 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return hits;
}
