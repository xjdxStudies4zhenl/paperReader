import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { forceCenter, forceCollide, forceX, forceY, forceZ } from 'd3-force-3d';

/** 懒加载：3D 库体积不小，只有切到关系图时才加载 */
let libPromise = null;
function loadLib() {
  if (!libPromise) {
    libPromise = Promise.all([import('3d-force-graph'), import('three')]).then(([graph, three]) => ({
      ForceGraph3D: graph.default,
      THREE: three,
    }));
  }
  return libPromise;
}

const COLORS = {
  folder: '#a78bfa',
  folderUncat: '#8b93a7',
  doc: '#5b8def',
  note: '#37c98b',
  orphan: '#7c8698',
  active: '#ffb020',
};

function nodeColor(node, active) {
  if (node.kind === 'folder') return node.color || COLORS.folder;
  if (node.kind === 'folder-uncat') return COLORS.folderUncat;
  if (node.kind === 'doc') return COLORS.doc;
  if (node.kind === 'orphan') return COLORS.orphan;
  return active ? COLORS.active : COLORS.note;
}

function nodeRadius(node) {
  if (node.kind === 'folder' || node.kind === 'folder-uncat') return 7.4;
  if (node.kind === 'doc') return 5.4;
  if (node.kind === 'orphan') return 6.2;
  return 3.2;
}

/** '#5b8def' → 'rgba(91,141,239,alpha)'，用于按分类给连线着色 */
function withAlpha(hex, alpha) {
  const fallback = `rgba(156, 132, 255, ${alpha})`;
  if (!hex || typeof hex !== 'string') return fallback;
  const value = hex.replace('#', '').trim();
  if (value.length !== 6) return fallback;
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  if ([r, g, b].some((n) => Number.isNaN(n))) return fallback;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * 适应视图：自己按节点坐标算包围球再定相机。
 * （库自带的 zoomToFit 对自定义 nodeThreeObject 的包围盒算得不准，会忽远忽近）
 */
function frameCamera(graph, duration = 700) {
  try {
    const nodes = (graph.graphData() && graph.graphData().nodes) || [];
    if (!nodes.length) return;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const node of nodes) {
      const x = Number.isFinite(node.x) ? node.x : 0;
      const y = Number.isFinite(node.y) ? node.y : 0;
      const z = Number.isFinite(node.z) ? node.z : 0;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
      minZ = Math.min(minZ, z);
      maxZ = Math.max(maxZ, z);
    }
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;
    const centerZ = (minZ + maxZ) / 2;
    const spanX = maxX - minX;
    const spanY = maxY - minY;
    const spanZ = maxZ - minZ;
    // 分轴计算距离，比包围球更贴合实际投影，避免过度留白
    const halfW = spanX / 2 + 24;
    const halfH = spanY / 2 + 20;
    const halfD = spanZ / 2;

    const camera = graph.camera();
    const vFov = ((camera.fov || 50) * Math.PI) / 180;
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * (camera.aspect || 1));
    const distV = halfH / Math.tan(vFov / 2);
    const distH = halfW / Math.tan(hFov / 2);
    const distance = Math.max(distV, distH, 120) + halfD;

    graph.cameraPosition(
      { x: centerX, y: centerY, z: centerZ + distance },
      { x: centerX, y: centerY, z: centerZ },
      duration
    );
  } catch {
    /* 忽略 */
  }
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

/** 用 canvas 画一个圆角标签，做成 Sprite（始终朝向相机） */
function makeLabelSprite(THREE, text, color, options = {}) {
  const label = String(text || '').trim() || '未命名';
  const fontSize = options.fontSize || 26;
  const font = `600 ${fontSize}px "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif`;
  const padX = 16;
  const measure = document.createElement('canvas').getContext('2d');
  measure.font = font;
  const textWidth = Math.ceil(measure.measureText(label).width);
  const maxWidth = options.maxWidth || 420;
  const width = Math.min(maxWidth, Math.max(88, textWidth + padX * 2));
  const height = options.height || 60;

  const canvas = document.createElement('canvas');
  canvas.width = width * 2;
  canvas.height = height * 2;
  const ctx = canvas.getContext('2d');
  ctx.scale(2, 2);
  ctx.font = font;
  ctx.textBaseline = 'middle';

  ctx.fillStyle = options.background || 'rgba(12, 17, 30, 0.78)';
  roundRect(ctx, 1, 1, width - 2, height - 2, 16);
  ctx.fill();
  ctx.strokeStyle = options.border || 'rgba(120, 160, 255, 0.45)';
  ctx.lineWidth = 1.5;
  roundRect(ctx, 1, 1, width - 2, height - 2, 16);
  ctx.stroke();

  let shown = label;
  while (ctx.measureText(shown).width > width - padX * 2 && shown.length > 1) {
    shown = shown.slice(0, -1);
  }
  if (shown !== label) shown = `${shown.slice(0, -1)}…`;

  ctx.fillStyle = color;
  ctx.fillText(shown, padX, height / 2 + 1);

  const texture = new THREE.CanvasTexture(canvas);
  if (THREE.SRGBColorSpace) texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  texture.needsUpdate = true;

  const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false });
  const sprite = new THREE.Sprite(material);
  const scale = options.scale || 0.058;
  sprite.scale.set(width * scale, height * scale, 1);
  return sprite;
}

