import React, { useEffect, useRef, useState } from 'react';
import { api, formatBytes, toast } from '../api.js';
import RepoBrowser from './RepoBrowser.jsx';
import RepoAi from './RepoAi.jsx';

const MODE_LABEL = {
  copy: '已复制进文库',
  link: '仅记录路径',
  clone: '已克隆到文库',
};

const PROVIDER_LABEL = {
  github: 'GitHub',
  gitlab: 'GitLab',
  gitee: 'Gitee',
  bitbucket: 'Bitbucket',
  codeberg: 'Codeberg',
  gitcode: 'GitCode',
  gitea: 'Gitea',
  other: '其它',
};

/**
 * 文献详情里的「代码仓库」区块。
 * - 从论文正文里解析仓库地址（脚注 / 实验小节常写 github.com/owner/repo）
 * - 绑定本地仓库：整棵复制进 <库根>/repos，原目录不动
 * - 直接 git clone 到 <库根>/repos
 * - 也支持只记录外部路径（不复制）
 */
export default function RepoSection({ docId, compact = false }) {
  const [repo, setRepo] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [url, setUrl] = useState('');
  const [detecting, setDetecting] = useState(false);
  const [detected, setDetected] = useState(null);
  /** '' | 'copy' | 'clone' */
  const [busy, setBusy] = useState('');
  const [progress, setProgress] = useState(null);
  const [depth, setDepth] = useState(true);
  const [linkOnly, setLinkOnly] = useState(false);
  /** 远程地址是否已经落库（只存了地址、还没绑本地文件时为 true） */
  const [remoteSaved, setRemoteSaved] = useState(false);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    setLoaded(false);
    setDetected(null);
    setProgress(null);
    setRemoteSaved(false);
    api.repo
      .get(docId)
      .then((row) => {
        if (!alive.current) return;
        // 只有地址、没有本地文件的记录：当作「未绑定」处理，但把地址回填进输入框
        if (row && !row.hasLocal) {
          setRepo(null);
          setUrl((prev) => prev || row.remote_url || '');
          setRemoteSaved(Boolean(row.remote_url));
        } else {
          setRepo(row);
          setUrl((prev) => prev || (row && row.remote_url) || '');
        }
        setLoaded(true);
      })
      .catch(() => {
        if (alive.current) setLoaded(true);
      });
    const off = api.repo.onProgress((payload) => {
      if (!payload || !alive.current) return;
      if (Number(payload.docId) !== Number(docId)) return;
      setProgress(payload);
    });
    return () => {
      alive.current = false;
      off();
    };
  }, [docId]);

  /** 地址失焦就落库：避免「填了地址、关掉弹窗、再打开就没了」 */
  const persistUrl = async (rawValue) => {
    const value = String(rawValue == null ? url : rawValue).trim();
    if (!value || busy) return;
    try {
      await api.repo.saveRemote({ docId, url: value });
      setRemoteSaved(true);
    } catch {
      // 地址还没写完整（或不是 git 地址）时静默忽略，真正绑定时会明确报错
      setRemoteSaved(false);
    }
  };

  /** 从论文正文 + 摘要里找仓库地址 */
  const detectFromPaper = async () => {
    setDetecting(true);
    try {
      const res = await api.repo.detect(docId);
      setDetected(res);
      if (res && res.primary) {
        setUrl((prev) => prev || res.primary.webUrl);
        toast(`论文里找到仓库：${res.primary.owner}/${res.primary.name}`, 'success');
        // 解析到的地址也立刻存下来
        persistUrl(res.primary.webUrl);
      } else {
        toast('论文里没找到 GitHub / GitLab / Gitee 地址（扫描版 PDF 可能读不出正文），可以手动粘贴', 'warn', 5500);
      }
    } catch (err) {
      toast(err.message || '解析失败', 'error');
    } finally {
      setDetecting(false);
    }
  };

  /** 选一个本地目录：默认整棵复制进文库，勾了「只记录路径」就不复制 */
  const bindLocal = async () => {
    setBusy('copy');
    setProgress(null);
    try {
      if (linkOnly) {
        // 只记录路径也要先选目录（这个对话框不做任何复制）
        const picked = await api.repo.pickDir();
        if (!picked || picked.canceled || !picked.path) return;
        const row = await api.repo.bindPath({ docId, path: picked.path, remoteUrl: url.trim() || undefined });
        setRepo(row);
        toast('已记录仓库路径', 'success');
        return;
      }
      const res = await api.repo.bindLocal({ docId, remoteUrl: url.trim() || undefined });
      if (!res || res.canceled) return;
      setRepo(res.repo);
      setRemoteSaved(true);
      if (res.repo && res.repo.failedCount) {
        toast(`已复制并绑定，但有 ${res.repo.failedCount} 个文件没复制成功（${res.repo.firstError}）`, 'warn', 7000);
      } else {
        toast('已复制进文库并绑定', 'success');
      }
    } catch (err) {
      toast(err.message || '绑定本地仓库失败', 'error', 6000);
    } finally {
      setBusy('');
      setProgress(null);
    }
  };

  const cloneFromRemote = async () => {
    const target = url.trim();
    if (!target) {
      toast('先填仓库地址，或者点「从论文解析」自动找', 'warn');
      return;
    }
    setBusy('clone');
    setProgress(null);
    try {
      const row = await api.repo.clone({ docId, url: target, depth: depth ? 1 : 0 });
      setRepo(row);
      toast('克隆完成，已绑定到这篇文献', 'success');
    } catch (err) {
      const msg = err.message || '克隆失败';
      toast(msg, /已取消/.test(msg) ? 'warn' : 'error', 7000);
    } finally {
      setBusy('');
      setProgress(null);
    }
  };

  const cancelClone = async () => {
    try {
      await api.repo.cancel(docId);
      toast('已取消克隆', 'warn');
    } catch {
      /* 忽略 */
    }
  };

  const unbind = async () => {
    if (!window.confirm('解除这篇文献的代码仓库绑定？')) return;
    let deleteFiles = false;
    if (repo && repo.bind_mode !== 'link' && repo.exists) {
      deleteFiles = window.confirm('文库里的仓库目录要不要一起删掉？\n\n确定 = 一并删除\n取消 = 只解除绑定，文件保留');
    }
    try {
      const res = await api.repo.remove({ docId, deleteFiles });
      setRepo(null);
      setUrl('');
      setRemoteSaved(false);
      toast(res && res.deleted ? '已解绑并删除仓库目录' : '已解除绑定', 'success');
    } catch (err) {
      toast(err.message || '解绑失败', 'error');
    }
  };

  /** 只保存过地址时，允许把这条记录清掉 */
  const clearRemote = async () => {
    try {
      await api.repo.remove({ docId, deleteFiles: false });
      setUrl('');
      setRemoteSaved(false);
      toast('已清除仓库地址', 'success');
    } catch (err) {
      toast(err.message || '清除失败', 'error');
    }
  };

  const openInBrowser = () => {
    const target = (repo && repo.remote_url) || url.trim();
    if (!target) return;
    window.open(target, '_blank');
  };

  if (!loaded) {
    return (
      <div className={`field repo-field${compact ? ' compact' : ''}`}>
        <span>代码仓库</span>
        <div className="repo-hint">读取中…</div>
      </div>
    );
  }

  /* ------------------------------ 已绑定 ------------------------------ */
  if (repo) {
    const providerLabel = PROVIDER_LABEL[repo.provider] || '仓库';
    return (
      <div className={`field repo-field${compact ? ' compact' : ''}`}>
        <span>代码仓库</span>
        <div className="repo-card">
          <div className="repo-line">
            <strong className="repo-name">📦 {repo.repo_name || '本地仓库'}</strong>
            <span className={`repo-badge mode-${repo.bind_mode}`}>{MODE_LABEL[repo.bind_mode] || repo.bind_mode}</span>
            {repo.default_branch ? <span className="repo-branch">⎇ {repo.default_branch}</span> : null}
          </div>

          {repo.remote_url ? (
            <button type="button" className="repo-link" title="在系统浏览器打开" onClick={openInBrowser}>
              {providerLabel} · {repo.remote_url}
            </button>
          ) : (
            <div className="repo-hint">没有关联远程地址（本地目录里也没读到 origin）</div>
          )}

          <code className="repo-path" title={repo.absPath}>
            {repo.absPath}
          </code>

          <div className="repo-meta">
            {repo.exists ? (
              <span>
                {repo.file_count} 个文件 · {formatBytes(repo.size_bytes)}
              </span>
            ) : (
              <span className="repo-warn">目录不存在，可能被移动或删除了</span>
            )}
            {repo.last_sync_at ? <span className="repo-dim">· {repo.last_sync_at} 绑定</span> : null}
          </div>

          <div className="repo-actions">
            <button type="button" className="ghost-btn tiny" onClick={() => api.repo.open(docId).catch((e) => toast(e.message, 'error'))}>
              打开文件夹
            </button>
            <button type="button" className="ghost-btn tiny" onClick={() => api.repo.reveal(docId).catch((e) => toast(e.message, 'error'))}>
              在资源管理器中显示
            </button>
            {repo.remote_url ? (
              <button type="button" className="ghost-btn tiny" onClick={openInBrowser}>
                打开仓库网页
              </button>
            ) : null}
            <button type="button" className="ghost-btn tiny danger" onClick={unbind}>
              解绑
            </button>
          </div>

          {/* 仓库文件：点目录展开、点文件直接预览 */}
          <RepoBrowser docId={docId} compact={compact} />

          {/* 让模型读一遍仓库，从几个角度给出解读 */}
          <RepoAi docId={docId} />
        </div>
      </div>
    );
  }

  /* ------------------------------ 未绑定 ------------------------------ */
  const percent = progress && typeof progress.percent === 'number' ? progress.percent : null;

  return (
    <div className={`field repo-field${compact ? ' compact' : ''}`}>
      <span>代码仓库</span>
      <div className="repo-card empty">
        <input
          className="repo-input"
          value={url}
          placeholder="https://github.com/owner/repo（可留空，先选本地文件夹）"
          onChange={(e) => {
            setUrl(e.target.value);
            setRemoteSaved(false);
          }}
          onBlur={(e) => persistUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              persistUrl(e.currentTarget.value);
            }
          }}
          disabled={Boolean(busy)}
        />
        {remoteSaved ? (
          <div className="repo-hint repo-saved">
            ✓ 地址已保存到这篇文献
            <button type="button" className="repo-inline-btn" onClick={clearRemote}>
              清除
            </button>
          </div>
        ) : null}

        <div className="repo-actions">
          <button type="button" className="ghost-btn tiny" onClick={detectFromPaper} disabled={detecting || Boolean(busy)}>
            {detecting ? '解析中…' : '🔍 从论文解析'}
          </button>
          <button type="button" className="ghost-btn tiny" onClick={bindLocal} disabled={Boolean(busy)}>
            {busy === 'copy' ? '处理中…' : linkOnly ? '📁 选择并记录路径' : '📁 绑定本地仓库（复制进文库）'}
          </button>
          <button type="button" className="primary-btn tiny" onClick={cloneFromRemote} disabled={Boolean(busy) || !url.trim()}>
            {busy === 'clone' ? '克隆中…' : '⤓ 从远程克隆'}
          </button>
          {busy === 'clone' ? (
            <button type="button" className="ghost-btn tiny" onClick={cancelClone}>
              取消
            </button>
          ) : null}
        </div>

        <div className="repo-options">
          <label className="repo-check">
            <input type="checkbox" checked={linkOnly} onChange={(e) => setLinkOnly(e.target.checked)} disabled={Boolean(busy)} />
            <span>只记录路径（不复制文件，适合本来就在固定位置的大仓库）</span>
          </label>
          <label className="repo-check">
            <input type="checkbox" checked={depth} onChange={(e) => setDepth(e.target.checked)} disabled={Boolean(busy)} />
            <span>浅克隆（--depth 1，只取最新一次提交）</span>
          </label>
        </div>

        {detected && detected.urls && detected.urls.length ? (
          <div className="repo-detected">
            <span className="repo-dim">论文里找到 {detected.urls.length} 个地址：</span>
            {detected.urls.slice(0, 4).map((item) => (
              <button
                key={item.cloneUrl}
                type="button"
                className="repo-url-chip"
                title={item.cloneUrl}
                onClick={() => setUrl(item.webUrl)}
              >
                {PROVIDER_LABEL[item.provider] || item.host} · {item.owner}/{item.name}
              </button>
            ))}
          </div>
        ) : null}

        {busy ? (
          <div className="repo-progress">
            <div className="repo-progress-bar">
              <span style={{ width: `${percent == null ? 20 : percent}%` }} className={percent == null ? 'indeterminate' : ''} />
            </div>
            <div className="repo-progress-text">
              {busy === 'clone'
                ? progress
                  ? `${progress.label || 'git'}${percent == null ? '' : ` ${percent}%`}`
                  : '正在连接远程仓库…'
                : progress && progress.phase === 'scan'
                  ? `正在统计文件…${progress.files ? ` 已扫描 ${progress.files} 个` : ''}`
                  : progress
                    ? `复制中 ${percent == null ? 0 : percent}% · ${formatBytes(progress.done || 0)} / ${formatBytes(progress.total || 0)}`
                    : '正在准备复制…'}
            </div>
          </div>
        ) : (
          <div className="repo-hint">
            绑定后仓库会放在文库的 <code>repos/</code> 子目录里；复制方式会跳过 node_modules、.venv、__pycache__ 等可再生成的大目录。
          </div>
        )}
      </div>
    </div>
  );
}
