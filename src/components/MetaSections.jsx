import React, { useEffect, useRef, useState } from 'react';
import { isDocDrag, readDocId } from '../dnd.js';

/** 与主进程 electron/ipc/meta.js 的 TAG_COLORS 保持一致 */
export const TAG_COLORS = ['#5b8def', '#37c98b', '#ffb020', '#ff5f6d', '#a78bfa', '#22d3ee', '#f472b6', '#84cc16'];

/* ------------------------------- 图标 ------------------------------- */

function ChevronIcon() {
  return (
    <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true">
      <path d="M4.6 2.8 8 6l-3.4 3.2" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg className="row-icon" viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
      <path
        d="M1.6 3.6A1.4 1.4 0 0 1 3 2.2h3.1c.4 0 .8.17 1.05.47l.72.86H13a1.4 1.4 0 0 1 1.4 1.4v7.2A1.4 1.4 0 0 1 13 13.5H3a1.4 1.4 0 0 1-1.4-1.4z"
        fill="currentColor"
        opacity="0.9"
      />
    </svg>
  );
}

/* ------------------------------- 行内表单 ------------------------------- */

/** 新建 / 重命名分类与标签；回车提交、Esc 取消 */
function MetaForm({ placeholder, initialName = '', initialColor = '', withColor = false, busyText = '保存中…', onSubmit, onCancel }) {
  const [name, setName] = useState(initialName);
  const [color, setColor] = useState(initialColor || TAG_COLORS[0]);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef(null);

  useEffect(() => {
    if (inputRef.current) inputRef.current.focus();
  }, []);

  const commit = async () => {
    const value = name.trim();
    if (!value || busy) return;
    setBusy(true);
    let ok = false;
    try {
      ok = await onSubmit(value, color);
    } finally {
      if (!ok) setBusy(false);
    }
  };

  return (
    <div className="meta-form">
      <input
        ref={inputRef}
        className="meta-form-input"
        value={name}
        placeholder={placeholder}
        disabled={busy}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            onCancel();
          }
        }}
      />
      {withColor && (
        <div className="color-row">
          {TAG_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              className={`color-dot ${c.toLowerCase() === String(color).toLowerCase() ? 'active' : ''}`}
              style={{ background: c }}
              title={c}
              disabled={busy}
              onClick={() => setColor(c)}
            />
          ))}
        </div>
      )}
      <div className="meta-form-actions">
        <button type="button" className="ghost-btn tiny" disabled={busy} onClick={commit}>
          {busy ? busyText : '确定'}
        </button>
        <button type="button" className="ghost-btn tiny" disabled={busy} onClick={onCancel}>
          取消
        </button>
      </div>
    </div>
  );
}

/* ------------------------------- 分类树 ------------------------------- */

/** 扁平分类（含 parent_id）→ 树 */
function buildFolderTree(folders) {
  const byId = new Map();
  for (const f of folders) byId.set(String(f.id), { ...f, children: [] });
  const roots = [];
  for (const f of folders) {
    const node = byId.get(String(f.id));
    if (!node.parent_id) {
      roots.push(node);
    } else {
      const parent = byId.get(String(node.parent_id));
      if (parent) parent.children.push(node);
      else roots.push(node); // 父级已不存在的孤儿节点落到根
    }
  }
  return roots;
}

