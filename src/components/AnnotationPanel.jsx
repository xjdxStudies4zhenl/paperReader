import React, { useEffect, useMemo, useState } from 'react';
import { api, guard, formatDate, toast } from '../api.js';

const TYPE_LABEL = {
  highlight: '高亮',
  underline: '下划线',
  strike: '删除线',
  box: '框选',
  ink: '手绘',
  note: '便签',
};

const TYPE_ICON = {
  highlight: '🖍',
  underline: '▁',
  strike: '⌁',
  box: '▭',
  ink: '✏',
  note: '📌',
};

/** 右侧批注面板 + 批注编辑抽屉 */
export default function AnnotationPanel({
  annos,
  docId,
  selectedId,
  editing,
  onSelect,
  onEdit,
  onCloseEdit,
  onUpdate,
  onRemove,
}) {
  const [filter, setFilter] = useState('all');
  const [keyword, setKeyword] = useState('');
  /** 单条批注折叠：记住被折叠的批注 id（正在编辑的那条始终展开） */
  const [folded, setFolded] = useState(() => new Set());

  const toggleFold = (id) => {
    setFolded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const filtered = useMemo(() => {
    return annos.filter((anno) => {
      if (filter !== 'all' && anno.anno_type !== filter) return false;
      if (keyword) {
        const text = `${anno.quote || ''} ${anno.content || ''}`.toLowerCase();
        if (!text.includes(keyword.toLowerCase())) return false;
      }
      return true;
    });
  }, [annos, filter, keyword]);

  const grouped = useMemo(() => {
    const map = new Map();
    for (const anno of filtered) {
      if (!map.has(anno.page_no)) map.set(anno.page_no, []);
      map.get(anno.page_no).push(anno);
    }
    return [...map.entries()].sort((a, b) => a[0] - b[0]);
  }, [filtered]);

  return (
    <aside className="anno-panel">
      <div className="anno-panel-head">
        <div className="anno-panel-title">批注列表</div>
        <span className="anno-count">{filtered.length}</span>
      </div>

      <div className="anno-panel-tools">
        <input
          className="search-input small"
          placeholder="搜索批注 / 原文"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
        />
        <select className="select small" value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="all">全部类型</option>
          {Object.entries(TYPE_LABEL).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </div>

      <div className="anno-list">
        {!grouped.length && <div className="anno-empty">还没有批注，选中文字或使用工具开始标注吧。</div>}
        {grouped.map(([pageNo, items]) => (
          <section key={pageNo} className="anno-page-group">
            <div className="anno-page-title">
              第 {pageNo} 页<span>{items.length}</span>
            </div>
            {items.map((anno) => {
              const isFolded = folded.has(anno.id) && !(editing && editing.id === anno.id);
              const preview = String(anno.content || anno.quote || '').replace(/\s+/g, ' ').trim();
              return (
                <article
                  key={anno.id}
                  className={`anno-card ${String(anno.id) === String(selectedId) ? 'active' : ''} ${isFolded ? 'folded' : ''}`}
                  onClick={() => {
                    // 点折叠的卡片先展开，再跳转
                    if (isFolded) toggleFold(anno.id);
                    onSelect(anno);
                  }}
                >
                  <div className="anno-card-head">
                    <button
                      type="button"
                      className="anno-fold"
                      title={isFolded ? '展开这条批注' : '折叠这条批注'}
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleFold(anno.id);
                      }}
                    >
                      {isFolded ? '▸' : '▾'}
                    </button>
                    <span className="anno-type" title={TYPE_LABEL[anno.anno_type] || anno.anno_type}>
                      {TYPE_ICON[anno.anno_type] || '•'} {TYPE_LABEL[anno.anno_type] || anno.anno_type}
                    </span>
                    <span className="anno-color" style={{ background: anno.color }} />
                    <span className="anno-time">{formatDate(anno.created_at)}</span>
                  </div>
                  {isFolded ? (
                    <p className="anno-preview" title={preview}>
                      {preview || '（这条批注没有文字内容）'}
                    </p>
                  ) : (
                    <>
                      {anno.quote ? <blockquote className="anno-quote">{anno.quote}</blockquote> : null}
                      {anno.content ? <p className="anno-content">{anno.content}</p> : null}
                      <div className="anno-card-actions">
                        <button
                          className="link-btn"
                          onClick={(e) => {
                            e.stopPropagation();
                            onEdit(anno);
                          }}
                        >
                          编辑
                        </button>
                        <button
                          className="link-btn danger"
                          onClick={(e) => {
                            e.stopPropagation();
                            onRemove(anno.id);
                          }}
                        >
                          删除
                        </button>
                      </div>
                    </>
                  )}
                </article>
              );
            })}
          </section>
        ))}
      </div>

      {editing && (
        <AnnotationEditor
          anno={editing}
          onClose={onCloseEdit}
          onUpdate={onUpdate}
          onRemove={onRemove}
        />
      )}
    </aside>
  );
}

