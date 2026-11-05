import React, { useCallback, useEffect, useState } from 'react';
import { api, toast, formatBytes } from '../api.js';
import { THEME_OPTIONS, useTheme } from '../theme.js';
import { TARGET_LANGS } from '../translate.js';
import AiSettingsPane from './AiSettingsPane.jsx';

const EMPTY = { host: '127.0.0.1', port: 3306, user: 'root', password: '', database: 'paper_reader' };

/* ============================ 数据库表单 ============================ */

/** 数据库连接表单，可同时用于首启引导与设置页 */
export function DbForm({ initial, onDone, compact = false }) {
  const [form, setForm] = useState({ ...EMPTY, ...initial, password: '' });
  const [testing, setTesting] = useState(false);
  const [initing, setIniting] = useState(false);
  const [result, setResult] = useState(null);

  useEffect(() => {
    if (initial) setForm((prev) => ({ ...prev, ...initial, password: '' }));
  }, [initial]);

  const setField = (key, value) => setForm((prev) => ({ ...prev, [key]: value }));

  const testConn = async () => {
    setTesting(true);
    setResult(null);
    try {
      const res = await api.db.test({ ...form, port: Number(form.port) || 3306 });
      setResult({ ok: true, message: `连接成功 · MySQL ${res.serverVersion}` });
      toast('连接成功', 'success');
    } catch (err) {
      setResult({ ok: false, message: err.message || '连接失败' });
      toast(err.message || '连接失败', 'error');
    } finally {
      setTesting(false);
    }
  };

  const initDb = async () => {
    setIniting(true);
    setResult(null);
    try {
      const info = await api.db.init({ ...form, port: Number(form.port) || 3306 });
      setResult({ ok: true, message: `已就绪 · ${info.tableCount} 张数据表` });
      toast('数据库初始化完成', 'success');
      onDone(info);
    } catch (err) {
      setResult({ ok: false, message: err.message || '初始化失败' });
      toast(err.message || '初始化失败', 'error');
    } finally {
      setIniting(false);
    }
  };

  return (
    <div className={`db-form ${compact ? 'compact' : ''}`}>
      <div className="field-row">
        <label className="field">
          <span>主机</span>
          <input value={form.host} onChange={(e) => setField('host', e.target.value)} placeholder="127.0.0.1" />
        </label>
        <label className="field narrow">
          <span>端口</span>
          <input value={form.port} onChange={(e) => setField('port', e.target.value)} placeholder="3306" />
        </label>
      </div>
      <div className="field-row">
        <label className="field">
          <span>用户名</span>
          <input value={form.user} onChange={(e) => setField('user', e.target.value)} placeholder="root" />
        </label>
        <label className="field">
          <span>密码</span>
          <input
            type="password"
            value={form.password}
            onChange={(e) => setField('password', e.target.value)}
            placeholder={initial?.hasPassword ? '已保存，留空则沿用' : 'MySQL 密码'}
          />
        </label>
      </div>
      <label className="field">
        <span>数据库名</span>
        <input value={form.database} onChange={(e) => setField('database', e.target.value)} placeholder="paper_reader" />
      </label>

      <div className="db-form-actions">
        <button className="ghost-btn" onClick={testConn} disabled={testing || initing}>
          {testing ? '测试中…' : '测试连接'}
        </button>
        <button className="primary-btn" onClick={initDb} disabled={testing || initing}>
          {initing ? '初始化中…' : '保存并初始化'}
        </button>
      </div>

      {result && <div className={`db-result ${result.ok ? 'ok' : 'error'}`}>{result.message}</div>}

      <p className="db-tip">
        需要本地可用的 MySQL 8.x 实例。初始化会自动建库（utf8mb4）并创建 <code>pr_*</code> 数据表，已有数据不会被覆盖。
      </p>
    </div>
  );
}

/** 首启引导：数据库未连接时展示 */
export function DbGate({ initial, onDone }) {
  return (
    <div className="gate">
      <div className="gate-card">
        <h1>连接本地 MySQL</h1>
        <p className="gate-sub">
          文献阅读器把文献元数据、批注与阅读记录都保存在你自己的 MySQL 数据库里，数据完全留在本地。
        </p>
        <DbForm initial={initial} onDone={onDone} />
      </div>
    </div>
  );
}

/* ============================ 外观 ============================ */

