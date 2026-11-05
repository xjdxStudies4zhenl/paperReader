import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Sidebar from './components/Sidebar.jsx';
import LibraryView from './components/LibraryView.jsx';
import Reader from './components/Reader.jsx';
import DocDialog from './components/DocDialog.jsx';
import NotesPanel from './components/NotesPanel.jsx';
import SettingsDialog, { DbGate } from './components/SettingsDialog.jsx';
import ModelInstallPrompt, { isModelPromptDismissed } from './components/ModelInstallPrompt.jsx';
import ModelDownloadBar from './components/ModelDownloadBar.jsx';
import StartupLoader from './components/StartupLoader.jsx';
import Toasts from './components/Toasts.jsx';
import { api, guard, toast } from './api.js';
import { buildThumbForDoc } from './pdf/thumb.js';
import { useTheme } from './theme.js';
import { isDocDrag } from './dnd.js';
import { translateApi } from './translate.js';
import logoUrl from './assets/logo.png';

const DEFAULT_FILTERS = { scope: 'all', folderId: null, tagId: null, keyword: '', sort: 'recent' };

const SCOPE_TITLE = {
  all: '全部文献',
  recent: '最近阅读',
  star: '星标文献',
  anno: '有批注的文献',
  notes: '笔记',
};

/** 阅读器标签页缓存：关掉应用再打开，多文献导航栏还能复原 */
const TABS_CACHE_KEY = 'pr.readerTabs';

function readTabsCache() {
  try {
    const raw = localStorage.getItem(TABS_CACHE_KEY);
    const list = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(list)) return [];
    return list
      .filter((t) => t && Number.isFinite(Number(t.id)))
      .map((t) => ({ id: Number(t.id), title: String(t.title || '') }));
  } catch {
    return [];
  }
}

/** 按 id 去重，保留第一次出现的顺序 */
function uniqueTabs(list) {
  const seen = new Set();
  const out = [];
  for (const tab of list) {
    if (!tab || seen.has(tab.id)) continue;
    seen.add(tab.id);
    out.push(tab);
  }
  return out;
}

