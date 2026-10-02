import pg from 'pg';
import { config } from '../config.js';

// DATE → plain 'YYYY-MM-DD' string (no timezone shifting). NUMERIC stays a string (never float).
pg.types.setTypeParser(1082, (v) => v);
// BIGINT ids fit safely in JS numbers for any realistic row count.
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  ssl: config.databaseSsl ? { rejectUnauthorized: false } : undefined,
  max: Number(process.env.DB_POOL_MAX || 10),
});

pool.on('error', (err) => console.error('[db] idle client error', err.message));

export async function query(text, params) {
  return pool.query(text, params);
}

/** Run fn inside a single database transaction. Any throw rolls everything back. */
export async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    throw err;
  } finally {
    client.release();
  }
}

/** Use an existing client if one is passed, otherwise open a transaction. */
export function withTx(db, fn) {
  return db && db !== pool ? fn(db) : tx(fn);
}
