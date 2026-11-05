'use strict';
/**
 * 应用配置：数据库连接信息与文献库目录。
 * 配置文件位于 userData/db-config.json，密码使用 Electron safeStorage 加密后落盘。
 */
const { app, safeStorage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULTS = {
  host: '127.0.0.1',
  port: 3306,
  user: 'root',
  password: '',
  database: 'paper_reader',
  /** 自定义文库目录；空字符串表示使用 userData/library */
  libraryPath: '',
};

function configFile() {
  return path.join(app.getPath('userData'), 'db-config.json');
}

/** 默认文库目录（userData/library） */
function defaultLibraryDir() {
  return path.join(app.getPath('userData'), 'library');
}

/** 文献 PDF 的本地存放目录：用户自定义优先，否则回落到默认目录 */
function libraryDir() {
  const custom = readConfig().libraryPath;
  if (custom && String(custom).trim()) {
    try {
      return path.resolve(String(custom).trim());
    } catch {
      return defaultLibraryDir();
    }
  }
  return defaultLibraryDir();
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 是否已存在用户保存过的连接配置（决定启动时要不要自动连库） */
function configExists() {
  try {
    return fs.existsSync(configFile());
  } catch {
    return false;
  }
}

function readConfig() {
  let raw = {};
  try {
    // 兼容带 BOM 的配置文件（Windows 记事本 / PowerShell 保存常见）
    const text = fs.readFileSync(configFile(), 'utf8').replace(/^\uFEFF/, '');
    raw = JSON.parse(text);
  } catch {
    raw = {};
  }
  const cfg = { ...DEFAULTS, ...raw };
  delete cfg.passwordEnc;
  if (raw.passwordEnc && raw.password) {
    try {
      cfg.password = safeStorage.decryptString(Buffer.from(raw.password, 'base64'));
    } catch {
      cfg.password = '';
    }
  }
  return cfg;
}

function writeConfig(input) {
  const cfg = { ...DEFAULTS, ...input };
  const out = {
    host: cfg.host,
    port: Number(cfg.port) || 3306,
    user: cfg.user,
    database: cfg.database,
    libraryPath: cfg.libraryPath ? path.resolve(String(cfg.libraryPath)) : '',
  };
  if (cfg.password && safeStorage.isEncryptionAvailable()) {
    out.password = safeStorage.encryptString(String(cfg.password)).toString('base64');
    out.passwordEnc = true;
  } else {
    out.password = cfg.password || '';
  }
  ensureDir(path.dirname(configFile()));
  fs.writeFileSync(configFile(), JSON.stringify(out, null, 2), 'utf8');
  return readConfig();
}

/** 对外展示用（隐去密码） */
function publicConfig(cfg = readConfig()) {
  return { host: cfg.host, port: cfg.port, user: cfg.user, database: cfg.database, hasPassword: Boolean(cfg.password) };
}

module.exports = {
  readConfig,
  writeConfig,
  publicConfig,
  configExists,
  libraryDir,
  defaultLibraryDir,
  ensureDir,
  configFile,
  DEFAULTS,
};
