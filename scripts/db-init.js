'use strict';
/**
 * 命令行初始化数据库（等价于应用内“初始化数据库”按钮）。
 *
 * 用法：
 *   npm run db:init -- --host=127.0.0.1 --port=3306 --user=root --password=yourpass --database=paper_reader
 * 或使用环境变量：
 *   PR_DB_HOST / PR_DB_PORT / PR_DB_USER / PR_DB_PASSWORD / PR_DB_NAME
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

  console.log(`[db:init] 目标 ${cfg.user}@${cfg.host}:${cfg.port}/${cfg.database}`);
  const info = await db.init(cfg);
  console.log('[db:init] 完成：', info);

  const tables = await db.query(
    `SELECT table_name, table_rows FROM information_schema.tables
      WHERE table_schema = ? AND table_name LIKE 'pr\\_%' ORDER BY table_name`,
    [cfg.database]
  );
  console.table(tables.map((t) => ({ 表名: t.table_name ?? t.TABLE_NAME, 估算行数: t.table_rows ?? t.TABLE_ROWS })));
  await db.close();
}

main().catch(async (err) => {
  console.error('[db:init] 失败：', err.message);
  await db.close().catch(() => {});
  process.exit(1);
});
