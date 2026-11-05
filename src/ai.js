/**
 * 外部 AI 的渲染进程客户端。
 * 所有请求都经 preload 暴露的 window.pr.ai，API Key 始终留在主进程。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api.js';

export function aiApi() {
  return (api && api.ai) || null;
}

export const AI_MODE_LABELS = {
  explain: '解释这段',
  simple: '通俗讲',
  keypoints: '提炼要点',
  translate: '翻译 + 解释',
  critique: '找问题',
};

/** 配置类型：本地 GGUF 和外部 API 在界面上要区分清楚 */
export const PROVIDER_KIND_LABELS = {
  openai: 'OpenAI 兼容',
  anthropic: 'Anthropic',
  local: '本地 GGUF',
};

/** 本地模型的推理后端选项（和「设置 → 翻译」保持一致） */
export const LOCAL_GPU_OPTIONS = [
  { value: 'auto', label: '自动（优先 GPU）' },
  { value: 'cuda', label: 'CUDA（NVIDIA）' },
  { value: 'vulkan', label: 'Vulkan（通用显卡）' },
  { value: 'metal', label: 'Metal（Apple）' },
  { value: 'cpu', label: 'CPU（不占显存）' },
];

export const LOCAL_CONTEXT_OPTIONS = [
  { value: 4096, label: '4K（省显存）' },
  { value: 8192, label: '8K（推荐）' },
  { value: 16384, label: '16K（长文，吃显存）' },
];

