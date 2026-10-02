import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { pool } from '../db/pool.js';
import { asyncH } from '../middleware/errors.js';
import { authenticate, COOKIE } from '../middleware/auth.js';
import { sha256, randomToken } from '../lib/crypto.js';
import { verifyPassword, hashPassword, checkPasswordPolicy } from '../lib/password.js';
import { unauthorized, badRequest, forbidden } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { config } from '../config.js';
import { z, str } from './_util.js';
import { DEFAULT_SETTINGS, mergeSettings } from '../services/company-setup.js';

const r = Router();
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: config.isTest ? 1000 : 20, standardHeaders: true, legacyHeaders: false,
  message: { error: { code: 'RATE_LIMITED', message: 'Too many sign-in attempts. Please wait 15 minutes and try again.' } } });

const MAX_FAILED = 5, LOCK_MIN = 15;
/** Security policy from the user's first company (falls back to safe defaults). */
async function securityFor(userId) {
  const { rows: [c] } = await pool.query(`SELECT c.settings FROM memberships m JOIN companies c ON c.id=m.company_id WHERE m.user_id=$1 ORDER BY m.created_at LIMIT 1`, [userId]);
  const s = mergeSettings(DEFAULT_SETTINGS, c?.settings || {}).security;
  return { maxFailed: Number(s.max_failed_logins) || MAX_FAILED, lockMin: Number(s.lockout_minutes) || LOCK_MIN, ttl: Number(s.session_timeout_hours) || config.sessionTtlHours };
}

export function sessionPayload(ctx) {
  return {
    user: { id: ctx.user.id, email: ctx.user.email, name: ctx.user.name, is_super_admin: !!ctx.user.is_super_admin, must_change_password: !!ctx.user.must_change_password },
    company: ctx.company ? { id: ctx.company.id, name: ctx.company.name, base_currency: ctx.company.base_currency, is_demo: ctx.company.is_demo, fy_start_month: ctx.company.fy_start_month } : null,
    role: ctx.isSuperAdmin ? 'Super Admin' : ctx.role?.name || null,
    permissions: [...ctx.permissions],
    settings: ctx.company ? publicSettings(ctx.settings) : null,
    csrf_token: ctx.csrfToken,
  };
}
function publicSettings(s) {
  return { branding: s.branding, appearance: s.appearance, terminology: s.terminology, features: s.features, dashboard: s.dashboard,
    ai: { enabled: s.ai.enabled, assistant_name: s.ai.assistant_name, allow_transaction_drafts: s.ai.allow_transaction_drafts },
    accounting: { expense_approval_threshold: s.accounting.expense_approval_threshold, journal_approval_threshold: s.accounting.journal_approval_threshold }, tax: { note: s.tax.note } };
}

r.post('/login', loginLimiter, asyncH(async (req, res) => {
  const { email, password } = z.object({ email: str(200).toLowerCase(), password: z.string().max(200) }).parse(req.body);
  const { rows: [u] } = await pool.query('SELECT * FROM users WHERE lower(email)=$1', [email]);
  const fail = async (msg = 'Incorrect email or password.') => {
    await audit({ ip: req.ip, userAgent: req.get('user-agent'), user: u ? { id: u.id, email: u.email } : { email } }, 'auth.login_failed', { entityType: 'user', entityId: u?.id, newValue: { email } });
    throw unauthorized(msg);
  };
  if (!u) { await verifyPassword(password, '$2a$12$C6UzMDM.H6dfI/f/IKcEeO7m1GZ5R1lYjS3U8n3v0h6m8cL2Yy5bG').catch(() => {}); return fail(); }
  if (u.locked_until && new Date(u.locked_until) > new Date()) return fail(`This account is temporarily locked after repeated failed sign-ins. Try again after ${new Date(u.locked_until).toLocaleTimeString('en-GB', { timeZone: 'Africa/Lusaka' })}.`);
  if (!u.is_active) return fail('This account has been disabled. Contact your administrator.');
  const sec = await securityFor(u.id);
  if (!(await verifyPassword(password, u.password_hash))) {
    const n = u.failed_logins + 1;
    await pool.query(`UPDATE users SET failed_logins=$2::int, locked_until=CASE WHEN $2::int >= $3::int THEN now() + ($4::text || ' minutes')::interval ELSE locked_until END WHERE id=$1`, [u.id, n, sec.maxFailed, String(sec.lockMin)]);
    return fail();
  }
  // choose default company: last used or first membership
  const { rows: mem } = await pool.query(`SELECT company_id FROM memberships m JOIN companies c ON c.id=m.company_id WHERE m.user_id=$1 AND m.is_active AND c.is_active ORDER BY m.created_at LIMIT 1`, [u.id]);
  let companyId = mem[0]?.company_id || null;
  if (!companyId && u.is_super_admin) companyId = (await pool.query('SELECT id FROM companies WHERE is_active ORDER BY is_demo, id LIMIT 1')).rows[0]?.id || null;
  if (!companyId && !u.is_super_admin) return fail('Your account is not assigned to any company. Contact your administrator.');
  const token = randomToken(32);
  const csrf = randomToken(24);
  await pool.query(`INSERT INTO sessions (id, user_id, company_id, csrf_token, ip, user_agent, expires_at) VALUES ($1,$2,$3,$4,$5,$6, now() + ($7 || ' hours')::interval)`,
    [sha256(token), u.id, companyId, csrf, req.ip, (req.get('user-agent') || '').slice(0, 300), String(sec.ttl)]);
  await pool.query('UPDATE users SET failed_logins=0, locked_until=NULL, last_login_at=now() WHERE id=$1', [u.id]);
  res.cookie(COOKIE, token, { httpOnly: true, secure: config.cookieSecure, sameSite: 'lax', maxAge: sec.ttl * 3600 * 1000, path: '/' });
  await audit({ ip: req.ip, userAgent: req.get('user-agent'), user: { id: u.id, email: u.email }, companyId }, 'auth.login', { entityType: 'user', entityId: u.id });
  res.json({ ok: true, csrf_token: csrf });
}));

