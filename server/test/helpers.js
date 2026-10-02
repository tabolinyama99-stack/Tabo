import request from 'supertest';
import { pool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { createApp } from '../src/app.js';
import { createSuperAdmin } from '../src/db/create-super-admin.js';

export const app = createApp();
export const ADMIN = { email: 'super@test.local', password: 'SuperSecret123' };

export async function resetDb() {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate({ log: false });
  const { company } = await createSuperAdmin({ ...ADMIN, name: 'Test Super Admin', companyName: 'Test Co Ltd' });
  return company;
}

/** A logged-in agent that sends the CSRF header automatically. */
export async function login(email = ADMIN.email, password = ADMIN.password) {
  const agent = request.agent(app);
  const res = await agent.post('/api/auth/login').send({ email, password });
  if (res.status !== 200) throw new Error(`login failed for ${email}: ${res.status} ${JSON.stringify(res.body)}`);
  const csrf = res.body.csrf_token;
  const wrap = (m) => (url) => agent[m](url).set('X-CSRF-Token', csrf);
  return { agent, csrf, get: (u) => agent.get(u), post: wrap('post'), put: wrap('put'), del: wrap('delete') };
}

export async function accountId(companyId, key) {
  return (await pool.query('SELECT id FROM accounts WHERE company_id=$1 AND (system_key=$2 OR code=$2)', [companyId, key])).rows[0].id;
}
export async function taxId(companyId, code = 'VAT16') {
  return (await pool.query('SELECT id FROM tax_rates WHERE company_id=$1 AND code=$2', [companyId, code])).rows[0].id;
}
export const today = () => new Date().toISOString().slice(0, 10);
export { pool, request };
