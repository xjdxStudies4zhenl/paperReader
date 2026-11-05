/**
 * 主题（亮 / 暗 / 跟随系统）。
 * 渲染进程本地持久化（localStorage），通过 <html data-theme> 驱动 CSS 变量。
 */
import { useCallback, useEffect, useState } from 'react';

const STORAGE_KEY = 'pr.theme';
const EVENT = 'pr:theme-change';
export const THEME_OPTIONS = [
  { key: 'system', label: '跟随系统', icon: '🖥', desc: '随 Windows 明暗模式自动切换' },
  { key: 'light', label: '亮色', icon: '☀', desc: '适合白天的浅色界面' },
  { key: 'dark', label: '暗色', icon: '🌙', desc: '默认的深色阅读界面' },
];
const VALID = THEME_OPTIONS.map((o) => o.key);

export function getStoredTheme() {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return VALID.includes(value) ? value : 'dark';
  } catch {
    return 'dark';
  }
}

function systemPrefersLight() {
  try {
    return window.matchMedia('(prefers-color-scheme: light)').matches;
  } catch {
    return false;
  }
}

export function resolveTheme(pref = getStoredTheme()) {
  if (pref === 'light' || pref === 'dark') return pref;
  return systemPrefersLight() ? 'light' : 'dark';
}

/** 把主题写到 <html>，CSS 里的 [data-theme='light'] 才会生效 */
export function applyTheme(pref = getStoredTheme()) {
  const resolved = resolveTheme(pref);
  const root = document.documentElement;
  root.dataset.theme = resolved;
  root.dataset.themePref = pref;
  root.style.colorScheme = resolved;
  return resolved;
}

export function setTheme(pref) {
  const next = VALID.includes(pref) ? pref : 'dark';
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    /* 隐私模式等场景下忽略持久化失败 */
  }
  applyTheme(next);
  window.dispatchEvent(new CustomEvent(EVENT, { detail: next }));
  return next;
}

export function toggleTheme() {
  const resolved = resolveTheme(getStoredTheme());
  return setTheme(resolved === 'light' ? 'dark' : 'light');
}

/** 在首帧前调用，避免启动闪一下暗色 */
applyTheme(getStoredTheme());

export function useTheme() {
  const [pref, setPref] = useState(getStoredTheme);
  const [resolved, setResolved] = useState(() => resolveTheme(getStoredTheme()));

  useEffect(() => {
    const onLocal = (event) => {
      setPref(event.detail);
      setResolved(resolveTheme(event.detail));
    };
    window.addEventListener(EVENT, onLocal);
    return () => window.removeEventListener(EVENT, onLocal);
  }, []);

  // 跟随系统时，监听系统明暗模式变化
  useEffect(() => {
    if (pref !== 'system') return undefined;
    let mq;
    try {
      mq = window.matchMedia('(prefers-color-scheme: light)');
    } catch {
      return undefined;
    }
    const onChange = () => setResolved(applyTheme('system'));
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [pref]);

  const update = useCallback((next) => {
    setTheme(next);
    setPref(next);
    setResolved(resolveTheme(next));
  }, []);

  return { pref, resolved, setTheme: update, toggle: toggleTheme };
}
