import React, { useEffect, useMemo, useState } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { api, toast } from '../api.js';
import { aiApi, useAiChat } from '../ai.js';

marked.setOptions({ breaks: true, gfm: true });

/** 推荐给用户的几个解析角度 */
const AI_MODES = [
  {
    key: 'overview',
    label: '项目概览',
    prompt:
      '请概述这个仓库：它解决什么问题、对应论文的哪部分工作、主要模块与关键文件分别负责什么、用了什么技术栈。' +
      '先用 5-8 条要点分模块讲，最后用 2-3 句话总结这个仓库的定位。',
  },
  {
    key: 'architecture',
    label: '架构与流程',
    prompt:
      '请梳理这个项目的架构与主流程：目录职责划分、模块之间的依赖和调用关系、训练/推理（或数据处理）的主链路。' +
      '用层级列表描述，关键链路可以用 A → B → C 的形式。指出入口文件和核心类/函数（用实际文件名）。',
  },
  {
    key: 'run',
    label: '怎么跑起来',
    prompt:
      '请给出可操作的运行指南：需要什么环境与依赖、怎么安装、数据怎么准备、训练与评测命令分别是什么。' +
      '命令要写成可直接复制的形式；如果信息不足，明确指出还缺哪些配置（例如数据路径、预训练权重）。',
  },
  {
    key: 'paper',
    label: '对照论文',
    prompt:
      '请把论文和代码对照起来：论文里的方法/模块分别落在哪些文件或函数；实验设置（数据集、超参、评价指标）在代码里怎么实现；' +
      '如果代码与论文描述存在差异或论文没提的细节，单独列一节说明。',
  },
  {
    key: 'review',
    label: '问题与改进',
    prompt:
      '请从工程与可复现性角度审查这个仓库：代码质量、配置与依赖的完备性、复现风险（缺权重、硬编码路径、随机种子等）、文档缺失。' +
      '最后按优先级给出 3 条最值得先改的建议，每条说明理由。',
  },
];

const SYSTEM_PROMPT =
  '你是一名资深软件工程师，负责帮中文读者读懂一篇论文配套的开源代码仓库。' +
  '只能依据下面提供的文件内容回答，不要编造不存在的文件、函数或命令；信息不足时明确说"仓库里没看到"并说明还需要什么。' +
  '回答用简体中文，Markdown 排版，条目化，具体到文件名，避免空话套话。';

/** 把仓库上下文和角度拼成一条 user 消息（总长度受 maxChars 限制） */
function buildMessages(mode, ctx) {
  const parts = [];
  if (ctx.doc && ctx.doc.title) parts.push(`【论文标题】${ctx.doc.title}`);
  if (ctx.doc && ctx.doc.abstract) parts.push(`【论文摘要】${String(ctx.doc.abstract).slice(0, 900)}`);
  const repoLine = [
    `【仓库】${ctx.repo.name}`,
    ctx.repo.url ? `地址 ${ctx.repo.url}` : '',
    ctx.repo.branch ? `默认分支 ${ctx.repo.branch}` : '',
    `共 ${ctx.repo.fileCount} 个文件`,
  ]
    .filter(Boolean)
    .join(' · ');
  parts.push(repoLine);
  if (ctx.stats) parts.push(`【文件类型分布】${ctx.stats}`);
  if (ctx.treeText) parts.push(`【目录结构】\n${ctx.treeText}${ctx.truncated ? '\n…（更深的目录已省略）' : ''}`);
  if (ctx.readme && ctx.readme.text) parts.push(`【${ctx.readme.name}】\n${ctx.readme.text}`);
  for (const item of ctx.manifests || []) parts.push(`【${item.name}】\n${item.text}`);

  const budget = Number(ctx.maxChars) || 12000;
  let body = parts.join('\n\n');
  if (body.length > budget) body = `${body.slice(0, budget)}\n…（上下文过长已截断）`;

  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `下面是仓库内容。\n\n${body}\n\n----\n${mode.prompt}` },
  ];
}

/**
 * 仓库「AI 解析」：调当前配置的模型（本地 GGUF 优先）读一遍仓库结构，
 * 从几个固定角度给出解读，结果可复制或存成这篇文献的笔记。
 */
