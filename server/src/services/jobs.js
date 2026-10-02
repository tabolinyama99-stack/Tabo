// Background jobs: notifications, recurring journals, auto-reversals, anomaly scans.
// Uses a Postgres advisory lock so only one app instance runs them at a time.
import { pool, tx } from '../db/pool.js';
import { toCents, formatK } from '../lib/money.js';
import { notify } from './notifications.js';
import { createJournal, reverseJournal } from './ledger.js';
import { scanAnomalies } from './anomalies.js';
import { addMonths, addDays } from './reports.js';

const today = () => new Date().toISOString().slice(0, 10);

function systemCtx(company) {
  return { system: true, companyId: company.id, company, settings: company.settings || {}, user: null, permissions: new Set(), isSuperAdmin: false };
}

export function nextRunDate(date, freq) {
  if (freq === 'WEEKLY') return addDays(date, 7);
  if (freq === 'MONTHLY') return addMonths(date, 1);
  if (freq === 'QUARTERLY') return addMonths(date, 3);
  return addMonths(date, 12);
}

export async function runRecurring(company) {
  const ctx = systemCtx(company);
  const { rows } = await pool.query(`SELECT * FROM recurring_journals WHERE company_id=$1 AND is_active AND next_run_date <= $2 AND (end_date IS NULL OR next_run_date <= end_date)`, [company.id, today()]);
  let created = 0;
  for (const r of rows) {
    try {
      await tx(async (db) => {
        let d = r.next_run_date;
        while (d <= today() && (!r.end_date || d <= r.end_date)) {
          await createJournal(db, ctx, { date: d, description: r.description, reference: r.name, source_type: 'RECURRING', recurring_id: r.id, status: r.auto_post ? 'POSTED' : 'DRAFT', lines: r.lines, approved: r.auto_post });
          created++; d = nextRunDate(d, r.frequency);
        }
        await db.query('UPDATE recurring_journals SET next_run_date=$2, last_run_at=now() WHERE id=$1', [r.id, d]);
      });
    } catch (e) {
      await notify(pool, company.id, { kind: 'system', title: `Recurring journal "${r.name}" could not run`, body: e.message, link: '/journals/recurring', dedupeKey: `recurring-fail-${r.id}-${today()}` });
    }
  }
  return created;
}

export async function runAutoReversals(company) {
  const ctx = systemCtx(company);
  const { rows } = await pool.query(`SELECT id, auto_reverse_on FROM journal_entries WHERE company_id=$1 AND status='POSTED' AND auto_reverse_on IS NOT NULL AND auto_reverse_on <= $2 AND reversed_by IS NULL`, [company.id, today()]);
  for (const r of rows) {
    try { await tx((db) => reverseJournal(db, ctx, r.id, { date: r.auto_reverse_on, reason: 'Automatic reversal' })); } catch (e) {
      await notify(pool, company.id, { kind: 'system', title: 'An automatic reversal failed', body: e.message, link: `/journals/${r.id}`, dedupeKey: `autorev-fail-${r.id}-${today()}` });
    }
  }
}

