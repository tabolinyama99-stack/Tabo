import { pool } from '../db/pool.js';

/** Create a notification once per dedupe key. kind maps to the permission needed to see it. */
export const KIND_PERMISSION = {
  invoice_overdue: 'view_sales', payment_received: 'view_payments', bill_due: 'view_purchases', reconciliation_required: 'reconcile_bank',
  unusual_transaction: 'review_anomalies', ai_review: 'view_dashboard', low_cash: 'view_banking', period_closing: 'manage_periods',
  tax_deadline: 'view_reports', approval_required: 'approve_transactions', system: 'view_dashboard',
};

export async function notify(db, companyId, { kind, title, body, link, userId = null, dedupeKey = null }) {
  const { rows: [c] } = await db.query('SELECT settings FROM companies WHERE id=$1', [companyId]);
  const prefs = c?.settings?.notifications || {};
  if (prefs[kind] === false) return null;
  const { rows } = await db.query(
    `INSERT INTO notifications (company_id, user_id, kind, title, body, link, dedupe_key) VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (company_id, dedupe_key) DO NOTHING RETURNING id`, [companyId, userId, kind, title, body || null, link || null, dedupeKey]);
  return rows[0]?.id || null;
}

export async function listNotifications(ctx, { limit = 30 } = {}) {
  const kinds = Object.entries(KIND_PERMISSION).filter(([, p]) => ctx.isSuperAdmin || ctx.permissions.has(p)).map(([k]) => k);
  const { rows } = await pool.query(
    `SELECT n.*, (r.user_id IS NOT NULL) AS is_read FROM notifications n
       LEFT JOIN notification_reads r ON r.notification_id=n.id AND r.user_id=$2
      WHERE n.company_id=$1 AND (n.user_id IS NULL OR n.user_id=$2) AND n.kind = ANY($3)
      ORDER BY n.created_at DESC LIMIT $4`, [ctx.companyId, ctx.user.id, kinds, limit]);
  return { items: rows, unread: rows.filter((r) => !r.is_read).length };
}

export async function markRead(ctx, ids) {
  for (const id of ids) {
    await pool.query(`INSERT INTO notification_reads (notification_id, user_id) SELECT id, $2 FROM notifications WHERE id=$1 AND company_id=$3 ON CONFLICT DO NOTHING`, [id, ctx.user.id, ctx.companyId]);
  }
}
