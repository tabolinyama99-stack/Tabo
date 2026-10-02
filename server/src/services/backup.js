// Database & configuration backups. Database backup/restore is Super Admin only.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { badRequest, notFound } from '../lib/errors.js';

function run(cmd, args, { input } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { env: { ...process.env } });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    if (input) { p.stdin.write(input); p.stdin.end(); }
    p.on('error', (e) => reject(new Error(`${cmd} is not available: ${e.message}`)));
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.trim().split('\n').slice(-3).join(' ') || `${cmd} exited with ${code}`))));
  });
}

async function finish(kind, file, ctx, companyId, notes) {
  const data = await fs.readFile(file);
  const sha = crypto.createHash('sha256').update(data).digest('hex');
  const { rows: [b] } = await pool.query(`INSERT INTO backups (kind, company_id, filename, size_bytes, sha256, notes, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [kind, companyId || null, path.basename(file), data.length, sha, notes || null, ctx.user?.id || null]);
  await audit(ctx, kind === 'DATABASE' ? 'backup.database_created' : 'backup.config_created', { entityType: 'backup', entityId: b.id, newValue: { filename: b.filename, size: b.size_bytes, sha256: sha } });
  return b;
}

export async function databaseBackup(ctx, notes) {
  await fs.mkdir(config.backupDir, { recursive: true });
  const file = path.join(config.backupDir, `tael-db-${new Date().toISOString().replace(/[:.]/g, '-')}.dump`);
  await run('pg_dump', ['--format=custom', '--no-owner', '--no-privileges', `--file=${file}`, config.databaseUrl]);
  return finish('DATABASE', file, ctx, null, notes);
}

const CONFIG_TABLES = { companies: 'id', roles: 'company_id', branches: 'company_id', departments: 'company_id', warehouses: 'company_id', tax_rates: 'company_id', number_sequences: 'company_id' };

export async function configBackup(ctx, companyId, notes) {
  await fs.mkdir(config.backupDir, { recursive: true });
  const out = { format: 'tael-config-v1', created_at: new Date().toISOString(), company_id: companyId, data: {} };
  for (const [t, key] of Object.entries(CONFIG_TABLES)) out.data[t] = (await pool.query(`SELECT * FROM ${t} WHERE ${key}=$1`, [companyId])).rows;
  const file = path.join(config.backupDir, `tael-config-c${companyId}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  await fs.writeFile(file, JSON.stringify(out, null, 2), { mode: 0o600 });
  return finish('CONFIG', file, ctx, companyId, notes);
}

/** Restore settings, numbering, roles' permissions and tax rates from a config backup (never touches transactions). */
export async function restoreConfig(ctx, companyId, json) {
  if (json?.format !== 'tael-config-v1') throw badRequest('This is not a TAEL Books configuration backup.');
  const c = json.data.companies?.[0];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (c) await client.query(`UPDATE companies SET settings=$2, legal_name=$3, tpin=$4, vat_number=$5, address=$6, phone=$7, email=$8, website=$9, updated_at=now() WHERE id=$1`,
      [companyId, c.settings, c.legal_name, c.tpin, c.vat_number, c.address, c.phone, c.email, c.website]);
    for (const r of json.data.roles || []) await client.query(`INSERT INTO roles (company_id, name, description, is_system, permissions, transaction_limit) VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT (company_id, name) DO UPDATE SET permissions=EXCLUDED.permissions, description=EXCLUDED.description, transaction_limit=EXCLUDED.transaction_limit`,
      [companyId, r.name, r.description, r.is_system, r.permissions, r.transaction_limit]);
    for (const s of json.data.number_sequences || []) await client.query(`UPDATE number_sequences SET prefix=$3, suffix=$4, padding=$5 WHERE company_id=$1 AND key=$2`, [companyId, s.key, s.prefix, s.suffix, s.padding]);
    for (const t of json.data.tax_rates || []) await client.query(`UPDATE tax_rates SET name=$4, rate=$5, effective_to=$6, is_active=$7, description=$8 WHERE company_id=$1 AND code=$2 AND effective_from=$3`,
      [companyId, t.code, t.effective_from, t.name, t.rate, t.effective_to, t.is_active, t.description]);
    await audit(ctx, 'backup.config_restored', { entityType: 'company', entityId: companyId, newValue: { from: json.created_at } }, client);
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}

export async function backupFile(id) {
  const { rows: [b] } = await pool.query('SELECT * FROM backups WHERE id=$1', [id]);
  if (!b) throw notFound('Backup');
  const file = path.join(config.backupDir, path.basename(b.filename));
  return { backup: b, file };
}

/** Full database restore from a stored dump. Super Admin only; requires typed confirmation upstream. */
export async function restoreDatabase(ctx, id) {
  const { backup, file } = await backupFile(id);
  if (backup.kind !== 'DATABASE') throw badRequest('Choose a database backup.');
  const data = await fs.readFile(file);
  if (crypto.createHash('sha256').update(data).digest('hex') !== backup.sha256) throw badRequest('Backup file checksum does not match; restore aborted.');
  // Safety copy first
  const safety = await databaseBackup(ctx, `Automatic safety backup before restoring #${id}`);
  await run('pg_restore', ['--clean', '--if-exists', '--no-owner', '--no-privileges', '--single-transaction', `--dbname=${config.databaseUrl}`, file]);
  // The restored database predates the safety backup: record it again so it stays visible in Backups.
  await pool.query(`INSERT INTO backups (kind, filename, size_bytes, sha256, notes, created_by) SELECT 'DATABASE', $1, $2, $3, $4, NULL WHERE NOT EXISTS (SELECT 1 FROM backups WHERE filename=$1)`,
    [safety.filename, safety.size_bytes, safety.sha256, safety.notes]);
  await pool.query('DELETE FROM sessions');
  await audit(ctx, 'backup.database_restored', { entityType: 'backup', entityId: id, newValue: { safety_backup: safety.filename } });
  return { restored: id, safety_backup: safety.id };
}
