import React from 'react';
import MetaSections from './MetaSections.jsx';
import logoUrl from '../assets/logo.png';

const NAV = [
  { key: 'all', label: '全部文献', icon: '📚' },
  { key: 'recent', label: '最近阅读', icon: '🕘' },
  { key: 'star', label: '星标文献', icon: '⭐' },
  { key: 'anno', label: '有批注', icon: '🖍' },
  { key: 'notes', label: '笔记', icon: '📝' },
];

export default function Sidebar({
  filters,
  onChange,
  folders,
  tags,
  onImport,
  onOpenSettings,
  onOpenLibrary,
  onSyncLibrary,
  dbInfo,
  onCreateFolder,
  onRenameFolder,
  onRemoveFolder,
  onCreateTag,
  onRenameTag,
  onRemoveTag,
  theme,
  onMoveDoc,
  dragging = false,
}) {
  const activeScope = filters.scope || 'all';
  const themeIcon = theme && theme.resolved === 'light' ? '🌙' : '☀';

  return (
    <aside className="sidebar">
      <div className="brand">
        <img className="brand-logo-img" src={logoUrl} alt="文献阅读器" draggable={false} />
        <div className="brand-text">
          <strong>文献阅读器</strong>
          <span>本地文献阅读与标注</span>
        </div>
      </div>

      <button className="primary-btn import-btn" onClick={onImport}>
        ＋ 导入 PDF
      </button>

      <nav className="nav">
        {NAV.map((item) => (
          <button
            key={item.key}
            className={`nav-item ${activeScope === item.key && !filters.folderId && !filters.tagId ? 'active' : ''}`}
            onClick={() => onChange({ scope: item.key, folderId: null, tagId: null })}
          >
            <span className="nav-icon">{item.icon}</span>
            {item.label}
          </button>
        ))}
      </nav>

      <MetaSections
        filters={filters}
        onChange={onChange}
        folders={folders}
        tags={tags}
        onCreateFolder={onCreateFolder}
        onRenameFolder={onRenameFolder}
        onRemoveFolder={onRemoveFolder}
        onCreateTag={onCreateTag}
        onRenameTag={onRenameTag}
        onRemoveTag={onRemoveTag}
        onMoveDoc={onMoveDoc}
        dragging={dragging}
      />

      <div className="sidebar-footer">
        {onSyncLibrary && (
          <button
            className="nav-item small"
            onClick={onSyncLibrary}
            title="扫描文库目录：把手工拖进去的 PDF 和新建的分类文件夹同步进系统"
          >
            🔄 同步文库目录
          </button>
        )}
        <button className="nav-item small" onClick={onOpenLibrary}>
          📂 打开文库目录
        </button>
        <button className="nav-item small" onClick={onOpenSettings}>
          ⚙ 设置中心
        </button>
        {theme && (
          <button className="nav-item small" onClick={() => theme.toggle()} title="切换亮色 / 暗色">
            {themeIcon} {theme.resolved === 'light' ? '切换到暗色' : '切换到亮色'}
          </button>
        )}
        <div className="db-badge" title={dbInfo ? `${dbInfo.config.user}@${dbInfo.config.host}:${dbInfo.config.port}` : ''}>
          <span className="db-dot" />
          {dbInfo ? `${dbInfo.config.database} · ${dbInfo.serverVersion || ''}` : '未连接'}
        </div>
      </div>
    </aside>
  );
}
