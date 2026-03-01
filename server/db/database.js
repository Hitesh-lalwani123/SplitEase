const { Pool } = require('pg');
const crypto = require('crypto');

let pool;

function generateJoinCode() {
  return crypto.randomBytes(3).toString('hex').toUpperCase();
}

function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('neon')
        ? { rejectUnauthorized: false }
        : false,
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    });

    pool.on('error', (err) => {
      console.error('Unexpected pg pool error', err);
    });
  }
  return pool;
}

/**
 * Shorthand query helper.
 * @param {string} text  – SQL with $1/$2/… placeholders
 * @param {any[]}  params – parameter array
 */
async function query(text, params) {
  const p = getPool();
  return p.query(text, params);
}

/**
 * Run a sequence of statements inside a single transaction.
 * @param {(client: import('pg').PoolClient) => Promise<T>} fn
 */
async function withTransaction(fn) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { getPool, query, withTransaction, generateJoinCode };