/**
 * 节点外观：
 * - 分类：八面体 + 环绕光环（视觉上是「根 / 容器」）
 * - 论文：发光球体
 * - 笔记：小发光球
 */
function buildNodeObject(THREE, node, active) {
  const group = new THREE.Group();
  const color = nodeColor(node, active);
  const radius = nodeRadius(node);
  const isFolder = node.kind === 'folder' || node.kind === 'folder-uncat';

  const geometry = isFolder
    ? new THREE.OctahedronGeometry(radius * 1.15, 0)
    : new THREE.SphereGeometry(radius, 24, 18);
  const mesh = new THREE.Mesh(
    geometry,
    new THREE.MeshStandardMaterial({
      color,
      roughness: isFolder ? 0.45 : 0.32,
      metalness: isFolder ? 0.35 : 0.15,
      flatShading: isFolder,
      emissive: new THREE.Color(color),
      emissiveIntensity: isFolder ? 0.35 : active ? 0.6 : 0.26,
    })
  );
  group.add(mesh);
  node.__mesh = mesh;

  // 外层柔光
  const halo = new THREE.Mesh(
    new THREE.SphereGeometry(radius * 1.65, 16, 12),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: isFolder ? 0.16 : 0.1, depthWrite: false })
  );
  group.add(halo);
  node.__halo = halo;

  // 分类节点加一圈光环，强化层级感
  if (isFolder) {
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(radius * 1.95, radius * 0.055, 8, 48),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.5, depthWrite: false })
    );
    ring.rotation.x = Math.PI / 2.35;
    group.add(ring);
    node.__ring = ring;
  }

  // 标签：分类 / 论文常显，笔记只在选中时显示
  if (node.kind !== 'note' || active) {
    const labelColor = isFolder
      ? '#efe7ff'
      : node.kind === 'doc'
        ? '#dbe7ff'
        : node.kind === 'orphan'
          ? '#c3cbd9'
          : '#ffd98a';
    const sprite = makeLabelSprite(THREE, node.label, labelColor, {
      fontSize: isFolder ? 30 : 26,
      height: isFolder ? 64 : 60,
      scale: isFolder ? 0.062 : 0.056,
      border: isFolder ? 'rgba(167, 139, 250, 0.55)' : undefined,
    });
    sprite.position.set(0, -(radius + (isFolder ? 5.4 : 4.4)), 0);
    group.add(sprite);
    node.__label = sprite;
  }

  node.__group = group;
  return group;
}

/**
 * 笔记关系图（3D 力导向，基于开源 3d-force-graph / three.js）。
 *
 * 层级建模：分类 ─(1:n)→ 论文 ─(1:n)→ 笔记，没有归属的笔记挂到「未归档笔记」。
 * - 点分类 → 回到文献库并只看该分类；点论文 → 打开阅读器；点笔记 → 打开该笔记。
 * - 模拟收敛后停下，不会一直跳；支持拖拽旋转 / 滚轮缩放 / 适应视图。
 */