/** 单个分类节点（递归渲染子节点） */
function FolderNode(props) {
  const {
    folder,
    expandedIds,
    onToggleExpand,
    editing,
    dropTarget,
    dropProps,
    selectedId,
    onSelectFolder,
    onCreateSubfolder,
    onRenameFolder,
    onRemoveFolder,
    onSubmitRename,
    onSubmitChild,
    onCancelEdit,
  } = props;

  const id = String(folder.id);
  const isExpanded = expandedIds.has(id);
  const hasChildren = folder.children.length > 0;
  const selected = String(selectedId) === id;

  return (
    <li className="folder-item">
      <div
        className={`side-row ${selected ? 'active' : ''} ${dropTarget === id ? 'drop-active' : ''}`}
        {...dropProps(id)}
      >
        <button
          type="button"
          className={`folder-chevron ${hasChildren ? '' : 'leaf'} ${isExpanded ? 'open' : ''}`}
          tabIndex={hasChildren ? 0 : -1}
          title={hasChildren ? (isExpanded ? '折叠' : '展开') : ''}
          onClick={(e) => {
            e.stopPropagation();
            if (hasChildren) onToggleExpand(folder.id);
          }}
        >
          <ChevronIcon />
        </button>

        <button type="button" className="side-label" title={folder.name} onClick={() => onSelectFolder(folder.id)}>
          <FolderIcon />
          <span className="side-label-text">{folder.name}</span>
          {folder.doc_count > 0 ? <span className="count-badge">{folder.doc_count}</span> : null}
        </button>

        <span className="side-actions">
          <button type="button" className="tag-action" title="新建子分类" onClick={(e) => { e.stopPropagation(); onCreateSubfolder(folder.id); }}>
            ＋
          </button>
          <button type="button" className="tag-action" title="重命名分类" onClick={(e) => { e.stopPropagation(); onRenameFolder(folder.id, folder.name); }}>
            ✎
          </button>
          <button type="button" className="tag-action" title="删除分类" onClick={(e) => { e.stopPropagation(); onRemoveFolder(folder.id); }}>
            ✕
          </button>
        </span>
      </div>

      {/* 重命名表单 */}
      {editing && editing.type === 'folder-rename' && editing.id === folder.id && (
        <MetaForm
          placeholder="新分类名称"
          initialName={editing.name}
          onSubmit={(name) => onSubmitRename(folder.id, name)}
          onCancel={onCancelEdit}
        />
      )}

      {/* 新建子分类表单 */}
      {editing && editing.type === 'folder-new-child' && editing.parentId === folder.id && (
        <MetaForm
          placeholder="子分类名称"
          onSubmit={(name) => onSubmitChild(folder.id, name)}
          onCancel={onCancelEdit}
        />
      )}

      {/* 子节点 */}
      {isExpanded && hasChildren && (
        <ul className="folder-children">
          {folder.children.map((child) => (
            <FolderNode key={child.id} {...props} folder={child} />
          ))}
        </ul>
      )}
    </li>
  );
}

/* ------------------------------- 主组件 ------------------------------- */

/**
 * 侧边栏的"分类 / 标签"区域。
 * 新建、重命名、删除都会走 IPC 落到 MySQL，成功后由上层刷新元数据。
 */