export default function RepoAi({ docId }) {
  const chat = useAiChat();
  const [mode, setMode] = useState(AI_MODES[0].key);
  const [ctx, setCtx] = useState(null);
  const [provider, setProvider] = useState(null);
  const [providerLoaded, setProviderLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [localHint, setLocalHint] = useState('');

  useEffect(() => {
    let alive = true;
    (async () => {
      const bridge = aiApi();
      if (!bridge) {
        setProviderLoaded(true);
        return;
      }
      try {
        const data = await bridge.providers();
        const list = (data && data.providers) || [];
        const local = list.find((p) => p.kind === 'local');
        const pick = local || list.find((p) => p.id === (data && data.defaultId)) || list[0] || null;
        if (!alive) return;
        setProvider(pick);
        // 本地模型没下载时给个提醒（不阻塞，模型列表拿不到就跳过）
        if (pick && pick.kind === 'local' && bridge.local) {
          try {
            const info = await bridge.local.models();
            const models = (info && info.models) || [];
            const installed = models.filter((m) => m.exists);
            if (!installed.length) setLocalHint('本地理解模型还没下载，可以先在「设置 → AI」里下一个，或临时用外部接口。');
          } catch {
            /* 忽略 */
          }
        }
      } catch {
        /* 忽略：界面上会提示未配置 */
      } finally {
        if (alive) setProviderLoaded(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    // 换文献时把上一次的上下文和输出丢掉
    setCtx(null);
    chat.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId]);

  const currentMode = useMemo(() => AI_MODES.find((m) => m.key === mode) || AI_MODES[0], [mode]);
  const busy = chat.state.status === 'loading' || chat.state.status === 'streaming';
  const text = chat.state.text || '';

  const html = useMemo(() => {
    if (!text) return '';
    try {
      return DOMPurify.sanitize(marked.parse(text));
    } catch {
      return '';
    }
  }, [text]);

  const start = async () => {
    if (!aiApi()) {
      toast('AI 能力不可用（preload 未注入）', 'error');
      return;
    }
    let context = ctx;
    if (!context) {
      try {
        context = await api.repo.context(docId);
        setCtx(context);
      } catch (err) {
        toast(err.message || '读取仓库内容失败', 'error', 6000);
        return;
      }
    }
    await chat.ask({
      messages: buildMessages(currentMode, context),
      providerId: provider ? provider.id : undefined,
      temperature: 0.3,
      maxTokens: 1400,
      mode: currentMode.key,
    });
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      toast('解析结果已复制', 'success');
    } catch {
      toast('复制失败，请手动选择文本', 'error');
    }
  };

  const saveAsNote = async () => {
    if (!text) return;
    setSaving(true);
    try {
      const title = `${(ctx && ctx.doc && ctx.doc.title) || '论文'} · 代码仓库解析（${currentMode.label}）`;
      await api.notes.create({
        title: title.slice(0, 200),
        content: text,
        htmlContent: html,
        docId,
      });
      toast('已保存为这篇文献的笔记', 'success');
    } catch (err) {
      toast(err.message || '保存失败', 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="repo-ai">
      <div className="repo-ai-head">
        <strong>AI 解析</strong>
        <span className="repo-ai-provider">
          {!providerLoaded
            ? '读取模型配置…'
            : provider
              ? provider.kind === 'local'
                ? `本地模型 · ${provider.name}`
                : `外部接口 · ${provider.name}`
              : '未配置模型（设置 → AI）'}
        </span>
      </div>

      <div className="repo-ai-modes">
        {AI_MODES.map((item) => (
          <button
            key={item.key}
            type="button"
            className={`repo-ai-mode ${mode === item.key ? 'active' : ''}`}
            onClick={() => setMode(item.key)}
            disabled={busy}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className="repo-ai-actions">
        <button type="button" className="primary-btn tiny" onClick={start} disabled={busy}>
          {busy ? '解析中…' : '🤖 开始解析'}
        </button>
        {busy ? (
          <button type="button" className="ghost-btn tiny" onClick={() => chat.abort()}>
            停止
          </button>
        ) : null}
        {text && !busy ? (
          <>
            <button type="button" className="ghost-btn tiny" onClick={copy}>
              复制
            </button>
            <button type="button" className="ghost-btn tiny" onClick={saveAsNote} disabled={saving}>
              {saving ? '保存中…' : '存为笔记'}
            </button>
          </>
        ) : null}
      </div>

      {localHint ? <div className="repo-hint">{localHint}</div> : null}

      {chat.state.error ? <div className="repo-hint repo-warn">{chat.state.error}</div> : null}

      {busy && !text ? <div className="repo-hint">正在读取仓库并生成回答…第一次调用需要加载模型，可能要等十几秒。</div> : null}

      {text ? (
        <>
          <div className="repo-ai-output markdown-body" dangerouslySetInnerHTML={{ __html: html }} />
          <div className="repo-ai-meta">
            {chat.state.model ? <span>{chat.state.model}</span> : null}
            {chat.state.ms ? <span>{(chat.state.ms / 1000).toFixed(1)}s</span> : null}
            {busy ? <span>生成中…</span> : null}
          </div>
        </>
      ) : null}

      {!text && !busy && !chat.state.error ? (
        <div className="repo-hint">
          选一个角度，让模型读一遍仓库的目录结构、README 和依赖清单再回答；结果可以存成这篇文献的笔记。
        </div>
      ) : null}
    </div>
  );
}
