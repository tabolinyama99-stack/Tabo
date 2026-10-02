// Admin Control Center APIs: company, branding, settings, users, roles, organisation,
// periods, numbering, tax, integrations/API keys, backups, audit, import/export.
import { Router } from 'express';
import multer from 'multer';
import fs from 'node:fs/promises';
import { pool, tx } from '../db/pool.js';
import { asyncH } from '../middleware/errors.js';
import { need, superAdminOnly } from '../middleware/auth.js';
import { audit, diff } from '../lib/audit.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { PERMISSIONS, ALL_PERMISSIONS } from '../lib/permissions.js';
import { hashPassword, checkPasswordPolicy } from '../lib/password.js';
import { randomToken, sha256 } from '../lib/crypto.js';
import { DEFAULT_SETTINGS, mergeSettings, setupCompany, ensurePeriods } from '../services/company-setup.js';
import { saveUpload, readDocument } from '../services/storage.js';
import { setSecret, secretStatus } from '../services/secrets.js';
import { databaseBackup, configBackup, restoreConfig, backupFile, restoreDatabase } from '../services/backup.js';
import { parseCsv } from '../services/banking.js';
import { reportToXlsx } from '../services/export.js';
import { config } from '../config.js';
import { z, str, optStr, money, pid, date, optDate } from './_util.js';

const r = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: 1 } });

// ───────────── Company ─────────────
const companySchema = z.object({
  name: str(200).min(1), legal_name: optStr(200), tpin: optStr(40), vat_number: optStr(40), registration_no: optStr(60), address: optStr(500), city: optStr(100),
  phone: optStr(40), phone_alt: optStr(40), email: optStr(200), website: optStr(200), base_currency: z.string().length(3).optional(), fy_start_month: z.coerce.number().int().min(1).max(12).optional(), timezone: optStr(60),
});

r.get('/company', need('manage_company', 'manage_settings'), asyncH(async (req, res) => {
  res.json({ ...req.ctx.company, settings: undefined });
}));

r.put('/company', need('manage_company'), asyncH(async (req, res) => {
  const b = companySchema.parse(req.body);
  const before = req.ctx.company;
  if (b.base_currency && b.base_currency !== before.base_currency) {
    const { rows: [{ n }] } = await pool.query(`SELECT COUNT(*)::int AS n FROM journal_entries WHERE company_id=$1 AND status='POSTED'`, [req.ctx.companyId]);
    if (n > 0) throw conflict('The base currency cannot be changed after transactions have been posted.');
    const { rows: [cur] } = await pool.query('SELECT enabled FROM currencies WHERE code=$1', [b.base_currency]);
    if (!cur?.enabled) throw badRequest('That currency is not enabled. Enable it under System Preferences first.');
  }
  const { rows: [after] } = await pool.query(
    `UPDATE companies SET name=$2, legal_name=$3, tpin=$4, vat_number=$5, registration_no=$6, address=$7, city=$8, phone=$9, phone_alt=$10, email=$11, website=$12,
       base_currency=COALESCE($13, base_currency), fy_start_month=COALESCE($14, fy_start_month), timezone=COALESCE($15, timezone), updated_at=now() WHERE id=$1 RETURNING *`,
    [req.ctx.companyId, b.name, b.legal_name || null, b.tpin || null, b.vat_number || null, b.registration_no || null, b.address || null, b.city || null, b.phone || null,
     b.phone_alt || null, b.email || null, b.website || null, b.base_currency || null, b.fy_start_month || null, b.timezone || null]);
  const { settings: _a, ...bb } = before; const { settings: _b, ...aa } = after;
  await audit(req.ctx, 'company.updated', { entityType: 'company', entityId: req.ctx.companyId, ...diff(bb, aa) });
  res.json(aa);
}));

r.get('/companies', superAdminOnly, asyncH(async (req, res) => {
  const { rows } = await pool.query(`SELECT c.id, c.name, c.tpin, c.is_demo, c.is_active, c.created_at, (SELECT COUNT(*) FROM memberships m WHERE m.company_id=c.id)::int AS users FROM companies c ORDER BY c.name`);
  res.json(rows);
}));

r.post('/companies', superAdminOnly, asyncH(async (req, res) => {
  const b = companySchema.parse(req.body);
  const c = await tx((db) => setupCompany(db, b, { createdBy: req.ctx.user.id }));
  await audit({ ...req.ctx, companyId: c.id }, 'company.created', { entityType: 'company', entityId: c.id, newValue: { name: c.name } });
  res.status(201).json(c);
}));

r.post('/companies/:id/active', superAdminOnly, asyncH(async (req, res) => {
  const { is_active } = z.object({ is_active: z.boolean() }).parse(req.body);
  await pool.query('UPDATE companies SET is_active=$2 WHERE id=$1', [pid(req), is_active]);
  await audit(req.ctx, is_active ? 'company.activated' : 'company.deactivated', { entityType: 'company', entityId: pid(req) });
  res.json({ ok: true });
}));

// ───────────── Settings (per section) ─────────────
const SECTION_PERM = { branding: 'manage_company', documents: 'manage_company', accounting: 'manage_settings', tax: 'manage_tax', dashboard: 'manage_settings',
  notifications: 'manage_settings', email: 'manage_settings', ai: 'manage_ai', security: 'manage_settings', appearance: 'manage_settings', terminology: 'manage_settings',
  features: 'manage_settings', integrations: 'manage_integrations', backup: 'manage_backups' };

r.get('/settings', need('manage_settings', 'manage_company', 'manage_ai', 'manage_tax', 'manage_integrations'), asyncH(async (req, res) => {
  const s = req.ctx.settings;
  res.json({ ...s, secrets: {
    smtp_password: await secretStatus(req.ctx.companyId, 'smtp_password'),
    ai_api_key: await secretStatus(req.ctx.companyId, 'anthropic_api_key'),
    platform_ai_key: { configured: !!config.anthropicApiKey || (await secretStatus(null, 'anthropic_api_key')).configured },
  } });
}));

