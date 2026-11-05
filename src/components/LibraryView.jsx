import React, { useEffect, useRef, useState } from 'react';
import { api, formatBytes, formatDate, guard, toast } from '../api.js';
import { generateThumbnail } from '../pdf/thumb.js';
import { startDocDrag } from '../dnd.js';

const SORTS = [
  { value: 'recent', label: '最近阅读' },
  { value: 'created', label: '导入时间' },
  { value: 'title', label: '标题' },
  { value: 'starred', label: '星标优先' },
];

function Thumb({ docId, hasThumb, title }) {
  const [src, setSrc] = useState(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    if (!hasThumb) return undefined;
    (async () => {
      const data = await guard(() => api.docs.thumb(docId));
      if (alive && data) setSrc(data);
      else if (alive) setFailed(true);
    })();
    return () => {
      alive = false;
    };
  }, [docId, hasThumb]);

  if (src) return <img className="card-thumb-img" src={src} alt={title} draggable={false} />;
  return (
    <div className="card-thumb-placeholder">
      <span>{failed ? '缩略图缺失' : 'PDF'}</span>
    </div>
  );
}

export default function LibraryView({
  docs,
  loading,
  filters,
  scopeTitle,
  onFilterChange,
  onOpen,
  onDetail,
  onRemove,
  onImport,
  onReload,
  importFolderId = null,
  importFolderName = '',
  onDragDocChange,
}) {
  const [keyword, setKeyword] = useState(filters.keyword || '');
  const [importing, setImporting] = useState(false);
  const [draggingId, setDraggingId] = useState(null);
  const dragRef = useRef(0);

  useEffect(() => {
    setKeyword(filters.keyword || '');
  }, [filters.keyword]);

  const submitSearch = () => {
    onFilterChange({ ...filters, keyword });
  };

  const doImport = async () => {
    setImporting(true);
    try {
      // 当前浏览某个分类时，导入的文献直接落到该分类
      const res = await api.docs.importFiles(importFolderId);
      if (!res || (!res.imported.length && !res.skipped.length)) return;
      await buildThumbs(res.imported);
      if (res.imported.length) {
        toast(`已导入 ${res.imported.length} 篇文献${importFolderName ? `到「${importFolderName}」` : ''}`, 'success');
      }
      if (res.skipped.length) toast(`跳过 ${res.skipped.length} 个文件（重复或格式不符）`, 'warn', 4500);
      onReload();
    } catch (err) {
      toast(err.message || '导入失败', 'error');
    } finally {
      setImporting(false);
    }
  };

  /** 为刚导入的文献生成首页缩略图 */
  const buildThumbs = async (items) => {
    for (const item of items || []) {
      try {
        const bytes = await api.docs.fileBytes(item.id);
        const { url, pageCount } = await generateThumbnail(bytes);
        await api.docs.saveThumb(item.id, url, pageCount);
      } catch (err) {
        console.warn('缩略图生成失败', item, err);
      }
    }
  };

  return (
    <section className="library">
      <header className="library-head">
        <div className="library-title">
          <h1>{scopeTitle}</h1>
          <span className="library-count">{docs.length} 篇</span>
        </div>
        <div className="library-actions">
          <input
            className="search-input"
            placeholder="搜索标题 / 作者 / 摘要…"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitSearch();
            }}
          />
          <select
            className="select"
            value={filters.sort || 'recent'}
            onChange={(e) => onFilterChange({ ...filters, sort: e.target.value })}
          >
            {SORTS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
          <button className="ghost-btn" onClick={onReload}>
            刷新
          </button>
          <button className="primary-btn" onClick={doImport} disabled={importing}>
            {importing ? '导入中…' : '导入 PDF'}
          </button>
        </div>
      </header>

      {loading && <div className="library-hint">正在读取文献列表…</div>}
      {!loading && !docs.length && (
        <div className="library-empty">
          <div className="empty-icon">📚</div>
          <h2>还没有文献</h2>
          <p>
            {importFolderName
              ? `当前分类「${importFolderName}」还没有文献，导入的 PDF 会自动归入该分类。`
              : '点击右上角「导入 PDF」，或把 PDF 文件拖拽到窗口里。'}
          </p>
          <button className="primary-btn" onClick={doImport} disabled={importing}>
            选择 PDF 文件
          </button>
        </div>
      )}

      <div className="card-grid">
        {docs.map((doc) => (
          <article
            key={doc.id}
            data-doc-id={doc.id}
            className={`doc-card ${draggingId === doc.id ? 'dragging' : ''}`}
            onClick={() => onOpen(doc)}
            draggable
            onDragStart={(e) => {
              startDocDrag(e, doc);
              setDraggingId(doc.id);
              if (onDragDocChange) onDragDocChange(doc.id);
            }}
            onDragEnd={() => {
              setDraggingId(null);
              if (onDragDocChange) onDragDocChange(null);
            }}
          >
            <div className="card-thumb">
              <Thumb docId={doc.id} hasThumb={Boolean(doc.has_thumb)} title={doc.title} />
              {doc.page_count ? <span className="card-pages">{doc.page_count} 页</span> : null}
              {doc.anno_count ? <span className="card-annos">🖍 {doc.anno_count}</span> : null}
            </div>
            <div className="card-body">
              <h3 className="card-title" title={doc.title}>
                {doc.title}
              </h3>
              <div className="card-meta">
                {doc.authors ? <span className="ellipsis">{doc.authors}</span> : <span>未知作者</span>}
                {doc.year ? <span className="card-year">{doc.year}</span> : null}
              </div>
              <div className="card-tags">
                {doc.folder_name ? <span className="folder-chip">📁 {doc.folder_name}</span> : null}
                {(doc.tags || []).slice(0, 3).map((tag) => (
                  <span key={tag.id} className="tag-chip tiny" style={{ borderColor: tag.color, color: tag.color }}>
                    #{tag.name}
                  </span>
                ))}
              </div>
              <div className="card-footer">
                <span className="stars">
                  {Array.from({ length: 5 }, (_, i) => (
                    <span key={i} className={i < (doc.star || 0) ? 'star on' : 'star'}>
                      ★
                    </span>
                  ))}
                </span>
                <span className="card-info">
                  {doc.last_read_at ? `读到 P${doc.last_page} · ${formatDate(doc.last_read_at)}` : formatBytes(doc.file_size)}
                </span>
              </div>
            </div>
            <div className="card-hover-actions">
              <button
                className="link-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  onDetail(doc);
                }}
              >
                详情
              </button>
              <button
                className="link-btn danger"
                onClick={(e) => {
                  e.stopPropagation();
                  if (window.confirm(`确定要从文库中移除《${doc.title}》吗？标注与笔记也会一并隐藏。`)) {
                    onRemove(doc);
                  }
                }}
              >
                移除
              </button>
            </div>
          </article>
        ))}
      </div>

      <div
        className="drop-hint"
        ref={dragRef}
        style={{ display: 'none' }}
      />
    </section>
  );
}
