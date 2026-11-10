import React, { useCallback, useEffect, useState } from 'react';
import { api, formatBytes, toast } from '../api.js';

const ICON_DIR = '📁';
const ICON_FILE = '📄';

/** 常见图片扩展：预览时直接出图，不出文本 */
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg']);

/**
 * 仓库文件树 + 单文件预览。
 * 详情弹窗和阅读器右侧的「码仓」面板共用这一个组件。
 */
export default function RepoBrowser({ docId, onEmpty, compact = false }) {
  const [tree, setTree] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState(() => new Set(['']));
  const [openedFile, setOpenedFile] = useState(null);
  const [fileLoading, setFileLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await api.repo.tree(docId, {});
      setTree(res);
      if (res && !res.bound && onEmpty) onEmpty();
    } catch (err) {
      setError(err.message || '读取仓库文件失败');
    } finally {
      setLoading(false);
    }
  }, [docId, onEmpty]);

  useEffect(() => {
    load();
  }, [load]);

  const toggleDir = (pathKey) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(pathKey)) next.delete(pathKey);
      else next.add(pathKey);
      return next;
    });
  };

  const openFile = async (node) => {
    setFileLoading(true);
    setOpenedFile({ name: node.name, path: node.path, size: node.size, loading: true });
    try {
      const res = await api.repo.file(docId, node.path);
      setOpenedFile(res);
    } catch (err) {
      toast(err.message || '读取文件失败', 'error');
      setOpenedFile(null);
    } finally {
      setFileLoading(false);
    }
  };

  const renderNodes = (nodes, depth) => {
    if (!nodes || !nodes.length) return null;
    return (
      <ul className="repo-tree-list">
        {nodes.map((node) => {
          const isDir = node.type === 'dir';
          const isOpen = expanded.has(node.path);
          return (
            <li key={node.path} className="repo-tree-item">
              <button
                type="button"
                className={`repo-tree-row ${isDir ? 'is-dir' : 'is-file'}`}
                style={{ paddingLeft: 8 + depth * 13 }}
                title={node.path}
                onClick={() => (isDir ? toggleDir(node.path) : openFile(node))}
              >
                <span className="repo-tree-caret">{isDir ? (isOpen ? '▾' : '▸') : ''}</span>
                <span className="repo-tree-icon">{isDir ? ICON_DIR : ICON_FILE}</span>
                <span className="repo-tree-name">{node.name}</span>
                {!isDir ? <span className="repo-tree-size">{formatBytes(node.size)}</span> : null}
              </button>
              {isDir && isOpen ? renderNodes(node.children, depth + 1) : null}
            </li>
          );
        })}
      </ul>
    );
  };

  if (loading) {
    return <div className={`repo-browser ${compact ? 'compact' : ''}`}>
      <div className="repo-browser-head">
        <strong>仓库文件</strong>
      </div>
      <div className="repo-hint">读取中…</div>
    </div>;
  }

  if (error) {
    return (
      <div className={`repo-browser ${compact ? 'compact' : ''}`}>
        <div className="repo-browser-head">
          <strong>仓库文件</strong>
          <button type="button" className="ghost-btn tiny" onClick={load}>
            重试
          </button>
        </div>
        <div className="repo-hint repo-warn">{error}</div>
      </div>
    );
  }

  if (!tree || !tree.bound) {
    return (
      <div className={`repo-browser ${compact ? 'compact' : ''}`}>
        <div className="repo-browser-head">
          <strong>仓库文件</strong>
        </div>
        <div className="repo-hint">还没有绑定代码仓库，绑定后这里会列出仓库文件。</div>
      </div>
    );
  }

  if (!tree.exists) {
    return (
      <div className={`repo-browser ${compact ? 'compact' : ''}`}>
        <div className="repo-browser-head">
          <strong>仓库文件</strong>
        </div>
        <div className="repo-hint">
          {tree.remoteOnly
            ? '只保存了仓库地址，还没有本地文件。绑定本地文件夹或从远程克隆之后，这里会列出文件。'
            : '仓库目录不存在，可能已被移动或删除。'}
        </div>
      </div>
    );
  }

  return (
    <div className={`repo-browser ${compact ? 'compact' : ''}`}>
      <div className="repo-browser-head">
        <strong>仓库文件</strong>
        <span className="repo-tree-count">{tree.total} 项</span>
        <div className="spacer" />
        <button type="button" className="ghost-btn tiny" onClick={load} title="重新读取目录">
          刷新
        </button>
      </div>

      <div className="repo-tree">
        {tree.nodes && tree.nodes.length ? (
          renderNodes(tree.nodes, 0)
        ) : (
          <div className="repo-hint">仓库是空的。</div>
        )}
      </div>

      {tree.truncated ? (
        <div className="repo-hint">文件太多，只显示了前 {tree.total} 项。完整的目录请点「打开文件夹」。</div>
      ) : null}

      {openedFile ? (
        <div className="repo-viewer-mask" onClick={() => setOpenedFile(null)}>
          <div className="repo-viewer" onClick={(e) => e.stopPropagation()}>
            <header className="repo-viewer-head">
              <span className="repo-viewer-title" title={openedFile.path}>
                {openedFile.name || openedFile.path}
              </span>
              <span className="repo-viewer-size">{formatBytes(openedFile.size || 0)}</span>
              <div className="spacer" />
              <button className="icon-btn" onClick={() => setOpenedFile(null)} title="关闭">
                ✕
              </button>
            </header>
            <div className="repo-viewer-body">
              {openedFile.loading || fileLoading ? (
                <div className="repo-hint">读取中…</div>
              ) : openedFile.tooLarge ? (
                <div className="repo-hint repo-warn">文件超过 400KB，不在应用内预览。请用「打开文件夹」在系统里查看。</div>
              ) : openedFile.binary ? (
                IMAGE_EXT.has(String(openedFile.ext || '')) ? (
                  <div className="repo-hint">图片文件（{openedFile.ext}），请在系统里打开查看。</div>
                ) : (
                  <div className="repo-hint">二进制文件（{openedFile.ext || '无扩展名'}），不在应用内预览。</div>
                )
              ) : (
                <pre className="repo-viewer-code">{openedFile.text}</pre>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
