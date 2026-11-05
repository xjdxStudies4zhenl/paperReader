import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import PdfPage from '../pdf/PdfPage.jsx';
import { loadPdfDocument } from '../pdf/pdfjs.js';
import { searchInPdf } from '../pdf/search.js';
import { buildPageBlocks } from '../pdf/page-translate.js';
import { api, guard, toast } from '../api.js';
import AnnotationPanel from './AnnotationPanel.jsx';
import TranslatePopover from './TranslatePopover.jsx';
import AiPanel from './AiPanel.jsx';
import SelectionBubble from './SelectionBubble.jsx';
import DocNoteDialog from './DocNoteDialog.jsx';
import { useTranslation } from '../translate.js';

export const HIGHLIGHT_COLORS = [
  { value: '#ffd400', label: '经典黄' },
  { value: '#ff4d4f', label: '重点红' },
  { value: '#ff9f43', label: '强调橙' },
  { value: '#52c41a', label: '结论绿' },
  { value: '#5b8def', label: '参考蓝' },
  { value: '#c56cf0', label: '灵感紫' },
];

const TOOLS = [
  { value: 'text', label: '选择', icon: '🖱', hint: '拖选文字后，选区旁会出现「翻译 / 理解」浮条' },
  { value: 'highlight', label: '高亮', icon: '🖍', hint: '选中文字即生成高亮，配合色板可标红' },
  { value: 'underline', label: '下划线', icon: '▁', hint: '选中文字加下划线' },
  { value: 'strike', label: '删除线', icon: '⌁', hint: '选中文字加删除线' },
  { value: 'box', label: '框选', icon: '▭', hint: '拖拽画出矩形框，适合框住图表' },
  { value: 'ink', label: '手绘', icon: '✏', hint: '按住鼠标自由书写' },
  { value: 'note', label: '便签', icon: '📌', hint: '点击页面放置便签' },
  { value: 'anno', label: '批注', icon: '👆', hint: '点击已有批注查看/编辑' },
];

/** 打开文献时的默认缩放：130% */
export const DEFAULT_SCALE = 1.3;

