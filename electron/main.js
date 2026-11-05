'use strict';
/**
 * 应用主进程入口。
 * - 注册 app:// 自定义协议承载渲染进程打包产物（保证 Web Worker / ES Module 可用）
 * - 创建主窗口、装配 IPC
 */
const { app, BrowserWindow, protocol, shell, Menu } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { registerIpc } = require('./ipc');
const db = require('./db');
const { readConfig, configExists } = require('./config');
const { reorganizeLibrary } = require('./library');

const isDev = process.env.PR_DEV_SERVER === '1';
const devServerUrl = process.env.PR_DEV_URL || 'http://127.0.0.1:5178';
const distDir = path.join(__dirname, '..', 'dist');

/**
 * 应用显示名改成「文献阅读器」后，Electron 默认会把 userData 目录一起改名，
 * 那样会读不到已有的 db-config.json / library。这里显式固定到旧目录，保证升级无损。
 */
app.setPath('userData', path.join(app.getPath('appData'), 'paper-reader'));

// app:// 必须注册为特权协议，否则模块、Worker、fetch 都会受限
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true,
    },
  },
]);

/** 把 app://bundle/<path> 映射到 dist 目录 */
function registerAppProtocol() {
  protocol.handle('app', async (request) => {
    const url = new URL(request.url);
    let rel = decodeURIComponent(url.pathname || '/');
    if (!rel || rel === '/') rel = '/index.html';
    const target = path.normalize(path.join(distDir, rel));
    if (!target.startsWith(distDir)) {
      return new Response('Forbidden', { status: 403 });
    }
    try {
      const data = await fs.promises.readFile(target);
      return new Response(data, {
        status: 200,
        headers: { 'Content-Type': contentType(target) },
      });
    } catch {
      return new Response('Not Found', { status: 404 });
    }
  });
}

function contentType(file) {
  const ext = path.extname(file).toLowerCase();
  switch (ext) {
    case '.html': return 'text/html; charset=utf-8';
    case '.js':
    case '.mjs': return 'text/javascript; charset=utf-8';
    case '.css': return 'text/css; charset=utf-8';
    case '.json': return 'application/json; charset=utf-8';
    case '.svg': return 'image/svg+xml';
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.woff': return 'font/woff';
    case '.woff2': return 'font/woff2';
    case '.ttf': return 'font/ttf';
    case '.bcmap': return 'application/octet-stream';
    case '.pfb': return 'application/octet-stream';
    default: return 'application/octet-stream';
  }
}

let mainWindow = null;

/** 窗口图标：打包后取 dist/logo.png（public 资源会被 vite 拷到 dist 根） */
function appIconPath() {
  const candidates = [
    path.join(distDir, 'logo.png'),
    path.join(__dirname, '..', 'public', 'logo.png'),
    path.join(process.resourcesPath || '', 'app.asar.unpacked', 'build', 'icon.png'),
  ];
  return candidates.find((candidate) => {
    try {
      return fs.existsSync(candidate);
    } catch {
      return false;
    }
  });
}