function AnnotationEditor({ anno, onClose, onUpdate, onRemove }) {
  const [content, setContent] = useState(anno.content || '');
  const [color, setColor] = useState(anno.color || '#ffd400');
  const [replies, setReplies] = useState([]);
  const [replyText, setReplyText] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setContent(anno.content || '');
    setColor(anno.color || '#ffd400');
    (async () => {
      const rows = await guard(() => api.annos.replies(anno.id));
      setReplies(rows || []);
    })();
  }, [anno.id]);

  const save = async () => {
    setSaving(true);
    try {
      await onUpdate(anno.id, { content, color });
      toast('批注已保存', 'success');
    } finally {
      setSaving(false);
    }
  };

  const addReply = async () => {
    if (!replyText.trim()) return;
    const row = await guard(() => api.annos.addReply(anno.id, replyText));
    if (row) {
      setReplies((prev) => [...prev, row]);
      setReplyText('');
    }
  };

  const removeReply = async (id) => {
    const ok = await guard(() => api.annos.removeReply(id));
    if (ok) setReplies((prev) => prev.filter((r) => r.id !== id));
  };

  return (
    <div className="anno-editor">
      <div className="anno-editor-head">
        <strong>编辑批注</strong>
        <button className="icon-btn" onClick={onClose}>
          ✕
        </button>
      </div>

      {anno.quote ? (
        <div className="anno-editor-quote">
          <span>原文</span>
          <blockquote>{anno.quote}</blockquote>
        </div>
      ) : null}

      <label className="field">
        <span>批注内容</span>
        <textarea rows={6} value={content} onChange={(e) => setContent(e.target.value)} placeholder="写下你的理解、疑问或结论…" />
      </label>

      <div className="field">
        <span>颜色</span>
        <div className="color-row">
          {['#ffd400', '#ff4d4f', '#ff9f43', '#52c41a', '#5b8def', '#c56cf0'].map((c) => (
            <button
              key={c}
              className={`color-dot ${color === c ? 'active' : ''}`}
              style={{ background: c }}
              onClick={() => setColor(c)}
            />
          ))}
        </div>
      </div>

      <div className="reply-block">
        <div className="reply-title">讨论（{replies.length}）</div>
        {replies.map((r) => (
          <div key={r.id} className="reply-item">
            <div className="reply-meta">
              {r.author} · {formatDate(r.created_at)}
              <button className="link-btn danger" onClick={() => removeReply(r.id)}>
                删除
              </button>
            </div>
            <div className="reply-content">{r.content}</div>
          </div>
        ))}
        <div className="reply-add">
          <input
            className="search-input small"
            placeholder="追加一条讨论…"
            value={replyText}
            onChange={(e) => setReplyText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') addReply();
            }}
          />
          <button className="ghost-btn" onClick={addReply}>
            发送
          </button>
        </div>
      </div>

      <div className="anno-editor-actions">
        <button className="danger-btn" onClick={() => onRemove(anno.id)}>
          删除标注
        </button>
        <div className="spacer" />
        <button className="ghost-btn" onClick={onClose}>
          取消
        </button>
        <button className="primary-btn" onClick={save} disabled={saving}>
          {saving ? '保存中…' : '保存'}
        </button>
      </div>
    </div>
  );
}
