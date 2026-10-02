import { pool } from '../db/pool.js';

const SENSITIVE = /password|secret|api_?key|token|hash/i;
function scrub(v) {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(scrub);
  const out = {};
  for (const [k, val] of Object.entries(v)) out[k] = SENSITIVE.test(k) ? (val ? '[redacted]' : val) : scrub(val);
  return out;
}

/**
 * Append an immutable audit record. Pass `db` to write inside the caller's transaction
 * so the audit row commits (or rolls back) together with the change it describes.
 */
export async function audit(ctx, action, { entityType, entityId, oldValue, newValue, viaAi = false, companyId } = {}, db = pool) {
  await db.query(
    `INSERT INTO audit_logs (company_id, user_id, user_email, action, entity_type, entity_id, old_value, new_value, ip, user_agent, via_ai)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [companyId ?? ctx?.companyId ?? null, ctx?.user?.id ?? null, ctx?.user?.email ?? null, action, entityType ?? null,
     entityId != null ? String(entityId) : null, oldValue === undefined ? null : JSON.stringify(scrub(oldValue)),
     newValue === undefined ? null : JSON.stringify(scrub(newValue)), ctx?.ip ?? null, ctx?.userAgent?.slice(0, 300) ?? null, viaAi || !!ctx?.viaAi],
  );
}

/** Shallow diff for readable before/after audit records. */
export function diff(before, after) {
  const o = {}, n = {};
  for (const k of new Set([...Object.keys(before || {}), ...Object.keys(after || {})])) {
    if (JSON.stringify(before?.[k]) !== JSON.stringify(after?.[k])) { o[k] = before?.[k]; n[k] = after?.[k]; }
  }
  return { oldValue: o, newValue: n };
}