r.put('/settings/:section', asyncH(async (req, res) => {
  const section = req.params.section;
  if (!SECTION_PERM[section]) throw badRequest('Unknown settings section.');
  if (!req.ctx.isSuperAdmin && !req.ctx.permissions.has(SECTION_PERM[section])) throw forbidden();
  if (section === 'security' && !req.ctx.isSuperAdmin) throw forbidden('Only the Super Admin can change security settings.');
  const incoming = z.record(z.string(), z.any()).parse(req.body);
  const allowed = Object.keys(DEFAULT_SETTINGS[section]);
  const clean = {};
  for (const [k, v] of Object.entries(incoming)) {
    if (!allowed.includes(k)) continue;
    if (/color$/.test(k) && v && !/^#[0-9a-f]{6}$/i.test(v)) throw badRequest(`${k} must be a hex colour like #0f5c4a.`);
    if (/threshold$/.test(k) && v !== null && v !== '' && !/^\d+(\.\d{1,2})?$/.test(String(v))) throw badRequest(`${k} must be an amount.`);
    clean[k] = v;
  }
  if (section === 'branding') for (const k of ['logo_document_id', 'logo_dark_document_id', 'favicon_document_id']) delete clean[k]; // use upload endpoints
  if (section === 'dashboard' && clean.widgets && !Array.isArray(clean.widgets)) throw badRequest('widgets must be a list.');
  if (section === 'security') {
    if (clean.password_min_length !== undefined && (clean.password_min_length < 8 || clean.password_min_length > 64)) throw badRequest('Minimum password length must be between 8 and 64.');
  }
  const before = req.ctx.settings[section];
  const after = mergeSettings(before, clean);
  await pool.query(`UPDATE companies SET settings = jsonb_set(COALESCE(settings,'{}'::jsonb), $2, $3::jsonb, true), updated_at=now() WHERE id=$1`, [req.ctx.companyId, `{${section}}`, JSON.stringify(after)]);
  await audit(req.ctx, 'settings.changed', { entityType: 'settings', entityId: section, ...diff(before, after) });
  res.json(after);
}));

r.put('/secrets/:key', asyncH(async (req, res) => {
  const map = { smtp_password: 'manage_settings', anthropic_api_key: 'manage_ai' };
  const key = req.params.key;
  if (!map[key]) throw badRequest('Unknown secret.');
  if (!req.ctx.isSuperAdmin && !req.ctx.permissions.has(map[key])) throw forbidden();
  const { value, scope } = z.object({ value: z.string().max(500).nullable(), scope: z.enum(['company', 'platform']).default('company') }).parse(req.body);
  if (scope === 'platform' && !req.ctx.isSuperAdmin) throw forbidden('Only the Super Admin can set platform-wide keys.');
  await setSecret(scope === 'platform' ? null : req.ctx.companyId, key, value, req.ctx.user.id);
  await audit(req.ctx, value ? 'secret.updated' : 'secret.removed', { entityType: 'secret', entityId: `${scope}:${key}` });
  res.json(await secretStatus(scope === 'platform' ? null : req.ctx.companyId, key));
}));

// ───────────── Branding uploads ─────────────
const SLOTS = { logo: 'logo_document_id', logo_dark: 'logo_dark_document_id', favicon: 'favicon_document_id' };
r.post('/branding/:slot', need('manage_company'), upload.single('file'), asyncH(async (req, res) => {
  const key = SLOTS[req.params.slot];
  if (!key) throw badRequest('Unknown branding slot.');
  const doc = await saveUpload(pool, req.ctx, req.file, { category: 'branding', kind: 'image' });
  const before = req.ctx.settings.branding[key];
  await pool.query(`UPDATE companies SET settings = jsonb_set(COALESCE(settings,'{}'::jsonb), $2, to_jsonb($3::bigint), true), updated_at=now() WHERE id=$1`, [req.ctx.companyId, `{branding,${key}}`, doc.id]);
  await audit(req.ctx, before ? 'branding.logo_replaced' : 'branding.logo_uploaded', { entityType: 'branding', entityId: req.params.slot, oldValue: { document_id: before }, newValue: { document_id: doc.id, name: doc.original_name } });
  res.json({ document_id: doc.id });
}));
r.delete('/branding/:slot', need('manage_company'), asyncH(async (req, res) => {
  const key = SLOTS[req.params.slot];
  if (!key) throw badRequest('Unknown branding slot.');
  await pool.query(`UPDATE companies SET settings = jsonb_set(COALESCE(settings,'{}'::jsonb), $2, 'null'::jsonb, true), updated_at=now() WHERE id=$1`, [req.ctx.companyId, `{branding,${key}}`]);
  await audit(req.ctx, 'branding.logo_removed', { entityType: 'branding', entityId: req.params.slot, oldValue: { document_id: req.ctx.settings.branding[key] } });
  res.json({ ok: true });
}));

// ───────────── Users ─────────────
r.get('/users', need('manage_users'), asyncH(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT u.id, u.email, u.name, u.phone, u.is_super_admin, u.is_active, u.last_login_at, u.locked_until, u.must_change_password, u.created_at,
            m.role_id, r.name AS role_name, m.branch_id, m.is_active AS membership_active
       FROM users u LEFT JOIN memberships m ON m.user_id=u.id AND m.company_id=$1 LEFT JOIN roles r ON r.id=m.role_id
      WHERE m.company_id=$1 OR u.is_super_admin ORDER BY u.name`, [req.ctx.companyId]);
  res.json(rows);
}));

const userSchema = z.object({ email: z.string().trim().toLowerCase().email().max(200), name: str(120).min(1), phone: optStr(40), role_id: z.coerce.number().int().positive(),
  branch_id: z.union([z.coerce.number().int().positive(), z.null()]).optional(), password: z.string().optional(), must_change_password: z.boolean().optional() });

async function assertRole(db, ctx, roleId) {
  const { rows: [role] } = await db.query('SELECT * FROM roles WHERE id=$1 AND company_id=$2', [roleId, ctx.companyId]);
  if (!role) throw badRequest('Role not found.');
  if (role.name === 'Super Admin' && !ctx.isSuperAdmin) throw forbidden('Only the Super Admin can assign the Super Admin role.');
  if (!ctx.isSuperAdmin && role.permissions.some((p) => !ctx.permissions.has(p))) throw forbidden('You cannot assign a role with more permissions than your own.');
  return role;
}

r.post('/users', need('manage_users'), asyncH(async (req, res) => {
  const b = userSchema.parse(req.body);
  const role = await assertRole(pool, req.ctx, b.role_id);
  const out = await tx(async (db) => {
    let { rows: [u] } = await db.query('SELECT * FROM users WHERE lower(email)=$1', [b.email]);
    let tempPassword = null;
    if (!u) {
      const pw = b.password || `${randomToken(9)}9a`;
      if (b.password) checkPasswordPolicy(b.password, req.ctx.settings.security.password_min_length); else tempPassword = pw;
      ({ rows: [u] } = await db.query(`INSERT INTO users (email, name, phone, password_hash, must_change_password) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [b.email, b.name, b.phone || null, await hashPassword(pw), b.must_change_password ?? true]));
    }
    await db.query(`INSERT INTO memberships (user_id, company_id, role_id, branch_id) VALUES ($1,$2,$3,$4) ON CONFLICT (user_id, company_id) DO UPDATE SET role_id=EXCLUDED.role_id, branch_id=EXCLUDED.branch_id, is_active=true`,
      [u.id, req.ctx.companyId, role.id, b.branch_id || null]);
    await audit(req.ctx, 'user.created', { entityType: 'user', entityId: u.id, newValue: { email: u.email, name: u.name, role: role.name } }, db);
    return { id: u.id, email: u.email, temporary_password: tempPassword };
  });
  res.status(201).json(out);
}));