export default function NotesGraph({
  notes = [],
  docs = [],
  folders = [],
  activeNoteId,
  onSelectNote,
  onOpenDoc,
  onOpenFolder,
}) {
  const wrapRef = useRef(null);
  const graphRef = useRef(null);
  const threeRef = useRef(null);
  const fittedRef = useRef(false);
  const lastSigRef = useRef('');
  const lastCountRef = useRef(-1);
  const selectRef = useRef(onSelectNote);
  const openDocRef = useRef(onOpenDoc);
  const openFolderRef = useRef(onOpenFolder);
  const activeRef = useRef(activeNoteId);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    selectRef.current = onSelectNote;
    openDocRef.current = onOpenDoc;
    openFolderRef.current = onOpenFolder;
  }, [onSelectNote, onOpenDoc, onOpenFolder]);
  useEffect(() => {
    activeRef.current = activeNoteId;
  }, [activeNoteId]);

  const docMap = useMemo(() => new Map((docs || []).map((doc) => [String(doc.id), doc])), [docs]);
  const docMapRef = useRef(docMap);
  useEffect(() => {
    docMapRef.current = docMap;
  }, [docMap]);

  /* 三层结构：分类 → 论文 → 笔记 */
  const graphData = useMemo(() => {
    const folderMap = new Map((folders || []).map((folder) => [String(folder.id), folder]));
    const nodes = [];
    const links = [];
    const folderNodes = new Map();
    const docNodes = new Map();
    const ORPHAN_ID = '__orphan__';
    let hasOrphan = false;
    let docTotal = 0;

    const ensureFolder = (folderId) => {
      const key = folderId == null ? '__none__' : String(folderId);
      if (folderNodes.has(key)) return folderNodes.get(key);
      const folder = folderId == null ? null : folderMap.get(key);
      const node = {
        id: `folder-${key}`,
        kind: folder ? 'folder' : 'folder-uncat',
        label: folder ? folder.name : '未分类',
        folderId: folderId == null ? null : Number(folderId),
        color: folder && folder.color ? folder.color : null,
        val: 7,
      };
      folderNodes.set(key, node);
      nodes.push(node);
      return node;
    };

    for (const note of notes) {
      const docKey = note.doc_id ? String(note.doc_id) : null;
      let docNodeId = null;

      if (docKey) {
        if (!docNodes.has(docKey)) {
          const doc = docMap.get(docKey) || null;
          const folderNode = ensureFolder(doc ? doc.folder_id : null);
          const node = {
            id: `doc-${docKey}`,
            kind: 'doc',
            label: (doc && doc.title) || note.doc_title || `文献 #${docKey}`,
            docId: doc ? doc.id : Number(docKey),
            folderId: doc ? doc.folder_id : null,
            val: 3.6,
          };
          docNodes.set(docKey, node);
          nodes.push(node);
          // 分类 → 论文：连线沿用分类颜色，视觉上按分类分组
          links.push({ source: folderNode.id, target: node.id, level: 1, color: folderNode.color });
          docTotal += 1;
        }
        docNodeId = docNodes.get(docKey).id;
      }

      const noteNode = {
        id: `note-${note.id}`,
        kind: 'note',
        label: note.title || '无标题笔记',
        noteId: note.id,
        docId: note.doc_id || null,
        val: 1.4,
      };
      nodes.push(noteNode);
      if (docNodeId) {
        links.push({ source: docNodeId, target: noteNode.id, level: 2 });
      } else {
        hasOrphan = true;
        links.push({ source: ORPHAN_ID, target: noteNode.id, level: 2 });
      }
    }

    if (hasOrphan) nodes.push({ id: ORPHAN_ID, kind: 'orphan', label: '未归档笔记', val: 5.6 });

    return {
      nodes,
      links,
      folderTotal: folderNodes.size,
      docTotal,
    };
  }, [notes, docs, folders]);

  /* 图结构签名：结构没变就不重新灌数据，避免上游无关重渲染把布局一次次重启 */
  const graphSignature = useMemo(
    () =>
      graphData.nodes.map((node) => `${node.id}|${node.kind}|${node.label}`).join('~') +
      '#' +
      graphData.links.map((link) => `${link.source}>${link.target}:${link.level}:${link.color || ''}`).join('~'),
    [graphData]
  );

  /* 初始化 3D 场景（只做一次） */
  useEffect(() => {
    let disposed = false;
    (async () => {
      try {
        const { ForceGraph3D, THREE } = await loadLib();
        if (disposed || !wrapRef.current) return;
        threeRef.current = THREE;

        const el = wrapRef.current;
        const rect = el.getBoundingClientRect();
        const width = Math.max(320, Math.round(rect.width || 800));
        const height = Math.max(320, Math.round(rect.height || 480));

        const graph = ForceGraph3D({ controlType: 'orbit' })(el)
          .width(width)
          .height(height)
          .backgroundColor('rgba(0,0,0,0)')
          .showNavInfo(false)
          .cooldownTicks(150)
          .cooldownTime(2800)
          .d3AlphaDecay(0.03)
          .d3VelocityDecay(0.3)
          .warmupTicks(20)
          .nodeRelSize(1)
          .nodeVal((node) => node.val || 1)
          .nodeLabel((node) => {
            if (node.kind === 'folder') return `分类：${node.label}`;
            if (node.kind === 'folder-uncat') return '未分类';
            if (node.kind === 'doc') return `论文：${node.label}`;
            if (node.kind === 'orphan') return '未归档笔记';
            return `笔记：${node.label}`;
          })
          .linkColor((link) => (link.level === 1 ? withAlpha(link.color, 0.42) : 'rgba(120, 156, 255, 0.22)'))
          .linkWidth((link) => (link.level === 1 ? 0.65 : 0.35))
          .linkOpacity(0.75)
          .linkDirectionalParticles((link) => (link.level === 1 ? 2 : 0))
          .linkDirectionalParticleWidth(1.5)
          .linkDirectionalParticleSpeed(0.004)
          .linkDirectionalParticleColor(() => 'rgba(178, 214, 255, 0.95)')
          .nodeThreeObject((node) => buildNodeObject(THREE, node, String(node.noteId) === String(activeRef.current)))
          .onNodeHover((node) => {
            if (el) el.style.cursor = node ? 'pointer' : 'default';
          })
          .onNodeClick((node) => {
            if (!node) return;
            if (node.kind === 'note') {
              if (selectRef.current) selectRef.current(node.noteId);
            } else if (node.kind === 'doc') {
              const doc = docMapRef.current.get(String(node.docId));
              if (doc && openDocRef.current) openDocRef.current(doc);
            } else if (node.kind === 'folder' || node.kind === 'folder-uncat') {
              // 「未分类」用 'none' 作为筛选值（与文献库一致）
              if (openFolderRef.current) openFolderRef.current(node.kind === 'folder-uncat' ? 'none' : node.folderId);
            }
          })
          .onEngineStop(() => {
            if (fittedRef.current) return;
            fittedRef.current = true;
            try {
              frameCamera(graph);
            } catch {
              /* 空图时忽略 */
            }
          });

        // 层级布局：分类→论文 更松，论文→笔记 更紧；再给一点向心引力
        try {
          const linkForce = graph.d3Force('link');
          if (linkForce && typeof linkForce.distance === 'function') {
            linkForce.distance((link) => (link.level === 1 ? 78 : 36));
            if (typeof linkForce.strength === 'function') {
              linkForce.strength((link) => (link.level === 1 ? 0.45 : 0.75));
            }
          }
          const chargeForce = graph.d3Force('charge');
          if (chargeForce && typeof chargeForce.strength === 'function') chargeForce.strength(-55);
          // 防止球体互相穿模/挤在一起
          graph.d3Force('collide', forceCollide((node) => nodeRadius(node) * 2.3).iterations(2));
          // 质心固定在原点，取景/相机才不会跑偏
          graph.d3Force('center', forceCenter(0, 0, 0));
          graph.d3Force('gravityX', forceX(0).strength(0.032));
          graph.d3Force('gravityY', forceY(0).strength(0.032));
          graph.d3Force('gravityZ', forceZ(0).strength(0.032));
        } catch {
          /* 忽略 */
        }

        try {
          const controls = graph.controls();
          if (controls) {
            controls.enableDamping = true;
            controls.dampingFactor = 0.12;
            controls.rotateSpeed = 0.9;
            controls.zoomSpeed = 1.1;
          }
        } catch {
          /* 忽略 */
        }

        graph.cameraPosition({ x: 0, y: 0, z: 360 });
        graphRef.current = graph;
        // 排查问题时可在控制台里设置 window.__NG_EXPOSE__ = true 再打开关系图
        if (typeof window !== 'undefined' && window.__NG_EXPOSE__) window.__notesGraph = graph;
        setReady(true);
      } catch (err) {
        console.error('[notes-graph] 初始化 3D 场景失败', err);
        if (!disposed) setError(err);
      }
    })();

    return () => {
      disposed = true;
      const graph = graphRef.current;
      graphRef.current = null;
      setReady(false);
      try {
        if (graph && typeof graph._destructor === 'function') graph._destructor();
      } catch {
        /* 忽略销毁异常 */
      }
      if (wrapRef.current) wrapRef.current.innerHTML = '';
    };
  }, []);

  /* 数据变化 → 重新喂给力导向图 */
  useEffect(() => {
    const graph = graphRef.current;
    if (!graph || !ready) return;
    if (lastSigRef.current === graphSignature) return;
    lastSigRef.current = graphSignature;
    try {
      if (lastCountRef.current !== graphData.nodes.length) {
        lastCountRef.current = graphData.nodes.length;
        fittedRef.current = false;
      }
      const clone = {
        nodes: graphData.nodes.map((node) => ({ ...node })),
        links: graphData.links.map((link) => ({ ...link })),
      };
      graph.graphData(clone);
      for (const delay of [600, 1400, 2600]) {
        setTimeout(() => {
          try {
            if (graphRef.current === graph) frameCamera(graph);
          } catch {
            /* 忽略 */
          }
        }, delay);
      }
    } catch (err) {
      console.error('[notes-graph] 载入图数据失败', err);
      setError(err);
    }
  }, [graphData, graphSignature, ready]);

  /* 容器尺寸变化 → 同步画布大小 */
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return undefined;
    const resize = () => {
      const graph = graphRef.current;
      const rect = el.getBoundingClientRect();
      if (!graph || !rect.width || !rect.height) return;
      try {
        graph.width(Math.round(rect.width)).height(Math.round(rect.height));
      } catch (err) {
        console.warn('[notes-graph] 调整画布尺寸失败', err);
      }
    };
    let observer = null;
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(resize);
      observer.observe(el);
    }
    window.addEventListener('resize', resize);
    resize();
    return () => {
      if (observer) observer.disconnect();
      window.removeEventListener('resize', resize);
    };
  }, []);

  /* 当前笔记高亮：直接改材质颜色，不重跑布局 */
  useEffect(() => {
    const graph = graphRef.current;
    if (!graph || !ready) return;
    if (!threeRef.current) return;
    try {
      const data = graph.graphData();
      for (const node of data.nodes || []) {
        const active = node.kind === 'note' && String(node.noteId) === String(activeNoteId);
        const color = nodeColor(node, active);
        if (node.__mesh && node.__mesh.material) {
          node.__mesh.material.color.set(color);
          if (node.__mesh.material.emissive) {
            node.__mesh.material.emissive.set(color);
            node.__mesh.material.emissiveIntensity = active ? 0.6 : node.kind === 'folder' ? 0.35 : 0.26;
          }
        }
        if (node.__halo && node.__halo.material) node.__halo.material.color.set(color);
        if (node.__ring && node.__ring.material) node.__ring.material.color.set(color);
      }
    } catch (err) {
      console.warn('[notes-graph] 更新高亮失败', err);
    }
  }, [activeNoteId, ready]);

  const fitView = useCallback(() => {
    const graph = graphRef.current;
    if (graph) {
      try {
        frameCamera(graph, 600);
      } catch {
        /* 忽略 */
      }
    }
  }, []);

  const hasNotes = notes.length > 0;

  return (
    <div className="notes-graph">
      <div className="notes-graph-head">
        <span className="notes-graph-count">
          {graphData.folderTotal} 个分类 · {graphData.docTotal} 篇论文 · {notes.length} 条笔记
        </span>
        <span className="notes-graph-legend">
          <span>
            <i className="ng-dot folder" />
            分类
          </span>
          <span>
            <i className="ng-dot doc" />
            论文
          </span>
          <span>
            <i className="ng-dot note" />
            笔记
          </span>
          <span className="muted">点节点跳转 · 拖拽旋转 · 滚轮缩放</span>
        </span>
        <button type="button" className="ghost-btn tiny" onClick={fitView} disabled={!ready}>
          适应视图
        </button>
      </div>
      <div className="notes-graph-canvas notes-graph-3d">
        {/* 3D 库会往这个容器里塞 canvas，所以它必须完全交给第三方管理：
            React 只渲染这一个空 div，不再往里放任何子节点，否则会和库的 DOM 操作打架。 */}
        <div className="notes-graph-stage" ref={wrapRef} />
        {!hasNotes && <div className="notes-graph-empty">还没有笔记，创建一条后这里会显示「分类 → 论文 → 笔记」的关联关系</div>}
        {hasNotes && error ? (
          <div className="notes-graph-empty">
            3D 场景初始化失败（当前环境可能不支持 WebGL）：{String(error && error.message ? error.message : error)}
            <br />
            可以切到左上角的「☰ 列表」继续使用。
          </div>
        ) : null}
        {hasNotes && !error && !ready ? <div className="notes-graph-loading">正在加载 3D 关系图…</div> : null}
      </div>
    </div>
  );
}
