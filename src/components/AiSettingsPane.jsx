import React, { useEffect, useMemo, useState } from 'react';
import { toast } from '../api.js';
import {
  LOCAL_CONTEXT_OPTIONS,
  LOCAL_GPU_OPTIONS,
  PROVIDER_KIND_LABELS,
  useAiProviders,
  useLocalModels,
} from '../ai.js';

const EMPTY_FORM = {
  id: '',
  name: '',
  kind: 'openai',
  baseUrl: '',
  model: '',
  apiKey: '',
  temperature: 0.3,
  maxTokens: 2048,
  disabled: false,
};

const LOCAL_STATE_LABEL = {
  idle: '未加载',
  starting: '进程启动中',
  loading: '模型加载中',
  ready: '就绪',
  error: '出错',
  restarting: '自动重启中',
};

function formatMB(bytes) {
  return `${(Number(bytes || 0) / 1024 / 1024).toFixed(1)}MB`;
}

/**
 * 设置 → AI 模型：
 * 1) 本地理解引擎——下载国内开源量化模型（GGUF），llama.cpp 本地推理，离线可用；
 * 2) 外部 AI 接口——多套 API 配置的增删改查与连通性测试。
 */
export default function AiSettingsPane() {
  const ai = useAiProviders();
  const local = useLocalModels();
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const [testingId, setTestingId] = useState('');
  const [presetKey, setPresetKey] = useState('');

  const [localModelId, setLocalModelId] = useState('');
  const [localPath, setLocalPath] = useState('');
  const [localGpu, setLocalGpu] = useState('auto');
  const [localContext, setLocalContext] = useState(8192);
  const [localBusy, setLocalBusy] = useState('');
  const [localMsg, setLocalMsg] = useState(null);

  const presets = ai.presets || [];
  const providers = ai.providers || [];
  const localModels = local.models || [];
  const localProvider = useMemo(() => providers.find((p) => p.kind === 'local') || null, [providers]);
  const localStatus = local.status || {};
  const localState = localStatus.state || 'idle';
  const localReady = localState === 'ready';
  const localDownload = local.download || null;
  const downloading = Boolean(localDownload && localDownload.status === 'downloading');

  useEffect(() => {
    if (form) setPresetKey('');
  }, [form && form.id]);

  // 模型清单就绪后给出一个默认选中项
  useEffect(() => {
    if (localModelId) return;
    const fallback = (localProvider && localProvider.localModelId) || local.defaultModelId || '';
    if (fallback) setLocalModelId(fallback);
  }, [localModelId, localProvider, local.defaultModelId]);

  // 已经存在本地配置时，把它的选择回填到界面
  useEffect(() => {
    if (!localProvider) return;
    if (localProvider.localModelId) setLocalModelId(localProvider.localModelId);
    setLocalPath(localProvider.localPath || '');
    setLocalGpu(localProvider.gpu || 'auto');
    setLocalContext(Number(localProvider.contextSize) || 8192);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [localProvider && localProvider.id]);

  const selectedModel = localModels.find((m) => m.id === localModelId) || null;
  const loadedModelLabel = useMemo(() => {
    if (!localReady || !localStatus.modelPath) return '';
    const hit = localModels.find((m) => m.path === localStatus.modelPath);
    return hit ? hit.shortLabel || hit.label : localStatus.modelPath;
  }, [localReady, localStatus.modelPath, localModels]);

  /* ------------------------------ 本地模型操作 ------------------------------ */

  const startLocalDownload = async () => {
    if (!localModelId) {
      toast('请先选一个模型', 'warn');
      return;
    }
    setLocalBusy('download');
    setLocalMsg(null);
    try {
      const res = await local.download(localModelId);
      if (res && res.status === 'done') {
        toast('模型下载完成', 'success');
        await local.refresh();
      } else if (res && res.status === 'error') {
        setLocalMsg({ ok: false, text: res.error || '下载失败' });
      }
    } catch (err) {
      setLocalMsg({ ok: false, text: err.message || '下载失败' });
    } finally {
      setLocalBusy('');
    }
  };

  const loadLocal = async () => {
    setLocalBusy('load');
    setLocalMsg(null);
    try {
      const res = await local.load({ localModelId, localPath, gpu: localGpu, contextSize: localContext });
      setLocalMsg({ ok: true, text: `本地推理就绪：${res.gpu || 'cpu'}${res.gpuDevice ? ` · ${res.gpuDevice}` : ''}` });
      toast(`模型已就绪：${res.gpu || 'cpu'}`, 'success');
      await local.refresh();
    } catch (err) {
      setLocalMsg({ ok: false, text: err.message || '加载失败' });
      toast(err.message || '加载失败', 'error', 6000);
    } finally {
      setLocalBusy('');
    }
  };

  const unloadLocal = async () => {
    setLocalBusy('unload');
    try {
      await local.unload();
      toast('已卸载本地模型，显存已释放', 'success');
    } catch (err) {
      toast(err.message || '卸载失败', 'error');
    } finally {
      setLocalBusy('');
    }
  };

  const pickLocalModel = async () => {
    try {
      const res = await local.pickModel();
      if (!res || res.canceled || !res.path) return;
      setLocalPath(res.path);
      toast('已指定本地 GGUF 文件', 'success');
    } catch (err) {
      toast(err.message || '选择模型失败', 'error');
    }
  };

  /** 把当前选择落成一条 kind=local 的配置并设为默认，之后「AI 理解」就走本机推理 */
  const enableLocal = async () => {
    setLocalBusy('enable');
    try {
      const label = (selectedModel && (selectedModel.shortLabel || selectedModel.label)) || localModelId || '本地 GGUF';
      const data = await ai.save({
        id: localProvider ? localProvider.id : undefined,
        name: (localProvider && localProvider.name) || '本地模型（离线）',
        kind: 'local',
        model: label,
        localModelId,
        localPath,
        gpu: localGpu,
        contextSize: localContext,
        temperature: localProvider ? localProvider.temperature : 0.3,
        maxTokens: localProvider ? localProvider.maxTokens : 1024,
        disabled: false,
      });
      const saved = ((data && data.providers) || []).find((p) => p.kind === 'local');
      if (saved) await ai.setDefault(saved.id);
      toast('已切换到本地模型：AI 理解不联网、不花 Token', 'success', 4500);
    } catch (err) {
      toast(err.message || '启用本地模型失败', 'error', 6000);
    } finally {
      setLocalBusy('');
    }
  };

  /* ------------------------------ 外部 API 操作 ------------------------------ */

  const startCreate = (preset) => {
    const base = preset
      ? { ...EMPTY_FORM, name: preset.name, kind: preset.kind, baseUrl: preset.baseUrl, model: preset.model }
      : { ...EMPTY_FORM };
    setForm(base);
  };

  const startEdit = (provider) => {
    setForm({
      id: provider.id,
      name: provider.name,
      kind: provider.kind,
      baseUrl: provider.baseUrl,
      model: provider.model,
      apiKey: '',
      temperature: provider.temperature ?? 0.3,
      maxTokens: provider.maxTokens ?? 2048,
      disabled: Boolean(provider.disabled),
      keyMasked: provider.keyMasked,
    });
  };

  const setField = (key, value) => setForm((prev) => ({ ...prev, [key]: value }));

  const applyPreset = (key) => {
    setPresetKey(key);
    const preset = presets.find((item) => item.key === key);
    if (!preset) return;
    setForm((prev) => ({
      ...prev,
      name: prev && prev.name ? prev.name : preset.name,
      kind: preset.kind,
      baseUrl: preset.baseUrl,
      model: preset.model,
    }));
  };

  const submit = async () => {
    if (!form) return;
    setSaving(true);
    try {
      await ai.save({
        id: form.id || undefined,
        name: form.name,
        kind: form.kind,
        baseUrl: form.baseUrl,
        model: form.model,
        apiKey: form.apiKey ? form.apiKey : undefined,
        temperature: Number(form.temperature),
        maxTokens: Number(form.maxTokens),
        disabled: Boolean(form.disabled),
      });
      toast(form.id ? 'AI 配置已更新' : 'AI 配置已保存', 'success');
      setForm(null);
    } catch (err) {
      toast(err.message || '保存失败', 'error');
    } finally {
      setSaving(false);
    }
  };

  const runTest = async (id) => {
    setTestingId(id);
    try {
      const result = await ai.test(id);
      toast(
        `连接成功：${result.model || '可用'}（${result.ms}ms）${result.sample ? ` · ${result.sample}` : ''}`,
        'success',
        4500
      );
      await ai.refresh();
      await local.refresh();
    } catch (err) {
      toast(err.message || '测试失败', 'error', 6000);
      await ai.refresh();
    } finally {
      setTestingId('');
    }
  };

  const removeProvider = async (provider) => {
    const ok = window.confirm(`删除 AI 配置「${provider.name}」？`);
    if (!ok) return;
    try {
      await ai.remove(provider.id);
      toast('已删除', 'success');
    } catch (err) {
      toast(err.message || '删除失败', 'error');
    }
  };

  return (
    <div className="ai-pane">
      <h3 className="section-title">本地理解引擎（离线）</h3>
      <p className="section-desc">
        和划词翻译同一套做法：下载国内开源模型（Qwen2.5）的 <b>GGUF 量化版</b>，用 llama.cpp 在独立进程里跑「AI 理解」。
        装好之后划词解释、整篇摘要、追问全部在本机完成：不联网、不消耗 Token、不需要 API Key，论文正文不会离开这台机器。
      </p>

      <div className="tr-status">
        <span className={`tr-badge ${localState}`}>{LOCAL_STATE_LABEL[localState] || localState}</span>
        <span className="tr-status-item">后端：{localStatus.gpu || '—'}</span>
        <span className="tr-status-item">设备：{localStatus.gpuDevice || '—'}</span>
        {localStatus.vram ? <span className="tr-status-item">显存：{Math.round((localStatus.vram.total || 0) / 1024 / 1024)}MB 可用</span> : null}
        {localReady && loadedModelLabel ? <span className="tr-status-item">已装载：{loadedModelLabel}</span> : null}
        {localProvider ? (
          <span className="tr-status-item">当前配置：{localProvider.name}</span>
        ) : (
          <span className="tr-status-item">还没启用，选好模型点下面的按钮即可</span>
        )}
      </div>

      {localStatus.lastError && <div className="db-result error">{localStatus.lastError}</div>}
      {localMsg && <div className={`db-result ${localMsg.ok ? 'ok' : 'error'}`}>{localMsg.text}</div>}

      <div className="tr-models">
        {localModels.map((model) => {
          const isTarget = downloading && localDownload.modelId === model.id;
          return (
            <label key={model.id} className={`tr-model ${localModelId === model.id ? 'active' : ''}`}>
              <input
                type="radio"
                name="ai-local-model"
                checked={localModelId === model.id}
                onChange={() => setLocalModelId(model.id)}
              />
              <span className="tr-model-main">
                <span className="tr-model-name">{model.label}</span>
                <span className="tr-model-note">{model.note}</span>
                <span className="tr-model-path" title={model.path}>
                  {model.path}
                </span>
              </span>
              <span className={`tr-model-badge ${isTarget ? '' : model.exists ? 'ok' : 'missing'}`}>
                {isTarget ? `${Math.round(localDownload.percent || 0)}%` : model.exists ? `${model.sizeMB}MB` : '未下载'}
              </span>
            </label>
          );
        })}
        {!localModels.length && <div className="ai-empty">正在读取模型清单…</div>}
      </div>

      <div className="path-actions">
        <button className="ghost-btn small" onClick={startLocalDownload} disabled={downloading || Boolean(localBusy)}>
          {downloading ? '下载中…' : '下载所选模型'}
        </button>
        <button className="ghost-btn small" onClick={pickLocalModel} disabled={Boolean(localBusy)}>
          选择本地 GGUF 文件…
        </button>
        <button className="ghost-btn small" onClick={() => local.openDir().catch((err) => toast(err.message, 'error'))}>
          打开模型目录
        </button>
        {localPath ? (
          <button className="ghost-btn small" onClick={() => setLocalPath('')}>
            清除自定义路径
          </button>
        ) : null}
        <button className="ghost-btn small" onClick={loadLocal} disabled={Boolean(localBusy)}>
          {localBusy === 'load' ? '加载中…' : localReady ? '重新加载模型' : '在本机加载模型'}
        </button>
        <button className="ghost-btn small" onClick={unloadLocal} disabled={Boolean(localBusy) || !localReady}>
          卸载释放显存
        </button>
      </div>

      {downloading && (
        <div className="install-progress">
          <div className="install-bar">
            <span style={{ width: `${Math.min(100, Math.round(localDownload.percent || 0))}%` }} />
          </div>
          <div className="install-progress-meta">
            <span>
              {formatMB(localDownload.received)} / {formatMB(localDownload.total)} · {Math.round(localDownload.percent || 0)}%
            </span>
            <span>
              {localDownload.speed ? `${(localDownload.speed / 1024 / 1024).toFixed(1)} MB/s` : ''}
              {localDownload.mirror ? ` · ${localDownload.mirror}` : ''}
            </span>
            <button className="ghost-btn tiny" onClick={() => local.cancelDownload()}>
              取消
            </button>
          </div>
        </div>
      )}
      {localDownload && localDownload.status === 'error' && (
        <div className="db-result error">
          {localDownload.error}
          {localDownload.triedMirrors && localDownload.triedMirrors.length
            ? `（已试：${localDownload.triedMirrors.join(' → ')}）`
            : ''}
        </div>
      )}

      <div className="field-row">
        <label className="field">
          <span>推理后端（失败会自动降级并回显真实值）</span>
          <select value={localGpu} onChange={(e) => setLocalGpu(e.target.value)}>
            {LOCAL_GPU_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field narrow">
          <span>上下文长度</span>
          <select value={localContext} onChange={(e) => setLocalContext(Number(e.target.value))}>
            {LOCAL_CONTEXT_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="db-form-actions">
        <button className="primary-btn" onClick={enableLocal} disabled={Boolean(localBusy)}>
          {localBusy === 'enable' ? '启用中…' : '用本地模型做 AI 理解'}
        </button>
      </div>
      <p className="pane-tip">
        本地模型体积大（1.06GB 起），建议先「下载所选模型」再点启用；同一台机器上和翻译模型共用模型目录
        {local.dir ? `（${local.dir}）` : ''}，空闲 10 分钟自动卸载释放显存。
      </p>

      <h3 className="section-title">外部 AI 接口（可选）</h3>
      <p className="section-desc">
        不想占用本机显存、或需要更强的推理时，也可以配置多套 API（OpenAI、DeepSeek、通义千问、智谱、OpenRouter、Ollama 本地服务或自建网关都行）。
        划词「AI 理解」和「整篇摘要」会用上面选中的默认配置；API Key 经系统加密后只存在本机，界面上只显示打码值。
      </p>

      <div className="ai-toolbar">
        <label className="ai-toolbar-label">默认配置</label>
        <select
          className="select"
          value={ai.defaultId || ''}
          onChange={async (e) => {
            try {
              await ai.setDefault(e.target.value);
            } catch (err) {
              toast(err.message || '切换失败', 'error');
            }
          }}
          disabled={!providers.length}
        >
          {!providers.length && <option value="">尚未配置</option>}
          {providers.map((provider) => (
            <option key={provider.id} value={provider.id}>
              {provider.name}（{provider.model}）
            </option>
          ))}
        </select>
        <span className="spacer" />
        <button className="primary-btn" onClick={() => startCreate(null)}>
          ＋ 新增配置
        </button>
      </div>

      {form && (
        <div className="ai-form">
          <div className="field-row">
            <label className="field">
              <span>用预设快速填充</span>
              <select value={presetKey} onChange={(e) => applyPreset(e.target.value)}>
                <option value="">选择服务商…</option>
                {presets.map((preset) => (
                  <option key={preset.key} value={preset.key}>
                    {preset.name} · {preset.hint}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>配置名称</span>
              <input
                value={form.name}
                placeholder="例如：DeepSeek 主力 / 本地 Ollama"
                onChange={(e) => setField('name', e.target.value)}
              />
            </label>
          </div>

          <div className="field-row">
            <label className="field narrow">
              <span>协议</span>
              <select value={form.kind} onChange={(e) => setField('kind', e.target.value)}>
                <option value="openai">OpenAI 兼容</option>
                <option value="anthropic">Anthropic</option>
              </select>
            </label>
            <label className="field">
              <span>Base URL</span>
              <input
                value={form.baseUrl}
                placeholder="https://api.deepseek.com/v1"
                onChange={(e) => setField('baseUrl', e.target.value)}
              />
            </label>
          </div>

          <div className="field-row">
            <label className="field">
              <span>模型名</span>
              <input value={form.model} placeholder="deepseek-chat" onChange={(e) => setField('model', e.target.value)} />
            </label>
            <label className="field">
              <span>API Key</span>
              <input
                type="password"
                value={form.apiKey}
                placeholder={form.keyMasked ? `已保存（${form.keyMasked}），留空不修改` : 'sk-…（本地服务可留空）'}
                onChange={(e) => setField('apiKey', e.target.value)}
              />
            </label>
          </div>

          <div className="field-row">
            <label className="field narrow">
              <span>温度</span>
              <input
                type="number"
                step="0.1"
                min="0"
                max="2"
                value={form.temperature}
                onChange={(e) => setField('temperature', e.target.value)}
              />
            </label>
            <label className="field narrow">
              <span>最大 tokens</span>
              <input
                type="number"
                step="128"
                min="64"
                max="32000"
                value={form.maxTokens}
                onChange={(e) => setField('maxTokens', e.target.value)}
              />
            </label>
            <label className="field ai-checkbox">
              <span>状态</span>
              <label className="ai-checkbox-inner">
                <input
                  type="checkbox"
                  checked={Boolean(form.disabled)}
                  onChange={(e) => setField('disabled', e.target.checked)}
                />
                停用这套配置
              </label>
            </label>
          </div>

          <div className="db-form-actions">
            <button className="ghost-btn" onClick={() => setForm(null)} disabled={saving}>
              取消
            </button>
            {form.id && (
              <button className="ghost-btn" onClick={() => runTest(form.id)} disabled={Boolean(testingId)}>
                {testingId === form.id ? '测试中…' : '测试连接'}
              </button>
            )}
            <button className="primary-btn" onClick={submit} disabled={saving}>
              {saving ? '保存中…' : '保存'}
            </button>
          </div>
        </div>
      )}

      {!providers.length && !form && (
        <div className="ai-empty">
          <p>还没有任何配置。想要完全离线可以启用上面的本地模型；想用云端效果就点「＋ 新增配置」填一个 Key。</p>
        </div>
      )}

      <div className="ai-list">
        {providers.map((provider) => (
          <div className={`ai-item ${provider.id === ai.defaultId ? 'active' : ''}`} key={provider.id}>
            <div className="ai-item-main">
              <div className="ai-item-title">
                <strong>{provider.name}</strong>
                {provider.id === ai.defaultId && <span className="ai-badge">默认</span>}
                {provider.disabled && <span className="ai-badge muted">已停用</span>}
                <span className="ai-kind">{PROVIDER_KIND_LABELS[provider.kind] || provider.kind}</span>
              </div>
              <div className="ai-item-meta">
                {provider.kind === 'local' ? (
                  <>
                    <span>{provider.model}</span>
                    <span>·</span>
                    <span>{provider.gpu || 'auto'}</span>
                    <span>·</span>
                    <span className="ellipsis" title={provider.localPath || local.dir}>
                      {provider.localPath || '默认模型目录'}
                    </span>
                  </>
                ) : (
                  <>
                    <span className="ellipsis" title={provider.baseUrl}>
                      {provider.baseUrl}
                    </span>
                    <span>·</span>
                    <span>{provider.model}</span>
                    {provider.hasKey && <span>· Key {provider.keyMasked}</span>}
                    {!provider.hasKey && <span className="muted">· 未设置 Key</span>}
                  </>
                )}
              </div>
              {provider.lastTest && (
                <div className={`ai-item-test ${provider.lastTest.ok ? 'ok' : 'fail'}`}>
                  {provider.lastTest.ok
                    ? `上次测试通过 · ${provider.lastTest.ms}ms`
                    : `上次测试失败：${String(provider.lastTest.message || '').slice(0, 80)}`}
                </div>
              )}
            </div>
            <div className="ai-item-actions">
              {provider.id !== ai.defaultId && (
                <button
                  className="ghost-btn tiny"
                  onClick={async () => {
                    try {
                      await ai.setDefault(provider.id);
                    } catch (err) {
                      toast(err.message || '设置失败', 'error');
                    }
                  }}
                >
                  设为默认
                </button>
              )}
              <button className="ghost-btn tiny" onClick={() => runTest(provider.id)} disabled={Boolean(testingId)}>
                {testingId === provider.id ? '测试中…' : '测试'}
              </button>
              {provider.kind !== 'local' && (
                <button className="ghost-btn tiny" onClick={() => startEdit(provider)}>
                  编辑
                </button>
              )}
              <button className="ghost-btn tiny danger" onClick={() => removeProvider(provider)}>
                删除
              </button>
            </div>
          </div>
        ))}
      </div>

      {ai.error && <p className="ai-error">{ai.error}</p>}
      {local.error && <p className="ai-error">{local.error}</p>}

      <p className="section-note">
        提示：本地模型（Qwen2.5 GGUF）与外部 API 的区别——本地模型不联网、免费、可断网使用，但受本机显存/算力限制；
        外部 API 效果更强，但选中的论文片段/正文会发送到该服务商（Ollama、LM Studio、自建网关除外）。
      </p>
    </div>
  );
}
