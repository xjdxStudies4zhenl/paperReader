import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import logoUrl from '../assets/logo.png';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const STATE_ICON = {
  pending: '○',
  running: '◌',
  done: '✓',
  skip: '—',
  error: '!',
};

/**
 * 启动装载遮罩：数据库连上之后，直接把本地模型（翻译 / AI 理解）预热进显存，
 * 顺便用一层遮罩把「正在加载」讲清楚，避免第一次划词/理解时干等。
 *
 * - 没有安装模型时不会显示遮罩（直接进入应用）；
 * - 单个模型加载失败只会标记该步骤，不影响进入应用；
 * - 「跳过，先进入」只是把遮罩藏起来，后台仍会继续把剩下的模型装完。
 */
export default function StartupLoader({ onDone }) {
  const [visible, setVisible] = useState(false);
  const [steps, setSteps] = useState([]);
  const [elapsed, setElapsed] = useState(0);
  const doneRef = useRef(false);
  const finish = () => {
    if (doneRef.current) return;
    doneRef.current = true;
    onDone();
  };

  // 计时（纯展示）
  useEffect(() => {
    if (!visible) return undefined;
    const timer = setInterval(() => setElapsed((v) => v + 1), 1000);
    return () => clearInterval(timer);
  }, [visible]);

  // 探测 → 依次装载
  useEffect(() => {
    let alive = true;
    const update = (key, patch) =>
      setSteps((prev) => prev.map((step) => (step.key === key ? { ...step, ...patch } : step)));

    (async () => {
      try {
        /* ---------- 1) 探测需要装哪些模型 ---------- */
      const plan = [];

      let translateInfo = null;
      try {
        translateInfo = await api.translate.status();
      } catch {
        /* 数据库/服务异常时忽略，后面按未安装处理 */
      }
      const tModel = translateInfo && translateInfo.settings && translateInfo.settings.model;
      if (tModel && tModel.exists) {
        plan.push({
          key: 'translate',
          label: '翻译模型',
          detail: tModel.label || 'Hy-MT2-1.8B',
          run: () => api.translate.load({}),
        });
      } else {
        plan.push({ key: 'translate', label: '翻译模型', detail: '未下载，跳过（设置 → 翻译 可下载）', skip: true });
      }

      let provider = null;
      try {
        const data = await api.ai.providers();
        const list = (data && data.providers) || [];
        provider = list.find((p) => p.id === data.defaultId) || list[0] || null;
      } catch {
        provider = null;
      }
      let chatModel = null;
      if (provider && provider.kind === 'local') {
        try {
          const info = await api.ai.local.models();
          const list = (info && info.models) || [];
          chatModel = list.find((m) => m.id === provider.localModelId) || list[0] || null;
        } catch {
          chatModel = null;
        }
      }
      if (provider && provider.kind === 'local' && chatModel && chatModel.exists) {
        plan.push({
          key: 'chat',
          label: 'AI 理解模型',
          detail: chatModel.shortLabel || chatModel.label,
          run: () =>
            api.ai.local.load({
              localModelId: provider.localModelId,
              localPath: provider.localPath,
              gpu: provider.gpu,
              contextSize: provider.contextSize,
            }),
        });
      } else {
        plan.push({
          key: 'chat',
          label: 'AI 理解模型',
          detail: provider && provider.kind === 'local' ? '未下载，跳过（设置 → AI 模型 可下载）' : '未启用本地模型，跳过',
          skip: true,
        });
      }

      if (!alive) return;
      setSteps(plan.map((step) => ({ key: step.key, label: step.label, detail: step.detail, state: step.skip ? 'skip' : 'pending' })));

      const hasWork = plan.some((step) => !step.skip);
      if (!hasWork) {
        // 没有任何模型需要装载：不留遮罩，直接进入应用
        finish();
        return;
      }
      setVisible(true);

      /* ---------- 2) 逐个装载（顺序执行，避免显存一下子顶满） ---------- */
      for (const step of plan) {
        if (!alive) return;
        if (step.skip) continue;
        update(step.key, { state: 'running' });
        try {
          const res = await step.run();
          if (!alive) return;
          const backend = res && res.gpu ? `${res.gpu}${res.gpuDevice ? ` · ${res.gpuDevice}` : ''}` : '已就绪';
          update(step.key, { state: 'done', detail: backend });
        } catch (err) {
          if (!alive) return;
          update(step.key, { state: 'error', detail: (err && err.message) || '加载失败' });
        }
      }

      if (!alive) return;
      await sleep(450);
      if (!alive) return;
      finish();
      } catch (err) {
        console.error('[startup] 预加载模型失败', err);
      } finally {
        // 兜底：无论成功失败都收起遮罩，别把用户挡在外面
        if (alive) finish();
      }
    })();

    return () => {
      // 只中止本轮的 UI 更新；不要在这里调用 onDone（StrictMode 会 mount→unmount→mount，
      // 否则遮罩会被第一次卸载立刻关掉）
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!visible) return null;

  const total = steps.length || 1;
  const doneCount = steps.filter((step) => step.state === 'done' || step.state === 'skip' || step.state === 'error').length;
  const percent = Math.round((doneCount / total) * 100);

  return (
    <div className="startup-mask">
      <div className="startup-box">
        <img className="startup-logo" src={logoUrl} alt="文献阅读器" draggable={false} />
        <h1 className="startup-title">正在初始化文献阅读器</h1>
        <p className="startup-hint">
          首次启动会把本地模型预热进显存，通常几秒到几十秒；装好后翻译、AI 理解都会更快。
        </p>

        <div className="startup-bar">
          <span style={{ width: `${percent}%` }} />
        </div>

        <ul className="startup-steps">
          {steps.map((step) => (
            <li key={step.key} className={`startup-step ${step.state}`}>
              <span className="startup-step-icon">{STATE_ICON[step.state] || '○'}</span>
              <span className="startup-step-label">{step.label}</span>
              <span className="startup-step-detail" title={step.detail}>
                {step.detail}
              </span>
            </li>
          ))}
        </ul>

        <div className="startup-foot">
          <span className="startup-elapsed">已用 {elapsed}s</span>
          <button className="ghost-btn small" onClick={() => setVisible(false)}>
            跳过，先进入
          </button>
        </div>
      </div>
    </div>
  );
}