export default function App() {
  const [booted, setBooted] = useState(false);
  const [dbInfo, setDbInfo] = useState(null);
  const [dbReady, setDbReady] = useState(false);
  const [docs, setDocs] = useState([]);
  const [folders, setFolders] = useState([]);
  const [tags, setTags] = useState([]);
  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const [loadingDocs, setLoadingDocs] = useState(false);
  /** 阅读器多标签：openTabs = [{ id, title }]，activeTabId 为当前标签 */
  const [openTabs, setOpenTabs] = useState([]);
  const [activeTabId, setActiveTabId] = useState(null);
  const [detailDoc, setDetailDoc] = useState(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [modelPromptOpen, setModelPromptOpen] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  /** 启动装载遮罩：数据库连上后先把本地模型预热进显存 */
  const [startupOpen, setStartupOpen] = useState(false);
  const startupOnceRef = useRef(false);
  /** 正在被拖动的文献卡片 id（从卡片拖到分类时用于高亮投放区） */
  const [draggingDocId, setDraggingDocId] = useState(null);
  const theme = useTheme();

  /* --------------------------- 启动：探测数据库 --------------------------- */
  const bootstrap = useCallback(async () => {
    try {
      const info = await api.db.status();
      setDbInfo(info);
      setDbReady(Boolean(info && info.connected));
      return Boolean(info && info.connected);
    } catch (err) {
      console.error(err);
      setDbReady(false);
      return false;
    } finally {
      setBooted(true);
    }
  }, []);

  useEffect(() => {
    bootstrap();
  }, [bootstrap]);

  /* --------------- 启动装载：直接预加载本地模型（带遮罩进度） --------------- */
  useEffect(() => {
    if (!dbReady || startupOnceRef.current) return;
    startupOnceRef.current = true;
    setStartupOpen(true);
  }, [dbReady]);

  /* --------------------- 首启引导：是否安装翻译模型 --------------------- */
  useEffect(() => {
    if (!dbReady) return;
    if (isModelPromptDismissed()) return;
    const translate = translateApi();
    if (!translate || !translate.modelState) return;
    let alive = true;
    translate
      .modelState()
      .then((info) => {
        // 已经有模型就不用问了
        if (alive && info && info.installed === 0) setModelPromptOpen(true);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [dbReady]);

  /* --------------------------- 数据加载 --------------------------- */
  const loadMeta = useCallback(async () => {
    const [folderRows, tagRows] = await Promise.all([api.folders.list(), api.tags.list()]);
    setFolders(folderRows || []);
    setTags(tagRows || []);
  }, []);

  const loadDocs = useCallback(async (nextFilters = filters) => {
    setLoadingDocs(true);
    try {
      const query = {
        folderId: nextFilters.folderId,
        tagId: nextFilters.tagId,
        keyword: nextFilters.keyword || undefined,
        sort: nextFilters.sort,
        starOnly: nextFilters.scope === 'star',
        recent: nextFilters.scope === 'recent',
        hasAnno: nextFilters.scope === 'anno',
      };
      const rows = await api.docs.list(query);
      setDocs(rows || []);
    } catch (err) {
      toast(err.message || '读取文献列表失败', 'error');
    } finally {
      setLoadingDocs(false);
    }
  }, [filters]);

  useEffect(() => {
    if (!dbReady) return;
    loadMeta();
    loadDocs(filters);
  }, [dbReady, filters, loadMeta, loadDocs]);

  const changeFilters = (next) => {
    setFilters({ ...DEFAULT_FILTERS, ...next });
  };

  const refreshAll = useCallback(async () => {
    await loadMeta();
    await loadDocs(filters);
  }, [loadMeta, loadDocs, filters]);

  /* --------------- 元数据补全：老数据缺作者时从 PDF 自动补一次 --------------- */
  const backfilledRef = useRef(false);
  useEffect(() => {
    if (!dbReady || backfilledRef.current) return;
    backfilledRef.current = true;
    api.docs
      .backfill(50)
      .then((res) => {
        if (res && res.updated > 0) {
          toast(`已从 PDF 补全 ${res.updated} 篇文献的作者/元数据`, 'success', 4200);
          refreshAll();
        }
      })
      .catch((err) => console.warn('元数据补全失败', err));
  }, [dbReady, refreshAll]);

  /* ------------------------ 分类 / 标签（持久化） ------------------------ */

  /** 新建分类：写入数据库 → 刷新侧边栏 → 直接跳到该分类 */
  const createFolder = useCallback(
    async (name, parentId) => {
      const row = await guard(() => api.folders.create(name, parentId), '创建分类失败');
      if (!row) return null;
      toast(`已创建分类「${row.name}」`, 'success');
      await loadMeta();
      setFilters({ ...DEFAULT_FILTERS, scope: 'all', folderId: row.id });
      return row;
    },
    [loadMeta]
  );

  /** 供文献详情弹窗使用：只创建，不改变侧边栏筛选 */
  const quickCreateFolder = useCallback(
    async (name, parentId) => {
      const row = await guard(() => api.folders.create(name, parentId), '创建分类失败');
      if (!row) return null;
      toast(`已创建分类「${row.name}」`, 'success');
      await loadMeta();
      return row;
    },
    [loadMeta]
  );

  const renameFolder = useCallback(
    async (id, name) => {
      const row = await guard(() => api.folders.rename(id, name), '重命名分类失败');
      if (!row) return false;
      toast('分类已重命名', 'success');
      await loadMeta();
      return true;
    },
    [loadMeta]
  );

  const removeFolder = useCallback(
    async (id) => {
      const folder = folders.find((f) => String(f.id) === String(id));
      if (!folder) return false;
      const childCount = folders.filter((f) => f.parent_id && String(f.parent_id) === String(id)).length;
      let msg = `删除分类「${folder.name}」？\n分类下的文献会移动到"未分类"，不会被删除。`;
      if (childCount > 0) msg += `\n（含 ${childCount} 个子分类，也会一并删除）`;
      const confirmed = window.confirm(msg);
      if (!confirmed) return false;
      const res = await guard(() => api.folders.remove(id), '删除分类失败');
      if (!res) return false;
      const removed = Array.isArray(res.removedFolders) ? res.removedFolders.map(String) : [String(id)];
      toast('分类已删除', 'success');
      await loadMeta();
      // 当前选中的分类（含被删分类的子孙）被删掉时复位筛选
      setFilters((prev) => (removed.includes(String(prev.folderId)) ? { ...prev, folderId: null } : prev));
      return true;
    },
    [folders, loadMeta]
  );

  /* ------------------------------ 阅读器标签页 ------------------------------ */

  /** 标签页缓存是否已启用（首次打开文献之前不写盘，避免把上次的缓存冲掉） */
  const tabsCacheReadyRef = useRef(false);

  // 标签页变化 → 写入缓存，供下次启动复原
  useEffect(() => {
    if (!tabsCacheReadyRef.current) return;
    try {
      localStorage.setItem(TABS_CACHE_KEY, JSON.stringify(openTabs));
    } catch {
      /* 缓存失败不影响使用 */
    }
  }, [openTabs]);

  /**
   * 打开文献：已经开着就切过去，否则新增一个标签。
   * 本次会话第一次打开文献时，把上次缓存的多文献标签一起复原
   * （也就是「下次打开任意文献，之前的那几篇也会一起打开」）。
   */
  const openReader = useCallback((doc) => {
    if (!doc || !doc.id) return;
    const id = Number(doc.id);
    const title = doc.title || `文献 ${id}`;
    let cached = [];
    if (!tabsCacheReadyRef.current) {
      tabsCacheReadyRef.current = true;
      cached = readTabsCache();
      if (cached.length) {
        toast(`已恢复上次打开的 ${cached.length} 个标签`, 'info', 3200);
        // 校验缓存：文献可能已被删除；顺便用库里的最新标题覆盖缓存标题
        api.docs
          .list({})
          .then((rows) => {
            if (!Array.isArray(rows) || !rows.length) return;
            const titleById = new Map(rows.map((r) => [Number(r.id), r.title || '']));
            setOpenTabs((prev) => {
              const next = prev
                .filter((t) => titleById.has(Number(t.id)))
                .map((t) => ({ ...t, title: titleById.get(Number(t.id)) || t.title }));
              const same =
                next.length === prev.length && next.every((t, i) => t.id === prev[i].id && t.title === prev[i].title);
              return same ? prev : next;
            });
          })
          .catch(() => {});
      }
    }
    setOpenTabs((prev) => {
      const next = uniqueTabs([...cached, ...prev, { id, title }]);
      const same = next.length === prev.length && next.every((t, i) => t.id === prev[i].id && t.title === prev[i].title);
      return same ? prev : next;
    });
    setActiveTabId(id);
  }, []);

  /** 关闭单个标签：关的是当前标签就切到相邻的一个，全关完则回到文献库首页 */
  const closeReaderTab = useCallback(
    (id) => {
      const idx = openTabs.findIndex((t) => t.id === id);
      const rest = openTabs.filter((t) => t.id !== id);
      setOpenTabs(rest);
      if (activeTabId === id) {
        const neighbour = rest[Math.min(Math.max(idx, 0), rest.length - 1)];
        setActiveTabId(neighbour ? neighbour.id : null);
      }
      refreshAll();
    },
    [openTabs, activeTabId, refreshAll]
  );

  const createTag = useCallback(
    async (name, color) => {
      const row = await guard(() => api.tags.create(name, color), '创建标签失败');
      if (!row) return null;
      toast(`已创建标签 #${row.name}`, 'success');
      await loadMeta();
      return row;
    },
    [loadMeta]
  );

  const renameTag = useCallback(
    async (id, name, color) => {
      const row = await guard(() => api.tags.rename(id, name, color), '更新标签失败');
      if (!row) return false;
      toast('标签已更新', 'success');
      await loadMeta();
      return true;
    },
    [loadMeta]
  );

  const removeTag = useCallback(
    async (id) => {
      const tag = tags.find((t) => String(t.id) === String(id));
      if (!tag) return false;
      const confirmed = window.confirm(`删除标签「#${tag.name}」？\n文献本身不会被删除，只是解除这个标签。`);
      if (!confirmed) return false;
      const res = await guard(() => api.tags.remove(id), '删除标签失败');
      if (!res) return false;
      toast('标签已删除', 'success');
      await loadMeta();
      setFilters((prev) => (String(prev.tagId) === String(id) ? { ...prev, tagId: null } : prev));
      return true;
    },
    [tags, loadMeta]
  );

  /* --------------------------- 导入（含拖拽） --------------------------- */

  /**
   * 导入目标分类：只有当前正在浏览某个分类时才有值。
   * 'none'（未分类）、标签视图、搜索等场景都按未分类处理。
   */
  const importFolderId = useMemo(() => {
    const id = Number(filters.folderId);
    return Number.isFinite(id) && id > 0 ? id : null;
  }, [filters.folderId]);

  const importFolderName = useMemo(() => {
    if (!importFolderId) return '';
    const folder = folders.find((f) => String(f.id) === String(importFolderId));
    return folder ? folder.name : '';
  }, [importFolderId, folders]);

  const describeImportTarget = (folderId) => {
    if (!folderId) return '';
    const folder = folders.find((f) => String(f.id) === String(folderId));
    return folder ? `「${folder.name}」` : '';
  };

  const importByPaths = useCallback(
    async (paths) => {
      if (!paths.length) return;
      try {
        const res = await api.docs.importPaths(paths, importFolderId);
        if (!res) return;
        for (const item of res.imported) {
          try {
            await buildThumbForDoc(item.id);
          } catch (err) {
            console.warn('缩略图生成失败', err);
          }
        }
        if (res.imported.length) {
          toast(`已导入 ${res.imported.length} 篇文献${describeImportTarget(res.folderId)}`, 'success');
        }
        if (res.skipped.length) toast(`跳过 ${res.skipped.length} 个文件（重复或格式不符）`, 'warn', 4500);
        await refreshAll();
      } catch (err) {
        toast(err.message || '导入失败', 'error');
      }
    },
    [importFolderId, folders, refreshAll]
  );

  const importViaDialog = useCallback(async () => {
    try {
      const res = await api.docs.importFiles(importFolderId);
      if (!res) return;
      if (!res.imported.length) {
        if (res.skipped.length) toast(`跳过 ${res.skipped.length} 个文件（重复或格式不符）`, 'warn', 4500);
        return;
      }
      for (const item of res.imported) {
        await buildThumbForDoc(item.id).catch(() => {});
      }
      toast(`已导入 ${res.imported.length} 篇文献${describeImportTarget(res.folderId)}`, 'success');
      await refreshAll();
    } catch (err) {
      toast(err.message || '导入失败', 'error');
    }
  }, [importFolderId, folders, refreshAll]);

  /**
   * 扫描文库目录：用户可能在资源管理器里直接拖了 PDF / 新建了分类文件夹，
   * 这里把「目录即分类」对齐到数据库（文件不移动，只补齐记录）。
   */
  const syncLibrary = useCallback(async () => {
    const res = await guard(() => api.storage.syncLibrary(), '同步文库失败');
    if (!res) return null;
    const parts = [];
    if (res.imported) parts.push(`新导入 ${res.imported}`);
    if (res.restored) parts.push(`恢复 ${res.restored}`);
    if (res.moved) parts.push(`跟随移动 ${res.moved}`);
    if (res.folderFixed) parts.push(`分类校正 ${res.folderFixed}`);
    if (res.createdFolders && res.createdFolders.length) parts.push(`新建分类 ${res.createdFolders.length}`);
    if (res.duplicates) parts.push(`重复跳过 ${res.duplicates}`);
    if (res.failed && res.failed.length) parts.push(`失败 ${res.failed.length}`);
    const text = `同步完成：扫描 ${res.scanned} 个文件${parts.length ? `，${parts.join('，')}` : '，全部已是最新'}`;
    toast(text, res.failed && res.failed.length ? 'warn' : 'success', 5600);
    await refreshAll();
    return res;
  }, [refreshAll]);

  useEffect(() => {
    const onDragOver = (e) => {
      // 拖动文献卡片时不弹「松开导入 PDF」的遮罩
      if (isDocDrag(e)) return;
      e.preventDefault();
      if (e.dataTransfer && e.dataTransfer.types.includes('Files')) setDragActive(true);
    };
    const onDragLeave = (e) => {
      if (e.relatedTarget === null) setDragActive(false);
    };
    const onDrop = async (e) => {
      // 卡片拖到分类上由分类自己处理，这里不再当文件导入
      if (isDocDrag(e)) {
        setDragActive(false);
        return;
      }
      e.preventDefault();
      setDragActive(false);
      if (!dbReady) {
        toast('请先完成数据库连接', 'warn');
        return;
      }
      const files = Array.from(e.dataTransfer.files || []);
      const paths = files
        .map((file) => {
          try {
            return api.app.pathForFile(file);
          } catch {
            return '';
          }
        })
        .filter((p) => p && /\.pdf$/i.test(p));
      if (!paths.length) {
        toast('只支持拖入 PDF 文件', 'warn');
        return;
      }
      await importByPaths(paths);
    };
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, [dbReady, importByPaths]);

  /* --------------------------- 文献操作 --------------------------- */
  const removeDoc = async (doc) => {
    try {
      await api.docs.remove(doc.id);
      // 文档被删掉后，顺手关掉它的标签
      setOpenTabs((prev) => prev.filter((t) => Number(t.id) !== Number(doc.id)));
      setActiveTabId((prev) => (Number(prev) === Number(doc.id) ? null : prev));
      toast('已从文库移除', 'success');
      refreshAll();
    } catch (err) {
      toast(err.message || '删除失败', 'error');
    }
  };

  /**
   * 拖拽改分组：把卡片拖到侧边栏某个分类（或“未分类”）上。
   * folderId 为 null 表示移出分类。
   */
  const moveDocToFolder = useCallback(
    async (docId, folderId) => {
      const doc = docs.find((d) => String(d.id) === String(docId));
      const targetId = folderId === undefined || folderId === 'none' ? null : folderId;
      const currentId = doc ? doc.folder_id : undefined;
      if (doc && String(currentId || '') === String(targetId || '')) {
        const folder = folders.find((f) => String(f.id) === String(targetId));
        toast(targetId ? `已在「${folder ? folder.name : '该分类'}」中` : '该文献本来就在未分类', 'warn');
        return false;
      }
      const res = await guard(() => api.docs.update(docId, { folder_id: targetId }), '移动文献失败');
      if (!res) return false;
      const folder = folders.find((f) => String(f.id) === String(targetId));
      toast(targetId ? `已移动到「${folder ? folder.name : '分类'}」` : '已移出分类', 'success');
      await refreshAll();
      return true;
    },
    [docs, folders, refreshAll]
  );

  const scopeTitle = useMemo(() => {
    if (filters.folderId === 'none') return '未分类文献';
    if (filters.folderId) {
      const folder = folders.find((f) => String(f.id) === String(filters.folderId));
      return folder ? `分类 · ${folder.name}` : '分类';
    }
    if (filters.tagId) {
      const tag = tags.find((t) => String(t.id) === String(filters.tagId));
      return tag ? `标签 · #${tag.name}` : '标签';
    }
    return SCOPE_TITLE[filters.scope] || '全部文献';
  }, [filters, folders, tags]);

  /**
   * 阅读器左侧菜单：复用首页同一个 Sidebar，功能完全一致。
   * 导航类操作（切范围 / 分类 / 标签、导入、新建分类）顺便回到文库首页并收起抽屉，
   * 重命名、改色、设置、主题这类原地操作则保持当前阅读不打断。
   */
  const renderReaderSidebar = useCallback(
    ({ close }) => (
      <Sidebar
        filters={filters}
        onChange={(next) => {
          changeFilters(next);
          close();
          setActiveTabId(null);
        }}
        folders={folders}
        tags={tags}
        dbInfo={dbInfo}
        onImport={() => {
          close();
          setActiveTabId(null);
          importViaDialog();
        }}
        onOpenSettings={() => {
          close();
          setSettingsOpen(true);
        }}
        onOpenLibrary={() => api.app.openLibrary()}
        onSyncLibrary={() => {
          close();
          syncLibrary();
        }}
        onCreateFolder={async (name, parentId) => {
          const row = await createFolder(name, parentId);
          close();
          setActiveTabId(null);
          return row;
        }}
        onRenameFolder={renameFolder}
        onRemoveFolder={removeFolder}
        onCreateTag={createTag}
        onRenameTag={renameTag}
        onRemoveTag={removeTag}
        theme={theme}
        onMoveDoc={moveDocToFolder}
        dragging={false}
      />
    ),
    [
      filters,
      folders,
      tags,
      dbInfo,
      importViaDialog,
      syncLibrary,
      createFolder,
      renameFolder,
      removeFolder,
      createTag,
      renameTag,
      removeTag,
      theme,
      moveDocToFolder,
    ]
  );

  if (!booted) {
    return (
      <div className="boot">
        <img className="boot-logo" src={logoUrl} alt="文献阅读器" draggable={false} />
        <p>正在启动文献阅读器…</p>
      </div>
    );
  }

  if (!dbReady) {
    return (
      <>
        <DbGate
          initial={dbInfo ? dbInfo.config : null}
          onDone={async () => {
            const ok = await bootstrap();
            if (ok) toast('欢迎使用文献阅读器', 'success');
          }}
        />
        <ModelDownloadBar />
        <Toasts />
      </>
    );
  }

  return (
    <div className="app">
      <Sidebar
        filters={filters}
        onChange={changeFilters}
        folders={folders}
        tags={tags}
        dbInfo={dbInfo}
        onImport={importViaDialog}
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenLibrary={() => api.app.openLibrary()}
        onSyncLibrary={syncLibrary}
        onCreateFolder={createFolder}
        onRenameFolder={renameFolder}
        onRemoveFolder={removeFolder}
        onCreateTag={createTag}
        onRenameTag={renameTag}
        onRemoveTag={removeTag}
        theme={theme}
        onMoveDoc={moveDocToFolder}
        dragging={Boolean(draggingDocId)}
      />

      {filters.scope === 'notes' ? (
        <NotesPanel
          docs={docs}
          folders={folders}
          onOpenDoc={(doc) => openReader(doc)}
          onOpenFolder={(folderId) => changeFilters({ scope: 'all', folderId })}
        />
      ) : (
        <LibraryView
          docs={docs}
          loading={loadingDocs}
          filters={filters}
          scopeTitle={scopeTitle}
          onFilterChange={changeFilters}
          onOpen={(doc) => openReader(doc)}
          onDetail={(doc) => setDetailDoc(doc)}
          onRemove={removeDoc}
          onReload={refreshAll}
          onImport={refreshAll}
          importFolderId={importFolderId}
          importFolderName={importFolderName}
          onDragDocChange={setDraggingDocId}
        />
      )}

      {openTabs.map((tab) => (
        <Reader
          key={tab.id}
          docId={tab.id}
          active={tab.id === activeTabId}
          tabs={openTabs}
          onSelectTab={(id) => setActiveTabId(id)}
          onCloseTab={(id) => closeReaderTab(id)}
          onOpenDoc={(doc) => openReader(doc)}
          onGoHome={() => {
            setActiveTabId(null);
            refreshAll();
          }}
          renderSidebar={renderReaderSidebar}
          onDocChanged={() => {}}
        />
      ))}

      {detailDoc && (
        <DocDialog
          doc={detailDoc}
          folders={folders}
          allTags={tags}
          onCreateFolder={quickCreateFolder}
          onClose={() => setDetailDoc(null)}
          onSaved={(updated, metaOnly) => {
            if (updated) setDetailDoc(updated);
            refreshAll();
          }}
          onOpen={(doc) => {
            setDetailDoc(null);
            openReader(doc);
          }}
        />
      )}

      {settingsOpen && (
        <SettingsDialog
          dbInfo={dbInfo}
          onClose={() => setSettingsOpen(false)}
          onReconnected={async () => {
            const ok = await bootstrap();
            if (ok) await refreshAll();
          }}
        />
      )}

      {dragActive && (
        <div className="drop-mask">
          松开鼠标导入 PDF{importFolderName ? ` 到「${importFolderName}」` : '（未分类）'}
        </div>
      )}
      {modelPromptOpen && <ModelInstallPrompt onClose={() => setModelPromptOpen(false)} />}
      {startupOpen && <StartupLoader onDone={() => setStartupOpen(false)} />}
      <ModelDownloadBar />
      <Toasts />
    </div>
  );
}
