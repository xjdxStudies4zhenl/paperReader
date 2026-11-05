'use strict';
/**
 * 「AI 理解」的提示词。
 * 统一约定：让模型输出中文、不用客套话、保留原文术语（英文术语保留原词）。
 */

const SYSTEM_BASE = [
  '你是一位严谨的科研助手，服务于正在精读英文论文的中文研究者。',
  '请用简体中文回答，语言简洁直接，不要寒暄，不要重复用户原话。',
  '专业术语保留英文原词（可用「中文（English）」的形式），公式用行内 LaTeX 写法。',
  '不确定的地方明确说“不确定”，不要编造数据、引用或结论。',
].join('');

const MODES = {
  explain: {
    label: '解释这段',
    hint: '逐句讲清这段话在说什么',
    build: (text) => [
      { role: 'system', content: SYSTEM_BASE },
      {
        role: 'user',
        content: [
          '请解释下面这段论文原文：',
          '1) 先用 2-3 句概括它想说明什么；',
          '2) 再逐句说明关键概念和方法；',
          '3) 如果涉及公式或符号，逐个解释其含义；',
          '4) 最后用一句话说明这它在全文中的位置/作用（若能判断）。',
          '',
          '原文：',
          text,
        ].join('\n'),
      },
    ],
  },
  simple: {
    label: '通俗讲',
    hint: '用外行也能懂的话讲一遍',
    build: (text) => [
      { role: 'system', content: SYSTEM_BASE },
      {
        role: 'user',
        content: [
          '请把下面这段论文内容讲给一个同领域但非本方向的研究生听：',
          '先用一个生活化的类比解释核心思想，再说明它解决什么问题、怎么做的、效果如何。不要超过 400 字。',
          '',
          '原文：',
          text,
        ].join('\n'),
      },
    ],
  },
  keypoints: {
    label: '提炼要点',
    hint: '压成可粘贴的要点清单',
    build: (text) => [
      { role: 'system', content: SYSTEM_BASE },
      {
        role: 'user',
        content: [
          '请把下面这段内容整理成要点清单（Markdown 无序列表）：',
          '每条一句话，只保留事实与结论，去掉举例和修辞。最多 6 条。',
          '',
          '原文：',
          text,
        ].join('\n'),
      },
    ],
  },
  translate: {
    label: '翻译 + 解释',
    hint: '先直译，再解释难点',
    build: (text) => [
      { role: 'system', content: SYSTEM_BASE },
      {
        role: 'user',
        content: [
          '请处理下面这段论文原文：',
          '第 1 部分：忠于原文的中文翻译；',
          '第 2 部分：挑出 2-3 个最容易读错的术语/句型，说明为什么这样理解。',
          '',
          '原文：',
          text,
        ].join('\n'),
      },
    ],
  },
  critique: {
    label: '找问题',
    hint: '站在审稿人角度挑刺',
    build: (text) => [
      { role: 'system', content: SYSTEM_BASE },
      {
        role: 'user',
        content: [
          '请以同行评审的角度审视下面这段内容：',
          '指出其中可能的假设、局限、实验设计漏洞或表述含糊之处，并给出改进建议。',
          '如果内容本身没问题，就直接说“没有明显问题”，不要硬找。',
          '',
          '原文：',
          text,
        ].join('\n'),
      },
    ],
  },
};

/** 追问：把理解上下文一起带上，保证是“接着刚才说” */
function buildFollowUp({ mode, quote, answer, question }) {
  const context = [
    quote ? `原文片段：\n${quote}` : '',
    answer ? `此前的解释：\n${answer.slice(-2000)}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
  return [
    { role: 'system', content: SYSTEM_BASE },
    {
      role: 'user',
      content: `${context}\n\n我的问题：${question}\n\n请紧扣上面的原文回答，必要时指出我的理解哪里偏了。`,
    },
  ];
}

/** 整篇理解：用标题/作者/摘要 + 正文片段做结构化摘要 */
function buildSummary({ title, authors, year, journal, text, language = 'zh' }) {
  const meta = [title && `标题：${title}`, authors && `作者：${authors}`, year && `年份：${year}`, journal && `期刊：${journal}`]
    .filter(Boolean)
    .join('\n');
  return [
    {
      role: 'system',
      content: `${SYSTEM_BASE}\n输出使用 Markdown，小标题用「### 」。`,
    },
    {
      role: 'user',
      content: [
        '请阅读下面这篇论文的文本，输出结构化理解，包含四个部分：',
        '### 一句话结论\n### 研究问题与动机\n### 方法与关键设计\n### 主要结果与局限',
        '每部分 2-4 句，务必基于给定文本，不要引入外部知识。',
        language && language !== 'zh' ? `（如原文为${language}，仍用中文输出）` : '',
        '',
        meta,
        '',
        '正文：',
        text,
      ]
        .filter(Boolean)
        .join('\n'),
    },
  ];
}

function buildMessages(payload = {}) {
  const { mode = 'explain', text = '', question, quote, answer } = payload;
  if (question && String(question).trim()) {
    return buildFollowUp({ mode, quote: quote || text, answer, question: String(question).trim() });
  }
  if (mode === 'summary') return buildSummary(payload);
  const preset = MODES[mode] || MODES.explain;
  const body = String(text || '').trim();
  if (!body) throw new Error('没有可分析的内容');
  return preset.build(body);
}

function listModes() {
  return Object.entries(MODES).map(([key, value]) => ({ key, label: value.label, hint: value.hint }));
}

module.exports = { buildMessages, listModes, MODES };