function createWindow() {
  const icon = appIconPath();
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 960,
    minWidth: 1080,
    minHeight: 680,
    show: false,
    backgroundColor: '#11131a',
    title: '文献阅读器',
    ...(icon ? { icon } : {}),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      webSecurity: true,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());

  // 外部链接交给系统浏览器
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  if (!isDev && !fs.existsSync(path.join(distDir, 'index.html'))) {
    // 常见误用：没 build 直接 `electron .`，会得到一个 app:// 的 Not Found 白页
    console.error('[main] 未找到 dist/index.html，请先执行 npm run build（或 npm start）');
    mainWindow.loadURL(
      'data:text/html;charset=utf-8,' +
        encodeURIComponent(
          '<body style="background:#11131a;color:#e6e8ee;font:14px/1.7 system-ui;padding:48px">' +
            '<h2>渲染进程产物缺失</h2>' +
            '<p>未找到 <code>dist/index.html</code>，请先在项目根目录执行：</p>' +
            '<pre style="background:#1b1f2b;padding:12px;border-radius:8px">npm run build\nnpm run app</pre>' +
            '<p>或使用 <code>npm start</code>（会先构建再启动）。</p>' +
            '</body>'
        )
    );
    return mainWindow;
  }

  const target = isDev ? devServerUrl : 'app://bundle/index.html';
  mainWindow.loadURL(target);

  if (process.env.PR_OPEN_DEVTOOLS === '1') {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  // 冒烟测试模式：截图后自动退出（CI / 本地自检用）
  if (process.env.PR_SMOKE === '1') {
    mainWindow.webContents.on('console-message', (...args) => {
      const detail = args[0] && typeof args[0] === 'object' && 'message' in args[0] ? args[0] : null;
      const message = detail ? detail.message : args[2];
      if (message && /moveDoc|dnd/i.test(String(message))) console.log('[renderer]', String(message));
    });
    mainWindow.webContents.once('did-finish-load', async () => {
      const outDir = process.env.PR_SMOKE_OUT || path.join(app.getPath('userData'), 'smoke');
      fs.mkdirSync(outDir, { recursive: true });
      const shot = async (name) => {
        const image = await mainWindow.webContents.capturePage();
        fs.writeFileSync(path.join(outDir, name), image.toPNG());
        console.log('[smoke] 截图：', path.join(outDir, name));
      };
      try {
        await new Promise((r) => setTimeout(r, 2500));
        await shot('01-library.png');
        if (process.env.PR_SMOKE_ACTION === 'settings') {
          const click = (sel, text) =>
            mainWindow.webContents.executeJavaScript(`(() => {
              const nodes = [...document.querySelectorAll(${JSON.stringify(sel)})];
              const hit = nodes.find((n) => (n.textContent || '').includes(${JSON.stringify(text)}));
              if (hit) hit.click();
              return Boolean(hit);
            })()`);
          const opened = await click('.sidebar-footer .nav-item', '设置');
          console.log('[smoke] 打开设置中心：', opened);
          await new Promise((r) => setTimeout(r, 500));
          await shot('11-settings-dark.png');
          await click('.settings-nav-item', '存储');
          await new Promise((r) => setTimeout(r, 500));
          await shot('12-storage-dark.png');
          await click('.settings-nav-item', '外观');
          await new Promise((r) => setTimeout(r, 300));
          await click('.theme-card', '亮色');
          await new Promise((r) => setTimeout(r, 700));
          await shot('13-settings-light.png');
          await click('.settings-nav-item', '存储');
          await new Promise((r) => setTimeout(r, 500));
          await shot('14-storage-light.png');
          await click('.settings-nav-item', '数据库');
          await new Promise((r) => setTimeout(r, 500));
          await shot('15-database-light.png');
          await click('.settings-nav-item', '关于');
          await new Promise((r) => setTimeout(r, 500));
          await shot('16-about-light.png');
          await click('.settings-nav-item', '翻译');
          await new Promise((r) => setTimeout(r, 800));
          await shot('19-translate-settings.png');
          await click('.modal-head .icon-btn', '✕');
          await new Promise((r) => setTimeout(r, 600));
          await shot('17-library-light.png');
          const backToDark = await click('.sidebar-footer .nav-item', '切换到暗色');
          console.log('[smoke] 切回暗色：', backToDark);
          await new Promise((r) => setTimeout(r, 500));
          await shot('18-library-dark.png');
        }
        if (process.env.PR_SMOKE_ACTION === 'model-prompt') {
          const clickByText = (sel, text) =>
            mainWindow.webContents.executeJavaScript(`(() => {
              const nodes = [...document.querySelectorAll(${JSON.stringify(sel)})];
              const hit = nodes.find((n) => (n.textContent || '').includes(${JSON.stringify(text)}));
              if (hit) hit.click();
              return Boolean(hit);
            })()`);
          // 清掉「不再提示」，让引导重新出现
          await mainWindow.webContents.executeJavaScript("localStorage.removeItem('pr.modelPrompt')");
          await mainWindow.webContents.executeJavaScript('location.reload()');
          await new Promise((r) => setTimeout(r, 4000));
          const seen = await mainWindow.webContents.executeJavaScript(
            "Boolean(document.querySelector('.install-modal'))"
          );
          console.log('[smoke:prompt] 引导出现：', seen);
          await shot('40-model-prompt.png');
          if (process.env.PR_SMOKE_DOWNLOAD !== '1') {
            console.log('[smoke:prompt] 跳过下载测试');
          } else {
            const started = await clickByText('.install-modal .primary-btn', '下载并安装');
            console.log('[smoke:prompt] 开始下载：', started);
            await new Promise((r) => setTimeout(r, 6000));
            const progress = await mainWindow.webContents.executeJavaScript(
              "(() => { const el = document.querySelector('.install-progress-meta'); return el ? el.textContent.replace(/\\s+/g, ' ') : 'none'; })()"
            );
            console.log('[smoke:prompt] 进度：', progress);
            await shot('41-model-downloading.png');
            const cancelled = await clickByText('.install-modal .ghost-btn', '取消下载');
            console.log('[smoke:prompt] 取消：', cancelled);
            await new Promise((r) => setTimeout(r, 1200));
            await shot('42-model-cancelled.png');
          }
        }
        if (process.env.PR_SMOKE_ACTION === 'translate-ui') {
          await mainWindow.webContents.executeJavaScript(
            `window.pr.translate.saveSettings({ modelId: ${JSON.stringify(process.env.PR_SMOKE_MODEL || 'hy-mt2-1.8b-q4km')} })`
          );
          await mainWindow.webContents.executeJavaScript(
            "(() => { const card = document.querySelector('.doc-card'); if (card) card.click(); return true; })()"
          );
          await new Promise((r) => setTimeout(r, 6000));
          const steps = await mainWindow.webContents.executeJavaScript(`(async () => {
            const out = [];
            const toolBtn = [...document.querySelectorAll('.tool-btn')].find((b) => (b.textContent || '').includes('划译'));
            if (toolBtn) toolBtn.click();
            out.push(['选择划译工具', Boolean(toolBtn)]);
            await new Promise((r) => setTimeout(r, 300));
            const page = document.querySelector('.pdf-page');
            if (!page) return JSON.stringify([...out, ['页面', 'no-page']]);
            const spans = [...page.querySelectorAll('.text-layer span')].filter((s) => (s.textContent || '').trim().length > 3);
            if (spans.length < 2) return JSON.stringify([...out, ['文本层', 'spans=' + spans.length]]);
            const range = document.createRange();
            range.setStart(spans[0].firstChild, 0);
            const endNode = spans[Math.min(2, spans.length - 1)].firstChild;
            range.setEnd(endNode, Math.min(40, (endNode.textContent || '').length));
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
            out.push(['选中文本', sel.toString().slice(0, 60)]);
            page.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
            await new Promise((r) => setTimeout(r, 1500));
            out.push(['浮层出现', Boolean(document.querySelector('.translate-pop'))]);
            await new Promise((r) => setTimeout(r, 9000));
            const result = document.querySelector('.translate-result');
            out.push(['译文', result ? (result.textContent || '').slice(0, 120) : 'none']);
            return JSON.stringify(out, null, 1);
          })()`);
          console.log('[smoke:tr-ui]', steps);
          await shot('32-translate-popover.png');
        }
        if (process.env.PR_SMOKE_ACTION === 'translate') {
          const text = process.env.PR_SMOKE_TEXT || 'Attention is all you need.';
          const out = await mainWindow.webContents.executeJavaScript(`(async () => {
            const log = [];
            window.__chunks = [];
            window.pr.translate.onChunk((c) => window.__chunks.push(c.text));
            log.push(['status', JSON.stringify(await window.pr.translate.status())]);
            const modelId = ${JSON.stringify(process.env.PR_SMOKE_MODEL || '')};
            try {
              const loaded = await window.pr.translate.load(modelId ? { modelId } : {});
              log.push(['load', JSON.stringify({ state: loaded.state, gpu: loaded.gpu, device: loaded.gpuDevice, model: loaded.modelPath })]);
            } catch (err) {
              log.push(['load-error', err && err.message]);
              return JSON.stringify(log, null, 1);
            }
            try {
              const t0 = Date.now();
              const res = await window.pr.translate.text({ requestId: 'smoke-tr-1', text: ${JSON.stringify(text)}, target: 'zh' });
              log.push(['translate', JSON.stringify({ text: res.text, ms: res.ms, wallMs: Date.now() - t0, chunks: window.__chunks.length })]);
            } catch (err) {
              log.push(['translate-error', err && err.message]);
            }
            return JSON.stringify(log, null, 1);
          })()`);
          console.log('[smoke:tr]', out);
          await shot('31-translate.png');
        }
        if (process.env.PR_SMOKE_ACTION === 'layout-dry' || process.env.PR_SMOKE_ACTION === 'layout-run') {
          const dryRun = process.env.PR_SMOKE_ACTION === 'layout-dry';
          const plan = await mainWindow.webContents.executeJavaScript(
            `window.pr.storage.reorganize({ dryRun: ${dryRun} }).then((r) => JSON.stringify(r, null, 1))`
          );
          console.log('[smoke:layout]', dryRun ? '试运行' : '已执行', plan);
        }
        if (process.env.PR_SMOKE_ACTION === 'dump') {
          const dumped = await mainWindow.webContents.executeJavaScript(`(async () => JSON.stringify({
            folders: (await window.pr.folders.list()).map((f) => [f.id, f.name, f.doc_count]),
            docs: (await window.pr.docs.list({})).map((d) => [d.id, d.folder_id, d.folder_name, d.file_name, d.stored_path, d.orig_name]),
            storage: await window.pr.storage.info(),
          }, null, 1))()`);
          console.log('[smoke:dump]', dumped);
        }
        if (process.env.PR_SMOKE_ACTION === 'dnd') {
          const run = (expr) => mainWindow.webContents.executeJavaScript(expr);
          // 步骤 1：准备分类 + 触发 dragstart/dragover，观察投放高亮
          const prepare = `(async () => {
            const api = window.pr;
            const folders = await api.folders.list();
            if (!folders.length) {
              await api.folders.create('拖拽测试');
              location.reload();
              return 'reloading';
            }
            const folder = folders[0];
            const docs = await api.docs.list({ sort: 'created' });
            if (!docs.length) return 'no-docs';
            const doc = docs.find((d) => String(d.folder_id || '') !== String(folder.id)) || docs[0];
            const dt = new DataTransfer();
            dt.setData('application/x-pr-doc', String(doc.id));
            window.__prDnd = { dt, docId: doc.id, folderId: folder.id, folderName: folder.name };
            const card = document.querySelector('[data-doc-id="' + doc.id + '"]') || document.querySelector('.doc-card');
            card.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
            await new Promise((r) => setTimeout(r, 150));
            const target = [...document.querySelectorAll('.side-row .nav-item')].find((b) =>
              (b.textContent || '').includes(folder.name)
            );
            if (!target) return 'no-target';
            window.__prDnd.target = folder.name;
            target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
            await new Promise((r) => setTimeout(r, 250));
            return JSON.stringify({
              folder: folder.name,
              docId: doc.id,
              hint: Boolean(document.querySelector('.side-drop-hint')),
              hovered: [...document.querySelectorAll('.nav-item.drop-hover')].map((n) => (n.textContent || '').trim()),
              dragging: Boolean(document.querySelector('.doc-card.dragging')),
            });
          })()`;
          let prepared = await run(prepare);
          console.log('[smoke:dnd] 准备：', prepared);
          console.log(
            '[smoke:dnd] 现状：',
            await run(`(async () => JSON.stringify({
              folders: (await window.pr.folders.list()).map((f) => [f.id, f.name, f.doc_count]),
              docs: (await window.pr.docs.list({})).map((d) => [d.id, d.title.slice(0, 12), d.folder_id, d.folder_name]),
            }))()`)
          );
          if (prepared === 'reloading') {
            await new Promise((r) => setTimeout(r, 3000));
            prepared = await run(prepare);
            console.log('[smoke:dnd] 准备(重载后)：', prepared);
          }
          await shot('20-dnd-hover.png');

          // 步骤 2：真正 drop，验证数据库里的分组变了
          const dropped = await run(`(async () => {
            const { dt, docId, folderId } = window.__prDnd;
            const name = window.__prDnd.folderName;
            const calls = [];
            const orig = window.pr.docs.update;
            window.pr.docs.update = async (id, patch) => {
              try {
                const r = await orig(id, patch);
                calls.push({ id, patch, retFolder: r && r.folder_id });
                return r;
              } catch (err) {
                calls.push({ id, patch, error: err && err.message });
                throw err;
              }
            };
            const target = [...document.querySelectorAll('.side-row .nav-item')].find((b) =>
              (b.textContent || '').includes(name)
            );
            target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
            await new Promise((r) => setTimeout(r, 2500));
            const after = await window.pr.docs.get(docId);
            window.pr.docs.update = orig;
            return JSON.stringify({
              expectFolderId: folderId,
              docId,
              folder_id: after.folder_id,
              folder_name: after.folder_name,
              calls,
              toasts: [...document.querySelectorAll('.toast')].map((t) => (t.textContent || '').trim()),
            });
          })()`);
          console.log('[smoke:dnd] 移动到分类：', dropped);
          await shot('21-dnd-moved.png');

          // 步骤 3：再拖到「未分类」，验证可以移出分组（同一条文献，直接构造 payload）
          const cleared = await run(`(async () => {
            const { docId } = window.__prDnd;
            const dt = new DataTransfer();
            dt.setData('application/x-pr-doc', String(docId));
            const target = [...document.querySelectorAll('.side-section .nav-item.small')].find((b) =>
              (b.textContent || '').includes('未分类')
            );
            target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
            await new Promise((r) => setTimeout(r, 150));
            target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
            await new Promise((r) => setTimeout(r, 2500));
            const after = await window.pr.docs.get(docId);
            return JSON.stringify({ folder_id: after.folder_id, folder_name: after.folder_name });
          })()`);
          console.log('[smoke:dnd] 移出分类：', cleared);
          await shot('22-dnd-cleared.png');
        }
        if (process.env.PR_SMOKE_ACTION && !['dnd', 'detail'].includes(process.env.PR_SMOKE_ACTION)) {
          await mainWindow.webContents.executeJavaScript(
            "(() => { const card = document.querySelector('.doc-card'); if (card) { card.click(); return true; } return false; })()"
          );
          await new Promise((r) => setTimeout(r, 5000));
          await shot('02-reader.png');
        }
        if (process.env.PR_SMOKE_ACTION === 'detail') {
          const opened = await mainWindow.webContents.executeJavaScript(
            "(() => { const btn = [...document.querySelectorAll('.link-btn')].find((b) => b.textContent.includes('详情')); if (btn) { btn.click(); return true; } return false; })()"
          );
          console.log('[smoke] 打开详情：', opened);
          await new Promise((r) => setTimeout(r, 800));
          await shot('04-detail.png');
        }
        if (process.env.PR_SMOKE_ACTION === 'annotate') {
          await mainWindow.webContents.executeJavaScript(`(() => {
            const tool = [...document.querySelectorAll('.tool-btn')].find((b) => b.textContent.includes('高亮'));
            if (tool) tool.click();
            return Boolean(tool);
          })()`);
          await new Promise((r) => setTimeout(r, 500));
          const result = await mainWindow.webContents.executeJavaScript(`(() => {
            const page = document.querySelector('.pdf-page');
            if (!page) return 'no-page';
            const spans = page.querySelectorAll('.text-layer span');
            if (spans.length < 5) return 'no-spans:' + spans.length;
            const range = document.createRange();
            const startNode = spans[3].firstChild;
            const endNode = spans[4].firstChild;
            if (!startNode || !endNode) return 'no-text-node';
            range.setStart(startNode, 0);
            range.setEnd(endNode, Math.min(12, endNode.textContent.length));
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
            page.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
            return 'ok:' + sel.toString().slice(0, 40);
          })()`);
          console.log('[smoke] 标注脚本：', result);
          await new Promise((r) => setTimeout(r, 2500));
          await shot('03-annotated.png');
        }
      } catch (err) {
        console.error('[smoke] 失败：', err);
      } finally {
        app.quit();
      }
    });
  }

  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    console.error('[main] 渲染进程异常退出', details);
  });

  return mainWindow;
}

