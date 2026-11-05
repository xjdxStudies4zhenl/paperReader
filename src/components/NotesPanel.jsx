import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, guard, toast, formatDate } from '../api.js';
import NotesGraph from './NotesGraph.jsx';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

marked.setOptions({ breaks: true, gfm: true });

function renderMarkdown(src) {
  if (!src) return '';
  const html = marked.parse(src);
  return DOMPurify.sanitize(html);
}

function NoteListItem({ note, active, onClick, onDelete }) {
  const title = note.title || '无标题笔记';
  const docLabel = note.doc_title ? `📄 ${note.doc_title}` : null;
  const preview = (note.content || '').replace(/[#*`>\-\[\]()!]/g, '').slice(0, 60);

  return (
    <div className={`note-list-item ${active ? 'active' : ''}`} onClick={onClick}>
      <button
        type="button"
        className="note-item-del"
        title="删除这条笔记"
        onClick={(e) => {
          e.stopPropagation();
          onDelete(note);
        }}
      >
        🗑
      </button>
      <div className="note-item-title">{title}</div>
      {docLabel && <div className="note-item-doc">{docLabel}</div>}
      <div className="note-item-preview">{preview || '空笔记'}</div>
      <div className="note-item-date">{formatDate(note.updated_at)}</div>
    </div>
  );
}

function NoteEditor({ note, docs, onSave, onDelete }) {
  const [title, setTitle] = useState(note?.title || '');
  const [content, setContent] = useState(note?.content || '');
  const [mode, setMode] = useState('edit');
  const [docId, setDocId] = useState(note?.doc_id || '');
  const [saving, setSaving] = useState(false);
  const textareaRef = useRef(null);
  const saveTimerRef = useRef(null);

  useEffect(() => {
    setTitle(note?.title || '');
    setContent(note?.content || '');
    setDocId(note?.doc_id || '');
    setMode('edit');
  }, [note?.id]);

  /** 只有内容真的变了才自动保存（否则 note 对象每次更新都会再触发一轮保存，形成死循环） */
  const normalizedTitle = (value) => String(value || '').trim() || '无标题笔记';
  const dirty =
    Boolean(note) &&
    (normalizedTitle(title) !== normalizedTitle(note.title) ||
      content !== String(note.content || '') ||
      String(docId || '') !== String(note.doc_id || ''));

  const autoSave = useCallback(() => {
    if (!note) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(async () => {
      setSaving(true);
      try {
        await onSave(note.id, {
          title: normalizedTitle(title),
          content,
          htmlContent: renderMarkdown(content),
          docId: docId ? Number(docId) : null,
        });
      } finally {
        setSaving(false);
      }
    }, 600);
  }, [note, title, content, docId, onSave]);

  useEffect(() => {
    if (!note || !dirty) return undefined;
    autoSave();
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, [dirty, note, autoSave]);

  const handleManualSave = async () => {
    if (!note || saving) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    setSaving(true);
    try {
      await onSave(note.id, {
        title: title.trim() || '无标题笔记',
        content,
        htmlContent: renderMarkdown(content),
        docId: docId ? Number(docId) : null,
      });
    } finally {
      setSaving(false);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Tab' && mode === 'edit') {
      e.preventDefault();
      const ta = textareaRef.current;
      if (!ta) return;
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      const next = content.substring(0, start) + '  ' + content.substring(end);
      setContent(next);
      requestAnimationFrame(() => {
        ta.selectionStart = ta.selectionEnd = start + 2;
      });
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      handleManualSave();
    }
  };

  const previewHtml = useMemo(() => renderMarkdown(content), [content]);

  if (!note) {
    return (
      <div className="note-editor-empty">
        <div className="note-editor-empty-icon">📝</div>
        <p>选择一篇笔记开始编辑</p>
        <p className="note-editor-empty-hint">或点击左下角「新建笔记」创建</p>
      </div>
    );
  }

  return (
    <div className="note-editor">
      <div className="note-editor-head">
        <input
          className="note-editor-title"
          value={title}
          placeholder="笔记标题…"
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        <div className="note-editor-toolbar">
          {saving && <span className="note-saving">保存中…</span>}
          <div className="note-mode-tabs">
            <button
              className={`note-mode-tab ${mode === 'edit' ? 'active' : ''}`}
              onClick={() => setMode('edit')}
            >
              编辑
            </button>
            <button
              className={`note-mode-tab ${mode === 'preview' ? 'active' : ''}`}
              onClick={() => setMode('preview')}
            >
              预览
            </button>
          </div>
          <select
            className="note-doc-select"
            value={docId}
            onChange={(e) => setDocId(e.target.value)}
            title="关联文献"
          >
            <option value="">不关联文献</option>
            {docs.map((d) => (
              <option key={d.id} value={d.id}>
                {d.title || d.orig_name || `文献 #${d.id}`}
              </option>
            ))}
          </select>
          <button
            className="note-delete-btn with-text"
            title="删除笔记"
            onClick={() => onDelete(note.id)}
          >
            🗑 删除
          </button>
        </div>
      </div>

      {mode === 'edit' ? (
        <textarea
          ref={textareaRef}
          className="note-editor-textarea"
          value={content}
          placeholder="在这里写笔记…支持 Markdown 语法"
          onChange={(e) => setContent(e.target.value)}
          onKeyDown={handleKeyDown}
          spellCheck={false}
        />
      ) : (
        <div
          className="note-editor-preview markdown-body"
          dangerouslySetInnerHTML={{ __html: previewHtml }}
        />
      )}
    </div>
  );
}

export default function NotesPanel({ docs, folders = [], onOpenDoc, onOpenFolder }) {
  const [notes, setNotes] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  /** 列表（逐条编辑） / 关系图（笔记 ↔ 文献 力导向图） */
  const [view, setView] = useState('list');

  const activeNote = useMemo(
    () => notes.find((n) => String(n.id) === String(activeId)) || null,
    [notes, activeId]
  );

  const loadNotes = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await api.notes.list();
      setNotes(rows || []);
      if (rows && rows.length) {
        setActiveId((prev) => prev || rows[0].id);
      }
    } catch (err) {
      toast(err.message || '读取笔记失败', 'error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadNotes();
  }, [loadNotes]);

  const handleCreate = async () => {
    if (creating) return;
    setCreating(true);
    try {
      const note = await guard(
        () => api.notes.create({ title: '', content: '', htmlContent: '' }),
        '创建笔记失败'
      );
      if (note) {
        setNotes((prev) => [note, ...prev]);
        setActiveId(note.id);
        toast('已创建新笔记', 'success');
      }
    } finally {
      setCreating(false);
    }
  };

  const handleSave = async (id, patch) => {
    const updated = await guard(
      () => api.notes.update(id, patch),
      '保存笔记失败'
    );
    if (updated) {
      setNotes((prev) => prev.map((n) => (String(n.id) === String(id) ? updated : n)));
    }
  };

  const handleDelete = async (id) => {
    const note = notes.find((n) => String(n.id) === String(id));
    if (!note) return;
    const confirmed = window.confirm(`删除笔记「${note.title || '无标题'}」？\n此操作不可恢复。`);
    if (!confirmed) return;
    const res = await guard(() => api.notes.remove(id), '删除笔记失败');
    if (res) {
      const rest = notes.filter((n) => String(n.id) !== String(id));
      setNotes(rest);
      // 删的是当前笔记就顺到下一篇，避免编辑器空着
      if (String(activeId) === String(id)) setActiveId(rest[0] ? rest[0].id : null);
      toast('笔记已删除', 'success');
    }
  };

  return (
    <div className="notes-view">
      <div className="notes-sidebar">
        <div className="notes-sidebar-head">
          <h2>📝 笔记</h2>
          <button className="ghost-btn tiny" onClick={handleCreate} disabled={creating}>
            {creating ? '…' : '＋ 新建'}
          </button>
        </div>
        <div className="notes-view-tabs">
          <button
            type="button"
            className={`notes-view-tab ${view === 'list' ? 'active' : ''}`}
            onClick={() => setView('list')}
            title="列表：逐条编辑"
          >
            ☰ 列表
          </button>
          <button
            type="button"
            className={`notes-view-tab ${view === 'graph' ? 'active' : ''}`}
            onClick={() => setView('graph')}
            title="关系图：看笔记和论文的关联"
          >
            ⚭ 关系图
          </button>
        </div>
        <div className="notes-list">
          {loading && <div className="notes-loading">加载中…</div>}
          {!loading && notes.length === 0 && (
            <div className="notes-empty">
              <p>还没有笔记</p>
              <p className="notes-empty-hint">点击「＋ 新建」创建第一篇笔记</p>
            </div>
          )}
          {notes.map((note) => (
            <NoteListItem
              key={note.id}
              note={note}
              active={String(note.id) === String(activeId)}
              onClick={() => {
                setActiveId(note.id);
                setView('list');
              }}
              onDelete={(n) => handleDelete(n.id)}
            />
          ))}
        </div>
      </div>
      {/* 编辑器保持挂载（切到关系图时不丢未保存的输入），只是隐藏 */}
      <div className="notes-pane" style={view === 'graph' ? { display: 'none' } : undefined}>
        <NoteEditor note={activeNote} docs={docs} onSave={handleSave} onDelete={handleDelete} />
      </div>
      {view === 'graph' && (
        <NotesGraph
          notes={notes}
          docs={docs}
          folders={folders}
          activeNoteId={activeId}
          onSelectNote={(id) => {
            setActiveId(id);
            setView('list');
          }}
          onOpenDoc={onOpenDoc}
          onOpenFolder={onOpenFolder}
        />
      )}
    </div>
  );
}
