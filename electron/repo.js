'use strict';
/**
 * 文献关联代码仓库（码仓）。
 *
 * 三种绑法：
 *   copy  —— 把用户选中的本地仓库整棵复制进 `<库根>/repos/`，原目录不动（默认）
 *   link  —— 只记录外部目录的绝对路径，不复制
 *   clone —— 用系统 git 从远程（GitHub / GitLab / Gitee…）克隆到 `<库根>/repos/`
 *
 * 仓库地址可以从论文正文里解析出来：多数论文的脚注 / 实验小节会写
 * `https://github.com/owner/repo` 或 `github.com/owner/repo.git`。
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const db = require('./db');
const { libraryDir, ensureDir } = require('./config');
const { docFilePath, safeDirName } = require('./library');
const { extractPdfText } = require('./pdf-text');

/** 复制时跳过的目录：体积大且可再生成，复制没意义 */
const EXCLUDE_DIRS = new Set([
  'node_modules',
  '.venv',
  'venv',
  '__pycache__',
  '.mypy_cache',
  '.pytest_cache',
  '.ruff_cache',
  '.ipynb_checkpoints',
  '.gradle',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
]);

const PROVIDER_BY_HOST = {
  'github.com': 'github',
  'www.github.com': 'github',
  'gitlab.com': 'gitlab',
  'www.gitlab.com': 'gitlab',
  'gitee.com': 'gitee',
  'www.gitee.com': 'gitee',
  'bitbucket.org': 'bitbucket',
  'codeberg.org': 'codeberg',
  'gitcode.com': 'gitcode',
  'gitea.com': 'gitea',
};

/** 正在跑的克隆任务：docId → child，用于取消 */
const runningClones = new Map();
/** 用户主动取消的克隆，避免把「已取消」当成失败报错 */
const cancelledClones = new Set();

/* ------------------------------ 路径 ------------------------------ */

function repoRoot() {
  return ensureDir(path.join(libraryDir(), 'repos'));
}

/** 数据库里存的可能是相对 <库根>/repos 的路径，也可能是外部绝对路径 */
function resolveRepoPath(row) {
  const raw = String((row && row.local_path) || '').trim();
  if (!raw) return '';
  return path.isAbsolute(raw) ? raw : path.join(repoRoot(), raw);
}

/** 判断目标是否在文库 repos 目录内部（删除前必须校验，避免误删用户外部目录） */
function insideRepoRoot(target) {
  const root = path.resolve(repoRoot());
  const abs = path.resolve(target);
  return abs === root || abs.startsWith(root + path.sep);
}

async function uniqueRepoDir(docId, name) {
  const root = repoRoot();
  const base = `${docId}-${safeDirName(name || 'repo', 'repo')}`;
  let candidate = path.join(root, base);
  for (let i = 2; fs.existsSync(candidate); i += 1) {
    candidate = path.join(root, `${base}-${i}`);
  }
  return candidate;
}

/* ------------------------------ 地址解析 ------------------------------ */

/**
 * 把各种写法的仓库地址归一化成 { host, provider, owner, name, webUrl, cloneUrl }。
 * 支持：
 *   https://github.com/owner/repo(.git)
 *   git@github.com:owner/repo.git
 *   ssh://git@github.com/owner/repo.git
 *   github.com/owner/repo
 * 认不出来返回 null。
 */
