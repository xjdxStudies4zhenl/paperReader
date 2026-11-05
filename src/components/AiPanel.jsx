import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, guard, toast } from '../api.js';
import { useAiChat, useAiProviders } from '../ai.js';

/** 极简 Markdown：只处理小标题、列表、段落，够读即可 */
function renderRich(text) {
  const lines = String(text || '').split('\n');
  const blocks = [];
  let list = null;
  const flush = () => {
    if (list && list.length) {
      blocks.push(
        <ul className="ai-list-block" key={`ul-${blocks.length}`}>
          {list.map((item, i) => (
            <li key={i}>{item}</li>
          ))}
        </ul>
      );
    }
    list = null;
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (/^#{1,4}\s+/.test(line)) {
      flush();
      blocks.push(
        <h4 className="ai-h" key={`h-${blocks.length}`}>
          {line.replace(/^#{1,4}\s+/, '')}
        </h4>
      );
    } else if (/^[-*]\s+/.test(line)) {
      if (!list) list = [];
      list.push(line.replace(/^[-*]\s+/, ''));
    } else if (!line.trim()) {
      flush();
    } else {
      flush();
      blocks.push(
        <p className="ai-p" key={`p-${blocks.length}`}>
          {line}
        </p>
      );
    }
  }
  flush();
  return blocks;
}

/**
 * 「AI 理解」浮层：划词理解 / 整篇摘要共用。
 * 请求由主进程转发到用户配置的外部 API，这里只负责交互与流式渲染。
 */
export default function AiPanel({ anchor, payload, docId, pageNo, rects, onClose, onSaved }) {
  const providers = useAiProviders();
  const chat = useAiChat();
  const boxRef = useRef(null);
  const [pos, setPos] = useState({ left: 80, top: 120 });
  const [mode, setMode] = useState(payload.mode || 'explain');
  const [providerId, setProviderId] = useState('');
  const [question, setQuestion] = useState('');
  const started = useRef(false);
  const [saving, setSaving] = useState(false);

  const isSummary = mode === 'summary';
  const activeProvider = providers.providers.find((p) => p.id === providerId) || providers.active;

  useEffect(() => {
    if (providers.active && !providerId) setProviderId(providers.active.id);
  }, [providers.active, providerId]);

  const run = useCallback(
    (nextMode) => {
      const quote = payload.quote || '';
      const text = payload.text || quote;
      if (!text) return;
      chat.ask({
        mode: nextMode || mode,
        text,
        quote,
        title: payload.title,
        authors: payload.authors,
        year: payload.year,
        journal: payload.journal,
        providerId: activeProvider ? activeProvider.id : undefined,
      });
    },
    [chat, mode, payload, activeProvider]
  );

  // 打开时自动跑一次
  useEffect(() => {
    if (started.current) return;
    if (providers.loading) return;
    started.current = true;
    run(mode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providers.loading]);

  // 跟随内容高度定位
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const width = box.offsetWidth || 460;
    const height = box.offsetHeight || 320;
    const margin = 12;
    const headerSafe = 52;
    let left = anchor ? anchor.left : 120;
    let top = anchor ? anchor.bottom + 8 : 140;
    if (left + width + margin > window.innerWidth) left = window.innerWidth - width - margin;
    if (left < margin) left = margin;
    if (top + height + margin > window.innerHeight) top = Math.max(headerSafe, (anchor ? anchor.top : 320) - height - 8);
    if (top < headerSafe) top = headerSafe;
    setPos({ left, top });
  }, [anchor, chat.state.text, chat.state.status]);

  const submitFollowUp = () => {
    const value = question.trim();
    if (!value) return;
    setQuestion('');
    chat.followUp(value, { providerId: activeProvider ? activeProvider.id : undefined, mode });
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(chat.state.text || '');
      toast('已复制', 'success');
    } catch {
      toast('复制失败，请手动选择文本', 'warn');
    }
  };

  /** 把理解结果落成一条批注（原文进 quote，AI 回答进 content） */
  const saveAsAnno = async () => {
    if (!chat.state.text) return;
    if (!docId || !pageNo) {
      toast('整篇摘要不能存成页内批注，可先复制', 'warn');
      return;
    }
    setSaving(true);
    try {
      const created = await guard(() =>
        api.annos.create({
          docId,
          pageNo,
          type: 'note',
          color: '#7c5cff',
          rects: rects || [],
          inkPaths: [],
          quote: payload.quote || '',
          content: `【AI 理解】${chat.state.text}`,
          opacity: 0.9,
        })
      );
      if (created) {
        toast('已存为批注', 'success');
        if (onSaved) onSaved(created);
        onClose();
      }
    } finally {
      setSaving(false);
    }
  };

  const modeList = useMemo(() => providers.modes || [], [providers.modes]);
  const busy = chat.state.status === 'loading' || chat.state.status === 'streaming';

  return (
    <div className="ai-pop" ref={boxRef} style={{ left: pos.left, top: pos.top }} onMouseDown={(e) => e.stopPropagation()}>
      <header className="ai-head">
        <span className="ai-title">{isSummary ? '🧠 AI 整篇理解' : '🧠 AI 理解'}</span>
        {providers.providers.length > 1 ? (
          <select
            className="ai-provider"
            value={providerId}
            onChange={(e) => {
              setProviderId(e.target.value);
              run(mode);
            }}
            title="切换 AI 配置"
          >
            {providers.providers.map((provider) => (
              <option key={provider.id} value={provider.id}>
                {provider.name}
                {provider.kind === 'local' ? '（本地）' : ''}
              </option>
            ))}
          </select>
        ) : (
          <span className="ai-provider-static">
            {activeProvider
              ? `${activeProvider.name} · ${activeProvider.model}${activeProvider.kind === 'local' ? ' · 本地' : ''}`
              : '未配置'}
          </span>
        )}
        <button className="icon-btn" title="关闭" onClick={onClose}>
          ✕
        </button>
      </header>

      {!isSummary && (
        <div className="ai-modes">
          {modeList.map((item) => (
            <button
              key={item.key}
              className={`ai-mode ${mode === item.key ? 'active' : ''}`}
              title={item.hint}
              disabled={busy}
              onClick={() => {
                setMode(item.key);
                run(item.key);
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}

      <div className="ai-body">
        {payload.quote && !isSummary && (
          <div className="ai-quote" title={payload.quote}>
            {payload.quote}
          </div>
        )}

        {chat.state.status === 'error' ? (
          <div className="ai-error-box">
            <p>{chat.state.error}</p>
            <p className="ai-hint">
              {/本地理解模型|模型文件不存在|还没下载/.test(chat.state.error || '')
                ? '本地模型还没准备好：到「设置 → AI 模型 → 本地理解引擎」下载一个量化模型（1GB 起），或在同一页把默认配置换成外部 API。'
                : /还没有配置|没有选中有效的 AI 配置/.test(chat.state.error || '')
                  ? '请到「设置 → AI 模型」启用本地模型，或添加一套外部 API 后再试。'
                  : '可在「设置 → AI 模型」里换一套配置、下载本地模型或测试连通性。'}
            </p>
          </div>
        ) : (
          <div className="ai-answer">
            {chat.state.text ? (
              renderRich(chat.state.text)
            ) : (
              <p className="ai-placeholder">
                {busy
                  ? activeProvider && activeProvider.kind === 'local'
                    ? '本地模型推理中（首次要加载模型，可能等几十秒）…'
                    : '正在请求模型…'
                  : '等待结果…'}
              </p>
            )}
            {chat.state.status === 'streaming' && <span className="ai-caret">▍</span>}
          </div>
        )}

        {chat.history.map((item, index) => (
          <div className="ai-follow" key={index}>
            <div className="ai-follow-q">问：{item.question}</div>
            <div className="ai-answer">{renderRich(item.answer)}</div>
          </div>
        ))}
      </div>

      <div className="ai-ask">
        <input
          className="ai-ask-input"
          placeholder="追问：为什么这样设计？有没有反例？"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              submitFollowUp();
            }
          }}
        />
        {busy ? (
          <button className="ghost-btn tiny" onClick={() => chat.abort()}>
            停止
          </button>
        ) : (
          <button className="ghost-btn tiny" onClick={submitFollowUp} disabled={!question.trim()}>
            追问
          </button>
        )}
      </div>

      <footer className="ai-foot">
        <span className="ai-meta">
          {chat.state.ms ? `${(chat.state.ms / 1000).toFixed(2)}s` : ''}
          {chat.state.text ? ` · ${chat.state.text.length} 字` : ''}
          {chat.state.model ? ` · ${chat.state.model}` : ''}
        </span>
        <div className="spacer" />
        <button className="ghost-btn tiny" onClick={() => run(mode)} disabled={busy}>
          重试
        </button>
        <button className="ghost-btn tiny" onClick={copy} disabled={!chat.state.text}>
          复制
        </button>
        <button className="primary-btn tiny-btn" onClick={saveAsAnno} disabled={!chat.state.text || saving || isSummary}>
          {saving ? '保存中…' : '存为批注'}
        </button>
      </footer>
    </div>
  );
}