/**
 * 首次启动（或升级后首次启动）把文库整理成「分类目录 + 原始文件名」布局。
 * 用 pr_setting_info 里的标记保证只跑一次；失败不影响启动，可在设置里手动重跑。
 */
async function ensureLibraryLayout() {
  if (process.env.PR_SKIP_LIBRARY_LAYOUT === '1') {
    console.log('[main] 跳过文库整理（PR_SKIP_LIBRARY_LAYOUT=1）');
    return;
  }
  try {
    const done = await db.queryOne(
      "SELECT setting_value FROM pr_setting_info WHERE setting_key = 'library_layout_v2'"
    );
    if (done && String(done.setting_value) === '1') return;
    const summary = await reorganizeLibrary();
    await db.execute(
      `INSERT INTO pr_setting_info (setting_key, setting_value) VALUES ('library_layout_v2', '1')
       ON DUPLICATE KEY UPDATE setting_value = '1'`
    );
    console.log('[main] 文库已整理为「分类目录 + 原文件名」：', {
      total: summary.total,
      moved: summary.moved,
      unchanged: summary.unchanged,
      failed: summary.failed.length,
    });
  } catch (err) {
    console.warn('[main] 文库整理失败（可在设置→存储里手动整理）：', err && err.message);
  }
}

app.whenReady().then(async () => {
  // Windows / Linux 去掉 Electron 默认菜单：它的「关闭」绑着 Ctrl+W，
  // 会和阅读器的「关闭当前标签」冲突，误按会把整个窗口关掉。
  // macOS 保留菜单（Cmd+C/V 等系统快捷键依赖它）。
  if (process.platform !== 'darwin') Menu.setApplicationMenu(null);
  registerAppProtocol();
  registerIpc(() => mainWindow);
  console.log('[main] userData =', app.getPath('userData'));
  createWindow();

  // 启动时尝试自动连接数据库（失败不阻塞，界面会引导用户去设置）
  // 只有用户已经保存过连接配置才自动连库，否则首启会一直用默认空密码重试并报 Access denied
  if (!configExists()) {
    console.log('[main] 尚未保存数据库配置，跳过自动连接，等待首启引导');
  } else {
    const cfg = readConfig();
    try {
      await db.init(cfg);
      console.log('[main] MySQL 已连接：', db.status());
      await ensureLibraryLayout();
    } catch (err) {
      console.warn('[main] MySQL 连接失败：', err.message);
    }
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', async () => {
  await db.close().catch(() => {});
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', async () => {
  await db.close().catch(() => {});
});