r.put('/users/:id', need('manage_users'), asyncH(async (req, res) => {
  const id = pid(req);
  const b = userSchema.partial({ email: true, password: true }).parse(req.body);
  const { rows: [u] } = await pool.query(`SELECT u.*, m.role_id, m.branch_id FROM users u JOIN memberships m ON m.user_id=u.id AND m.company_id=$2 WHERE u.id=$1`, [id, req.ctx.companyId]);
  if (!u) throw notFound('User');
  if (u.is_super_admin && !req.ctx.isSuperAdmin) throw forbidden('Only the Super Admin can edit the Super Admin account.');
  const role = await assertRole(pool, req.ctx, b.role_id);
  await tx(async (db) => {
    await db.query('UPDATE users SET name=$2, phone=$3, updated_at=now() WHERE id=$1', [id, b.name, b.phone || null]);
    await db.query('UPDATE memberships SET role_id=$3, branch_id=$4 WHERE user_id=$1 AND company_id=$2', [id, req.ctx.companyId, role.id, b.branch_id || null]);
    await audit(req.ctx, u.role_id !== role.id ? 'user.permissions_changed' : 'user.updated', { entityType: 'user', entityId: id,
      ...diff({ name: u.name, phone: u.phone, role_id: u.role_id, branch_id: u.branch_id }, { name: b.name, phone: b.phone || null, role_id: role.id, branch_id: b.branch_id || null }) }, db);
  });
  res.json({ ok: true });
}));

r.post('/users/:id/status', need('manage_users'), asyncH(async (req, res) => {
  const id = pid(req);
  const { is_active } = z.object({ is_active: z.boolean() }).parse(req.body);
  if (id === req.ctx.user.id) throw badRequest('You cannot disable your own account.');
  const { rows: [u] } = await pool.query('SELECT is_super_admin FROM users WHERE id=$1', [id]);
  if (!u) throw notFound('User');
  if (u.is_super_admin) throw forbidden('The Super Admin account cannot be disabled here.');
  // Disabling removes access to this company; deactivating globally is Super Admin only.
  await pool.query('UPDATE memberships SET is_active=$3 WHERE user_id=$1 AND company_id=$2', [id, req.ctx.companyId, is_active]);
  if (req.ctx.isSuperAdmin && req.body.global === true) await pool.query('UPDATE users SET is_active=$2 WHERE id=$1', [id, is_active]);
  if (!is_active) await pool.query('DELETE FROM sessions WHERE user_id=$1 AND (company_id=$2 OR $3)', [id, req.ctx.companyId, req.body.global === true]);
  await audit(req.ctx, is_active ? 'user.enabled' : 'user.disabled', { entityType: 'user', entityId: id, newValue: { global: req.body.global === true } });
  res.json({ ok: true });
}));

r.post('/users/:id/reset-password', need('manage_users'), asyncH(async (req, res) => {
  const id = pid(req);
  const { rows: [u] } = await pool.query(`SELECT u.* FROM users u JOIN memberships m ON m.user_id=u.id AND m.company_id=$2 WHERE u.id=$1`, [id, req.ctx.companyId]);
  if (!u) throw notFound('User');
  if (u.is_super_admin && !req.ctx.isSuperAdmin) throw forbidden();
  if (!req.ctx.isSuperAdmin) {
    // A login shared with other companies may only be reset by the Super Admin (prevents cross-company takeover).
    const { rows: [{ n }] } = await pool.query('SELECT COUNT(*)::int AS n FROM memberships WHERE user_id=$1 AND company_id<>$2', [id, req.ctx.companyId]);
    if (n > 0) throw forbidden('This user also belongs to another company. Ask the Super Admin to reset their password.');
  }
  const temp = req.body?.password || `${randomToken(9)}7k`;
  if (req.body?.password) checkPasswordPolicy(temp, req.ctx.settings.security.password_min_length);
  await pool.query('UPDATE users SET password_hash=$2, must_change_password=true, failed_logins=0, locked_until=NULL, updated_at=now() WHERE id=$1', [id, await hashPassword(temp)]);
  await pool.query('DELETE FROM sessions WHERE user_id=$1', [id]);
  await audit(req.ctx, 'user.password_reset', { entityType: 'user', entityId: id });
  res.json({ temporary_password: req.body?.password ? null : temp });
}));

