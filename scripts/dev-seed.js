'use strict';
/**
 * 开发用示例数据：生成一份演示 PDF，写入文库并插入分类 / 标签 / 标注 / 阅读记录。
 * 仅用于本地联调与冒烟测试，正式使用请在界面里导入自己的文献。
 *
 *   node scripts/dev-seed.js --port=3306 --user=root --password=xxx --database=paper_reader
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const db = require('../electron/db');

function parseArgs(argv) {
  const out = {};
  for (const item of argv) {
    const m = item.match(/^--([^=]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

const APP_NAME = 'paper-reader';

function userDataDir() {
  return path.join(process.env.APPDATA || process.env.HOME || '.', APP_NAME);
}

const LINES = [
  'Attention Is All You Need (demo paper)',
  'Ashish Vaswani, Noam Shazeer, Niki Parmar, Jakob Uszkoreit',
  '',
  'Abstract',
  'The dominant sequence transduction models are based on complex recurrent or',
  'convolutional neural networks that include an encoder and a decoder. The best',
  'performing models also connect the encoder and decoder through an attention',
  'mechanism. We propose a new simple network architecture, the Transformer,',
  'based solely on attention mechanisms, dispensing with recurrence and',
  'convolutions entirely. Experiments on two machine translation tasks show',
  'these models to be superior in quality while being more parallelizable and',
  'requiring significantly less time to train.',
  '',
  '1. Introduction',
  'Recurrent neural networks, long short-term memory and gated recurrent neural',
  'networks in particular, have been firmly established as state of the art',
  'approaches in sequence modeling and transduction problems such as language',
  'modeling and machine translation.',
  '',
  '2. Background',
  'The goal of reducing sequential computation also forms the foundation of the',
  'Extended Neural GPU, ByteNet and ConvS2S, all of which use convolutional',
  'neural networks as basic building block, computing hidden representations in',
  'parallel for all input and output positions.',
];

async function buildPdf() {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  const layout = [];
  for (let p = 0; p < 2; p += 1) {
    const page = pdf.addPage([595.28, 841.89]);
    let y = 780;
    const slice = p === 0 ? LINES : LINES.slice(12);
    for (const line of slice) {
      if (!line) {
        y -= 10;
        continue;
      }
      const isHeading = /^\d\.|^Abstract/.test(line) || line.includes('(demo paper)');
      page.drawText(line, {
        x: 60,
        y,
        size: isHeading ? 13 : 10,
        font: isHeading ? bold : font,
        color: rgb(0.12, 0.12, 0.16),
        maxWidth: 480,
      });
      layout.push({ page: p + 1, text: line, y, height: isHeading ? 14 : 11 });
      y -= isHeading ? 24 : 16;
    }
  }
  const bytes = await pdf.save();
  return { bytes: Buffer.from(bytes), layout };
}

function normRect(layout, page, index, widthRatio = 0.82) {
  const item = layout.filter((l) => l.page === page)[index];
  if (!item) return [{ x: 0.1, y: 0.5, w: 0.6, h: 0.02 }];
  return [
    {
      x: 60 / 595.28,
      y: (item.y - 2) / 841.89,
      w: (480 * widthRatio) / 595.28,
      h: (item.height + 3) / 841.89,
    },
  ];
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cfg = {
    host: args.host || process.env.PR_DB_HOST || '127.0.0.1',
    port: Number(args.port || process.env.PR_DB_PORT || 3306),
    user: args.user || process.env.PR_DB_USER || 'root',
    password: args.password !== undefined ? args.password : process.env.PR_DB_PASSWORD || '',
    database: args.database || process.env.PR_DB_NAME || 'paper_reader',
  };

  await db.init(cfg);

  const { bytes, layout } = await buildPdf();
  const libDir = path.join(userDataDir(), 'library');
  fs.mkdirSync(libDir, { recursive: true });
  const hash = crypto.createHash('sha256').update(bytes).digest('hex');
  const fileName = `${hash.slice(0, 16)}.pdf`;
  fs.writeFileSync(path.join(libDir, fileName), bytes);

  const existed = await db.queryOne('SELECT id FROM pr_doc_info WHERE file_hash = ?', [hash]);
  let docId = existed && existed.id;
  if (!docId) {
    const res = await db.execute(
      `INSERT INTO pr_doc_info (title, authors, year, journal, abstract, file_name, file_hash, file_size, page_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        'Attention Is All You Need（示例文献）',
        'Vaswani, A.; Shazeer, N.; Parmar, N.; Uszkoreit, J.',
        2017,
        'NeurIPS',
        '提出完全基于注意力机制的 Transformer 架构，抛弃循环与卷积结构，在机器翻译任务上取得更好质量且更易并行训练。',
        fileName,
        hash,
        bytes.length,
        2,
      ]
    );
    docId = res.insertId;
  } else {
    await db.execute('UPDATE pr_doc_info SET is_deleted = 0, file_name = ? WHERE id = ?', [fileName, docId]);
  }

  // 分类
  const folder = await db.queryOne('SELECT id FROM pr_folder_info WHERE name = ?', ['深度学习']);
  let folderId = folder && folder.id;
  if (!folderId) {
    const r = await db.execute('INSERT INTO pr_folder_info (name, sort_no) VALUES (?, ?)', ['深度学习', 1]);
    folderId = r.insertId;
  }
  await db.execute('UPDATE pr_doc_info SET folder_id = ?, star = ? WHERE id = ?', [folderId, 4, docId]);

  // 标签
  for (const [name, color] of [
    ['Transformer', '#5b8def'],
    ['必读', '#ff4d4f'],
    ['注意力机制', '#52c41a'],
  ]) {
    let tag = await db.queryOne('SELECT id FROM pr_tag_info WHERE name = ?', [name]);
    if (!tag) {
      const r = await db.execute('INSERT INTO pr_tag_info (name, color) VALUES (?, ?)', [name, color]);
      tag = { id: r.insertId };
    }
    await db.execute('INSERT IGNORE INTO pr_doc_tag_rd (doc_id, tag_id) VALUES (?, ?)', [docId, tag.id]);
  }

  // 标注（无则创建）
  const annoCount = await db.queryOne('SELECT COUNT(*) AS cnt FROM pr_anno_info WHERE doc_id = ?', [docId]);
  if (!Number(annoCount.cnt)) {
    const items = [
      {
        page: 1,
        type: 'highlight',
        color: '#ff4d4f',
        quote: 'We propose a new simple network architecture, the Transformer, based solely on attention mechanisms',
        content: '核心贡献：完全用注意力替代循环结构，是本篇的立论基础。',
        rects: normRect(layout, 1, 7),
      },
      {
        page: 1,
        type: 'highlight',
        color: '#ffd400',
        quote: 'these models to be superior in quality while being more parallelizable',
        content: '并行化收益 → 训练更快，是后续工程落地的主要卖点。',
        rects: normRect(layout, 1, 10),
      },
      {
        page: 1,
        type: 'underline',
        color: '#5b8def',
        quote: 'dispensing with recurrence and convolutions entirely',
        content: '',
        rects: normRect(layout, 1, 9),
      },
      {
        page: 1,
        type: 'note',
        color: '#ff9f43',
        quote: '',
        content: '对照阅读：图 1 的编码器-解码器堆叠结构。',
        rects: [{ x: 0.86, y: 0.42, w: 0.016, h: 0.022 }],
      },
      {
        page: 2,
        type: 'box',
        color: '#ff4d4f',
        quote: '',
        content: '这一段是相关工作，注意与 ByteNet / ConvS2S 的对比。',
        rects: [{ x: 0.09, y: 0.14, w: 0.78, h: 0.12 }],
      },
    ];
    for (const item of items) {
      await db.execute(
        `INSERT INTO pr_anno_info (doc_id, page_no, anno_type, color, rects, ink_paths, quote, content, opacity)
         VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
        [
          docId,
          item.page,
          item.type,
          item.color,
          JSON.stringify(item.rects),
          item.quote || null,
          item.content || null,
          item.type === 'highlight' ? 0.35 : 0.9,
        ]
      );
    }
    await db.execute('UPDATE pr_doc_info SET anno_count = (SELECT COUNT(*) FROM pr_anno_info WHERE doc_id = ? AND is_deleted = 0) WHERE id = ?', [docId, docId]);
  }

  // 阅读记录
  const readCount = await db.queryOne('SELECT COUNT(*) AS cnt FROM pr_read_rd WHERE doc_id = ?', [docId]);
  if (!Number(readCount.cnt)) {
    await db.execute(
      'INSERT INTO pr_read_rd (doc_id, start_page, end_page, duration_sec, closed_at) VALUES (?, 1, 2, 640, NOW())',
      [docId]
    );
  }
  await db.execute('UPDATE pr_doc_info SET last_page = 1, last_read_at = NOW(), read_seconds = 640 WHERE id = ?', [docId]);

  console.log(`[dev-seed] 完成：docId=${docId} 文件=${path.join(libDir, fileName)}`);
  await db.close();
}

main().catch(async (err) => {
  console.error('[dev-seed] 失败：', err.message);
  await db.close().catch(() => {});
  process.exit(1);
});
