'use strict';
/**
 * MySQL 数据访问层：连接池、建库、建表、查询封装。
 */
const mysql = require('mysql2/promise');
const fs = require('node:fs');
const path = require('node:path');

const state = {
  connected: false,
  error: null,
  serverVersion: null,
  database: null,
  host: null,
  schemaReady: false,
};

let pool = null;

function baseOptions(cfg) {
  return {
    host: cfg.host,
    port: Number(cfg.port) || 3306,
    user: cfg.user,
    password: cfg.password || '',
    charset: 'utf8mb4',
    timezone: 'local',
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: false,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
  };
}

/** 把 mysql2 的原始错误翻译成用户能看懂的提示 */
function friendlyError(err, cfg = {}) {
  const code = err && err.code;
  const where = `${cfg.user || 'root'}@${cfg.host || '127.0.0.1'}:${Number(cfg.port) || 3306}`;
  let message = null;
  switch (code) {
    case 'ER_ACCESS_DENIED_ERROR':
      message = `MySQL 拒绝访问（${where}）：用户名或密码不正确。请填写该 MySQL 账号的真实密码后重试。`;
      break;
    case 'ECONNREFUSED':
      message = `无法连接 MySQL（${where}）：端口未监听，请确认本机 MySQL 服务已启动。`;
      break;
    case 'ETIMEDOUT':
    case 'ENOTFOUND':
    case 'EHOSTUNREACH':
      message = `连接 MySQL 超时或主机不可达（${where}），请检查主机与端口。`;
      break;
    case 'ER_BAD_DB_ERROR':
      message = `数据库 ${cfg.database || ''} 不存在，请重新执行“保存并初始化”以自动建库。`;
      break;
    default:
      break;
  }
  if (!message) return err;
  const wrapped = new Error(message);
  wrapped.code = code;
  wrapped.cause = err;
  return wrapped;
}

function assertDatabaseName(name) {
  if (!/^[A-Za-z0-9_]{1,64}$/.test(String(name || ''))) {
    throw new Error('数据库名只能包含字母、数字与下划线');
  }
  return name;
}

/** 建库（幂等） */
async function ensureDatabase(cfg) {
  const dbName = assertDatabaseName(cfg.database);
  const conn = await mysql.createConnection({ ...baseOptions(cfg), multipleStatements: true });
  try {
    await conn.query(
      `CREATE DATABASE IF NOT EXISTS \`${dbName}\` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
    );
  } finally {
    await conn.end().catch(() => {});
  }
  return dbName;
}

/** 执行 schema.sql（幂等：全部使用 CREATE TABLE IF NOT EXISTS） */
async function runSchema(cfg) {
  const schemaPath = path.join(__dirname, 'schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf8');
  const conn = await mysql.createConnection({
    ...baseOptions(cfg),
    database: cfg.database,
    multipleStatements: true,
  });
  try {
    await conn.query(sql);
  } finally {
    await conn.end().catch(() => {});
  }
  state.schemaReady = true;
}

/**
 * 轻量迁移：给已有库补上新增列（schema.sql 的 CREATE TABLE IF NOT EXISTS 不会改动老表）。
 * 每一项都是幂等的，重复执行无副作用。
 */
const COLUMN_MIGRATIONS = [
  {
    table: 'pr_doc_info',
    column: 'stored_path',
    ddl: "ALTER TABLE pr_doc_info ADD COLUMN stored_path VARCHAR(512) NULL COMMENT '库内相对路径（含分类目录，/ 分隔）' AFTER file_name",
  },
  {
    table: 'pr_doc_info',
    column: 'orig_name',
    ddl: "ALTER TABLE pr_doc_info ADD COLUMN orig_name VARCHAR(255) NULL COMMENT '导入时的原始文件名' AFTER stored_path",
  },
];

async function ensureColumns(database) {
  const applied = [];
  for (const item of COLUMN_MIGRATIONS) {
    const row = await queryOne(
      `SELECT COUNT(*) AS cnt FROM information_schema.columns
        WHERE table_schema = ? AND table_name = ? AND column_name = ?`,
      [database, item.table, item.column]
    );
    if (row && Number(row.cnt) > 0) continue;
    try {
      await execute(item.ddl);
      applied.push(`${item.table}.${item.column}`);
    } catch (err) {
      // 并发启动/权限不足时不让整个初始化失败，只记录
      console.warn('[db] 迁移列失败：', item.table, item.column, err && err.message);
    }
  }
  return applied;
}

/** 建立连接池并校验连通性 */
async function connect(cfg) {
  await close();
  pool = mysql.createPool({ ...baseOptions(cfg), database: cfg.database, multipleStatements: false });
  const conn = await pool.getConnection();
  try {
    const [rows] = await conn.query('SELECT VERSION() AS version, DATABASE() AS db_name');
    state.connected = true;
    state.error = null;
    state.serverVersion = rows[0].version;
    state.database = rows[0].db_name;
    state.host = `${cfg.host}:${cfg.port}`;
  } finally {
    conn.release();
  }
  return state;
}

/** 初始化：建库 → 建表 → 建立池 → 补列 */
async function init(cfg) {
  try {
    await ensureDatabase(cfg);
    await runSchema(cfg);
    const info = await connect(cfg);
    // 校验表是否齐备
    const [tables] = await getPool().query(
      `SELECT COUNT(*) AS cnt FROM information_schema.tables
        WHERE table_schema = ? AND table_name LIKE 'pr\\_%'`,
      [cfg.database]
    );
    const migrated = await ensureColumns(cfg.database);
    if (migrated.length) console.log('[db] 已补充列：', migrated.join(', '));
    return { ...info, tableCount: Number(tables[0].cnt), migrated };
  } catch (err) {
    throw friendlyError(err, cfg);
  }
}

/** 只测试连通性，不建库 */
async function test(cfg) {
  try {
    const conn = await mysql.createConnection({ ...baseOptions(cfg), connectTimeout: 5000 });
    try {
      const [rows] = await conn.query('SELECT VERSION() AS version');
      return { ok: true, serverVersion: rows[0].version };
    } finally {
      await conn.end().catch(() => {});
    }
  } catch (err) {
    throw friendlyError(err, cfg);
  }
}

async function close() {
  if (pool) {
    const p = pool;
    pool = null;
    state.connected = false;
    await p.end().catch(() => {});
  }
}

function getPool() {
  if (!pool) throw new Error('数据库尚未连接，请先在设置中完成数据库配置');
  return pool;
}

async function query(sql, params = []) {
  const [rows] = await getPool().query(sql, params);
  return rows;
}

async function queryOne(sql, params = []) {
  const rows = await query(sql, params);
  return rows[0] || null;
}

async function execute(sql, params = []) {
  const [result] = await getPool().execute(sql, params);
  return result;
}

/** 事务封装 */
async function transaction(fn) {
  const conn = await getPool().getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
}

function status() {
  return { ...state };
}

module.exports = {
  init,
  connect,
  close,
  test,
  query,
  queryOne,
  execute,
  transaction,
  status,
  getPool,
  ensureColumns,
};
