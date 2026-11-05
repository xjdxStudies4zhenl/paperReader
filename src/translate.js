/**
 * 渲染进程侧的翻译客户端：只通过 preload 暴露的 window.pr.translate 调用，
 * 绝不直接 import node-llama-cpp（原生模块只能在主进程 / UtilityProcess 里加载）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api.js';

export const TARGET_LANGS = [
  { value: 'zh', label: '简体中文' },
  { value: 'en', label: '英语' },
  { value: 'ja', label: '日语' },
  { value: 'ko', label: '韩语' },
  { value: 'de', label: '德语' },
  { value: 'fr', label: '法语' },
  { value: 'ru', label: '俄语' },
  { value: 'zh-Hant', label: '繁体中文' },
];

export function translateApi() {
  return (api && api.translate) || null;
}

/** 按 requestId 分发流式片段（requestId 由渲染进程生成，先订阅再发请求） */
export function useTranslateStream() {
  const handlers = useRef(new Map());
  useEffect(() => {
    const translate = translateApi();
    if (!translate || !translate.onChunk) return undefined;
    return translate.onChunk((payload) => {
      const handler = handlers.current.get(payload.requestId);
      if (handler) handler(payload);
    });
  }, []);
  return useCallback((requestId, handler) => {
    if (!requestId) return;
    if (handler) handlers.current.set(requestId, handler);
    else handlers.current.delete(requestId);
  }, []);
}

/**
 * 划词翻译：流式回填 + 终态校验。
 * 用法：const { state, translate, reset } = useTranslation(); translate(text, { target: 'zh' })
 */
export function useTranslation() {
  const [state, setState] = useState({ status: 'idle', text: '', error: null, ms: null, target: 'zh' });
  const [settings, setSettings] = useState(null);
  const [modelState, setModelState] = useState(null);
  const bindStream = useTranslateStream();
  const seqRef = useRef(0);
  const activeRef = useRef(null);

  const refreshStatus = useCallback(async () => {
    const translate = translateApi();
    if (!translate) return null;
    try {
      const info = await translate.status();
      setModelState(info);
      if (info && info.settings) setSettings(info.settings);
      return info;
    } catch (err) {
      console.warn('读取翻译状态失败', err);
      return null;
    }
  }, []);

  useEffect(() => {
    refreshStatus();
  }, [refreshStatus]);

  /** 首次翻译时自动加载模型（后续保持常驻，空闲 10 分钟由主进程卸载） */
  const ensureLoaded = useCallback(async () => {
    const translate = translateApi();
    if (!translate) throw new Error('翻译能力不可用（preload 未注入）');
    const info = await translate.status();
    setModelState(info);
    if (info && info.state === 'ready') return info;
    if (!info || !info.settings || !info.settings.model || !info.settings.model.exists) {
      const where = info && info.settings && info.settings.model ? info.settings.model.path : '模型目录';
      throw new Error(`还没找到翻译模型，请把 GGUF 放到：\n${where}`);
    }
    const loaded = await translate.load({});
    setModelState(loaded);
    return loaded;
  }, []);

  const translate = useCallback(
    async (text, options = {}) => {
      const translateBridge = translateApi();
      if (!translateBridge) {
        setState({ status: 'error', text: '', error: '翻译能力不可用', ms: null, target: 'zh' });
        return null;
      }
      const mySeq = ++seqRef.current;
      const requestId = `tr-${Date.now()}-${mySeq}`;
      activeRef.current = requestId;
      setState({ status: 'loading', text: '', error: null, ms: null, target: options.target || 'zh' });

      bindStream(requestId, (payload) => {
        if (mySeq !== seqRef.current) return;
        setState((prev) => ({ ...prev, status: 'streaming', text: `${prev.text}${payload.text}` }));
      });

      try {
        await ensureLoaded();
        if (mySeq !== seqRef.current) return null;
        setState((prev) => ({ ...prev, status: 'streaming' }));
        const result = await translateBridge.text({
          requestId,
          text,
          target: options.target,
          style: options.style,
          maxTokens: options.maxTokens,
        });
        if (mySeq !== seqRef.current) return result;
        setState({
          status: 'done',
          text: result.text || '',
          error: null,
          ms: result.ms || null,
          target: result.target || 'zh',
        });
        return result;
      } catch (err) {
        if (mySeq !== seqRef.current) return null;
        setState({ status: 'error', text: '', error: err.message || '翻译失败', ms: null, target: 'zh' });
        return null;
      } finally {
        bindStream(requestId, null);
        if (activeRef.current === requestId) activeRef.current = null;
      }
    },
    [ensureLoaded, bindStream]
  );

  const abort = useCallback(async () => {
    const translateBridge = translateApi();
    const requestId = activeRef.current;
    seqRef.current += 1;
    setState((prev) => ({ ...prev, status: prev.status === 'streaming' ? 'done' : prev.status }));
    if (translateBridge && requestId) await translateBridge.abort(requestId).catch(() => {});
  }, []);

  const reset = useCallback(() => {
    seqRef.current += 1;
    setState({ status: 'idle', text: '', error: null, ms: null, target: 'zh' });
  }, []);

  return { state, settings, modelState, translate, abort, reset, refreshStatus };
}