function AppearancePane() {
  const { pref, resolved, setTheme } = useTheme();

  return (
    <div className="pane">
      <h3 className="section-title">界面主题</h3>
      <p className="section-desc">
        当前生效：{resolved === 'light' ? '亮色' : '暗色'}。主题只影响界面配色，不会改变 PDF 页面的显示效果。
      </p>

      <div className="theme-grid">
        {THEME_OPTIONS.map((option) => (
          <button
            key={option.key}
            className={`theme-card ${pref === option.key ? 'active' : ''}`}
            onClick={() => setTheme(option.key)}
          >
            <span className={`theme-preview ${option.key}`}>
              <span className="theme-preview-side" />
              <span className="theme-preview-main">
                <i />
                <i />
                <i />
              </span>
            </span>
            <span className="theme-card-label">
              <span className="theme-card-icon">{option.icon}</span>
              {option.label}
            </span>
            <span className="theme-card-desc">{option.desc}</span>
          </button>
        ))}
      </div>

      <p className="pane-tip">提示：侧边栏底部的 ☀ / 🌙 按钮可以在亮色与暗色之间快速切换。</p>
    </div>
  );
}

/* ============================ 存储 ============================ */

function StoragePane({ onApplied }) {
  const [info, setInfo] = useState(null);
  const [pending, setPending] = useState('');
  const [moveFiles, setMoveFiles] = useState(true);
  const [busy, setBusy] = useState(false);
  const [organizing, setOrganizing] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [msg, setMsg] = useState(null);

  const load = useCallback(async () => {
    try {
      const data = await api.storage.info();
      setInfo(data);
      return data;
    } catch (err) {
      toast(err.message || '读取存储位置失败', 'error');
      return null;
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const chooseDir = async () => {
    try {
      const res = await api.storage.pick();
      if (!res || res.canceled || !res.path) return;
      setPending(res.path);
      setMsg(null);
    } catch (err) {
      toast(err.message || '选择文件夹失败', 'error');
    }
  };

  /** 按分类重建目录结构并把文件改回原始文件名（幂等） */
  const reorganize = async () => {
    setOrganizing(true);
    setMsg(null);
    try {
      const res = await api.storage.reorganize();
      const text = `整理完成：移动 ${res.moved} 个，已就位 ${res.unchanged} 个${
        res.failed.length ? `，失败 ${res.failed.length} 个` : ''
      }`;
      setMsg({ ok: res.failed.length === 0, text });
      toast(text, res.failed.length ? 'warn' : 'success');
      await load();
      if (onApplied) onApplied();
    } catch (err) {
      setMsg({ ok: false, text: err.message || '整理失败' });
      toast(err.message || '整理失败', 'error');
    } finally {
      setOrganizing(false);
    }
  };

  /** 扫描文库目录：把用户手工拖进去的 PDF / 新建的目录同步进数据库（目录名 = 分类） */
  const syncNow = async () => {
    setSyncing(true);
    setMsg(null);
    try {
      const res = await api.storage.syncLibrary();
      const bits = [];
      if (res.imported) bits.push(`新导入 ${res.imported}`);
      if (res.restored) bits.push(`恢复 ${res.restored}`);
      if (res.moved) bits.push(`跟随移动 ${res.moved}`);
      if (res.folderFixed) bits.push(`分类校正 ${res.folderFixed}`);
      if (res.createdFolders && res.createdFolders.length) {
        const names = res.createdFolders.slice(0, 5).join('、');
        bits.push(`新建分类 ${res.createdFolders.length}（${names}${res.createdFolders.length > 5 ? '…' : ''}）`);
      }
      if (res.duplicates) bits.push(`重复跳过 ${res.duplicates}`);
      if (res.failed && res.failed.length) bits.push(`失败 ${res.failed.length}`);
      const text = `扫描 ${res.scanned} 个文件：${bits.length ? bits.join('，') : '全部已是最新'}`;
      setMsg({ ok: !(res.failed && res.failed.length), text });
      toast(text, res.failed && res.failed.length ? 'warn' : 'success', 5200);
      await load();
      if (onApplied) onApplied();
    } catch (err) {
      setMsg({ ok: false, text: err.message || '同步失败' });
      toast(err.message || '同步失败', 'error');
    } finally {
      setSyncing(false);
    }
  };

  const apply = async (target) => {
    const to = target === undefined ? pending : target;
    if (!to) {
      toast('请先选择目标文件夹', 'warn');
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const res = await api.storage.apply({ targetPath: to, moveFiles });
      const summary = res.unchanged
        ? '存储位置未变化'
        : `已切换到新目录${moveFiles ? `，迁移 ${res.moved} 个文件` : ''}${
            res.failed.length ? `，${res.failed.length} 个文件未能迁移` : ''
          }`;
      setMsg({ ok: res.failed.length === 0, text: summary });
      toast(summary, res.failed.length ? 'warn' : 'success');
      setPending('');
      await load();
      if (onApplied) onApplied();
    } catch (err) {
      setMsg({ ok: false, text: err.message || '切换存储位置失败' });
      toast(err.message || '切换存储位置失败', 'error');
    } finally {
      setBusy(false);
    }
  };

  const current = info ? info.dir : '—';
  const target = pending || '';

  return (
    <div className="pane">
      <h3 className="section-title">文库存储位置</h3>
      <p className="section-desc">导入的 PDF 会复制到这个文件夹统一管理；数据库里只记录相对路径，所以可以随时整体搬运。</p>

      <div className="path-box">
        <div className="path-label">当前目录</div>
        <div className="path-value" title={current}>
          {current}
        </div>
        <div className="path-actions">
          <button className="ghost-btn small" onClick={() => api.storage.open()}>
            打开目录
          </button>
          <button className="ghost-btn small" onClick={() => api.storage.reveal()}>
            在资源管理器中显示
          </button>
        </div>
      </div>

      <div className="stat-row">
        <div className="stat">
          <span className="stat-value">{info ? info.fileCount : '—'}</span>
          <span className="stat-label">文件数</span>
        </div>
        <div className="stat">
          <span className="stat-value">{info ? formatBytes(info.totalSize) : '—'}</span>
          <span className="stat-label">占用空间</span>
        </div>
        <div className="stat">
          <span className="stat-value">{info && info.isDefault ? '默认' : '自定义'}</span>
          <span className="stat-label">位置类型</span>
        </div>
      </div>

      <h3 className="section-title">目录结构</h3>
      <p className="section-desc">
        导入时保留原始文件名，并按分类建子目录：<code>&lt;库根&gt;/&lt;分类名&gt;/&lt;原文件名&gt;.pdf</code>，
        未分类的放在 <code>未分类</code> 目录里。改分类、拖拽换分组、删分类时文件会跟着移动；
        同一目录出现同名文件会自动加 <code>(2)</code> 后缀，不会覆盖。
      </p>
      <div className="db-form-actions">
        <button className="ghost-btn" onClick={reorganize} disabled={organizing}>
          {organizing ? '整理中…' : '按分类整理文库'}
        </button>
      </div>

      <h3 className="section-title">扫描同步（目录 = 分类）</h3>
      <p className="section-desc">
        如果你直接在资源管理器里把 PDF 拖进了文库目录，或手工新建了分类文件夹，系统不会自动知道。
        点下面按钮会扫描整个文库目录并按目录对齐：没入库的文件导入、被挪动/改名的文件跟着记、
        缺失的分类按目录名补建，内容重复的文件跳过不导入。
      </p>
      <div className="db-form-actions">
        <button className="ghost-btn" onClick={syncNow} disabled={syncing}>
          {syncing ? '扫描中…' : '扫描并同步文库目录'}
        </button>
      </div>

      <h3 className="section-title">更换位置</h3>
      <div className="path-box">
        <div className="path-label">目标目录</div>
        <div className={`path-value ${target ? '' : 'muted'}`} title={target}>
          {target || '尚未选择（点下方按钮挑选一个文件夹）'}
        </div>
        <div className="path-actions">
          <button className="ghost-btn small" onClick={chooseDir} disabled={busy}>
            选择文件夹…
          </button>
          <button
            className="ghost-btn small"
            onClick={() => setPending(info ? info.defaultDir : '')}
            disabled={busy || !info}
          >
            使用默认位置
          </button>
        </div>
      </div>

      <label className="checkbox-row">
        <input type="checkbox" checked={moveFiles} onChange={(e) => setMoveFiles(e.target.checked)} disabled={busy} />
        <span>把当前目录里的 PDF 一起搬到新位置（不勾选则只切换记录位置，旧文件留在原处）</span>
      </label>

      <div className="db-form-actions">
        <button className="primary-btn" onClick={() => apply()} disabled={busy || !target}>
          {busy ? '处理中…' : '应用新位置'}
        </button>
        {info && !info.isDefault && (
          <button className="ghost-btn" onClick={() => apply(info.defaultDir)} disabled={busy}>
            恢复默认目录
          </button>
        )}
      </div>

      {msg && <div className={`db-result ${msg.ok ? 'ok' : 'error'}`}>{msg.text}</div>}

      <p className="pane-tip">
        迁移只移动 PDF 本体，元数据、批注与阅读进度都在 MySQL 里，不受影响。跨盘迁移会自动退化为复制后删除。
      </p>
    </div>
  );
}

/* ============================ 数据库 / 关于 ============================ */

function DatabasePane({ dbInfo, onReconnected }) {
  return (
    <div className="pane">
      <h3 className="section-title">数据库连接</h3>
      <p className="section-desc">
        当前：
        {dbInfo
          ? `${dbInfo.config.user}@${dbInfo.config.host}:${dbInfo.config.port}/${dbInfo.config.database}`
          : '未连接'}
        {dbInfo && dbInfo.serverVersion ? ` · MySQL ${dbInfo.serverVersion}` : ''}
      </p>
      <DbForm initial={dbInfo ? dbInfo.config : null} onDone={() => onReconnected && onReconnected()} compact />
    </div>
  );
}

function AboutPane({ dbInfo }) {
  const versions = api && api.app ? api.app.versions() : null;
  return (
    <div className="pane">
      <h3 className="section-title">关于文献阅读器</h3>
      <p className="section-desc">纯本地的文献阅读与 PDF 标注工具，数据全部存放在你自己的机器上。</p>
      <ul className="about-list">
        <li>
          <span>版本</span>
          <b>0.1.0</b>
        </li>
        <li>
          <span>Electron</span>
          <b>{versions ? versions.electron : '—'}</b>
        </li>
        <li>
          <span>Chromium</span>
          <b>{versions ? versions.chrome : '—'}</b>
        </li>
        <li>
          <span>Node</span>
          <b>{versions ? versions.node : '—'}</b>
        </li>
        <li>
          <span>数据库</span>
          <b>{dbInfo && dbInfo.connected ? `MySQL ${dbInfo.serverVersion || ''}` : '未连接'}</b>
        </li>
      </ul>
      <p className="pane-tip">文库目录：{dbInfo ? dbInfo.library : '—'}</p>
    </div>
  );
}

/* ============================ 翻译（本地 Hy-MT2） ============================ */

const GPU_OPTIONS = [
  { value: 'auto', label: '自动（优先 CUDA / Vulkan / Metal）' },
  { value: 'cuda', label: 'CUDA（NVIDIA，需要 CUDA 版预编译包）' },
  { value: 'vulkan', label: 'Vulkan（跨厂商 GPU）' },
  { value: 'metal', label: 'Metal（Apple Silicon）' },
  { value: 'cpu', label: '仅 CPU（最慢，兜底）' },
];

const STATE_LABEL = {
  idle: '未加载',
  starting: '进程启动中',
  loading: '模型加载中',
  ready: '就绪',
  error: '出错',
  restarting: '自动重启中',
};

function TranslatePane() {
  const [status, setStatus] = useState(null);
  const [settings, setSettings] = useState(null);
  const [models, setModels] = useState([]);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState(null);
  const [download, setDownload] = useState(null);

  const loadAll = useCallback(async () => {
    try {
      const [st, md] = await Promise.all([api.translate.status(), api.translate.models()]);
      setStatus(st);
      setSettings(st && st.settings);
      setModels((md && md.models) || []);
    } catch (err) {
      toast(err.message || '读取翻译配置失败', 'error');
    }
  }, []);

  useEffect(() => {
    loadAll();
    const offStatus = api.translate.onStatus((next) => setStatus((prev) => ({ ...(prev || {}), ...next })));
    const offDownload = api.translate.onDownload((payload) => {
      setDownload(payload);
      if (payload.status === 'done') loadAll();
    });
    return () => {
      offStatus && offStatus();
      offDownload && offDownload();
    };
  }, [loadAll]);

  const save = async (patch) => {
    try {
      const next = await api.translate.saveSettings(patch);
      setSettings(next);
      const md = await api.translate.models();
      setModels((md && md.models) || []);
      setMsg(null);
      return next;
    } catch (err) {
      toast(err.message || '保存失败', 'error');
      return null;
    }
  };

  const doLoad = async () => {
    setBusy('load');
    setMsg(null);
    try {
      const res = await api.translate.load({});
      setStatus(res);
      toast(`模型已就绪：${res.gpu || 'cpu'}`, 'success');
      await loadAll();
    } catch (err) {
      setMsg({ ok: false, text: err.message || '加载失败' });
      toast(err.message || '加载失败', 'error');
    } finally {
      setBusy('');
    }
  };

  const doUnload = async () => {
    setBusy('unload');
    try {
      await api.translate.unload();
      toast('已卸载模型，显存已释放', 'success');
      await loadAll();
    } catch (err) {
      toast(err.message || '卸载失败', 'error');
    } finally {
      setBusy('');
    }
  };

  const pickModel = async () => {
    try {
      const res = await api.translate.pickModel();
      if (!res || res.canceled || !res.path) return;
      await save({ customPath: res.path });
      toast('已指定模型文件', 'success');
    } catch (err) {
      toast(err.message || '选择模型失败', 'error');
    }
  };

  /** 一键下载（主进程负责多源切换 + 断点续传） */
  const startDownload = async () => {
    setBusy('download');
    setMsg(null);
    try {
      const res = await api.translate.download(settings && settings.modelId);
      if (res && res.status === 'done') {
        toast('模型下载完成', 'success');
        await loadAll();
      } else if (res && res.status === 'error') {
        setMsg({ ok: false, text: res.error || '下载失败' });
      }
    } catch (err) {
      setMsg({ ok: false, text: err.message || '下载失败' });
    } finally {
      setBusy('');
    }
  };

  const state = status ? status.state : 'idle';
  const ready = state === 'ready';
  const currentModel = settings && settings.model;

  return (
    <div className="pane">
      <h3 className="section-title">本地翻译引擎</h3>
      <p className="section-desc">
        Tencent Hy-MT2-1.8B 跑在本机（llama.cpp / node-llama-cpp），划词翻译不联网、不上传文本。
        推理放在独立的 UtilityProcess 里，崩溃会被自动重启，不阻塞窗口。
      </p>

      <div className="tr-status">
        <span className={`tr-badge ${state}`}>{STATE_LABEL[state] || state}</span>
        <span className="tr-status-item">后端：{status && status.gpu ? status.gpu : '—'}</span>
        <span className="tr-status-item">设备：{(status && status.gpuDevice) || '—'}</span>
        {status && status.vram ? (
          <span className="tr-status-item">
            显存：{Math.round((status.vram.total || 0) / 1024 / 1024)}MB 可用
          </span>
        ) : null}
        {status && status.restartCount ? <span className="tr-status-item">重启次数：{status.restartCount}</span> : null}
      </div>
      {status && status.lastError && <div className="db-result error">{status.lastError}</div>}
      {msg && <div className={`db-result ${msg.ok ? 'ok' : 'error'}`}>{msg.text}</div>}

      <h3 className="section-title">模型</h3>
      <div className="tr-models">
        {models.map((model) => (
          <label key={model.id} className={`tr-model ${settings && settings.modelId === model.id ? 'active' : ''}`}>
            <input
              type="radio"
              name="tr-model"
              checked={Boolean(settings && settings.modelId === model.id)}
              onChange={() => save({ modelId: model.id })}
            />
            <span className="tr-model-main">
              <span className="tr-model-name">{model.label}</span>
              <span className="tr-model-note">{model.note}</span>
              <span className="tr-model-path" title={model.path}>
                {model.path}
              </span>
            </span>
            <span className={`tr-model-badge ${model.exists ? 'ok' : 'missing'}`}>
              {model.exists ? `${model.sizeMB}MB` : '未下载'}
            </span>
          </label>
        ))}
      </div>

      <div className="path-actions">
        <button className="ghost-btn small" onClick={startDownload} disabled={busy === 'download' || (download && download.status === 'downloading')}>
          {download && download.status === 'downloading' ? '下载中…' : '下载所选模型'}
        </button>
        <button className="ghost-btn small" onClick={pickModel}>
          选择本地 GGUF 文件…
        </button>
        <button className="ghost-btn small" onClick={() => api.translate.openModelsDir()}>
          打开模型目录
        </button>
        {settings && settings.customPath ? (
          <button className="ghost-btn small" onClick={() => save({ customPath: '' })}>
            清除自定义路径
          </button>
        ) : null}
      </div>

      {download && download.status === 'downloading' && (
        <div className="install-progress">
          <div className="install-bar">
            <span style={{ width: `${Math.min(100, Math.round(download.percent || 0))}%` }} />
          </div>
          <div className="install-progress-meta">
            <span>
              {(download.received / 1024 / 1024).toFixed(1)}MB / {(download.total / 1024 / 1024).toFixed(1)}MB ·{' '}
              {Math.round(download.percent || 0)}%
            </span>
            <span>
              {download.speed ? `${(download.speed / 1024 / 1024).toFixed(1)} MB/s` : ''}
              {download.mirror ? ` · ${download.mirror}` : ''}
            </span>
            <button className="ghost-btn tiny" onClick={() => api.translate.cancelDownload()}>
              取消
            </button>
          </div>
        </div>
      )}
      {download && download.status === 'error' && (
        <div className="db-result error">
          {download.error}
          {download.triedMirrors && download.triedMirrors.length ? `（已试：${download.triedMirrors.join(' → ')}）` : ''}
        </div>
      )}
      {currentModel && !currentModel.exists ? (
        <p className="pane-tip">
          未找到模型文件。可执行 <code>npm run model:download</code>，或把 <code>{currentModel.id}</code> 对应的 GGUF
          放进上面这个目录。
        </p>
      ) : null}

      <h3 className="section-title">推理后端</h3>
      <div className="field-row">
        <label className="field">
          <span>GPU 后端（尽量强制指定，失败会自动降级并显示实际值）</span>
          <select value={(settings && settings.gpu) || 'auto'} onChange={(e) => save({ gpu: e.target.value })}>
            {GPU_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field narrow">
          <span>默认译入</span>
          <select value={(settings && settings.target) || 'zh'} onChange={(e) => save({ target: e.target.value })}>
            {TARGET_LANGS.map((lang) => (
              <option key={lang.value} value={lang.value}>
                {lang.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="db-form-actions">
        <button className="primary-btn" onClick={doLoad} disabled={Boolean(busy)}>
          {busy === 'load' ? '加载中…' : ready ? '重新加载模型' : '加载模型'}
        </button>
        <button className="ghost-btn" onClick={doUnload} disabled={Boolean(busy) || !ready}>
          {busy === 'unload' ? '卸载中…' : '卸载释放显存'}
        </button>
      </div>

      <p className="pane-tip">
        提示：1.25bit 是极致量化版（约 440MB），体积最小、速度最快，但当前 node-llama-cpp 自带的 llama.cpp
        还读不了这个 GGUF（tensor offset 校验失败），会提示切换；Q4_K_M 是实测最稳的选择。修改后端或模型后需要点「重新加载模型」才会生效。
      </p>
    </div>
  );
}

/* ============================ 设置中心 ============================ */

const SECTIONS = [
  { key: 'appearance', label: '外观', icon: '🎨' },
  { key: 'storage', label: '存储', icon: '📁' },
  { key: 'translate', label: '翻译', icon: '🌐' },
  { key: 'ai', label: 'AI 模型', icon: '🧠' },
  { key: 'database', label: '数据库', icon: '💾' },
  { key: 'about', label: '关于', icon: 'ℹ' },
];

export default function SettingsDialog({ dbInfo, onClose, onReconnected, initialSection = 'appearance' }) {
  const [section, setSection] = useState(initialSection);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal settings-modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h2>设置</h2>
          <button className="icon-btn" onClick={onClose} title="关闭">
            ✕
          </button>
        </header>

        <div className="settings-body">
          <nav className="settings-nav">
            {SECTIONS.map((item) => (
              <button
                key={item.key}
                className={`settings-nav-item ${section === item.key ? 'active' : ''}`}
                onClick={() => setSection(item.key)}
              >
                <span className="settings-nav-icon">{item.icon}</span>
                {item.label}
              </button>
            ))}
          </nav>

          <div className="settings-pane">
            {section === 'appearance' && <AppearancePane />}
            {section === 'storage' && (
              <StoragePane
                onApplied={() => {
                  if (onReconnected) onReconnected();
                }}
              />
            )}
            {section === 'database' && <DatabasePane dbInfo={dbInfo} onReconnected={onReconnected} />}
            {section === 'translate' && <TranslatePane />}
            {section === 'ai' && <AiSettingsPane />}
            {section === 'about' && <AboutPane dbInfo={dbInfo} />}
          </div>
        </div>
      </div>
    </div>
  );
}
