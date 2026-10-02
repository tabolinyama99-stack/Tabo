import { pool } from '../db/pool.js';
import { encrypt, decrypt, mask } from '../lib/crypto.js';

export async function setSecret(companyId, key, value, userId) {
  if (value === null || value === '') {
    await pool.query('DELETE FROM secrets WHERE COALESCE(company_id,0)=COALESCE($1::bigint,0) AND key=$2', [companyId, key]);
    return;
  }
  await pool.query(
    `INSERT INTO secrets (company_id, key, ciphertext, updated_by) VALUES ($1,$2,$3,$4)
     ON CONFLICT (COALESCE(company_id,0), key) DO UPDATE SET ciphertext=EXCLUDED.ciphertext, updated_by=EXCLUDED.updated_by, updated_at=now()`,
    [companyId, key, encrypt(value), userId || null]);
}
export async function getSecret(companyId, key) {
  const { rows } = await pool.query('SELECT ciphertext FROM secrets WHERE COALESCE(company_id,0)=COALESCE($1::bigint,0) AND key=$2', [companyId, key]);
  if (!rows[0]) return null;
  try { return decrypt(rows[0].ciphertext); } catch { return null; }
}
export async function secretStatus(companyId, key) {
  const v = await getSecret(companyId, key);
  return { configured: !!v, preview: v ? mask(v) : null };
}
