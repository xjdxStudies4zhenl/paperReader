// 搜索匹配算法自检（与 src/pdf/search.js 中 findMatches 保持一致的逻辑副本）
function isSpace(ch) {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v' || ch === '\u00a0' || ch === '\u3000';
}
function foldChar(ch) {
  if (ch === '\u00a0' || ch === '\u3000') return ' ';
  return ch.toLowerCase();
}
function buildEntry(items, eolFlags = []) {
  let plain = '';
  const boundaries = new Set();
  for (let k = 0; k < items.length; k += 1) {
    if (plain.length > 0) boundaries.add(plain.length);
    plain += items[k];
    if (eolFlags[k]) plain += ' ';
  }
  return { plain, boundaries, folded: plain.split('').map(foldChar) };
}
function findMatches(entry, query) {
  const { plain, boundaries, folded: textFold } = entry;
  const q = query.split('').map(foldChar).join('').replace(/\s+/g, ' ').trim();
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
        let tj = ti;
        while (tj < n && isSpace(text[tj])) tj += 1;
        if (tj > ti) {
          ti = tj;
        } else if (boundaries.has(ti)) {
          /* 零宽跨 item */
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
      i = ti - 1;
    }
  }
  return matches;
}

let pass = 0;
let fail = 0;
function t(name, entry, query, expectCount, expectText) {
  const ms = findMatches(entry, query);
  const okCount = ms.length === expectCount;
  const okText = expectText === undefined || (ms[0] && entry.plain.slice(ms[0].start, ms[0].end) === expectText);
  if (okCount && okText) {
    pass += 1;
    console.log('PASS', name);
  } else {
    fail += 1;
    console.log('FAIL', name, 'got', ms.length, 'matches', JSON.stringify(ms), 'text:', ms[0] && JSON.stringify(entry.plain.slice(ms[0].start, ms[0].end)));
  }
}

// 1) 单 item 内短语
t('单 item 短语', buildEntry(['hello world abc hello world']), 'hello world', 2, 'hello world');
// 2) 词被拆到两个 item、无空格字符：短语搜到
t('跨 item 无空格短语', buildEntry(['hello', 'world']), 'hello world', 1, 'helloworld');
// 3) 查询不带空格也能跨 item（词内拆分）
t('跨 item 词内拼接', buildEntry(['ther', 'mal']), 'thermal', 1, 'thermal');
// 4) 单 item 中没有空格时，查询的空格不能匹配（防误命中）
t('空格不误命中', buildEntry(['helloworld']), 'hello world', 0);
t('a b 不命中 cab', buildEntry(['cab']), 'a b', 0);
// 5) 大小写与全角空格
t('大小写不敏感', buildEntry(['Hello WORLD']), 'hello world', 1, 'Hello WORLD');
t('全角空格', buildEntry(['文献　阅读器']), '文献 阅读器', 1, '文献　阅读器');
// 6) 中文
t('中文子串', buildEntry(['本地文献阅读器工具']), '文献阅读', 1, '文献阅读');
// 7) item 自带前后空格
t('item 自带空格', buildEntry(['foo ', 'bar']), 'foo bar', 1, 'foo bar');
// 8) EOL 补空格后跨行短语
t('跨行短语', buildEntry(['first line', 'second line'], [true, false]), 'line second', 1);
// 9) 多重空白折叠
t('多空格查询', buildEntry(['a   b']), 'a  b', 1, 'a   b');
// 10) 连续命中不重叠
t('aaa 中 aa', buildEntry(['aaaa']), 'aa', 2);
// 11) 空查询
t('空查询', buildEntry(['abc']), '   ', 0);

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