export async function runNotifications(company) {
  const cid = company.id;
  const n = company.settings?.notifications || {};
  const { rows: overdue } = await pool.query(`SELECT d.id, d.number, d.due_date, (d.total-d.amount_paid-d.amount_credited) AS due, c.name FROM sales_documents d JOIN customers c ON c.id=d.customer_id
      WHERE d.company_id=$1 AND d.doc_type='INVOICE' AND d.status IN ('SENT','PARTIALLY_PAID') AND d.due_date < CURRENT_DATE`, [cid]);
  for (const o of overdue) await notify(pool, cid, { kind: 'invoice_overdue', title: `Invoice ${o.number} is overdue`, body: `${o.name} owes ${formatK(o.due)} (due ${o.due_date}).`, link: `/sales/documents/${o.id}`, dedupeKey: `overdue-${o.id}` });

  const days = Number(n.bill_due_days ?? 3);
  const { rows: bills } = await pool.query(`SELECT d.id, d.number, d.due_date, (d.total-d.amount_paid-d.amount_credited) AS due, s.name FROM purchase_documents d JOIN suppliers s ON s.id=d.supplier_id
      WHERE d.company_id=$1 AND d.doc_type='BILL' AND d.status IN ('POSTED','PARTIALLY_PAID') AND d.due_date <= CURRENT_DATE + $2::int`, [cid, days]);
  for (const b of bills) await notify(pool, cid, { kind: 'bill_due', title: `Bill ${b.number} ${b.due_date < today() ? 'is overdue' : 'is due soon'}`, body: `${formatK(b.due)} to ${b.name}, due ${b.due_date}.`, link: `/purchases/documents/${b.id}`, dedupeKey: `billdue-${b.id}` });

  const { rows: banks } = await pool.query(`SELECT a.id, a.name, b.low_balance_threshold, COALESCE((SELECT SUM(debit-credit) FROM ledger l WHERE l.account_id=a.id),0) AS bal,
      (SELECT MAX(statement_date) FROM reconciliations r WHERE r.bank_account_id=a.id AND r.status='COMPLETED') AS last_rec,
      EXISTS (SELECT 1 FROM ledger l WHERE l.account_id=a.id) AS has_activity, b.is_cash
      FROM accounts a JOIN bank_accounts b ON b.account_id=a.id WHERE a.company_id=$1 AND a.is_active`, [cid]);
  const lowThr = n.low_cash_threshold;
  for (const b of banks) {
    const thr = b.low_balance_threshold || lowThr;
    if (thr && b.has_activity && toCents(Number(b.bal).toFixed(2)) < toCents(thr)) await notify(pool, cid, { kind: 'low_cash', title: `Low balance: ${b.name}`, body: `Balance ${formatK(Number(b.bal).toFixed(2))} is below ${formatK(thr)}.`, link: '/banking', dedupeKey: `lowcash-${b.id}-${today()}` });
    const recDays = Number(n.reconciliation_days ?? 30);
    if (!b.is_cash && b.has_activity && (!b.last_rec || b.last_rec < addDays(today(), -recDays))) await notify(pool, cid, { kind: 'reconciliation_required', title: `Reconcile ${b.name}`, body: b.last_rec ? `Last reconciled ${b.last_rec}.` : 'This account has never been reconciled.', link: '/banking/reconcile', dedupeKey: `recon-${b.id}-${today().slice(0, 7)}` });
  }

  const d = new Date();
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  if (lastDay - d.getUTCDate() <= 3) await notify(pool, cid, { kind: 'period_closing', title: 'Month end is approaching', body: 'Review drafts, reconcile bank accounts and lock the period when complete.', link: '/admin/periods', dedupeKey: `period-close-${today().slice(0, 7)}` });

  const due = Number(company.settings?.tax?.vat_return_due_day ?? 18);
  const before = Number(company.settings?.tax?.tax_reminder_days_before ?? 5);
  const dueDate = `${today().slice(0, 8)}${String(Math.min(due, lastDay)).padStart(2, '0')}`;
  if (today() <= dueDate && addDays(today(), before) >= dueDate) await notify(pool, cid, { kind: 'tax_deadline', title: `Tax return due ${dueDate}`, body: 'Prepare the VAT return using the Tax Report. Confirm the deadline with ZRA.', link: '/reports/tax', dedupeKey: `tax-${dueDate}` });

  const { rows: [pend] } = await pool.query(`SELECT (SELECT COUNT(*) FROM expenses WHERE company_id=$1 AND status='PENDING_APPROVAL') + (SELECT COUNT(*) FROM journal_entries WHERE company_id=$1 AND status='PENDING_APPROVAL') AS n`, [cid]);
  if (Number(pend.n) > 0) await notify(pool, cid, { kind: 'approval_required', title: `${pend.n} transaction(s) awaiting approval`, link: '/approvals', dedupeKey: `approvals-${today()}` });
  const { rows: [ai] } = await pool.query(`SELECT COUNT(*)::int AS n FROM expenses WHERE company_id=$1 AND ai_generated AND status='DRAFT'`, [cid]);
  if (ai.n > 0) await notify(pool, cid, { kind: 'ai_review', title: `${ai.n} AI-prepared draft(s) need review`, link: '/approvals', dedupeKey: `ai-drafts-${today()}` });
}

export async function runAllJobs({ anomalies = true } = {}) {
  const client = await pool.connect();
  try {
    const { rows: [l] } = await client.query('SELECT pg_try_advisory_lock(777002) AS ok');
    if (!l.ok) return;
    const { rows: companies } = await client.query('SELECT * FROM companies WHERE is_active');
    for (const c of companies) {
      try {
        await runRecurring(c);
        await runAutoReversals(c);
        await runNotifications(c);
        if (anomalies) await scanAnomalies(pool, c.id);
      } catch (e) { console.error(`[jobs] company ${c.id}:`, e.message); }
    }
    await client.query(`DELETE FROM sessions WHERE expires_at < now()`);
  } finally {
    await client.query('SELECT pg_advisory_unlock(777002)').catch(() => {});
    client.release();
  }
}

export function startJobs() {
  const tick = () => runAllJobs().catch((e) => console.error('[jobs]', e.message));
  setTimeout(tick, 15_000);
  return setInterval(tick, 60 * 60 * 1000);
}