r.delete('/users/:id', need('manage_users'), asyncH(async (req, res) => {
  const id = pid(req);
  if (id === req.ctx.user.id) throw badRequest('You cannot remove yourself.');
  const { rows: [u] } = await pool.query('SELECT is_super_admin, email FROM users WHERE id=$1', [id]);
  if (!u) throw notFound('User');
  if (u.is_super_admin) throw forbidden('The Super Admin account cannot be removed.');
  // Users with history are never hard-deleted: their membership is deactivated to keep the audit trail intact.
  await pool.query('UPDATE memberships SET is_active=false WHERE user_id=$1 AND company_id=$2', [id, req.ctx.companyId]);
  await pool.query('DELETE FROM sessions WHERE user_id=$1 AND company_id=$2', [id, req.ctx.companyId]);
  await audit(req.ctx, 'user.deactivated', { entityType: 'user', entityId: id, oldValue: { email: u.email } });
  res.json({ ok: true });
}));

// ───────────── Roles & permissions ─────────────
r.get('/permissions', need('manage_roles', 'manage_users'), (req, res) => res.json(Object.entries(PERMISSIONS).map(([key, label]) => ({ key, label }))));
r.get('/roles', need('manage_roles', 'manage_users'), asyncH(async (req, res) => {
  const { rows } = await pool.query(`SELECT r.*, (SELECT COUNT(*) FROM memberships m WHERE m.role_id=r.id AND m.is_active)::int AS users FROM roles r WHERE company_id=$1 ORDER BY is_system DESC, name`, [req.ctx.companyId]);
  res.json(rows);
}));
const roleSchema = z.object({ name: str(80).min(1), description: optStr(300), permissions: z.array(z.string()), transaction_limit: z.union([money, z.null(), z.literal('')]).optional() });
r.post('/roles', need('manage_roles'), asyncH(async (req, res) => {
  const b = roleSchema.parse(req.body);
  const perms = b.permissions.filter((p) => ALL_PERMISSIONS.includes(p));
  if (!req.ctx.isSuperAdmin && perms.some((p) => !req.ctx.permissions.has(p))) throw forbidden('You cannot grant permissions you do not have.');
  const { rows: [role] } = await pool.query(`INSERT INTO roles (company_id, name, description, permissions, transaction_limit) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [req.ctx.companyId, b.name, b.description || null, perms, b.transaction_limit || null]);
  await audit(req.ctx, 'role.created', { entityType: 'role', entityId: role.id, newValue: { name: role.name, permissions: perms, transaction_limit: role.transaction_limit } });
  res.status(201).json(role);
}));
r.put('/roles/:id', need('manage_roles'), asyncH(async (req, res) => {
  const id = pid(req);
  const b = roleSchema.parse(req.body);
  const { rows: [role] } = await pool.query('SELECT * FROM roles WHERE id=$1 AND company_id=$2', [id, req.ctx.companyId]);
  if (!role) throw notFound('Role');
  if (role.name === 'Super Admin') throw forbidden('The Super Admin role always has every permission and cannot be edited.');
  const perms = b.permissions.filter((p) => ALL_PERMISSIONS.includes(p));
  if (!req.ctx.isSuperAdmin && perms.some((p) => !req.ctx.permissions.has(p))) throw forbidden('You cannot grant permissions you do not have.');
  const { rows: [after] } = await pool.query(`UPDATE roles SET name=$2, description=$3, permissions=$4, transaction_limit=$5 WHERE id=$1 RETURNING *`,
    [id, role.is_system ? role.name : b.name, b.description || null, perms, b.transaction_limit || null]);
  await audit(req.ctx, 'role.permissions_changed', { entityType: 'role', entityId: id, oldValue: { permissions: role.permissions, transaction_limit: role.transaction_limit }, newValue: { permissions: perms, transaction_limit: after.transaction_limit } });
  res.json(after);
}));
r.delete('/roles/:id', need('manage_roles'), asyncH(async (req, res) => {
  const id = pid(req);
  const { rows: [role] } = await pool.query('SELECT * FROM roles WHERE id=$1 AND company_id=$2', [id, req.ctx.companyId]);
  if (!role) throw notFound('Role');
  if (role.is_system) throw conflict('Built-in roles cannot be deleted. You can edit their permissions instead.');
  const { rows: [{ n }] } = await pool.query('SELECT COUNT(*)::int AS n FROM memberships WHERE role_id=$1', [id]);
  if (n) throw conflict('This role is assigned to users. Reassign them first.');
  await pool.query('DELETE FROM roles WHERE id=$1', [id]);
  await audit(req.ctx, 'role.deleted', { entityType: 'role', entityId: id, oldValue: { name: role.name } });
  res.json({ ok: true });
}));

// ───────────── Branches / departments / warehouses ─────────────
for (const t of ['branches', 'departments', 'warehouses']) {
  r.get(`/${t}`, asyncH(async (req, res) => res.json((await pool.query(`SELECT * FROM ${t} WHERE company_id=$1 ORDER BY code`, [req.ctx.companyId])).rows)));
  const sch = z.object({ code: str(20).min(1), name: str(120).min(1), address: optStr(300), location: optStr(300), is_active: z.boolean().optional() });
  r.post(`/${t}`, need('manage_settings'), asyncH(async (req, res) => {
    const b = sch.parse(req.body);
    const extra = t === 'branches' ? ['address', b.address] : t === 'warehouses' ? ['location', b.location] : null;
    const { rows: [row] } = await pool.query(`INSERT INTO ${t} (company_id, code, name${extra ? `, ${extra[0]}` : ''}) VALUES ($1,$2,$3${extra ? ',$4' : ''}) RETURNING *`,
      [req.ctx.companyId, b.code.toUpperCase(), b.name, ...(extra ? [extra[1] || null] : [])]);
    await audit(req.ctx, `${t.slice(0, -1).replace('branche', 'branch')}.created`, { entityType: t, entityId: row.id, newValue: row });
    res.status(201).json(row);
  }));
  r.put(`/${t}/:id`, need('manage_settings'), asyncH(async (req, res) => {
    const b = sch.parse(req.body);
    const { rows: [before] } = await pool.query(`SELECT * FROM ${t} WHERE id=$1 AND company_id=$2`, [pid(req), req.ctx.companyId]);
    if (!before) throw notFound();
    const extra = t === 'branches' ? 'address' : t === 'warehouses' ? 'location' : null;
    const { rows: [row] } = await pool.query(`UPDATE ${t} SET code=$3, name=$4, is_active=$5${extra ? `, ${extra}=$6` : ''} WHERE id=$1 AND company_id=$2 RETURNING *`,
      [pid(req), req.ctx.companyId, b.code.toUpperCase(), b.name, b.is_active ?? true, ...(extra ? [b[extra] || null] : [])]);
    await audit(req.ctx, `${t}.updated`, { entityType: t, entityId: row.id, ...diff(before, row) });
    res.json(row);
  }));
}

// ───────────── Financial periods ─────────────
r.get('/periods', need('view_ledger', 'manage_periods'), asyncH(async (req, res) => {
  await ensurePeriods(pool, req.ctx.companyId, new Date().toISOString().slice(0, 10));
  const { rows } = await pool.query(`SELECT p.*, u.name AS locked_by_name,
      (SELECT COUNT(*) FROM journal_entries e WHERE e.company_id=p.company_id AND e.entry_date BETWEEN p.start_date AND p.end_date AND e.status IN ('DRAFT','PENDING_APPROVAL'))::int AS open_drafts
      FROM fiscal_periods p LEFT JOIN users u ON u.id=p.locked_by WHERE p.company_id=$1 ORDER BY start_date DESC`, [req.ctx.companyId]);
  res.json(rows);
}));
r.post('/periods/generate', need('manage_periods'), asyncH(async (req, res) => {
  const { date: d } = z.object({ date }).parse(req.body);
  await ensurePeriods(pool, req.ctx.companyId, d);
  await audit(req.ctx, 'period.generated', { entityType: 'fiscal_period', newValue: { for_date: d } });
  res.json({ ok: true });
}));
r.post('/periods/:id/:action', asyncH(async (req, res) => {
  const id = pid(req), action = req.params.action;
  if (!['lock', 'close', 'reopen'].includes(action)) throw notFound('Action');
  const perm = action === 'reopen' ? 'reopen_periods' : 'manage_periods';
  if (!req.ctx.isSuperAdmin && !req.ctx.permissions.has(perm)) throw forbidden(action === 'reopen' ? 'Only authorised users can reopen a locked period.' : undefined);
  const { rows: [p] } = await pool.query('SELECT * FROM fiscal_periods WHERE id=$1 AND company_id=$2', [id, req.ctx.companyId]);
  if (!p) throw notFound('Period');
  const reason = String(req.body?.reason || '').trim();
  if (action === 'reopen') {
    if (p.status === 'OPEN') throw conflict('This period is already open.');
    if (p.status === 'CLOSED' && !req.ctx.isSuperAdmin) throw forbidden('Only the Super Admin can reopen a closed period.');
    if (!reason) throw badRequest('A reason is required to reopen a period.');
  }
  if (action !== 'reopen') {
    const { rows: [{ n }] } = await pool.query(`SELECT COUNT(*)::int AS n FROM journal_entries WHERE company_id=$1 AND entry_date BETWEEN $2 AND $3 AND status IN ('DRAFT','PENDING_APPROVAL')`, [req.ctx.companyId, p.start_date, p.end_date]);
    if (n && !req.body?.force) throw conflict(`${n} draft or pending journal(s) are dated in this period. Post or delete them first, or confirm to lock anyway.`);
  }
  const status = action === 'lock' ? 'LOCKED' : action === 'close' ? 'CLOSED' : 'OPEN';
  await pool.query('UPDATE fiscal_periods SET status=$2, locked_by=$3, locked_at=now() WHERE id=$1', [id, status, req.ctx.user.id]);
  await audit(req.ctx, `period.${action}ed`.replace('closeed', 'closed'), { entityType: 'fiscal_period', entityId: id, oldValue: { status: p.status }, newValue: { status, reason: reason || undefined, period: p.name } });
  res.json({ ok: true, status });
}));

// ───────────── Numbering ─────────────
r.get('/numbering', need('manage_settings'), asyncH(async (req, res) => {
  res.json((await pool.query('SELECT key, prefix, suffix, next_value, padding FROM number_sequences WHERE company_id=$1 ORDER BY key', [req.ctx.companyId])).rows);
}));
r.put('/numbering/:key', need('manage_settings'), asyncH(async (req, res) => {
  const b = z.object({ prefix: z.string().max(20).regex(/^[\w\-/.]*$/, 'letters, numbers, - / . only'), suffix: z.string().max(20).regex(/^[\w\-/.]*$/).default(''),
    next_value: z.coerce.number().int().positive(), padding: z.coerce.number().int().min(1).max(12) }).parse(req.body);
  const { rows: [before] } = await pool.query('SELECT * FROM number_sequences WHERE company_id=$1 AND key=$2', [req.ctx.companyId, req.params.key]);
  if (!before) throw notFound('Sequence');
  if (b.next_value < before.next_value && !req.ctx.isSuperAdmin) throw forbidden('Only the Super Admin can move a sequence backwards (it may create duplicate numbers).');
  await pool.query('UPDATE number_sequences SET prefix=$3, suffix=$4, next_value=$5, padding=$6 WHERE company_id=$1 AND key=$2', [req.ctx.companyId, req.params.key, b.prefix, b.suffix, b.next_value, b.padding]);
  await audit(req.ctx, 'numbering.changed', { entityType: 'number_sequence', entityId: req.params.key, ...diff(before, { ...before, ...b }) });
  res.json({ ok: true });
}));

// ───────────── Currencies (system preferences) ─────────────
r.get('/currencies', asyncH(async (req, res) => res.json((await pool.query('SELECT * FROM currencies ORDER BY enabled DESC, code')).rows)));
r.put('/currencies/:code', superAdminOnly, asyncH(async (req, res) => {
  const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body);
  if (req.params.code === 'ZMW' && !enabled) throw badRequest('Zambian Kwacha cannot be disabled.');
  await pool.query('UPDATE currencies SET enabled=$2 WHERE code=$1', [req.params.code, enabled]);
  await audit(req.ctx, 'currency.changed', { entityType: 'currency', entityId: req.params.code, newValue: { enabled } });
  res.json({ ok: true });
}));

// ───────────── API keys ─────────────
r.get('/api-keys', need('manage_integrations'), asyncH(async (req, res) => {
  res.json((await pool.query(`SELECT k.id, k.name, k.prefix, k.permissions, k.created_at, k.last_used_at, k.revoked_at, u.name AS created_by FROM api_keys k LEFT JOIN users u ON u.id=k.created_by WHERE k.company_id=$1 ORDER BY k.created_at DESC`, [req.ctx.companyId])).rows);
}));
r.post('/api-keys', need('manage_integrations'), asyncH(async (req, res) => {
  const b = z.object({ name: str(80).min(1), permissions: z.array(z.string()).min(1) }).parse(req.body);
  const perms = b.permissions.filter((p) => ALL_PERMISSIONS.includes(p) && !p.startsWith('manage_'));
  if (!req.ctx.isSuperAdmin && perms.some((p) => !req.ctx.permissions.has(p))) throw forbidden('You cannot grant permissions you do not have.');
  const key = `tael_${randomToken(30)}`;
  const { rows: [k] } = await pool.query(`INSERT INTO api_keys (company_id, name, prefix, key_hash, permissions, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [req.ctx.companyId, b.name, key.slice(0, 10), sha256(key), perms, req.ctx.user.id]);
  await audit(req.ctx, 'api_key.created', { entityType: 'api_key', entityId: k.id, newValue: { name: b.name, permissions: perms } });
  res.status(201).json({ id: k.id, key, note: 'Copy this key now. It will not be shown again.' });
}));
r.delete('/api-keys/:id', need('manage_integrations'), asyncH(async (req, res) => {
  await pool.query('UPDATE api_keys SET revoked_at=now() WHERE id=$1 AND company_id=$2', [pid(req), req.ctx.companyId]);
  await audit(req.ctx, 'api_key.revoked', { entityType: 'api_key', entityId: pid(req) });
  res.json({ ok: true });
}));

// ───────────── Audit logs ─────────────
r.get('/audit-logs', need('view_audit_logs'), asyncH(async (req, res) => {
  const p = [req.ctx.companyId]; let w = '';
  if (req.query.user_id) { p.push(Number(req.query.user_id)); w += ` AND l.user_id=$${p.length}`; }
  if (req.query.action) { p.push(`%${req.query.action}%`); w += ` AND l.action ILIKE $${p.length}`; }
  if (req.query.entity_type) { p.push(req.query.entity_type); w += ` AND l.entity_type=$${p.length}`; }
  if (req.query.entity_id) { p.push(String(req.query.entity_id)); w += ` AND l.entity_id=$${p.length}`; }
  if (req.query.from) { p.push(req.query.from); w += ` AND l.created_at >= $${p.length}::date`; }
  if (req.query.to) { p.push(req.query.to); w += ` AND l.created_at < $${p.length}::date + 1`; }
  if (req.query.ai === 'true') w += ' AND l.via_ai';
  const limit = Math.max(1, Math.min(Number(req.query.limit) || 100, 1000)), offset = Math.max(Number(req.query.offset) || 0, 0);
  const { rows } = await pool.query(`SELECT l.*, COALESCE(u.name, l.user_email, 'System') AS user_name FROM audit_logs l LEFT JOIN users u ON u.id=l.user_id
      WHERE l.company_id=$1 ${w} ORDER BY l.id DESC LIMIT ${limit} OFFSET ${offset}`, p);
  const { rows: [{ n }] } = await pool.query(`SELECT COUNT(*)::int AS n FROM audit_logs l WHERE l.company_id=$1 ${w}`, p);
  res.json({ items: rows, total: n });
}));
r.get('/audit-logs/verify', need('view_audit_logs'), asyncH(async (req, res) => {
  const { rows } = await pool.query(`SELECT id, prev_hash, hash, company_id, user_id, action, entity_type, entity_id, old_value::text AS o, new_value::text AS n, created_at::text AS t,
      encode(digest(prev_hash || '|' || COALESCE(company_id::text,'') || '|' || COALESCE(user_id::text,'') || '|' || action || '|' || COALESCE(entity_type,'') || '|' || COALESCE(entity_id,'') || '|' ||
        COALESCE(old_value::text,'') || '|' || COALESCE(new_value::text,'') || '|' || created_at::text, 'sha256'),'hex') AS recomputed FROM audit_logs ORDER BY id`);
  let prev = 'GENESIS', broken = null;
  for (const x of rows) { if (x.prev_hash !== prev || x.hash !== x.recomputed) { broken = x.id; break; } prev = x.hash; }
  res.json({ entries: rows.length, intact: broken === null, first_broken_id: broken });
}));

// ───────────── Backups ─────────────
r.get('/backups', need('manage_backups'), asyncH(async (req, res) => {
  const { rows } = await pool.query(`SELECT b.*, u.name AS created_by_name FROM backups b LEFT JOIN users u ON u.id=b.created_by WHERE ${req.ctx.isSuperAdmin ? 'true' : 'b.company_id=$1'} ORDER BY b.created_at DESC LIMIT 200`, req.ctx.isSuperAdmin ? [] : [req.ctx.companyId]);
  res.json(rows);
}));
r.post('/backups/database', superAdminOnly, asyncH(async (req, res) => res.status(201).json(await databaseBackup(req.ctx, req.body?.notes))));
r.post('/backups/config', need('manage_backups'), asyncH(async (req, res) => res.status(201).json(await configBackup(req.ctx, req.ctx.companyId, req.body?.notes))));
r.get('/backups/:id/download', need('manage_backups'), asyncH(async (req, res) => {
  const { backup, file } = await backupFile(pid(req));
  if (backup.kind === 'DATABASE' && !req.ctx.isSuperAdmin) throw forbidden('Only the Super Admin can download database backups.');
  if (backup.kind === 'CONFIG' && backup.company_id !== req.ctx.companyId && !req.ctx.isSuperAdmin) throw forbidden();
  await audit(req.ctx, 'backup.downloaded', { entityType: 'backup', entityId: backup.id });
  res.download(file, backup.filename);
}));
r.post('/backups/:id/restore', superAdminOnly, asyncH(async (req, res) => {
  const { confirm } = z.object({ confirm: z.string() }).parse(req.body);
  if (confirm !== 'RESTORE') throw badRequest('Type RESTORE to confirm. This replaces the entire database.');
  const { backup, file } = await backupFile(pid(req));
  if (backup.kind === 'CONFIG') {
    if (backup.company_id !== req.ctx.companyId) throw badRequest('Switch to the company this configuration backup belongs to before restoring it.');
    await restoreConfig(req.ctx, req.ctx.companyId, JSON.parse(await fs.readFile(file, 'utf8')));
    return res.json({ ok: true, restored: 'configuration' });
  }
  res.json(await restoreDatabase(req.ctx, backup.id));
}));
r.post('/backups/config/upload', need('manage_backups'), upload.single('file'), asyncH(async (req, res) => {
  if (!req.file) throw badRequest('Choose a configuration backup file.');
  let json; try { json = JSON.parse(req.file.buffer.toString('utf8')); } catch { throw badRequest('The file is not valid JSON.'); }
  if (!req.ctx.isSuperAdmin && !req.ctx.permissions.has('manage_settings')) throw forbidden();
  await restoreConfig(req.ctx, req.ctx.companyId, json);
  res.json({ ok: true });
}));

// ───────────── Data export / import ─────────────
const EXPORTS = {
  customers: `SELECT code, name, contact_person, email, phone, address, tpin, credit_limit, payment_terms_days, is_active FROM customers WHERE company_id=$1 ORDER BY code`,
  suppliers: `SELECT code, name, contact_person, email, phone, address, tpin, payment_terms_days, bank_details, is_active FROM suppliers WHERE company_id=$1 ORDER BY code`,
  accounts: `SELECT code, name, type, subtype, system_key, cash_flow_category, is_active FROM accounts WHERE company_id=$1 ORDER BY code`,
  items: `SELECT i.code, i.name, i.description, i.unit, i.sale_price, i.purchase_price, ia.code AS income_account, ea.code AS expense_account FROM items i LEFT JOIN accounts ia ON ia.id=i.income_account_id LEFT JOIN accounts ea ON ea.id=i.expense_account_id WHERE i.company_id=$1 ORDER BY i.code`,
  journal_lines: `SELECT e.number, e.entry_date, e.reference, e.description, e.source_type, e.status, a.code AS account_code, a.name AS account_name, l.debit, l.credit FROM journal_lines l JOIN journal_entries e ON e.id=l.entry_id JOIN accounts a ON a.id=l.account_id WHERE l.company_id=$1 AND e.status IN ('POSTED','REVERSED') ORDER BY e.entry_date, e.id, l.line_no`,
  invoices: `SELECT d.number, d.doc_type, d.doc_date, d.due_date, c.name AS customer, d.subtotal, d.tax_total, d.total, d.amount_paid, d.status FROM sales_documents d JOIN customers c ON c.id=d.customer_id WHERE d.company_id=$1 ORDER BY d.doc_date`,
  bills: `SELECT d.number, d.doc_type, d.doc_date, d.due_date, s.name AS supplier, d.supplier_reference, d.subtotal, d.tax_total, d.total, d.amount_paid, d.status FROM purchase_documents d JOIN suppliers s ON s.id=d.supplier_id WHERE d.company_id=$1 ORDER BY d.doc_date`,
  expenses: `SELECT e.number, e.expense_date, COALESCE(s.name, e.payee_name) AS payee, a.name AS category, e.amount, e.tax_amount, e.total, e.status FROM expenses e JOIN accounts a ON a.id=e.account_id LEFT JOIN suppliers s ON s.id=e.supplier_id WHERE e.company_id=$1 ORDER BY e.expense_date`,
};
r.get('/export/:entity', need('export_reports', 'manage_settings'), asyncH(async (req, res) => {
  const sql = EXPORTS[req.params.entity];
  if (!sql) throw badRequest('Unknown export.');
  const { rows, fields } = await pool.query(sql, [req.ctx.companyId]);
  await audit(req.ctx, 'data.exported', { entityType: 'export', entityId: req.params.entity, newValue: { rows: rows.length } });
  if (req.query.format === 'xlsx') {
    const buf = await reportToXlsx({ title: req.params.entity, subtitle: `Exported ${new Date().toISOString().slice(0, 10)}`, columns: fields.map((f) => ({ key: f.name, label: f.name, type: ['debit', 'credit', 'total', 'subtotal', 'tax_total', 'amount', 'amount_paid', 'tax_amount', 'sale_price', 'purchase_price', 'credit_limit'].includes(f.name) ? 'money' : 'text' })), rows }, req.ctx.company);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${req.params.entity}.xlsx"`);
    return res.send(Buffer.from(buf));
  }
  const esc = (v) => (v === null || v === undefined ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const csv = [fields.map((f) => f.name).join(','), ...rows.map((row) => fields.map((f) => esc(row[f.name])).join(','))].join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${req.params.entity}.csv"`);
  res.send(`﻿${csv}`);
}));

r.post('/import/:entity', need('manage_settings'), upload.single('file'), asyncH(async (req, res) => {
  const entity = req.params.entity;
  if (!['customers', 'suppliers', 'accounts', 'items'].includes(entity)) throw badRequest('Import supports customers, suppliers, accounts and items.');
  if (!req.file) throw badRequest('Choose a CSV file.');
  const rows = parseCsv(req.file.buffer.toString('utf8').replace(/^﻿/, ''));
  if (rows.length < 2) throw badRequest('The file has no data rows.');
  const head = rows[0].map((h) => String(h).trim().toLowerCase());
  const get = (row, k) => { const i = head.indexOf(k); return i >= 0 ? String(row[i] ?? '').trim() : ''; };
  const result = await tx(async (db) => {
    let created = 0, updated = 0; const errors = [];
    for (const [i, row] of rows.slice(1).entries()) {
      try {
        if (entity === 'accounts') {
          const type = get(row, 'type').toUpperCase();
          if (!['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'COST_OF_SALES', 'EXPENSE'].includes(type)) throw new Error('invalid type');
          const q = await db.query(`INSERT INTO accounts (company_id, code, name, type, subtype) VALUES ($1,$2,$3,$4,COALESCE(NULLIF($5,''),'general'))
              ON CONFLICT (company_id, code) DO UPDATE SET name=EXCLUDED.name RETURNING (xmax = 0) AS inserted`, [req.ctx.companyId, get(row, 'code'), get(row, 'name'), type, get(row, 'subtype')]);
          q.rows[0].inserted ? created++ : updated++;
        } else if (entity === 'items') {
          const q = await db.query(`INSERT INTO items (company_id, code, name, description, unit, sale_price, purchase_price) VALUES ($1,$2,$3,$4,COALESCE(NULLIF($5,''),'each'),COALESCE(NULLIF($6,'')::numeric,0),COALESCE(NULLIF($7,'')::numeric,0))
              ON CONFLICT (company_id, code) DO UPDATE SET name=EXCLUDED.name, sale_price=EXCLUDED.sale_price, purchase_price=EXCLUDED.purchase_price RETURNING (xmax = 0) AS inserted`,
            [req.ctx.companyId, get(row, 'code'), get(row, 'name'), get(row, 'description') || null, get(row, 'unit'), get(row, 'sale_price').replace(/,/g, ''), get(row, 'purchase_price').replace(/,/g, '')]);
          q.rows[0].inserted ? created++ : updated++;
        } else {
          const code = get(row, 'code') || `${entity === 'customers' ? 'C' : 'S'}${String(Date.now()).slice(-5)}${i}`;
          if (!get(row, 'name')) throw new Error('name is required');
          const q = await db.query(`INSERT INTO ${entity} (company_id, code, name, contact_person, email, phone, address, tpin, payment_terms_days) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,COALESCE(NULLIF($9,'')::int,30))
              ON CONFLICT (company_id, code) DO UPDATE SET name=EXCLUDED.name, email=EXCLUDED.email, phone=EXCLUDED.phone, address=EXCLUDED.address, tpin=EXCLUDED.tpin RETURNING (xmax = 0) AS inserted`,
            [req.ctx.companyId, code, get(row, 'name'), get(row, 'contact_person') || null, get(row, 'email') || null, get(row, 'phone') || null, get(row, 'address') || null, get(row, 'tpin') || null, get(row, 'payment_terms_days')]);
          q.rows[0].inserted ? created++ : updated++;
        }
      } catch (e) { errors.push(`Row ${i + 2}: ${e.message}`); }
    }
    if (errors.length && req.query.strict === 'true') throw badRequest(`Import failed: ${errors.slice(0, 5).join('; ')}`);
    await audit(req.ctx, 'data.imported', { entityType: 'import', entityId: entity, newValue: { created, updated, errors: errors.length } }, db);
    return { created, updated, errors: errors.slice(0, 50) };
  });
  res.json(result);
}));

// ───────────── System info ─────────────
r.get('/system', need('manage_settings'), asyncH(async (req, res) => {
  const { rows: [db] } = await pool.query(`SELECT version() AS version, pg_size_pretty(pg_database_size(current_database())) AS size`);
  const { rows: [counts] } = await pool.query(`SELECT (SELECT COUNT(*) FROM journal_entries WHERE company_id=$1)::int AS journals, (SELECT COUNT(*) FROM users)::int AS users, (SELECT COUNT(*) FROM companies)::int AS companies, (SELECT COUNT(*) FROM documents WHERE company_id=$1)::int AS documents`, [req.ctx.companyId]);
  const { rows: mig } = await pool.query('SELECT name, applied_at FROM schema_migrations ORDER BY name');
  res.json({ app: 'TAEL Books', version: '1.0.0', node: process.version, env: config.env, database: db, counts, migrations: mig, ai_platform_key: !!config.anthropicApiKey });
}));

export default r;
export { readDocument, optDate };