export default function Reader({
  docId,
  /** 返回文献库首页（隐藏阅读器，标签页保留在缓存里） */
  onGoHome,
  /** 渲染左侧菜单内容：(utils) => ReactNode；utils.close() 关闭抽屉 */
  renderSidebar,
  onDocChanged,
  /** 多标签：只有当前标签响应快捷键与渲染标签条 */
  active = true,
  tabs = [],
  onSelectTab,
  onCloseTab,
  onOpenDoc,
}) {
  const [doc, setDoc] = useState(null);
  const [pdfDoc, setPdfDoc] = useState(null);
  const [annos, setAnnos] = useState([]);
  const [tool, setTool] = useState('text');
  const [color, setColor] = useState('#ffd400');
  const [scale, setScale] = useState(DEFAULT_SCALE);
  const [currentPage, setCurrentPage] = useState(1);
  const [selectedId, setSelectedId] = useState(null);
  const [editing, setEditing] = useState(null);
  const [panelOpen, setPanelOpen] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [exporting, setExporting] = useState('');
  /** 划词翻译：当前选区与目标语言 */
  const [selection, setSelection] = useState(null);
  const [targetLang, setTargetLang] = useState('zh');
  const translation = useTranslation();
  /** 划词浮条：正常拖选文字后出现，不改变当前工具 */
  const [selBubble, setSelBubble] = useState(null);
  /** AI 理解：划词面板 / 整篇摘要，payload 交给 AiPanel */
  const [aiTarget, setAiTarget] = useState(null);
  const [summarizing, setSummarizing] = useState(false);
  /** Ctrl+F 全文搜索 */
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchHits, setSearchHits] = useState([]);
  const [searchIdx, setSearchIdx] = useState(0);
  const [searching, setSearching] = useState(false);
  /** 一键翻译：译文原位替换 */
  const [trMode, setTrMode] = useState(false);
  const [trSegments, setTrSegments] = useState({});
  const [trStatus, setTrStatus] = useState({ state: 'idle', done: 0, total: 0 });

  const scrollRef = useRef(null);
  const pageRefs = useRef({});
  const currentPageRef = useRef(1);
  const saveTimer = useRef(null);
  const searchInputRef = useRef(null);
  const searchTokenRef = useRef(0);
  const lastScrollHitRef = useRef('');
  const trSegmentsRef = useRef({});
  const trCancelRef = useRef(false);
  const runTranslateDocRef = useRef(null);
  /** 打开另一篇文献的选择器 */
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerDocs, setPickerDocs] = useState([]);
  const [pickerQuery, setPickerQuery] = useState('');
  const [pickerLoading, setPickerLoading] = useState(false);
  /** 工具栏「更多操作」下拉菜单（导出 / AI / 一键翻译） */
  const [menuOpen, setMenuOpen] = useState(false);
  /** 左侧菜单抽屉（分类 / 标签 / 导入 / 设置，和首页左侧栏同一套功能） */
  const [navOpen, setNavOpen] = useState(false);
  /** 本文笔记编辑器 */
  const [noteOpen, setNoteOpen] = useState(false);
  /** 菜单用 fixed 定位，避免被顶栏的 overflow 裁剪 */
  const [menuPos, setMenuPos] = useState({ top: 0, right: 0 });
  const menuRef = useRef(null);
  const menuBtnRef = useRef(null);

  const toggleMenu = useCallback(() => {
    if (menuOpen) {
      setMenuOpen(false);
      return;
    }
    const el = menuBtnRef.current;
    if (el) {
      const rect = el.getBoundingClientRect();
      setMenuPos({ top: Math.round(rect.bottom + 6), right: Math.round(window.innerWidth - rect.right) });
    }
    setMenuOpen(true);
  }, [menuOpen]);

  // 点空白处或 Esc 收起菜单
  useEffect(() => {
    if (!menuOpen) return undefined;
    const onDown = (event) => {
      if (menuRef.current && !menuRef.current.contains(event.target)) setMenuOpen(false);
    };
    const onKey = (event) => {
      if (event.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  const registerPageRef = useCallback((pageNo, el) => {
    if (el) pageRefs.current[pageNo] = el;
    else delete pageRefs.current[pageNo];
  }, []);

  /* ------------------------------ 载入文档 ------------------------------ */
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    // 换文档：清掉上一篇的译文缓存与状态
    trCancelRef.current = true;
    trSegmentsRef.current = {};
    setTrSegments({});
    setTrMode(false);
    setTrStatus({ state: 'idle', done: 0, total: 0 });
    (async () => {
      const detail = await guard(() => api.docs.get(docId));
      if (!alive || !detail) return;
      setDoc(detail);
      const bytes = await guard(() => api.docs.fileBytes(docId));
      if (!alive || !bytes) return;
      const loaded = await loadPdfDocument(bytes);
      if (!alive) return;
      setPdfDoc(loaded);
      // 默认按 130% 显示；不再按窗口宽度自动缩放（用户可随时用 ± / Ctrl+滚轮调整）
      setScale(DEFAULT_SCALE);
      const startPage = Math.min(Math.max(1, detail.last_page || 1), loaded.numPages);
      setCurrentPage(startPage);
      currentPageRef.current = startPage;
      const rows = await guard(() => api.annos.list(docId));
      setAnnos(rows || []);
      setLoading(false);
      requestAnimationFrame(() => {
        const el = pageRefs.current[startPage];
        if (el) el.scrollIntoView({ block: 'start' });
      });
    })().catch((err) => {
      console.error(err);
      if (alive) {
        setError(err && err.message ? err.message : '无法打开该文献');
        setLoading(false);
      }
    });
    return () => {
      alive = false;
    };
  }, [docId]);

  /* --------------------------- 阅读记录与进度 --------------------------- */
  // 只有当前标签（active）才算阅读时长：返回首页 / 切到别的标签时暂停计时
  useEffect(() => {
    if (!active) return undefined;
    let sessionId = null;
    let closed = false;
    const openedAt = Date.now();
    (async () => {
      const res = await guard(() => api.docs.openSession(docId, currentPageRef.current));
      sessionId = res ? res.sessionId : null;
      // 会话还没开完就已经切走了：立刻补一次关闭，避免脏会话
      if (closed && sessionId) {
        api.docs.closeSession(sessionId, currentPageRef.current, 0).catch(() => {});
        sessionId = null;
      }
    })();
    return () => {
      closed = true;
      const duration = Math.round((Date.now() - openedAt) / 1000);
      if (sessionId) {
        api.docs.closeSession(sessionId, currentPageRef.current, duration).catch(() => {});
      }
      api.docs.saveProgress(docId, currentPageRef.current, duration).catch(() => {});
      if (onDocChanged) onDocChanged();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId, active]);

  useEffect(() => {
    currentPageRef.current = currentPage;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      api.docs.saveProgress(docId, currentPage, 0).catch(() => {});
    }, 800);
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [currentPage, docId]);

  /* ------------------------------ 滚动定位 ------------------------------ */
  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return undefined;
    let ticking = false;
    const onScroll = () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        ticking = false;
        const top = container.getBoundingClientRect().top;
        let best = currentPageRef.current;
        let bestDelta = Infinity;
        for (const [pageNo, el] of Object.entries(pageRefs.current)) {
          if (!el) continue;
          const delta = Math.abs(el.getBoundingClientRect().top - top - 12);
          if (delta < bestDelta) {
            bestDelta = delta;
            best = Number(pageNo);
          }
        }
        if (best !== currentPageRef.current) setCurrentPage(best);
      });
    };
    container.addEventListener('scroll', onScroll, { passive: true });
    return () => container.removeEventListener('scroll', onScroll);
  }, [pdfDoc]);

  const gotoPage = useCallback(
    (page) => {
      if (!pdfDoc) return;
      const target = Math.min(Math.max(1, page), pdfDoc.numPages);
      setCurrentPage(target);
      currentPageRef.current = target;
      const el = pageRefs.current[target];
      if (el) el.scrollIntoView({ block: 'start', behavior: 'smooth' });
    },
    [pdfDoc]
  );

  /* ------------------------------ Ctrl+F 全文搜索 ------------------------------ */

  /** 滚动到某个命中位置（优先命中矩形，其次页面顶部） */
  const scrollToHit = useCallback((hit) => {
    if (!hit) return;
    setCurrentPage(hit.pageNo);
    currentPageRef.current = hit.pageNo;
    requestAnimationFrame(() => {
      const el = document.querySelector(`.pdf-scroll [data-hit-id="${hit.id}"]`);
      if (el && el.scrollIntoView) {
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      } else {
        const pageEl = pageRefs.current[hit.pageNo];
        if (pageEl) pageEl.scrollIntoView({ block: 'start', behavior: 'smooth' });
      }
    });
  }, []);

  /** 执行搜索（逐页渐进出结果，换词时用 token 取消旧任务） */
  useEffect(() => {
    if (!searchOpen || !pdfDoc) return undefined;
    const q = searchQuery.trim();
    if (!q) {
      setSearchHits([]);
      setSearchIdx(0);
      setSearching(false);
      return undefined;
    }
    setSearching(true);
    const token = searchTokenRef.current + 1;
    searchTokenRef.current = token;
    const timer = setTimeout(() => {
      searchInPdf(pdfDoc, q, {
        onProgress: (soFar) => {
          if (searchTokenRef.current === token) setSearchHits(soFar);
        },
      })
        .then((hits) => {
          if (searchTokenRef.current !== token) return;
          setSearchHits(hits);
          setSearchIdx(0);
          setSearching(false);
        })
        .catch(() => {
          if (searchTokenRef.current === token) setSearching(false);
        });
    }, 220);
    return () => clearTimeout(timer);
  }, [searchOpen, searchQuery, pdfDoc]);

  /** 命中结果变化 / 切换序号时自动滚动定位（同一命中只滚一次） */
  useEffect(() => {
    if (!searchHits.length) return;
    const hit = searchHits[Math.min(searchIdx, searchHits.length - 1)];
    if (!hit || hit.id === lastScrollHitRef.current) return;
    lastScrollHitRef.current = hit.id;
    scrollToHit(hit);
  }, [searchHits, searchIdx, scrollToHit]);

  const navigateHit = useCallback(
    (dir) => {
      setSearchIdx((idx) => {
        const n = searchHits.length;
        if (!n) return 0;
        return (((idx + dir) % n) + n) % n;
      });
    },
    [searchHits.length]
  );

  const openSearch = useCallback(() => {
    setSearchOpen(true);
    requestAnimationFrame(() => {
      if (searchInputRef.current) {
        searchInputRef.current.focus();
        searchInputRef.current.select();
      }
    });
  }, []);

  const closeSearch = useCallback(() => {
    searchTokenRef.current += 1; // 取消进行中的搜索
    setSearchOpen(false);
    setSearchQuery('');
    setSearchHits([]);
    setSearchIdx(0);
    setSearching(false);
    lastScrollHitRef.current = '';
  }, []);

  /* ------------------------ 多标签：打开另一篇文献 ------------------------ */

  /** 打开「选择文献」面板（列出库里的文献，点了就在新标签里打开） */
  const openPicker = useCallback(async () => {
    setPickerOpen(true);
    if (pickerDocs.length) return;
    setPickerLoading(true);
    try {
      const rows = await guard(() => api.docs.list({ sort: 'recent' }));
      setPickerDocs(Array.isArray(rows) ? rows : []);
    } finally {
      setPickerLoading(false);
    }
  }, [pickerDocs.length]);

  const pickerList = useMemo(() => {
    const q = pickerQuery.trim().toLowerCase();
    const list = q
      ? pickerDocs.filter((d) =>
          `${d.title || ''} ${d.authors || ''} ${d.journal || ''}`.toLowerCase().includes(q)
        )
      : pickerDocs;
    return list.slice(0, 200);
  }, [pickerDocs, pickerQuery]);

  /* ------------------------ 一键翻译（译文原位替换） ------------------------ */

  /** 单段翻译（走本地 Hy-MT2；失败返回空串，交给上层跳过） */
  const translateText = useCallback(async (text) => {
    const res = await api.translate.text({ text, target: 'zh' });
    return (res && res.text) || '';
  }, []);

  /** 恢复原文 */
  const restoreOriginal = useCallback(() => {
    trCancelRef.current = true;
    setTrMode(false);
    setTrStatus({ state: 'idle', done: 0, total: 0 });
  }, []);

  /** 打开文档时载入已缓存的页面译文（pr_page_translate_rd） */
  useEffect(() => {
    if (!docId) return undefined;
    let alive = true;
    (async () => {
      const rows = await guard(() => api.translate.pageList(docId, 'zh'));
      if (!alive || !rows || !rows.length) return;
      const map = {};
      for (const row of rows) {
        if (row && row.blocks && row.blocks.length) map[row.pageNo] = row.blocks;
      }
      if (!Object.keys(map).length) return;
      trSegmentsRef.current = map;
      setTrSegments(map);
    })();
    return () => {
      alive = false;
    };
  }, [docId]);

  /** 清空缓存并重译（模型升级或想换译法时用） */
  const retranslateDoc = useCallback(async () => {
    await guard(() => api.translate.pageClear(docId, 'zh'));
    trCancelRef.current = true;
    trSegmentsRef.current = {};
    setTrSegments({});
    setTrMode(false);
    setTrStatus({ state: 'idle', done: 0, total: 0 });
    // 等一帧再启动，确保状态已重置
    setTimeout(() => {
      runTranslateDocRef.current && runTranslateDocRef.current();
    }, 0);
  }, [docId]);

  /**
   * 一键翻译整篇：逐页切行 → 分批翻译 → 原位替换。
   * 只替换文字、不动坐标，所以版式/图片/公式位置完全保留。
   */
  const runTranslateDoc = useCallback(async () => {
    if (!pdfDoc) return;
    // 1) 确认模型可用（没装就引导去设置页）
    try {
      const info = await api.translate.status();
      if (!info || info.state !== 'ready') {
        const model = info && info.settings && info.settings.model;
        if (!model || !model.exists) {
          toast('还没找到翻译模型，请到「设置 → 翻译」里下载后再试', 'warn', 6000);
          return;
        }
        setTrStatus({ state: 'loading', done: 0, total: pdfDoc.numPages });
        await api.translate.load({});
      }
    } catch (err) {
      toast(err.message || '翻译模型不可用', 'error');
      return;
    }

    trCancelRef.current = false;
    setTrMode(true);
    const total = pdfDoc.numPages;
    setTrStatus({ state: 'running', done: 0, total });

    for (let pageNo = 1; pageNo <= total; pageNo += 1) {
      if (trCancelRef.current) break;
      if (trSegmentsRef.current[pageNo]) {
        setTrStatus({ state: 'running', done: pageNo, total });
        continue;
      }
      try {
        const page = await pdfDoc.getPage(pageNo);
        const res = await buildPageBlocks(page, translateText);
        if (res.blocks.length) {
          trSegmentsRef.current = { ...trSegmentsRef.current, [pageNo]: res.blocks };
          setTrSegments(trSegmentsRef.current);
          // 落库持久化（失败不影响显示，下次重译即可）
          api.translate
            .pageSave({ docId, pageNo, targetLang: 'zh', hash: res.hash, blocks: res.blocks })
            .catch(() => {});
        }
      } catch (err) {
        console.warn('[translate-doc] 第', pageNo, '页失败', err);
      }
      setTrStatus({ state: 'running', done: pageNo, total });
    }

    setTrStatus({
      state: trCancelRef.current ? 'cancelled' : 'done',
      done: trCancelRef.current ? 0 : total,
      total,
    });
    if (!trCancelRef.current) toast('整篇翻译完成，已原位替换为中文', 'success', 4000);
  }, [pdfDoc, translateText]);

  /** 工具栏按钮：未翻译 → 开始；已翻译 → 还原原文 */
  const toggleDocTranslate = useCallback(() => {
    if (trMode) restoreOriginal();
    else runTranslateDoc();
  }, [trMode, restoreOriginal, runTranslateDoc]);

  // 供「重译」在清空状态后再触发，避免闭包拿到旧值
  useEffect(() => {
    runTranslateDocRef.current = runTranslateDoc;
  }, [runTranslateDoc]);

  /* ------------------------------ 标注操作 ------------------------------ */
  const handleCreate = useCallback(
    async (draft) => {
      const created = await guard(() =>
        api.annos.create({
          docId,
          pageNo: draft.pageNo,
          type: draft.type,
          color: draft.color,
          rects: draft.rects || [],
          inkPaths: draft.inkPaths || [],
          quote: draft.quote || '',
          content: '',
          opacity: draft.type === 'highlight' ? 0.35 : 0.9,
        })
      );
      if (!created) return;
      setAnnos((prev) => [...prev, created].sort((a, b) => a.page_no - b.page_no || a.id - b.id));
      setSelectedId(created.id);
      if (draft.type === 'note' || draft.editNow) setEditing(created);
      if (onDocChanged) onDocChanged();
    },
    [docId, onDocChanged]
  );

  const handleUpdateAnno = useCallback(
    async (id, patch) => {
      const updated = await guard(() => api.annos.update(id, patch));
      if (!updated) return;
      setAnnos((prev) => prev.map((a) => (a.id === updated.id ? updated : a)));
      setEditing((prev) => (prev && prev.id === updated.id ? updated : prev));
      if (onDocChanged) onDocChanged();
    },
    [onDocChanged]
  );

  const handleRemoveAnno = useCallback(
    async (id) => {
      const ok = await guard(() => api.annos.remove(id));
      if (!ok) return;
      setAnnos((prev) => prev.filter((a) => a.id !== id));
      setEditing((prev) => (prev && prev.id === id ? null : prev));
      setSelectedId((prev) => (prev === id ? null : prev));
      toast('已删除批注', 'success');
      if (onDocChanged) onDocChanged();
    },
    [onDocChanged]
  );

  const selectAnno = useCallback(
    (anno) => {
      setSelectedId(anno ? anno.id : null);
      if (anno) gotoPage(anno.page_no);
    },
    [gotoPage]
  );

  /* ------------------------------ 划词翻译 ------------------------------ */
  const closeTranslation = useCallback(() => {
    setSelection(null);
    translation.reset();
  }, [translation]);

  const runTranslate = useCallback(
    (payload, lang) => {
      const target = lang || translation.settings?.target || targetLang || 'zh';
      translation.translate(payload.quote, { target });
    },
    [translation, targetLang]
  );

  /** 「选择」工具下拖选文字：只记录选区并弹浮条，不生成任何标注 */
  const handleSelectText = useCallback((payload) => {
    if (!payload || !payload.quote) return;
    setSelBubble(payload);
  }, []);

  const closeBubble = useCallback(() => setSelBubble(null), []);

  /** 浮条 → 翻译（本地模型） */
  const bubbleTranslate = useCallback(() => {
    const payload = selBubble;
    setSelBubble(null);
    if (!payload) return;
    setSelection(payload);
    runTranslate(payload);
  }, [selBubble, runTranslate]);

  /** 浮条 → AI 理解 */
  const bubbleExplain = useCallback(() => {
    const payload = selBubble;
    setSelBubble(null);
    if (!payload) return;
    setSelection(null);
    setAiTarget({
      anchor: payload.anchor,
      pageNo: payload.pageNo,
      rects: payload.rects,
      payload: { mode: 'explain', quote: payload.quote, text: payload.quote },
    });
  }, [selBubble]);

  /** 浮条 → 按当前颜色高亮 */
  const bubbleHighlight = useCallback(async () => {
    const payload = selBubble;
    setSelBubble(null);
    if (!payload) return;
    const created = await guard(() =>
      api.annos.create({
        docId,
        pageNo: payload.pageNo,
        type: 'highlight',
        color,
        rects: payload.rects || [],
        inkPaths: [],
        quote: payload.quote || '',
        opacity: 0.35,
      })
    );
    if (!created) return;
    setAnnos((prev) => [...prev, created].sort((a, b) => a.page_no - b.page_no || a.id - b.id));
    if (onDocChanged) onDocChanged();
  }, [selBubble, docId, color, onDocChanged]);

  const bubbleCopy = useCallback(async () => {
    const payload = selBubble;
    if (!payload) return;
    try {
      await navigator.clipboard.writeText(payload.quote || '');
      toast('已复制选中文字', 'success');
    } catch {
      toast('复制失败，请手动选择文本', 'warn');
    }
    setSelBubble(null);
  }, [selBubble]);

  /** 抽取正文用于整篇理解（截断到 12k 字符，避免超出上下文） */
  const collectDocText = useCallback(
    async (limit = 12000) => {
      if (!pdfDoc) return '';
      const parts = [];
      let used = 0;
      const pages = Math.min(pdfDoc.numPages, 15);
      for (let i = 1; i <= pages; i += 1) {
        try {
          const page = await pdfDoc.getPage(i);
          const content = await page.getTextContent();
          const text = content.items
            .map((item) => item.str || '')
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim();
          if (!text) continue;
          parts.push(`【第 ${i} 页】${text}`);
          used += text.length;
          if (used >= limit) break;
        } catch {
          /* 单页解析失败忽略 */
        }
      }
      return parts.join('\n\n').slice(0, limit);
    },
    [pdfDoc]
  );

  const openAiSummary = useCallback(async () => {
    if (!pdfDoc) return;
    setSummarizing(true);
    try {
      const text = await collectDocText();
      if (!text) {
        toast('没有抽取到正文（扫描版 PDF 没有文字层），可以先用「理解」工具划词提问', 'warn', 5000);
        return;
      }
      setSelection(null);
      setAiTarget({
        anchor: null,
        pageNo: null,
        rects: [],
        payload: {
          mode: 'summary',
          text,
          quote: doc ? doc.title : '',
          title: doc ? doc.title : '',
          authors: doc ? doc.authors : '',
          year: doc ? doc.year : null,
          journal: doc ? doc.journal : '',
        },
      });
    } finally {
      setSummarizing(false);
    }
  }, [pdfDoc, doc, collectDocText]);

  const changeTargetLang = useCallback(
    (lang) => {
      setTargetLang(lang);
      if (selection) runTranslate(selection, lang);
    },
    [runTranslate, selection]
  );

  /** 把译文落成一条批注（原文进 quote，译文进 content） */
  const saveTranslationAnno = useCallback(async () => {
    if (!selection || !translation.state.text) return;
    const created = await guard(() =>
      api.annos.create({
        docId,
        pageNo: selection.pageNo,
        type: 'note',
        color: '#5b8def',
        rects: selection.rects || [],
        inkPaths: [],
        quote: selection.quote || '',
        content: `【译文·${translation.state.target}】${translation.state.text}`,
        opacity: 0.9,
      })
    );
    if (!created) return;
    setAnnos((prev) => [...prev, created].sort((a, b) => a.page_no - b.page_no || a.id - b.id));
    toast('译文已存为批注', 'success');
    if (onDocChanged) onDocChanged();
  }, [docId, selection, translation.state, onDocChanged]);

  /* ------------------------------- 导出 ------------------------------- */
  const doExport = async (kind) => {
    setExporting(kind);
    try {
      const res = await guard(() => (kind === 'md' ? api.exporter.markdown(docId) : api.exporter.flatten(docId)));
      if (res && res.filePath) toast(`已导出：${res.filePath}`, 'success', 5000);
    } finally {
      setExporting('');
    }
  };

  /* ------------------------------ 快捷键 ------------------------------ */
  useEffect(() => {
    const onKey = (event) => {
      // 多标签：只有当前标签响应快捷键，否则隐藏的标签也会一起动作
      if (!active) return;
      // Ctrl+B：呼出 / 收起左侧菜单
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'b') {
        event.preventDefault();
        setNavOpen((v) => !v);
        return;
      }
      // 抽屉打开时先处理 Esc，其余快捷键让位给菜单里的输入框
      if (navOpen) {
        if (event.key === 'Escape') {
          event.preventDefault();
          setNavOpen(false);
        }
        return;
      }
      // 笔记编辑器打开时，快捷键全部让位给它自己的输入框
      if (noteOpen) return;
      // Ctrl+Tab / Ctrl+Shift+Tab：切换标签
      if (event.ctrlKey && event.key === 'Tab' && tabs.length > 1) {
        event.preventDefault();
        const idx = tabs.findIndex((t) => t.id === docId);
        const nextIdx = ((idx < 0 ? 0 : idx) + (event.shiftKey ? -1 : 1) + tabs.length) % tabs.length;
        if (tabs[nextIdx] && onSelectTab) onSelectTab(tabs[nextIdx].id);
        return;
      }
      // Ctrl+W：关闭当前标签
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'w') {
        event.preventDefault();
        if (onCloseTab) onCloseTab(docId);
        return;
      }
      // Ctrl+F：任何输入框里也生效（浏览器默认查找被拦截）
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        openSearch();
        return;
      }
      // F3 / Shift+F3：下一个 / 上一个命中
      if (searchOpen && (event.key === 'F3' || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'g'))) {
        event.preventDefault();
        navigateHit(event.shiftKey ? -1 : 1);
        return;
      }
      const tag = (event.target && event.target.tagName) || '';
      if (['INPUT', 'TEXTAREA'].includes(tag)) return;
      if (event.key === 'Escape') {
        if (searchOpen) closeSearch();
        else if (selBubble) setSelBubble(null);
        else if (aiTarget) setAiTarget(null);
        else if (selection) closeTranslation();
        else if (editing) setEditing(null);
        else if (tool !== 'text') setTool('text');
        return;
      }
      if (event.key === 'ArrowRight' || event.key === 'PageDown') {
        event.preventDefault();
        gotoPage(currentPage + 1);
      } else if (event.key === 'ArrowLeft' || event.key === 'PageUp') {
        event.preventDefault();
        gotoPage(currentPage - 1);
      } else if ((event.ctrlKey || event.metaKey) && (event.key === '=' || event.key === '+')) {
        event.preventDefault();
        setScale((s) => Math.min(4, Number((s + 0.15).toFixed(2))));
      } else if ((event.ctrlKey || event.metaKey) && event.key === '-') {
        event.preventDefault();
        setScale((s) => Math.max(0.4, Number((s - 0.15).toFixed(2))));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [currentPage, gotoPage, tool, editing, selection, closeTranslation, aiTarget, selBubble, searchOpen, openSearch, closeSearch, navigateHit, active, tabs, docId, onSelectTab, onCloseTab, navOpen, noteOpen]);

  /* 点空白处 / 滚动时收起选区浮条 */
  useEffect(() => {
    if (!selBubble) return undefined;
    const onDown = (event) => {
      if (event.target && event.target.closest && event.target.closest('.sel-bubble')) return;
      setSelBubble(null);
    };
    const onScroll = () => setSelBubble(null);
    document.addEventListener('mousedown', onDown, true);
    scrollRef.current && scrollRef.current.addEventListener('scroll', onScroll, { passive: true });
    const scroller = scrollRef.current;
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      if (scroller) scroller.removeEventListener('scroll', onScroll);
    };
  }, [selBubble]);

  const annosByPage = useMemo(() => {
    const map = new Map();
    for (const anno of annos) {
      if (!map.has(anno.page_no)) map.set(anno.page_no, []);
      map.get(anno.page_no).push(anno);
    }
    return map;
  }, [annos]);

  /** 搜索命中按页分组，供 PdfPage 画高亮 */
  const hitsByPage = useMemo(() => {
    const map = new Map();
    for (const hit of searchHits) {
      if (!map.has(hit.pageNo)) map.set(hit.pageNo, []);
      map.get(hit.pageNo).push(hit);
    }
    return map;
  }, [searchHits]);
  const activeHit = searchHits.length ? searchHits[Math.min(searchIdx, searchHits.length - 1)] : null;

  const toolMeta = TOOLS.find((t) => t.value === tool);

  /** 下拉菜单按钮文字：把进行中的状态直接显示出来，避免收进菜单后看不到进度 */
  const menuLabel =
    trStatus.state === 'running'
      ? `翻译中 ${trStatus.done}/${trStatus.total}`
      : trStatus.state === 'loading'
        ? '加载模型…'
        : exporting
          ? '导出中…'
          : summarizing
            ? '抽取正文…'
            : '更多操作';

  return (
    <div className="reader" style={active ? undefined : { display: 'none' }}>
      {/* 多标签条：每篇 PDF 一个标签，互不影响（缩放/滚动/批注/译文各自保留） */}
      <div className="reader-tabs">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            className={`reader-tab ${tab.id === docId ? 'active' : ''}`}
            title={tab.title}
            onClick={() => onSelectTab && onSelectTab(tab.id)}
          >
            <span className="reader-tab-title">{tab.title}</span>
            <span
              className="reader-tab-close"
              title="关闭这篇（Ctrl+W）"
              onClick={(e) => {
                e.stopPropagation();
                if (onCloseTab) onCloseTab(tab.id);
              }}
            >
              ✕
            </span>
          </button>
        ))}
        <button type="button" className="reader-tab-add" title="打开另一篇文献" onClick={openPicker}>
          ＋
        </button>
      </div>

      <header className="reader-topbar">
        <button
          className={`ghost-btn nav-toggle-btn ${navOpen ? 'active' : ''}`}
          title="左侧菜单：分类 / 标签 / 导入 / 设置（Ctrl+B）"
          onClick={() => setNavOpen((v) => !v)}
        >
          <span className="nav-toggle-icon">☰</span>
          <span className="nav-toggle-label">菜单</span>
        </button>
        <button className="icon-btn" title="返回文献库首页（标签会保留，下次打开自动恢复）" onClick={onGoHome}>
          ←
        </button>
        <div className="reader-title" title={doc ? doc.title : ''}>
          {doc ? doc.title : '加载中…'}
        </div>

        <div className="tool-group">
          {TOOLS.map((t) => (
            <button
              key={t.value}
              className={`tool-btn ${tool === t.value ? 'active' : ''}`}
              title={`${t.label} · ${t.hint}`}
              onClick={() => setTool(t.value)}
            >
              <span className="tool-icon">{t.icon}</span>
              <span className="tool-label">{t.label}</span>
            </button>
          ))}
        </div>

        <div className="color-group">
          {HIGHLIGHT_COLORS.map((c) => (
            <button
              key={c.value}
              className={`color-dot ${color === c.value ? 'active' : ''}`}
              style={{ background: c.value }}
              title={c.label}
              onClick={() => {
                setColor(c.value);
                if (tool === 'text') setTool('highlight');
              }}
            />
          ))}
        </div>

        <div className="spacer" />

        <div className="zoom-group">
          <button
            className="icon-btn"
            title="缩小"
            onClick={() => setScale((s) => Math.max(0.4, Number((s - 0.15).toFixed(2))))}
          >
            −
          </button>
          <span className="zoom-value">{Math.round(scale * 100)}%</span>
          <button
            className="icon-btn"
            title="放大"
            onClick={() => setScale((s) => Math.min(4, Number((s + 0.15).toFixed(2))))}
          >
            +
          </button>
        </div>

        <div className="page-group">
          <input
            className="page-input"
            value={currentPage}
            onChange={(e) => {
              const v = Number(e.target.value.replace(/[^\d]/g, ''));
              if (v) setCurrentPage(v);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') gotoPage(currentPage);
            }}
          />
          <span className="page-total">/ {pdfDoc ? pdfDoc.numPages : '—'}</span>
        </div>

        <div className="menu-wrap" ref={menuRef}>
          <button
            ref={menuBtnRef}
            className={`ghost-btn ${menuOpen ? 'active' : ''}`}
            title="导出 / AI 摘要 / 一键翻译（点开选择）"
            onClick={toggleMenu}
          >
            {menuLabel} <span className="caret">▾</span>
          </button>
          {menuOpen && (
            <div className="menu-panel" role="menu" style={{ top: menuPos.top, right: menuPos.right }}>
              <button
                className="menu-item"
                disabled={Boolean(exporting)}
                onClick={() => {
                  setMenuOpen(false);
                  doExport('md');
                }}
              >
                <span>📄 导出 Markdown</span>
                {exporting === 'md' ? <em>导出中…</em> : null}
              </button>
              <button
                className="menu-item"
                disabled={Boolean(exporting)}
                onClick={() => {
                  setMenuOpen(false);
                  doExport('pdf');
                }}
              >
                <span>📕 导出标注 PDF</span>
                {exporting === 'pdf' ? <em>导出中…</em> : null}
              </button>
              <button
                className="menu-item"
                disabled={summarizing || !pdfDoc}
                onClick={() => {
                  setMenuOpen(false);
                  openAiSummary();
                }}
                title="用 AI 对整篇做结构化理解（标题/方法/结果/局限）：默认走本地量化模型，也可在设置里切外部 API"
              >
                <span>🧠 AI 摘要</span>
                {summarizing ? <em>抽取正文…</em> : null}
              </button>
              <div className="menu-sep" />
              {trStatus.state === 'running' ? (
                <button
                  className="menu-item"
                  onClick={() => {
                    setMenuOpen(false);
                    restoreOriginal();
                  }}
                >
                  <span>✕ 中止翻译，恢复原文</span>
                  <em>
                    翻译中 {trStatus.done}/{trStatus.total}
                  </em>
                </button>
              ) : (
                <>
                  <button
                    className={`menu-item ${trMode ? 'active' : ''}`}
                    disabled={!pdfDoc || trStatus.state === 'loading'}
                    onClick={() => {
                      setMenuOpen(false);
                      toggleDocTranslate();
                    }}
                    title="整篇翻译成中文并原位替换：段落级重排、只动文字不动坐标；译文自动缓存到数据库"
                  >
                    <span>{trMode ? '↩ 恢复原文' : '🌐 一键翻译整篇'}</span>
                    {trStatus.state === 'loading' ? <em>加载模型…</em> : null}
                  </button>
                  {Object.keys(trSegments).length > 0 ? (
                    <button
                      className="menu-item"
                      onClick={() => {
                        setMenuOpen(false);
                        retranslateDoc();
                      }}
                      title="清空译文缓存并重新翻译"
                    >
                      <span>↻ 重新翻译（清空缓存）</span>
                    </button>
                  ) : null}
                </>
              )}
            </div>
          )}
        </div>
        <button
          className={`ghost-btn ${noteOpen ? 'active' : ''}`}
          onClick={() => setNoteOpen(true)}
          title="给这篇文献写笔记（Markdown，自动保存到数据库）"
        >
          📝 笔记
        </button>
        <button className={`ghost-btn ${panelOpen ? 'active' : ''}`} onClick={() => setPanelOpen((v) => !v)}>
          批注 {annos.length}
        </button>
      </header>

      {/* Ctrl+F 搜索面板 */}
      {searchOpen && (
        <div className="reader-search">
          <input
            ref={searchInputRef}
            className="reader-search-input"
            value={searchQuery}
            placeholder="在文档中搜索…"
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                navigateHit(e.shiftKey ? -1 : 1);
              } else if (e.key === 'Escape') {
                e.preventDefault();
                closeSearch();
              }
            }}
          />
          <span className={`reader-search-count ${searchHits.length ? '' : 'empty'}`}>
            {searching
              ? '搜索中…'
              : searchQuery.trim()
                ? searchHits.length
                  ? `${Math.min(searchIdx + 1, searchHits.length)} / ${searchHits.length}`
                  : '无结果'
                : ''}
          </span>
          <button className="icon-btn" title="上一个（Shift+Enter）" disabled={!searchHits.length} onClick={() => navigateHit(-1)}>
            ↑
          </button>
          <button className="icon-btn" title="下一个（Enter）" disabled={!searchHits.length} onClick={() => navigateHit(1)}>
            ↓
          </button>
          <button className="icon-btn" title="关闭（Esc）" onClick={closeSearch}>
            ✕
          </button>
        </div>
      )}

      <div className="reader-body">
        <main className="pdf-scroll" ref={scrollRef}>
          {loading && <div className="reader-hint">正在加载 PDF…</div>}
          {error && <div className="reader-hint error">{error}</div>}
          {toolMeta && tool !== 'text' && (
            <div className="tool-hint">
              {toolMeta.icon} {toolMeta.label}：{toolMeta.hint}
            </div>
          )}
          <div className="pdf-pages">
            {pdfDoc &&
              Array.from({ length: pdfDoc.numPages }, (_, i) => i + 1).map((pageNo) => (
                <PdfPage
                  key={pageNo}
                  pdf={pdfDoc}
                  pageNumber={pageNo}
                  scale={scale}
                  annotations={annosByPage.get(pageNo) || []}
                  searchHits={hitsByPage.get(pageNo) || []}
                  searchActiveId={activeHit ? activeHit.id : null}
                  translateMode={trMode}
                  translationSegments={trSegments[pageNo]}
                  tool={tool}
                  color={color}
                  selectedId={selectedId}
                  onCreate={handleCreate}
                  onPick={selectAnno}
                  onSelectText={handleSelectText}
                  registerRef={registerPageRef}
                />
              ))}
          </div>
        </main>

        {panelOpen && (
          <AnnotationPanel
            annos={annos}
            docId={docId}
            selectedId={selectedId}
            editing={editing}
            onSelect={selectAnno}
            onEdit={setEditing}
            onCloseEdit={() => setEditing(null)}
            onUpdate={handleUpdateAnno}
            onRemove={handleRemoveAnno}
          />
        )}
      </div>

      {selBubble && (
        <SelectionBubble
          anchor={selBubble.anchor}
          quote={selBubble.quote}
          onTranslate={bubbleTranslate}
          onExplain={bubbleExplain}
          onHighlight={bubbleHighlight}
          onCopy={bubbleCopy}
          onClose={closeBubble}
        />
      )}

      {selection && (
        <TranslatePopover
          anchor={selection.anchor}
          quote={selection.quote}
          state={translation.state}
          target={translation.state.target || targetLang}
          modelState={translation.modelState}
          onTargetChange={changeTargetLang}
          onClose={closeTranslation}
          onRetry={() => runTranslate(selection)}
          onSaveAnno={saveTranslationAnno}
        />
      )}
      {aiTarget && (
        <AiPanel
          anchor={aiTarget.anchor}
          payload={aiTarget.payload}
          docId={docId}
          pageNo={aiTarget.pageNo}
          rects={aiTarget.rects}
          onClose={() => setAiTarget(null)}
          onSaved={(anno) => {
            setAnnos((prev) => [...prev, anno].sort((a, b) => a.page_no - b.page_no || a.id - b.id));
            if (onDocChanged) onDocChanged();
          }}
        />
      )}

      {/* 打开另一篇文献（在标签页里打开，不打断当前阅读） */}
      {pickerOpen && (
        <div className="modal-mask" onClick={() => setPickerOpen(false)}>
          <div className="modal doc-picker" onClick={(e) => e.stopPropagation()}>
            <header className="modal-head">
              <h2>打开文献</h2>
              <button className="icon-btn" onClick={() => setPickerOpen(false)}>
                ✕
              </button>
            </header>
            <div className="modal-body">
              <input
                className="search-input"
                placeholder="搜索标题 / 作者 / 期刊…"
                value={pickerQuery}
                autoFocus
                onChange={(e) => setPickerQuery(e.target.value)}
              />
              <div className="doc-picker-list">
                {pickerLoading && <div className="side-empty">正在读取文献库…</div>}
                {!pickerLoading && !pickerList.length && <div className="side-empty">没有匹配的文献</div>}
                {pickerList.map((item) => {
                  const opened = tabs.some((t) => t.id === item.id);
                  return (
                    <button
                      key={item.id}
                      type="button"
                      className={`doc-picker-row ${item.id === docId ? 'current' : ''}`}
                      onClick={() => {
                        setPickerOpen(false);
                        if (onOpenDoc) onOpenDoc(item);
                      }}
                    >
                      <span className="doc-picker-title">{item.title || '未命名文献'}</span>
                      <span className="doc-picker-meta">
                        {[item.journal, item.year].filter(Boolean).join(' · ') || '—'}
                        {opened ? ' · 已打开' : ''}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 本文笔记编辑器（写入 pr_note_info，doc_id 指向当前文献） */}
      {noteOpen && (
        <DocNoteDialog docId={docId} docTitle={doc ? doc.title : ''} onClose={() => setNoteOpen(false)} />
      )}

      {/* 左侧菜单抽屉：和首页左侧栏同一套功能（分类 / 标签 / 导入 / 设置 / 主题） */}
      {renderSidebar && navOpen && (
        <div className="reader-nav">
          <div className="reader-nav-mask" onClick={() => setNavOpen(false)} />
          <aside className="reader-nav-panel" role="navigation">
            <button className="reader-nav-close" title="收起菜单（Esc）" onClick={() => setNavOpen(false)}>
              ✕
            </button>
            <div className="reader-nav-body">{renderSidebar({ close: () => setNavOpen(false) })}</div>
          </aside>
        </div>
      )}
    </div>
  );
}
