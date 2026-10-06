/**
 * db.js — Postgres 持久化层（Railway 注入 DATABASE_URL 时启用；本地无 DATABASE_URL 则回退到 JSON 文件）
 * 设计：内存数组仍是运行时真源，本模块只负责"启动时加载"和"变更时写回"，
 *       最大程度复用现有逻辑，避免大改每个接口。
 */

let pool = null;
const hasDb = !!process.env.DATABASE_URL;

if (hasDb) {
  const { Pool } = require('pg');
  const isLocal = /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL);
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: isLocal ? false : { rejectUnauthorized: false }
  });
}

// 建表（幂等）
async function init() {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_state (
      id INT PRIMARY KEY,
      data JSONB,
      updated_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS uploads (
      name TEXT PRIMARY KEY,
      data BYTEA,
      content_type TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);
}

async function loadState() {
  if (!pool) return null;
  const r = await pool.query('SELECT data FROM app_state WHERE id = 1');
  return r.rows[0] ? r.rows[0].data : null;
}

async function saveState(state) {
  if (!pool) return;
  await pool.query(
    'INSERT INTO app_state (id, data, updated_at) VALUES (1, $1, now()) ON CONFLICT (id) DO UPDATE SET data = $1, updated_at = now()',
    [JSON.stringify(state)]
  );
}

async function saveUpload(name, buffer, contentType) {
  if (!pool) return false;
  await pool.query(
    'INSERT INTO uploads (name, data, content_type) VALUES ($1, $2, $3) ON CONFLICT (name) DO UPDATE SET data = $2, content_type = $3',
    [name, buffer, contentType || 'application/octet-stream']
  );
  return true;
}

async function getUpload(name) {
  if (!pool) return null;
  const r = await pool.query('SELECT data, content_type FROM uploads WHERE name = $1', [name]);
  return r.rows[0] || null;
}

module.exports = { hasDb, init, loadState, saveState, saveUpload, getUpload };