export default function MetaSections({
  filters,
  onChange,
  folders = [],
  tags = [],
  onCreateFolder,
  onRenameFolder,
  onRemoveFolder,
  onCreateTag,
  onRenameTag,
  onRemoveTag,
  onMoveDoc,
  dragging = false,
}) {
  // editing = { type: 'folder-new' | 'folder-new-child' | 'folder-rename' | 'tag-new' | 'tag-rename', id?, parentId?, name?, color? }
  const [editing, setEditing] = useState(null);
  // 当前被卡片拖拽悬停的分类（'none' 或 folder.id）
  const [dropTarget, setDropTarget] = useState(null);
  // 分类树展开状态；新出现的节点默认展开，用户手动折叠的不强行恢复
  const [expandedIds, setExpandedIds] = useState(() => new Set(folders.map((f) => String(f.id))));
  const knownIds = useRef(new Set(folders.map((f) => String(f.id))));

  const closeEditor = () => setEditing(null);

  useEffect(() => {
    if (!dragging) setDropTarget(null);
  }, [dragging]);

  useEffect(() => {
    setExpandedIds((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const f of folders) {
        const id = String(f.id);
        if (!knownIds.current.has(id)) {
          knownIds.current.add(id);
          next.add(id);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [folders]);

  /** 分类行作为「拖拽文献卡片」的投放目标 */
  const dropProps = (key) => ({
    onDragOver: (e) => {
      if (!isDocDrag(e) || !onMoveDoc) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      setDropTarget((prev) => (prev === key ? prev : key));
    },
    onDragLeave: (e) => {
      if (!isDocDrag(e)) return;
      if (e.currentTarget.contains(e.relatedTarget)) return;
      setDropTarget((prev) => (prev === key ? null : prev));
    },
    onDrop: async (e) => {
      if (!isDocDrag(e) || !onMoveDoc) return;
      e.preventDefault();
      e.stopPropagation();
      setDropTarget(null);
      const docId = readDocId(e);
      if (docId == null) return;
      await onMoveDoc(docId, key);
    },
  });

  const toggleExpand = (id) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      const key = String(id);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  /* ---------- 提交处理（返回 true 关闭表单） ---------- */

  const submitRoot = async (name) => {
    const row = await onCreateFolder(name);
    if (row) closeEditor();
    return Boolean(row);
  };

  const submitChild = async (parentId, name) => {
    const row = await onCreateFolder(name, parentId);
    if (row) closeEditor();
    return Boolean(row);
  };

  const submitRename = async (id, name) => {
    const ok = await onRenameFolder(id, name);
    if (ok) closeEditor();
    return Boolean(ok);
  };

  const submitTag = async (name, color) => {
    const row = await onCreateTag(name, color);
    if (row) closeEditor();
    return Boolean(row);
  };

  const submitTagRename = async (id, name, color) => {
    const ok = await onRenameTag(id, name, color);
    if (ok) closeEditor();
    return Boolean(ok);
  };

  /* ---------- 选中筛选 ---------- */

  const selectFolder = (id) => {
    // 'none' 表示未分类；数字表示分类
    onChange({ ...filters, scope: 'all', folderId: id, tagId: null });
  };
  const selectTag = (id) => {
    onChange({ ...filters, scope: 'tag', folderId: null, tagId: id });
  };

  const tree = buildFolderTree(folders);

  return (
    <>
      {/* ====== 分类 ====== */}
      <div className="meta-section">
        <div className="meta-header">
          <strong className="meta-title">分类</strong>
          {!(editing && String(editing.type).startsWith('folder-')) && (
            <button type="button" className="ghost-btn tiny" title="新建分类" onClick={() => setEditing({ type: 'folder-new' })}>
              ＋
            </button>
          )}
        </div>

        <ul className="side-list">
          {/* 未分类 */}
          <li className="folder-item">
            <div className={`side-row ${String(filters.folderId) === 'none' ? 'active' : ''} ${dropTarget === 'none' ? 'drop-active' : ''}`} {...dropProps('none')}>
              <span className="folder-chevron leaf">
                <ChevronIcon />
              </span>
              <button type="button" className="side-label" onClick={() => selectFolder('none')}>
                <FolderIcon />
                <span className="side-label-text">未分类文献</span>
              </button>
            </div>
          </li>

          {/* 树 */}
          {tree.map((root) => (
            <FolderNode
              key={root.id}
              folder={root}
              expandedIds={expandedIds}
              onToggleExpand={toggleExpand}
              editing={editing}
              dropTarget={dropTarget}
              dropProps={dropProps}
              selectedId={filters.folderId}
              onSelectFolder={selectFolder}
              onCreateSubfolder={(parentId) => setEditing({ type: 'folder-new-child', parentId })}
              onRenameFolder={(id, name) => setEditing({ type: 'folder-rename', id, name })}
              onRemoveFolder={onRemoveFolder}
              onSubmitRename={submitRename}
              onSubmitChild={submitChild}
              onCancelEdit={closeEditor}
            />
          ))}

          {/* 根级新建表单 */}
          {editing && editing.type === 'folder-new' && (
            <li className="folder-item">
              <MetaForm placeholder="分类名称" onSubmit={submitRoot} onCancel={closeEditor} />
            </li>
          )}
        </ul>

        {!folders.length && !(editing && editing.type === 'folder-new') && (
          <div className="side-empty">还没有分类，点右上角 ＋ 新建</div>
        )}
      </div>

      {/* ====== 标签 ====== */}
      <div className="meta-section">
        <div className="meta-header">
          <strong className="meta-title">标签</strong>
          {!(editing && String(editing.type).startsWith('tag-')) && (
            <button type="button" className="ghost-btn tiny" title="新建标签" onClick={() => setEditing({ type: 'tag-new' })}>
              ＋
            </button>
          )}
        </div>

        <ul className="side-list">
          {(tags || []).map((tag) => (
            <li className="folder-item" key={tag.id}>
              <div className={`side-row ${String(filters.tagId) === String(tag.id) ? 'active' : ''}`}>
                <span className="folder-chevron leaf">
                  <ChevronIcon />
                </span>
                <button type="button" className="side-label" onClick={() => selectTag(tag.id)}>
                  <span className="tag-dot" style={{ background: tag.color || TAG_COLORS[0] }} />
                  <span className="side-label-text">{tag.name}</span>
                  {tag.doc_count > 0 ? <span className="count-badge">{tag.doc_count}</span> : null}
                </button>
                <span className="side-actions">
                  <button
                    type="button"
                    className="tag-action"
                    title="重命名标签"
                    onClick={(e) => {
                      e.stopPropagation();
                      setEditing({ type: 'tag-rename', id: tag.id, name: tag.name, color: tag.color });
                    }}
                  >
                    ✎
                  </button>
                  <button type="button" className="tag-action" title="删除标签" onClick={(e) => { e.stopPropagation(); onRemoveTag(tag.id); }}>
                    ✕
                  </button>
                </span>
              </div>

              {editing && editing.type === 'tag-rename' && String(editing.id) === String(tag.id) && (
                <MetaForm
                  placeholder="新标签名称"
                  initialName={editing.name}
                  initialColor={editing.color}
                  withColor
                  onSubmit={(name, color) => submitTagRename(tag.id, name, color)}
                  onCancel={closeEditor}
                />
              )}
            </li>
          ))}

          {editing && editing.type === 'tag-new' && (
            <li className="folder-item">
              <MetaForm placeholder="标签名称" withColor onSubmit={submitTag} onCancel={closeEditor} />
            </li>
          )}
        </ul>

        {!tags.length && !(editing && editing.type === 'tag-new') && (
          <div className="side-empty">还没有标签，点右上角 ＋ 新建</div>
        )}
      </div>
    </>
  );
}