r.get('/public-branding', asyncH(async (req, res) => {
  const cid = Number(req.query.company) || (await pool.query('SELECT id FROM companies WHERE is_active ORDER BY is_demo, id LIMIT 1')).rows[0]?.id;
  if (!cid) return res.json({ name: 'TAEL Books', branding: DEFAULT_SETTINGS.branding, has_logo: false });
  const { rows: [c] } = await pool.query('SELECT id, name, settings FROM companies WHERE id=$1 AND is_active', [cid]);
  if (!c) return res.json({ name: 'TAEL Books', branding: DEFAULT_SETTINGS.branding, has_logo: false });
  const b = mergeSettings(DEFAULT_SETTINGS, c.settings).branding;
  res.json({ company_id: c.id, name: c.name, branding: { primary_color: b.primary_color, secondary_color: b.secondary_color, login_title: b.login_title, login_tagline: b.login_tagline, theme: b.theme },
    has_logo: !!b.logo_document_id, has_dark_logo: !!b.logo_dark_document_id, has_favicon: !!b.favicon_document_id });
}));

r.use(authenticate);

r.get('/me', asyncH(async (req, res) => {
  const { rows: companies } = req.ctx.isSuperAdmin
    ? await pool.query('SELECT id, name, is_demo FROM companies WHERE is_active ORDER BY name')
    : await pool.query('SELECT c.id, c.name, c.is_demo FROM memberships m JOIN companies c ON c.id=m.company_id WHERE m.user_id=$1 AND m.is_active AND c.is_active ORDER BY c.name', [req.ctx.user.id]);
  res.json({ ...sessionPayload(req.ctx), companies });
}));

r.post('/logout', asyncH(async (req, res) => {
  if (req.ctx.sessionId) await pool.query('DELETE FROM sessions WHERE id=$1', [req.ctx.sessionId]);
  await audit(req.ctx, 'auth.logout', { entityType: 'user', entityId: req.ctx.user.id });
  res.clearCookie(COOKIE, { path: '/' });
  res.json({ ok: true });
}));

r.post('/switch-company', asyncH(async (req, res) => {
  const { company_id } = z.object({ company_id: z.coerce.number().int().positive() }).parse(req.body);
  if (!req.ctx.isSuperAdmin) {
    const { rows } = await pool.query('SELECT 1 FROM memberships WHERE user_id=$1 AND company_id=$2 AND is_active', [req.ctx.user.id, company_id]);
    if (!rows[0]) throw forbidden('You do not have access to that company.');
  }
  await pool.query('UPDATE sessions SET company_id=$2 WHERE id=$1', [req.ctx.sessionId, company_id]);
  await audit({ ...req.ctx, companyId: company_id }, 'auth.switch_company', { entityType: 'company', entityId: company_id });
  res.json({ ok: true });
}));

r.post('/change-password', asyncH(async (req, res) => {
  const { current_password, new_password } = z.object({ current_password: z.string(), new_password: z.string() }).parse(req.body);
  const { rows: [u] } = await pool.query('SELECT password_hash FROM users WHERE id=$1', [req.ctx.user.id]);
  if (!(await verifyPassword(current_password, u.password_hash))) throw badRequest('Your current password is incorrect.');
  checkPasswordPolicy(new_password, req.ctx.settings?.security?.password_min_length || 10);
  if (current_password === new_password) throw badRequest('Choose a password different from your current one.');
  await pool.query('UPDATE users SET password_hash=$2, must_change_password=false, password_changed_at=now(), updated_at=now() WHERE id=$1', [req.ctx.user.id, await hashPassword(new_password)]);
  await pool.query('DELETE FROM sessions WHERE user_id=$1 AND id<>$2', [req.ctx.user.id, req.ctx.sessionId]);
  await audit(req.ctx, 'auth.password_changed', { entityType: 'user', entityId: req.ctx.user.id });
  res.json({ ok: true });
}));

r.put('/profile', asyncH(async (req, res) => {
  const { name, phone } = z.object({ name: str(120).min(1), phone: str(40).optional() }).parse(req.body);
  await pool.query('UPDATE users SET name=$2, phone=$3, updated_at=now() WHERE id=$1', [req.ctx.user.id, name, phone || null]);
  await audit(req.ctx, 'user.profile_updated', { entityType: 'user', entityId: req.ctx.user.id, newValue: { name, phone } });
  res.json({ ok: true });
}));

export default r;