function parseGitUrl(input) {
  let text = String(input || '').trim();
  if (!text || text.length > 500) return null;
  // 去掉 PDF 正文里常见的包裹字符与句末标点
  text = text
    .replace(/^[<("'\[「【]+/, '')
    .replace(/[>)"'\]」】,;，。；、.]+$/g, '')
    .trim();

  let host = '';
  let repoPath = '';

  // git@host:owner/repo.git
  let m = text.match(/^(?:git\+)?git@([A-Za-z0-9.-]+):(.+)$/);
  if (m) {
    host = m[1];
    repoPath = m[2];
  } else {
    // https://host/owner/repo(.git) / ssh://git@host/owner/repo
    m = text.match(/^(?:https?|git|ssh):\/\/(?:[^@/\s]+@)?([A-Za-z0-9.-]+)(?::\d+)?\/(.+)$/i);
    if (m) {
      host = m[1];
      repoPath = m[2];
    } else {
      // 裸域名：github.com/owner/repo
      m = text.match(/^([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)\/(.+)$/);
      if (m) {
        host = m[1];
        repoPath = m[2];
      }
    }
  }
  if (!host || !repoPath) return null;

  host = host.toLowerCase();
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) return null;

  repoPath = repoPath.split('?')[0].split('#')[0].replace(/\/+$/, '');
  repoPath = repoPath.replace(/^\/+/, '');

  // 切段：丢掉 /tree/main、/blob/... 这类网页子路径；GitLab 允许 group/sub/repo 多级
  let segments = repoPath.split('/').filter(Boolean);
  const WEB_MARKERS = ['tree', 'blob', 'issues', 'pull', 'pulls', 'releases', 'raw', 'wiki', 'commit', 'commits', 'archive'];
  const markerAt = segments.findIndex((seg, index) => index > 0 && WEB_MARKERS.includes(seg.toLowerCase()));
  if (markerAt > 1) segments = segments.slice(0, markerAt);
  if (!segments.length) return null;

  segments = segments.map((seg) => seg.replace(/[.]+$/g, ''));
  const name = segments[segments.length - 1].replace(/\.git$/i, '');
  if (!name) return null;
  segments[segments.length - 1] = name;

  const owner = segments.slice(0, -1).join('/');
  if (!owner) return null;
  if (!segments.every((seg) => /^[\w.-]+$/.test(seg))) return null;

  const cleanPath = `${owner}/${name}`;
  return {
    host,
    provider: PROVIDER_BY_HOST[host] || 'other',
    owner,
    name,
    webUrl: `https://${host}/${cleanPath}`,
    cloneUrl: `https://${host}/${cleanPath}.git`,
    raw: text,
  };
}

/**
 * 从一段文本里抓出所有仓库地址。
 * 会先按 URL 形态切，再按裸域名兜底，最后按 cloneUrl 去重。
 */
function findGitUrls(text) {
  const source = String(text || '');
  if (!source) return [];
  const found = new Map();

  const push = (candidate) => {
    const info = parseGitUrl(candidate);
    if (!info) return;
    if (!found.has(info.cloneUrl)) found.set(info.cloneUrl, info);
  };

  const schemes = source.match(/(?:https?|git|ssh):\/\/[^\s<>"'`）)】]+/gi) || [];
  for (const item of schemes) push(item);

  const scp = source.match(/git@[A-Za-z0-9.-]+:[^\s<>"'`）)】]+/g) || [];
  for (const item of scp) push(item);

  const bare = source.match(/(?:^|[\s(（<"'[【])((?:www\.)?(?:github|gitlab|gitee|bitbucket|codeberg|gitcode)\.com\/[^\s<>"'`）)】]+)/gi) || [];
  for (const item of bare) push(item.replace(/^[\s(（<"'[【]+/, ''));

  // GitHub 的地址最常见，排前面
  return [...found.values()].sort((a, b) => {
    const rank = (x) => (x.provider === 'github' ? 0 : x.provider === 'gitlab' ? 1 : 2);
    return rank(a) - rank(b);
  });
}

/* ------------------------------ 目录统计 ------------------------------ */

/**
 * 统计目录文件数与总字节数（跳过 EXCLUDE_DIRS）。
 * onCount 用于「正在统计…」阶段的反馈，传已数到的文件数。
 */
async function measureTree(dir, onCount) {
  const result = { fileCount: 0, sizeBytes: 0 };
  async function walk(current) {
    let entries = [];
    try {
      entries = await fs.promises.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (EXCLUDE_DIRS.has(entry.name.toLowerCase())) continue;
        await walk(path.join(current, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const stat = await fs.promises.stat(path.join(current, entry.name));
        result.fileCount += 1;
        result.sizeBytes += stat.size;
        if (onCount && result.fileCount % 200 === 0) onCount(result.fileCount);
      } catch {
        /* 单个文件读不到不影响整体 */
      }
    }
  }
  await walk(dir);
  return result;
}

/**
 * 递归复制，跳过 EXCLUDE_DIRS 与符号链接。
 * 单个文件失败不中断整次复制：记到 errors 里继续，最后统一汇报。
 */
async function copyTree(src, dst, onProgress, state, errors) {
  await fs.promises.mkdir(dst, { recursive: true });
  let entries = [];
  try {
    entries = await fs.promises.readdir(src, { withFileTypes: true });
  } catch (err) {
    throw new Error(`读取目录失败：${src}（${err.message}）`);
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const from = path.join(src, entry.name);
    const to = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      if (EXCLUDE_DIRS.has(entry.name.toLowerCase())) continue;
      try {
        await copyTree(from, to, onProgress, state, errors);
      } catch (err) {
        if (errors) errors.push(err.message);
      }
      continue;
    }
    if (!entry.isFile()) continue;
    try {
      await fs.promises.copyFile(from, to);
      const stat = await fs.promises.stat(to);
      state.done += stat.size;
      if (onProgress) onProgress(state.done, state.total);
    } catch (err) {
      if (errors) errors.push(`${entry.name}: ${err.message}`);
    }
  }
}

/* ------------------------------ 数据库 ------------------------------ */

async function requireDoc(docId) {
  const row = await db.queryOne(
    'SELECT id, title, file_name, stored_path, orig_name, abstract FROM pr_doc_info WHERE id = ? AND is_deleted = 0',
    [docId]
  );
  if (!row) throw new Error('文献不存在或已被删除');
  return row;
}

async function getRepo(docId) {
  const row = await db.queryOne('SELECT * FROM pr_repo_info WHERE doc_id = ?', [docId]);
  if (!row) return null;
  const hasLocal = Boolean(String(row.local_path || '').trim());
  const absPath = resolveRepoPath(row);
  let exists = false;
  if (hasLocal) {
    try {
      const stat = await fs.promises.stat(absPath);
      exists = stat.isDirectory();
    } catch {
      exists = false;
    }
  }
  // 统计值取写入时算好的结果，打开详情不再遍历整个仓库（可能是几十万文件）
  return { ...row, absPath, hasLocal, exists };
}

async function saveRepo(docId, patch) {
  const fields = ['remote_url', 'provider', 'repo_name', 'local_path', 'bind_mode', 'default_branch', 'file_count', 'size_bytes'];
  const values = fields.map((key) => (patch[key] === undefined ? null : patch[key]));
  await db.execute(
    `INSERT INTO pr_repo_info (doc_id, ${fields.join(', ')}, last_sync_at)
     VALUES (?, ${fields.map(() => '?').join(', ')}, NOW())
     ON DUPLICATE KEY UPDATE
       ${fields.map((key) => `${key} = VALUES(${key})`).join(', ')},
       last_sync_at = NOW()`,
    [docId, ...values]
  );
  return getRepo(docId);
}

/** 只保存远程地址（还没落本地文件），让用户填的地址立刻持久化 */
async function saveRemoteUrl(docId, rawUrl) {
  await requireDoc(docId);
  const info = parseGitUrl(rawUrl);
  if (!info) throw new Error('不是可识别的 Git 仓库地址，请用 https://github.com/owner/repo 这种写法');
  const existing = await db.queryOne('SELECT * FROM pr_repo_info WHERE doc_id = ?', [docId]);
  // 已经绑了本地文件的，不要被「只存地址」覆盖掉
  if (existing && String(existing.local_path || '').trim()) return getRepo(docId);
  return saveRepo(docId, {
    remote_url: info.webUrl,
    provider: info.provider,
    repo_name: info.name,
    local_path: null,
    bind_mode: 'remote',
    file_count: 0,
    size_bytes: 0,
  });
}

/** 把绝对路径压成相对 <库根>/repos 的形式，换文库目录后依然有效 */
function toStoredPath(absPath) {
  const abs = path.resolve(absPath);
  return insideRepoRoot(abs) ? path.relative(repoRoot(), abs).split(path.sep).join('/') : abs;
}

/* ------------------------------ 论文里找仓库地址 ------------------------------ */

/** 从 PDF 正文（前几页）+ 摘要里解析仓库地址 */
async function detectRepoUrl(docId) {
  const doc = await requireDoc(docId);
  let text = '';
  try {
    const buf = await fs.promises.readFile(docFilePath(doc));
    text = await extractPdfText(buf, 4);
  } catch (err) {
    // 读不到正文不算致命：还能用摘要和手工输入
    console.warn('[repo] 读取 PDF 正文失败：', err && err.message);
  }
  const haystack = `${text || ''} ${doc.abstract || ''}`;
  const urls = findGitUrls(haystack);
  return { urls, primary: urls[0] || null };
}

/** 读本地目录 .git/config 里的 origin，判断它本身是不是个仓库 */
async function detectGitInfoFromDir(dir) {
  const configPath = path.join(dir, '.git', 'config');
  let text = '';
  try {
    text = await fs.promises.readFile(configPath, 'utf8');
  } catch {
    return { isRepo: false, url: null };
  }
  const m = text.match(/\[remote\s+"origin"\][\s\S]*?url\s*=\s*(\S+)/i) || text.match(/url\s*=\s*(\S+)/i);
  const info = m ? parseGitUrl(m[1]) : null;
  return { isRepo: true, url: info ? info.webUrl : null, origin: m ? m[1] : null };
}

/* ------------------------------ 绑定：复制 ------------------------------ */

function buildProgress(docId, onProgress) {
  let last = 0;
  return (done, total) => {
    if (!onProgress) return;
    const now = Date.now();
    const finished = total > 0 && done >= total;
    if (!finished && now - last < 150) return;
    last = now;
    onProgress({
      docId,
      phase: 'copy',
      done,
      total,
      percent: total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0,
    });
  };
}

/**
 * 把本地仓库复制进 `<库根>/repos/`。
 * @param {number} docId
 * @param {string} sourceDir 用户选择的仓库目录
 * @param {{ remoteUrl?: string, onProgress?: Function }} options
 */
async function bindLocal(docId, sourceDir, options = {}) {
  await requireDoc(docId);
  const src = path.resolve(String(sourceDir || ''));
  const stat = await fs.promises.stat(src).catch(() => null);
  if (!stat || !stat.isDirectory()) throw new Error('选择的路径不是一个文件夹');

  const gitInfo = await detectGitInfoFromDir(src);
  const remote = parseGitUrl(options.remoteUrl) || (gitInfo.url ? parseGitUrl(gitInfo.url) : null);

  // 源目录已经在文库 repos 里：直接记录，不再复制一份
  if (insideRepoRoot(src)) {
    const stats = await measureTree(src);
    return saveRepo(docId, {
      remote_url: remote ? remote.webUrl : null,
      provider: remote ? remote.provider : null,
      repo_name: path.basename(src),
      local_path: toStoredPath(src),
      bind_mode: 'copy',
      file_count: stats.fileCount,
      size_bytes: stats.sizeBytes,
    });
  }

  const target = await uniqueRepoDir(docId, remote ? remote.name : path.basename(src));
  const emit = (payload) => {
    if (typeof options.onProgress === 'function') options.onProgress({ docId, ...payload });
  };
  // 大仓库要先遍历一遍才知道总大小，这一步单独给个「统计中」状态，别让界面看起来是卡死
  emit({ phase: 'scan', percent: null, files: 0 });
  const { fileCount, sizeBytes } = await measureTree(src, (files) => emit({ phase: 'scan', percent: null, files }));
  emit({ phase: 'scan', percent: null, files: fileCount, done: true });

  const progress = buildProgress(docId, options.onProgress);
  const state = { done: 0, total: sizeBytes };
  const errors = [];
  try {
    await copyTree(src, target, progress, state, errors);
  } catch (err) {
    await fs.promises.rm(target, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
  progress(sizeBytes, sizeBytes);
  const stats = await measureTree(target);
  const row = await saveRepo(docId, {
    remote_url: remote ? remote.webUrl : null,
    provider: remote ? remote.provider : null,
    repo_name: path.basename(target).replace(new RegExp(`^${docId}-`), ''),
    local_path: toStoredPath(target),
    bind_mode: 'copy',
    file_count: stats.fileCount,
    size_bytes: stats.sizeBytes,
  });
  return { ...row, failedCount: errors.length, firstError: errors[0] || '' };
}

/** 只记录外部目录路径，不复制文件 */
async function bindPath(docId, sourceDir, options = {}) {
  await requireDoc(docId);
  const src = path.resolve(String(sourceDir || ''));
  const stat = await fs.promises.stat(src).catch(() => null);
  if (!stat || !stat.isDirectory()) throw new Error('选择的路径不是一个文件夹');
  const gitInfo = await detectGitInfoFromDir(src);
  const remote = parseGitUrl(options.remoteUrl) || (gitInfo.url ? parseGitUrl(gitInfo.url) : null);
  const stats = await measureTree(src);
  return saveRepo(docId, {
    remote_url: remote ? remote.webUrl : null,
    provider: remote ? remote.provider : null,
    repo_name: path.basename(src),
    local_path: toStoredPath(src),
    bind_mode: insideRepoRoot(src) ? 'copy' : 'link',
    file_count: stats.fileCount,
    size_bytes: stats.sizeBytes,
  });
}

/* ------------------------------ 绑定：克隆 ------------------------------ */

function readDefaultBranch(dir) {
  try {
    const head = fs.readFileSync(path.join(dir, '.git', 'HEAD'), 'utf8').trim();
    const m = head.match(/^ref:\s*refs\/heads\/(.+)$/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/** 解析 git clone 的进度输出：`Receiving objects:  45% (…), 1.2 MiB | …` */
function parseGitProgress(chunk) {
  const text = String(chunk || '');
  const lines = text.split(/[\r\n]+/).filter((line) => line.trim());
  const last = lines[lines.length - 1] || '';
  const matches = [...text.matchAll(/(\d{1,3})%/g)];
  const percent = matches.length ? Number(matches[matches.length - 1][1]) : null;
  const label = (last.match(/^([A-Za-z][A-Za-z \-]+):/) || [])[1] || 'git';
  return { percent, label: label.trim(), line: last.trim() };
}

/**
 * 用系统 git 克隆远程仓库到 `<库根>/repos/<docId>-<name>`。
 * @param {number} docId
 * @param {{ url: string, depth?: boolean|number, onProgress?: Function }} payload
 */
async function cloneRepo(docId, payload = {}) {
  await requireDoc(docId);
  const info = parseGitUrl(payload.url);
  if (!info) throw new Error('不是可识别的 Git 仓库地址，请检查 https://github.com/owner/repo 格式');

  const target = await uniqueRepoDir(docId, info.name);
  const args = ['clone', '--progress'];
  const depth = Number(payload.depth);
  if (Number.isFinite(depth) && depth >= 1) args.push('--depth', String(Math.floor(depth)));
  args.push(info.cloneUrl, target);

  return new Promise((resolve, reject) => {
    let stderr = '';
    let child;
    cancelledClones.delete(Number(docId));
    try {
      child = spawn('git', args, {
        cwd: path.dirname(target),
        windowsHide: true,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo' },
      });
    } catch (err) {
      reject(new Error(`启动 git 失败：${err.message}`));
      return;
    }
    runningClones.set(Number(docId), child);

    const emit = (percent, label, line) => {
      if (typeof payload.onProgress !== 'function') return;
      payload.onProgress({ docId, phase: 'clone', percent, label, line });
    };

    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
      const progress = parseGitProgress(text);
      emit(progress.percent, progress.label, progress.line);
    });

    child.on('error', (err) => {
      runningClones.delete(Number(docId));
      if (err && err.code === 'ENOENT') {
        reject(new Error('没找到 git 命令：请先安装 Git for Windows（https://git-scm.com），并确保 git 在 PATH 里'));
        return;
      }
      reject(new Error(`执行 git 失败：${err.message}`));
    });

    child.on('close', async (code) => {
      runningClones.delete(Number(docId));
      const wasCancelled = cancelledClones.has(Number(docId));
      cancelledClones.delete(Number(docId));
      if (wasCancelled) {
        await fs.promises.rm(target, { recursive: true, force: true }).catch(() => {});
        reject(new Error('已取消克隆'));
        return;
      }
      if (code !== 0) {
        await fs.promises.rm(target, { recursive: true, force: true }).catch(() => {});
        const tail = stderr.split(/[\r\n]+/).filter(Boolean).slice(-3).join(' ');
        reject(new Error(`克隆失败（git 退出码 ${code}）${tail ? `：${tail}` : ''}`));
        return;
      }
      try {
        const stats = await measureTree(target);
        const saved = await saveRepo(docId, {
          remote_url: info.webUrl,
          provider: info.provider,
          repo_name: info.name,
          local_path: toStoredPath(target),
          bind_mode: 'clone',
          default_branch: readDefaultBranch(target),
          file_count: stats.fileCount,
          size_bytes: stats.sizeBytes,
        });
        emit(100, 'done', '克隆完成');
        resolve(saved);
      } catch (err) {
        reject(err);
      }
    });
  });
}

function cancelClone(docId) {
  const key = Number(docId);
  const child = runningClones.get(key);
  if (!child) return { canceled: false };
  cancelledClones.add(key);
  try {
    child.kill();
  } catch {
    /* ignore */
  }
  runningClones.delete(key);
  return { canceled: true };
}

/* ------------------------------ 浏览仓库文件 ------------------------------ */

/** 单文件预览上限：超过就不读内容，只给大小 */
const PREVIEW_MAX_BYTES = 400 * 1024;
/** 树里最多返回多少个节点，防止超大仓库把界面拖死 */
const TREE_MAX_NODES = 2000;

/**
 * 列出仓库的文件树（目录在前、按名字排序）。
 * 跳过符号链接、隐藏的系统垃圾文件与 node_modules 那类大目录。
 */
async function listTree(docId, options = {}) {
  const repo = await getRepo(docId);
  if (!repo) return { bound: false, nodes: [], root: '' };
  if (!repo.hasLocal) return { bound: true, exists: false, remoteOnly: true, nodes: [], root: '', repoName: repo.repo_name };
  if (!repo.exists) return { bound: true, exists: false, nodes: [], root: repo.absPath };

  const limit = Math.min(Math.max(Number(options.maxNodes) || TREE_MAX_NODES, 100), 20000);
  let count = 0;
  const skipped = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);

  async function walk(dir, rel, depth) {
    if (depth > 10 || count >= limit) return [];
    let entries = [];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    entries.sort((a, b) => {
      const aDir = a.isDirectory() ? 0 : 1;
      const bDir = b.isDirectory() ? 0 : 1;
      if (aDir !== bDir) return aDir - bDir;
      return a.name.localeCompare(b.name, 'zh-Hans-CN');
    });
    const nodes = [];
    for (const entry of entries) {
      if (count >= limit) break;
      if (entry.isSymbolicLink()) continue;
      if (skipped.has(entry.name)) continue;
      if (entry.isDirectory() && EXCLUDE_DIRS.has(entry.name.toLowerCase())) continue;
      const abs = path.join(dir, entry.name);
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        count += 1;
        nodes.push({ name: entry.name, path: childRel, type: 'dir', children: await walk(abs, childRel, depth + 1) });
        continue;
      }
      if (!entry.isFile()) continue;
      count += 1;
      let size = 0;
      try {
        size = (await fs.promises.stat(abs)).size;
      } catch {
        size = 0;
      }
      nodes.push({ name: entry.name, path: childRel, type: 'file', size });
    }
    return nodes;
  }

  const nodes = await walk(repo.absPath, '', 0);
  return {
    bound: true,
    exists: true,
    root: repo.absPath,
    repoName: repo.repo_name,
    nodes,
    truncated: count >= limit,
    total: count,
  };
}

/** 读一个仓库文件用于预览（文本直出，二进制只报类型） */
async function readRepoFile(docId, relPath) {
  const repo = await getRepo(docId);
  if (!repo) throw new Error('这篇文献还没有绑定代码仓库');
  if (!repo.exists) throw new Error('仓库目录不存在，可能已被移动或删除');

  const root = path.resolve(repo.absPath);
  const abs = path.resolve(root, String(relPath || '').replace(/^[\\/]+/, ''));
  if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error('路径越界');

  const stat = await fs.promises.stat(abs).catch(() => null);
  if (!stat || !stat.isFile()) throw new Error('文件不存在或不是普通文件');

  const ext = path.extname(abs).toLowerCase();
  if (stat.size > PREVIEW_MAX_BYTES) {
    return { path: relPath, name: path.basename(abs), size: stat.size, ext, tooLarge: true, binary: false, text: '' };
  }

  const buf = await fs.promises.readFile(abs);
  const binary = buf.includes(0);
  return {
    path: relPath,
    name: path.basename(abs),
    size: stat.size,
    ext,
    tooLarge: false,
    binary,
    text: binary ? '' : buf.toString('utf8'),
  };
}

/* ------------------------------ 给 AI 的仓库上下文 ------------------------------ */

/** 根目录里值得喂给模型的工程文件 */
const MANIFEST_NAMES = new Set([
  'package.json',
  'requirements.txt',
  'pyproject.toml',
  'setup.py',
  'setup.cfg',
  'environment.yml',
  'Pipfile',
  'tox.ini',
  'Cargo.toml',
  'go.mod',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'CMakeLists.txt',
  'meson.build',
  'Makefile',
  'Dockerfile',
  'compose.yaml',
  'docker-compose.yml',
  'composer.json',
  'Gemfile',
]);

const TREE_LINES_MAX = 120;
const README_MAX_CHARS = 5000;
const MANIFEST_MAX_CHARS = 2200;
const CONTEXT_MAX_CHARS = 12000;

/** 读仓库内的文本文件（限制字节数，二进制直接跳过） */
async function readTextFile(root, relPath, maxChars) {
  const abs = path.resolve(root, String(relPath || '').replace(/^[\\/]+/, ''));
  const rootAbs = path.resolve(root);
  if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) return '';
  try {
    const stat = await fs.promises.stat(abs);
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) return '';
    const buf = await fs.promises.readFile(abs);
    if (buf.includes(0)) return '';
    return buf.toString('utf8').slice(0, maxChars);
  } catch {
    return '';
  }
}

/**
 * 收集给 AI 的仓库上下文：目录树（前两层）、文件类型统计、README、依赖清单、论文标题与摘要。
 * 总长度有上限，避免把本地 3B 模型的上下文撑爆。
 */
async function buildContext(docId) {
  const repo = await getRepo(docId);
  if (!repo) throw new Error('这篇文献还没有绑定代码仓库');
  if (!repo.hasLocal) throw new Error('只保存了仓库地址、还没有本地文件，先绑定本地文件夹或从远程克隆');
  if (!repo.exists) throw new Error('仓库目录不存在，可能已被移动或删除');

  const doc = await requireDoc(docId);
  const tree = await listTree(docId, { maxNodes: 600 });

  const treeLines = [];
  const extCount = new Map();
  const walk = (nodes, depth) => {
    for (const node of nodes) {
      if (depth <= 2 && treeLines.length < TREE_LINES_MAX) {
        treeLines.push(`${'  '.repeat(depth)}${node.name}${node.type === 'dir' ? '/' : ''}`);
      }
      if (node.type === 'dir') walk(node.children || [], depth + 1);
      else {
        const ext = path.extname(node.name).toLowerCase() || '(无扩展名)';
        extCount.set(ext, (extCount.get(ext) || 0) + 1);
      }
    }
  };
  walk(tree.nodes || [], 0);

  const stats = [...extCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([ext, count]) => `${ext} × ${count}`)
    .join('、');

  const rootFiles = (tree.nodes || []).filter((n) => n.type === 'file').map((n) => n.name);
  const readmeName = rootFiles.find((name) => /^readme(\.|$)/i.test(name)) || '';
  const readme = readmeName ? await readTextFile(repo.absPath, readmeName, README_MAX_CHARS) : '';

  const manifests = [];
  for (const name of rootFiles) {
    if (manifests.length >= 4) break;
    if (name === readmeName || !MANIFEST_NAMES.has(name)) continue;
    const text = await readTextFile(repo.absPath, name, MANIFEST_MAX_CHARS);
    if (text) manifests.push({ name, text });
  }

  return {
    repo: {
      name: repo.repo_name || path.basename(repo.absPath),
      url: repo.remote_url || '',
      mode: repo.bind_mode,
      branch: repo.default_branch || '',
      fileCount: tree.total || 0,
      sizeBytes: Number(repo.size_bytes) || 0,
    },
    doc: { title: doc.title || '', abstract: doc.abstract || '' },
    treeText: treeLines.join('\n'),
    truncated: Boolean(tree.truncated),
    stats,
    readme: { name: readmeName, text: readme },
    manifests,
    maxChars: CONTEXT_MAX_CHARS,
  };
}

/* ------------------------------ 解绑 / 打开 ------------------------------ */

async function removeRepo(docId, options = {}) {
  const row = await db.queryOne('SELECT * FROM pr_repo_info WHERE doc_id = ?', [docId]);
  if (!row) return { removed: false };
  const absPath = resolveRepoPath(row);
  let deleted = false;
  // 只有复制/克隆进文库的目录才允许删除；外部「仅记录路径」的目录一律不动
  if (options.deleteFiles && row.bind_mode !== 'link' && absPath && insideRepoRoot(absPath)) {
    try {
      await fs.promises.rm(absPath, { recursive: true, force: true });
      deleted = true;
    } catch (err) {
      throw new Error(`删除仓库目录失败：${err.message}`);
    }
  }
  await db.execute('DELETE FROM pr_repo_info WHERE doc_id = ?', [docId]);
  return { removed: true, deleted };
}

async function openRepo(docId) {
  const repo = await getRepo(docId);
  if (!repo) throw new Error('还没有绑定代码仓库');
  if (!repo.exists) throw new Error('仓库目录不存在，可能已被移动或删除');
  const { shell } = require('electron');
  const err = await shell.openPath(repo.absPath);
  if (err) throw new Error(err);
  return { ok: true, path: repo.absPath };
}

async function revealRepo(docId) {
  const repo = await getRepo(docId);
  if (!repo) throw new Error('还没有绑定代码仓库');
  const { shell } = require('electron');
  if (repo.exists) shell.showItemInFolder(repo.absPath);
  else shell.openPath(path.dirname(repo.absPath));
  return { ok: true };
}

module.exports = {
  repoRoot,
  parseGitUrl,
  findGitUrls,
  detectRepoUrl,
  detectGitInfoFromDir,
  getRepo,
  bindLocal,
  bindPath,
  cloneRepo,
  cancelClone,
  listTree,
  readRepoFile,
  saveRemoteUrl,
  buildContext,
  removeRepo,
  openRepo,
  revealRepo,
  resolveRepoPath,
  insideRepoRoot,
};
