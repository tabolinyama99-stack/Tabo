import { pool } from '../db/pool.js';
import { sha256 } from '../lib/crypto.js';
import { unauthorized, forbidden, badRequest } from '../lib/errors.js';
import { ALL_PERMISSIONS } from '../lib/permissions.js';
import { DEFAULT_SETTINGS, mergeSettings } from '../services/company-setup.js';
import { config } from '../config.js';

export const COOKIE = 'tael_sid';

/** Load the company + the user's role/permissions in it into a request context. */
export async function buildContext({ user, companyId, ip, userAgent, apiKey }) {
  const ctx = { user, ip, userAgent, isSuperAdmin: !!user?.is_super_admin && !apiKey, permissions: new Set(), companyId: null, company: null, settings: DEFAULT_SETTINGS, role: null };
  if (apiKey) {
    ctx.permissions = new Set(apiKey.permissions);
    companyId = apiKey.company_id;
  }
  if (companyId) {
    const { rows: [company] } = await pool.query('SELECT * FROM companies WHERE id=$1 AND is_active', [companyId]);
    if (company) {
      if (!apiKey && !ctx.isSuperAdmin) {
        const { rows: [m] } = await pool.query(
          `SELECT r.* FROM memberships m JOIN roles r ON r.id=m.role_id WHERE m.user_id=$1 AND m.company_id=$2 AND m.is_active`, [user.id, company.id]);
        if (m) { ctx.role = m; ctx.permissions = new Set(m.permissions); }
      }
      if (ctx.isSuperAdmin || ctx.role || apiKey) {
        ctx.companyId = company.id; ctx.company = company;
        ctx.settings = mergeSettings(DEFAULT_SETTINGS, company.settings || {});
      }
    }
  }
  if (ctx.isSuperAdmin) ctx.permissions = new Set(ALL_PERMISSIONS);
  return ctx;
}

export async function authenticate(req, res, next) {
  try {
    const ip = req.ip, userAgent = req.get('user-agent') || '';
    const bearer = req.get('authorization')?.match(/^Bearer\s+(tael_[A-Za-z0-9_-]+)$/)?.[1];
    if (bearer) {
      const { rows: [k] } = await pool.query(`SELECT * FROM api_keys WHERE key_hash=$1 AND revoked_at IS NULL`, [sha256(bearer)]);
      if (!k) throw unauthorized('Invalid API key.');
      await pool.query('UPDATE api_keys SET last_used_at=now() WHERE id=$1', [k.id]);
      const { rows: [u] } = await pool.query('SELECT id, email, name, is_super_admin FROM users WHERE id=$1', [k.created_by]);
      req.ctx = await buildContext({ user: { id: u?.id, email: `api-key:${k.name}`, name: `API key ${k.name}`, is_super_admin: false }, ip, userAgent, apiKey: k });
      req.ctx.viaApiKey = true;
      return next();
    }
    const token = req.cookies?.[COOKIE];
    if (!token) throw unauthorized();
    const sid = sha256(token);
    const { rows: [s] } = await pool.query(
      `SELECT s.*, u.email, u.name, u.is_super_admin, u.is_active, u.must_change_password, u.phone FROM sessions s JOIN users u ON u.id=s.user_id
        WHERE s.id=$1 AND s.expires_at > now()`, [sid]);
    if (!s || !s.is_active) { res.clearCookie(COOKIE); throw unauthorized('Your session has expired. Please sign in again.'); }
    // sliding expiry, throttled
    if (Date.now() - new Date(s.last_seen_at).getTime() > 60_000) {
      await pool.query(`UPDATE sessions SET last_seen_at=now(), expires_at=now() + ($2 || ' hours')::interval WHERE id=$1`, [sid, String(config.sessionTtlHours)]);
    }
    const user = { id: s.user_id, email: s.email, name: s.name, is_super_admin: s.is_super_admin, must_change_password: s.must_change_password, phone: s.phone };
    req.ctx = await buildContext({ user, companyId: s.company_id, ip, userAgent });
    req.ctx.sessionId = sid; req.ctx.csrfToken = s.csrf_token;
    // CSRF: state-changing requests must echo the session's token in a header
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.get('x-csrf-token') !== s.csrf_token) throw forbidden('Security token missing or invalid. Refresh the page and try again.');
    next();
  } catch (e) { next(e); }
}

export function requireCompany(req, res, next) {
  if (!req.ctx?.companyId) return next(badRequest('Select a company first.'));
  if (req.ctx.user?.must_change_password && !req.path.includes('change-password')) return next(forbidden('You must change your password before continuing.'));
  next();
}

/** Route guard: user needs at least one of the given permissions. */
export const need = (...perms) => (req, res, next) => {
  const c = req.ctx;
  if (c?.isSuperAdmin || perms.some((p) => c?.permissions?.has(p))) return next();
  next(forbidden());
};

export const superAdminOnly = (req, res, next) => (req.ctx?.isSuperAdmin ? next() : next(forbidden('Only the Super Admin can perform this action.')));
