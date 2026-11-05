/** 渲染进程侧的统一 API 封装（真正的实现在 electron/preload.js） */
const raw = window.pr;

if (!raw) {
  // 帮助定位：直接浏览器打开 dist/index.html 时没有 preload
  console.error('未检测到 preload 暴露的 window.pr，请通过 Electron 启动应用');
}

export const api = raw;

/** 轻量提示（不依赖 React 上下文） */
const toastListeners = new Set();

export function toast(message, type = 'info', timeout = 3200) {
  const item = { id: `${Date.now()}-${Math.random()}`, message, type };
  toastListeners.forEach((fn) => fn(item));
  if (timeout > 0) {
    setTimeout(() => {
      toastListeners.forEach((fn) => fn({ ...item, dismiss: true }));
    }, timeout);
  }
}

export function subscribeToast(fn) {
  toastListeners.add(fn);
  return () => toastListeners.delete(fn);
}

/** 统一错误处理：把异常转成提示，避免界面白屏 */
export async function guard(fn, failMessage = '操作失败') {
  try {
    return await fn();
  } catch (err) {
    console.error(err);
    toast(err && err.message ? err.message : failMessage, 'error');
    return undefined;
  }
}

export function formatBytes(size) {
  const num = Number(size) || 0;
  if (num < 1024) return `${num} B`;
  if (num < 1024 * 1024) return `${(num / 1024).toFixed(1)} KB`;
  return `${(num / 1024 / 1024).toFixed(1)} MB`;
}

export function formatDate(value) {
  if (!value) return '—';
  const date = new Date(String(value).replace(' ', 'T'));
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString('zh-CN', { hour12: false });
}
