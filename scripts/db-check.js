'use strict';
/**
 * 命令行自检：查看表结构与各表数据量。
 *   npm run db:check -- --user=root --password=yourpass
 */
const db = require('../electron/db');

function parseArgs(argv) {
  const out = {};
  for (const item of argv) {
    const m = item.match(/^--([^=]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
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
  const tables = await db.query(
    `SELECT table_name AS name, table_comment AS comment FROM information_schema.tables
      WHERE table_schema = ? AND table_name LIKE 'pr\\_%' ORDER BY table_name`,
    [cfg.database]
  );
  const rows = [];
  for (const t of tables) {
    const safe = String(t.name).replace(/`/g, '');
    const stat = await db.queryOne(`SELECT COUNT(*) AS cnt FROM \`${safe}\``);
    rows.push({ 表名: t.name, 说明: t.comment, 行数: Number(stat.cnt) });
  }
  console.table(rows);
  await db.close();
}

main().catch(async (err) => {
  console.error('[db:check] 失败：', err.message);
  await db.close().catch(() => {});
  process.exit(1);
});
