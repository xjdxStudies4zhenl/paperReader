import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, guard, toast } from '../api.js';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

marked.setOptions({ breaks: true, gfm: true });

function renderMarkdown(src) {
  if (!src) return '';
  return DOMPurify.sanitize(marked.parse(src));
}

/**
 * 阅读器里的「本文笔记」编辑器。
 *
 * - 数据落在 pr_note_info，doc_id 关联当前文献（和「笔记」页是同一张表 / 同一套接口）；
 * - 打开时若本文还没有笔记，标题默认用论文标题，真正写了内容才会创建记录，避免留空笔记；
 * - Markdown 编辑 + 预览，输入后 800ms 自动保存，Ctrl/Cmd+S 手动保存，关闭前会补一次保存。
 */
export default function DocNoteDialog({ docId, docTitle, onClose }) {
  const [notes, setNotes] = useState([]);
  const [noteId, setNoteId] = useState(null);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [mode, setMode] = useState('edit');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState(null);
  const [creating, setCreating] = useState(false);

  const textareaRef = useRef(null);
  const dirtyRef = useRef(false);
  const mountedRef = useRef(true);

  const fallbackTitle = docTitle || '无标题笔记';

  useEffect(
    () => () => {
      mountedRef.current = false;
    },
    []
  );

  /* 载入本文已有笔记（按更新时间倒序，取最新一条先编辑） */
  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      try {
        const rows = await guard(() => api.notes.list(docId));
        if (!alive) return;
        const list = Array.isArray(rows) ? rows : [];
        setNotes(list);
        const first = list[0];
        if (first) {
          setNoteId(first.id);
          setTitle(first.title || '');
          setContent(first.content || '');
        } else {
          setNoteId(null);
          setTitle(fallbackTitle);
          setContent('');
        }
        dirtyRef.current = false;
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [docId, fallbackTitle]);

  const saveNow = useCallback(async () => {
    if (!dirtyRef.current) return null;
    const payload = {
      title: String(title || '').trim() || fallbackTitle,
      content,
      htmlContent: renderMarkdown(content),
      docId,
    };
    setSaving(true);
    try {
      if (noteId) {
        const updated = await guard(() => api.notes.update(noteId, payload), '保存笔记失败');
        if (updated) {
          setNotes((prev) => prev.map((n) => (String(n.id) === String(updated.id) ? updated : n)));
          setSavedAt(new Date());
          dirtyRef.current = false;
        }
        return updated;
      }
      const created = await guard(() => api.notes.create(payload), '创建笔记失败');
      if (created) {
        setNoteId(created.id);
        setNotes((prev) => [created, ...prev]);
        setSavedAt(new Date());
        dirtyRef.current = false;
        toast('已为本文创建笔记', 'success', 2200);
      }
      return created;
    } finally {
      if (mountedRef.current) setSaving(false);
    }
  }, [noteId, title, content, docId, fallbackTitle]);

  /* 输入后 800ms 自动保存 */
  useEffect(() => {
    if (!dirtyRef.current) return undefined;
    const timer = setTimeout(() => {
      saveNow();
    }, 800);
    return () => clearTimeout(timer);
  }, [title, content, saveNow]);

  const markDirty = () => {
    dirtyRef.current = true;
  };

  const handleClose = useCallback(async () => {
    if (dirtyRef.current) await saveNow();
    onClose();
  }, [saveNow, onClose]);

  /* Esc 关闭（并优先于阅读器的其它快捷键） */
  useEffect(() => {
    const onKey = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        handleClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [handleClose]);

  const switchNote = async (id) => {
    if (dirtyRef.current) await saveNow();
    const target = notes.find((n) => String(n.id) === String(id));
    if (!target) return;
    setNoteId(target.id);
    setTitle(target.title || '');
    setContent(target.content || '');
    setSavedAt(null);
    dirtyRef.current = false;
  };

  const createAnother = async () => {
    if (creating) return;
    if (dirtyRef.current) await saveNow();
    setCreating(true);
    try {
      const created = await guard(
        () => api.notes.create({ title: fallbackTitle, content: '', htmlContent: '', docId }),
        '创建笔记失败'
      );
      if (created) {
        setNotes((prev) => [created, ...prev]);
        setNoteId(created.id);
        setTitle(created.title || '');
        setContent('');
        setSavedAt(null);
        dirtyRef.current = false;
        toast('已新建一条笔记', 'success', 2000);
      }
    } finally {
      setCreating(false);
    }
  };

  const removeNote = async () => {
    if (!noteId) return;
    if (!window.confirm('删除这条笔记？此操作不可恢复。')) return;
    const res = await guard(() => api.notes.remove(noteId), '删除笔记失败');
    if (!res) return;
    const rest = notes.filter((n) => String(n.id) !== String(noteId));
    setNotes(rest);
    const next = rest[0];
    setNoteId(next ? next.id : null);
    setTitle(next ? next.title || '' : fallbackTitle);
    setContent(next ? next.content || '' : '');
    setSavedAt(null);
    dirtyRef.current = false;
    toast('笔记已删除', 'success');
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Tab' && mode === 'edit') {
      e.preventDefault();
      const ta = textareaRef.current;
      if (!ta) return;
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      setContent(content.substring(0, start) + '  ' + content.substring(end));
      markDirty();
      requestAnimationFrame(() => {
        ta.selectionStart = ta.selectionEnd = start + 2;
      });
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      saveNow();
    }
  };

  const previewHtml = useMemo(() => renderMarkdown(content), [content]);

  return (
    <div className="modal-mask" onClick={handleClose}>
      <div className="modal doc-note-modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h2>📝 本文笔记</h2>
          <span className="doc-note-doc" title={docTitle || ''}>
            {docTitle || '未命名文献'}
          </span>
          <div className="spacer" />
          <button className="icon-btn" title="关闭（Esc，自动保存）" onClick={handleClose}>
            ✕
          </button>
        </header>

        <div className="note-editor">
          <div className="note-editor-head">
            <input
              className="note-editor-title"
              value={title}
              placeholder="笔记标题（默认用论文标题，可修改）"
              onChange={(e) => {
                markDirty();
                setTitle(e.target.value);
              }}
              onKeyDown={handleKeyDown}
            />
            <div className="note-editor-toolbar">
              {saving ? (
                <span className="note-saving">保存中…</span>
              ) : savedAt ? (
                <span className="doc-note-saved">已保存 {savedAt.toLocaleTimeString('zh-CN', { hour12: false })}</span>
              ) : null}
              <div className="note-mode-tabs">
                <button className={`note-mode-tab ${mode === 'edit' ? 'active' : ''}`} onClick={() => setMode('edit')}>
                  编辑
                </button>
                <button
                  className={`note-mode-tab ${mode === 'preview' ? 'active' : ''}`}
                  onClick={() => setMode('preview')}
                >
                  预览
                </button>
              </div>
              {notes.length > 1 ? (
                <select
                  className="note-doc-select"
                  value={noteId || ''}
                  onChange={(e) => switchNote(e.target.value)}
                  title="切换本文关联的其它笔记"
                >
                  {notes.map((n) => (
                    <option key={n.id} value={n.id}>
                      {n.title || '无标题笔记'}
                    </option>
                  ))}
                </select>
              ) : null}
              <button className="ghost-btn tiny" onClick={createAnother} disabled={creating} title="再给本文新建一条笔记">
                ＋ 新建
              </button>
              {noteId ? (
                <button className="note-delete-btn" title="删除当前笔记" onClick={removeNote}>
                  🗑
                </button>
              ) : null}
            </div>
          </div>

          {loading ? (
            <div className="note-editor-empty">
              <p>正在读取笔记…</p>
            </div>
          ) : mode === 'edit' ? (
            <textarea
              ref={textareaRef}
              className="note-editor-textarea"
              value={content}
              placeholder="记录这篇论文的阅读思路、公式推导、实验细节、疑问…支持 Markdown（Ctrl+S 手动保存）"
              onChange={(e) => {
                markDirty();
                setContent(e.target.value);
              }}
              onKeyDown={handleKeyDown}
              spellCheck={false}
              autoFocus
            />
          ) : (
            <div className="note-editor-preview markdown-body" dangerouslySetInnerHTML={{ __html: previewHtml }} />
          )}
        </div>
      </div>
    </div>
  );
}
