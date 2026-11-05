'use strict';
/**
 * 按 DOI 从网络抓取文献元数据。
 * 主源 OpenAlex（免费、无需鉴权），失败时回落 Crossref。
 * 只补字段，不做任何数据库写入——写入逻辑在 ipc/docs.js / 渲染进程。
 */

const OPENALEX_BASE = 'https://api.openalex.org/works/https://doi.org/';
const CROSSREF_BASE = 'https://api.crossref.org/works/';

/** 去掉 URL / doi: 前缀，得到裸 DOI */
function normalizeDoi(raw) {
  let text = String(raw == null ? '' : raw).trim();
  if (!text) return '';
  text = text
    .replace(/^(https?:\/\/)?(dx\.)?doi\.org\//i, '')
    .replace(/^doi\s*:\s*/i, '')
    .replace(/[.。,，;；]+$/, '');
  return text;
}

/** 大致判断是否像 DOI（10.xxxx/...），用于快速过滤 */
function looksLikeDoi(value) {
  return /^10\.\d{4,9}\/\S+$/i.test(normalizeDoi(value));
}

/** DOI → 可安全拼进 URL 的形式（逐段编码，兼容含 ()<> 的 DOI） */
function encodeDoiPath(doi) {
  return doi
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
}

/** Electron 环境走 net（尊重系统代理）；node 自检环境回落全局 fetch */
function fetchJson(url, timeoutMs = 8000) {
  try {
    // 延迟 require：纯 node 自检时没有 electron 模块
    // eslint-disable-next-line global-require
    const { net } = require('electron');
    if (net && typeof net.request === 'function') return fetchJsonViaNet(net, url, timeoutMs);
  } catch {
    /* 非 Electron 环境 */
  }
  return fetchJsonViaFetch(url, timeoutMs);
}

function fetchJsonViaNet(net, url, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const request = net.request(url);
    const timer = setTimeout(() => {
      try {
        request.abort();
      } catch {
        /* ignore */
      }
      done(null);
    }, timeoutMs);
    request.on('response', (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        clearTimeout(timer);
        if (response.statusCode !== 200) return done(null);
        try {
          done(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch {
          done(null);
        }
      });
      response.on('error', () => {
        clearTimeout(timer);
        done(null);
      });
    });
    request.on('error', () => {
      clearTimeout(timer);
      done(null);
    });
    request.end();
  });
}

async function fetchJsonViaFetch(url, timeoutMs) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** OpenAlex 的倒排索引摘要 → 正文 */
function rebuildAbstract(inverted) {
  if (!inverted || typeof inverted !== 'object') return '';
  const pairs = [];
  for (const [word, positions] of Object.entries(inverted)) {
    for (const pos of positions || []) pairs.push([Number(pos), word]);
  }
  if (!pairs.length) return '';
  pairs.sort((a, b) => a[0] - b[0]);
  return pairs.map((p) => p[1]).join(' ');
}

/** 去掉 Crossref 摘要里的 JATS 标签 */
function stripXml(text) {
  return String(text || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function fromOpenAlex(doi, timeoutMs) {
  const data = await fetchJson(OPENALEX_BASE + encodeDoiPath(doi), timeoutMs);
  if (!data || !data.display_name) return null;
  const authors = (data.authorships || [])
    .map((a) => (a && a.author && a.author.display_name) || '')
    .filter(Boolean)
    .join('; ');
  const journal =
    (data.primary_location && data.primary_location.source && data.primary_location.source.display_name) ||
    (data.host_venue && data.host_venue.display_name) ||
    ((data.locations || []).map((l) => l && l.source && l.source.display_name).find(Boolean) || '');
  const year = Number(data.publication_year) || Number(String(data.publication_date || '').slice(0, 4)) || null;
  return {
    title: data.display_name || '',
    authors,
    year,
    journal: journal || '',
    doi: normalizeDoi((data.ids && data.ids.doi) || doi),
    abstract: rebuildAbstract(data.abstract_inverted_index),
    source: 'openalex',
  };
}

async function fromCrossref(doi, timeoutMs) {
  const data = await fetchJson(CROSSREF_BASE + encodeDoiPath(doi), timeoutMs);
  const m = data && data.message;
  if (!m || !m.title) return null;
  const authors = (m.author || [])
    .map((a) => [a.given, a.family].filter(Boolean).join(' '))
    .filter(Boolean)
    .join('; ');
  const year =
    (m.issued && m.issued['date-parts'] && m.issued['date-parts'][0] && m.issued['date-parts'][0][0]) ||
    (m.published && m.published['date-parts'] && m.published['date-parts'][0] && m.published['date-parts'][0][0]) ||
    null;
  return {
    title: (m.title || [])[0] || '',
    authors,
    year: Number(year) || null,
    journal: (m['container-title'] || [])[0] || '',
    doi: normalizeDoi(m.DOI || doi),
    abstract: stripXml(m.abstract),
    source: 'crossref',
  };
}

/**
 * 按 DOI 抓取元数据（OpenAlex → Crossref 兜底）。
 * @returns {Promise<{title,authors,year,journal,doi,abstract,source}|null>} 全失败返回 null
 */
async function fetchDoiMeta(rawDoi, options = {}) {
  const doi = normalizeDoi(rawDoi);
  if (!looksLikeDoi(doi)) return null;
  const timeoutMs = Math.min(Math.max(Number(options.timeoutMs) || 8000, 2000), 30000);
  try {
    const meta = await fromOpenAlex(doi, timeoutMs);
    if (meta) return meta;
  } catch {
    /* 回落 Crossref */
  }
  try {
    const meta = await fromCrossref(doi, timeoutMs);
    if (meta) return meta;
  } catch {
    /* 全部失败 */
  }
  return null;
}

module.exports = {
  normalizeDoi,
  looksLikeDoi,
  fetchDoiMeta,
};