/** 供应商列表 / 预设 / 理解模式，附带增删改测试 */
export function useAiProviders() {
  const [state, setState] = useState({
    loading: true,
    providers: [],
    presets: [],
    modes: [],
    defaultId: '',
    error: null,
  });

  const refresh = useCallback(async () => {
    const bridge = aiApi();
    if (!bridge) {
      setState((prev) => ({ ...prev, loading: false, error: 'AI 能力不可用（preload 未注入）' }));
      return null;
    }
    try {
      const [data, modes] = await Promise.all([bridge.providers(), bridge.modes()]);
      setState({
        loading: false,
        providers: (data && data.providers) || [],
        presets: (data && data.presets) || [],
        modes: modes || [],
        defaultId: (data && data.defaultId) || '',
        error: null,
      });
      return data;
    } catch (err) {
      setState((prev) => ({ ...prev, loading: false, error: err.message || '读取 AI 配置失败' }));
      return null;
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const save = useCallback(
    async (input) => {
      const bridge = aiApi();
      if (!bridge) throw new Error('AI 能力不可用');
      const data = await bridge.saveProvider(input);
      setState((prev) => ({
        ...prev,
        providers: (data && data.providers) || [],
        defaultId: (data && data.defaultId) || '',
      }));
      return data;
    },
    []
  );

  const remove = useCallback(async (id) => {
    const bridge = aiApi();
    if (!bridge) throw new Error('AI 能力不可用');
    const data = await bridge.removeProvider(id);
    setState((prev) => ({ ...prev, providers: (data && data.providers) || [], defaultId: (data && data.defaultId) || '' }));
    return data;
  }, []);

  const setDefault = useCallback(async (id) => {
    const bridge = aiApi();
    if (!bridge) throw new Error('AI 能力不可用');
    const data = await bridge.setDefault(id);
    setState((prev) => ({ ...prev, defaultId: (data && data.defaultId) || '' }));
    return data;
  }, []);

  const test = useCallback(async (id) => {
    const bridge = aiApi();
    if (!bridge) throw new Error('AI 能力不可用');
    return bridge.testProvider({ id });
  }, []);

  const active = useMemo(() => {
    const list = state.providers || [];
    return list.find((p) => p.id === state.defaultId) || list[0] || null;
  }, [state.providers, state.defaultId]);

  return { ...state, active, refresh, save, remove, setDefault, test };
}

/**
 * 本地量化模型（GGUF）的清单、下载进度、进程状态。
 * 和「设置 → 翻译」用的是同一套思路：主进程下载 + UtilityProcess 推理，渲染层只看进度。
 */
export function useLocalModels() {
  const [state, setState] = useState({
    loading: true,
    models: [],
    defaultModelId: '',
    status: null,
    download: null,
    dir: '',
    error: null,
  });

  const refresh = useCallback(async () => {
    const bridge = aiApi();
    const local = bridge && bridge.local;
    if (!local) {
      setState((prev) => ({ ...prev, loading: false, error: '本地模型能力不可用（preload 未注入）' }));
      return null;
    }
    try {
      const info = await local.models();
      setState((prev) => ({
        ...prev,
        loading: false,
        models: (info && info.models) || [],
        defaultModelId: (info && info.defaultModelId) || '',
        status: (info && info.status) || null,
        download: (info && info.download) || prev.download,
        dir: (info && info.dir) || '',
        error: null,
      }));
      return info;
    } catch (err) {
      setState((prev) => ({ ...prev, loading: false, error: err.message || '读取本地模型状态失败' }));
      return null;
    }
  }, []);

  useEffect(() => {
    refresh();
    const bridge = aiApi();
    const local = bridge && bridge.local;
    if (!local) return undefined;
    const offDownload = local.onDownload((payload) => {
      setState((prev) => ({ ...prev, download: payload }));
      if (payload && (payload.status === 'done' || payload.status === 'error')) refresh();
    });
    const offStatus = local.onStatus((next) => setState((prev) => ({ ...prev, status: { ...(prev.status || {}), ...next } })));
    return () => {
      offDownload && offDownload();
      offStatus && offStatus();
    };
  }, [refresh]);

  const ensureBridge = useCallback(() => {
    const bridge = aiApi();
    const local = bridge && bridge.local;
    if (!local) throw new Error('本地模型能力不可用（preload 未注入）');
    return local;
  }, []);

  const download = useCallback(
    async (modelId) => {
      const local = ensureBridge();
      const res = await local.download(modelId);
      await refresh();
      return res;
    },
    [ensureBridge, refresh]
  );

  const cancelDownload = useCallback(async () => {
    const local = ensureBridge();
    return local.cancelDownload();
  }, [ensureBridge]);

  const load = useCallback(
    async (overrides = {}) => {
      const local = ensureBridge();
      const status = await local.load(overrides);
      setState((prev) => ({ ...prev, status: { ...(prev.status || {}), ...status } }));
      return status;
    },
    [ensureBridge]
  );

  const unload = useCallback(async () => {
    const local = ensureBridge();
    const res = await local.unload();
    await refresh();
    return res;
  }, [ensureBridge, refresh]);

  const pickModel = useCallback(async () => {
    const local = ensureBridge();
    return local.pickModel();
  }, [ensureBridge]);

  const openDir = useCallback(async () => {
    const local = ensureBridge();
    return local.openDir();
  }, [ensureBridge]);

  return { ...state, refresh, download, cancelDownload, load, unload, pickModel, openDir };
}

/**
 * 单次「理解」会话：支持流式回填、追问、中止。
 * 同一时刻只保留一个请求，新的提问会打断旧的。
 */
export function useAiChat() {
  const [state, setState] = useState({
    status: 'idle', // idle | loading | streaming | done | error
    text: '',
    error: null,
    mode: 'explain',
    quote: '',
    providerName: '',
    model: '',
    ms: null,
  });
  const [history, setHistory] = useState([]);
  const seqRef = useRef(0);
  const reqRef = useRef(null);
  const unsubRef = useRef(null);

  const detach = useCallback(() => {
    if (unsubRef.current) {
      unsubRef.current();
      unsubRef.current = null;
    }
  }, []);

  useEffect(() => () => detach(), [detach]);

  const abort = useCallback(async () => {
    const bridge = aiApi();
    const requestId = reqRef.current;
    seqRef.current += 1;
    if (bridge && requestId) await bridge.abort(requestId).catch(() => {});
    detach();
    setState((prev) => (prev.status === 'streaming' || prev.status === 'loading' ? { ...prev, status: 'done' } : prev));
  }, [detach]);

  const reset = useCallback(() => {
    seqRef.current += 1;
    detach();
    reqRef.current = null;
    setHistory([]);
    setState({ status: 'idle', text: '', error: null, mode: 'explain', quote: '', providerName: '', model: '', ms: null });
  }, [detach]);

  const run = useCallback(
    async (payload = {}) => {
      const bridge = aiApi();
      if (!bridge) {
        setState((prev) => ({ ...prev, status: 'error', error: 'AI 能力不可用（preload 未注入）' }));
        return null;
      }
      const seq = ++seqRef.current;
      const requestId = `ai-${Date.now()}-${seq}`;
      reqRef.current = requestId;
      detach();

      setState((prev) => ({
        ...prev,
        status: 'loading',
        text: '',
        error: null,
        mode: payload.mode || prev.mode,
        quote: payload.quote || prev.quote || payload.text || '',
      }));

      const unsub = bridge.onChunk((chunk) => {
        if (!chunk || chunk.requestId !== requestId) return;
        if (seq !== seqRef.current) return;
        setState((prev) => ({ ...prev, status: 'streaming', text: chunk.text || `${prev.text}${chunk.delta || ''}` }));
      });
      unsubRef.current = unsub;

      try {
        const result = await bridge.chat({ requestId, ...payload });
        if (seq !== seqRef.current) return result;
        setState((prev) => ({
          ...prev,
          status: 'done',
          text: result.text || prev.text,
          ms: result.ms || null,
          providerName: result.providerName || '',
          model: result.model || '',
        }));
        if (payload.question) {
          setHistory((prev) => [...prev, { question: payload.question, answer: result.text || '' }]);
        }
        return result;
      } catch (err) {
        if (seq !== seqRef.current) return null;
        setState((prev) => ({ ...prev, status: 'error', error: err.message || 'AI 请求失败' }));
        return null;
      } finally {
        if (seq === seqRef.current) {
          detach();
          reqRef.current = null;
        }
      }
    },
    [detach]
  );

  const ask = useCallback(
    (payload) => {
      setHistory([]);
      return run(payload);
    },
    [run]
  );

  const followUp = useCallback(
    (question, extra = {}) => {
      const trimmed = String(question || '').trim();
      if (!trimmed) return null;
      return run({
        question: trimmed,
        quote: state.quote,
        answer: state.text,
        mode: state.mode,
        ...extra,
      });
    },
    [run, state.quote, state.text, state.mode]
  );

  return { state, history, ask, followUp, abort, reset };
}
