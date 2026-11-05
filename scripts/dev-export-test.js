'use strict';
/**
 * 开发用：不经过界面直接验证导出逻辑（Markdown 与标注版 PDF）。
 *   node scripts/dev-export-test.js --port=3306 --user=root --password=xxx
 */
const fs = require('node:fs');
const path = require('node:path');
const db = require('../electron/db');
const { buildMarkdown, renderAnnotatedPdf, loadDocBundle } = require('../electron/ipc/export');

function parseArgs(argv) {
  const out = {};
  for (const item of argv) {
    const m = item.match(/^--([^=]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function userDataDir() {
  return path.join(process.env.APPDATA || process.env.HOME || '.', 'paper-reader');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cfg = {
    host: args.host || '127.0.0.1',
    port: Number(args.port || 3306),
    user: args.user || 'root',
    password: args.password !== undefined ? args.password : '',
    database: args.database || 'paper_reader',
  };
  await db.init(cfg);

  const doc = await db.queryOne('SELECT id, title, file_name FROM pr_doc_info WHERE is_deleted = 0 ORDER BY id LIMIT 1');
  if (!doc) throw new Error('库中没有文献，请先运行 scripts/dev-seed.js');

  const bundle = await loadDocBundle(doc.id);
  const outDir = path.join(__dirname, '..', '.smoke');
  fs.mkdirSync(outDir, { recursive: true });

  const md = buildMarkdown(bundle);
  const mdPath = path.join(outDir, 'export-sample.md');
  fs.writeFileSync(mdPath, md, 'utf8');
  console.log(`[export-test] Markdown -> ${mdPath} (${md.length} 字节, ${bundle.annos.length} 条标注)`);

  const pdfBytes = fs.readFileSync(path.join(userDataDir(), 'library', doc.file_name));
  const out = await renderAnnotatedPdf(pdfBytes, bundle);
  const pdfPath = path.join(outDir, 'export-sample.pdf');
  fs.writeFileSync(pdfPath, out);
  console.log(`[export-test] 标注版 PDF -> ${pdfPath} (${out.length} 字节)`);

  await db.close();
}

main().catch(async (err) => {
  console.error('[export-test] 失败：', err.message);
  await db.close().catch(() => {});
  process.exit(1);
});
