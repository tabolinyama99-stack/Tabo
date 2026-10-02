// Dashboard metrics — all computed live from the ledger and posted documents.
import { toCents, fromCents } from '../lib/money.js';
import { profitAndLoss, aging, cashFlow, addMonths, addDays } from './reports.js';

const today = () => new Date().toISOString().slice(0, 10);
const monthStart = (d) => `${d.slice(0, 7)}-01`;
const monthEnd = (d) => { const x = new Date(`${d.slice(0, 7)}-01T00:00:00Z`); x.setUTCMonth(x.getUTCMonth() + 1); x.setUTCDate(0); return x.toISOString().slice(0, 10); };

export async function dashboard(db, companyId, q = {}) {
  const to = q.to || today();
  const from = q.from || monthStart(to);
  const longRange = (new Date(to) - new Date(from)) / 86400000 > 62;
  const pl = await profitAndLoss(db, companyId, { from, to, compare: longRange ? 'previous_year' : 'previous_period', branch_id: q.branch_id });

  const { rows: cash } = await db.query(
    `SELECT b.is_cash, COALESCE(SUM(l.debit - l.credit),0)::numeric(18,2) AS bal
       FROM bank_accounts b LEFT JOIN ledger l ON l.account_id=b.account_id AND l.entry_date <= $2 WHERE b.company_id=$1 GROUP BY b.is_cash`, [companyId, to]);
  const cashBal = cash.find((r) => r.is_cash)?.bal || '0.00';
  const bankBal = cash.find((r) => !r.is_cash)?.bal || '0.00';

  const ar = await aging(db, companyId, 'AR', { as_of: to });
  const ap = await aging(db, companyId, 'AP', { as_of: to });
  const overdue = (t) => fromCents(toCents(t.d1_30) + toCents(t.d31_60) + toCents(t.d61_90) + toCents(t.d90p));
  const { rows: [oi] } = await db.query(`SELECT COUNT(*)::int AS n FROM sales_documents WHERE company_id=$1 AND doc_type='INVOICE' AND status IN ('SENT','PARTIALLY_PAID') AND due_date < $2`, [companyId, to]);
  const { rows: [ob] } = await db.query(`SELECT COUNT(*)::int AS n FROM purchase_documents WHERE company_id=$1 AND doc_type='BILL' AND status IN ('POSTED','PARTIALLY_PAID')`, [companyId]);

  // 12-month trends from the ledger in one pass
  const trendFrom = monthStart(addMonths(to, -11));
  const { rows: trend } = await db.query(
    `SELECT to_char(l.entry_date,'YYYY-MM') AS month,
            COALESCE(SUM(CASE WHEN a.type='REVENUE' THEN l.credit - l.debit END),0)::numeric(18,2) AS revenue,
            COALESCE(SUM(CASE WHEN a.type IN ('EXPENSE','COST_OF_SALES') THEN l.debit - l.credit END),0)::numeric(18,2) AS expenses
       FROM ledger l JOIN accounts a ON a.id=l.account_id
      WHERE l.company_id=$1 AND l.entry_date BETWEEN $2 AND $3 ${q.branch_id ? 'AND l.branch_id=$4' : ''}
      GROUP BY 1 ORDER BY 1`, q.branch_id ? [companyId, trendFrom, monthEnd(to), q.branch_id] : [companyId, trendFrom, monthEnd(to)]);
  const { rows: cashTrend } = await db.query(
    `SELECT to_char(l.entry_date,'YYYY-MM') AS month, COALESCE(SUM(l.debit),0)::numeric(18,2) AS inflow, COALESCE(SUM(l.credit),0)::numeric(18,2) AS outflow
       FROM ledger l JOIN bank_accounts b ON b.account_id=l.account_id
      WHERE l.company_id=$1 AND l.entry_date BETWEEN $2 AND $3
        AND NOT EXISTS (SELECT 1 FROM journal_entries e WHERE e.id=l.entry_id AND e.source_type='BANK'
                         AND (SELECT COUNT(*) FROM journal_lines x JOIN bank_accounts bx ON bx.account_id=x.account_id WHERE x.entry_id=e.id) = (SELECT COUNT(*) FROM journal_lines x WHERE x.entry_id=e.id))
      GROUP BY 1 ORDER BY 1`, [companyId, trendFrom, monthEnd(to)]);
  const months = [];
  for (let i = 11; i >= 0; i--) months.push(addMonths(monthStart(to), -i).slice(0, 7));
  const tmap = new Map(trend.map((r) => [r.month, r]));
  const cmap = new Map(cashTrend.map((r) => [r.month, r]));
  const series = months.map((m) => {
    const r = tmap.get(m) || { revenue: '0.00', expenses: '0.00' };
    const c = cmap.get(m) || { inflow: '0.00', outflow: '0.00' };
    return { month: m, revenue: r.revenue, expenses: r.expenses, profit: fromCents(toCents(r.revenue) - toCents(r.expenses)), inflow: c.inflow, outflow: c.outflow, net_cash: fromCents(toCents(c.inflow) - toCents(c.outflow)) };
  });

  const { rows: byCustomer } = await db.query(
    `SELECT c.id, c.name, SUM(CASE WHEN d.doc_type='INVOICE' THEN d.subtotal ELSE -d.subtotal END)::numeric(18,2) AS amount
       FROM sales_documents d JOIN customers c ON c.id=d.customer_id
      WHERE d.company_id=$1 AND d.doc_type IN ('INVOICE','CREDIT_NOTE') AND d.status NOT IN ('DRAFT','CANCELLED') AND d.doc_date BETWEEN $2 AND $3
      GROUP BY c.id, c.name ORDER BY 3 DESC LIMIT 8`, [companyId, from, to]);
  const { rows: byCategory } = await db.query(
    `SELECT a.id, a.name, SUM(l.debit - l.credit)::numeric(18,2) AS amount
       FROM ledger l JOIN accounts a ON a.id=l.account_id
      WHERE l.company_id=$1 AND a.type IN ('EXPENSE','COST_OF_SALES') AND l.entry_date BETWEEN $2 AND $3
      GROUP BY a.id, a.name HAVING SUM(l.debit - l.credit) <> 0 ORDER BY 3 DESC LIMIT 8`, [companyId, from, to]);
  const { rows: [rev] } = await db.query(
    `SELECT (SELECT COUNT(*) FROM review_flags WHERE company_id=$1 AND status='OPEN')::int AS flags,
            (SELECT COUNT(*) FROM expenses WHERE company_id=$1 AND status IN ('DRAFT','PENDING_APPROVAL'))::int AS expense_drafts,
            (SELECT COUNT(*) FROM journal_entries WHERE company_id=$1 AND status IN ('DRAFT','PENDING_APPROVAL'))::int AS journal_drafts,
            (SELECT COUNT(*) FROM purchase_documents WHERE company_id=$1 AND status IN ('DRAFT','PENDING_APPROVAL') AND doc_type='BILL')::int AS bill_drafts,
            (SELECT COUNT(*) FROM bank_statement_lines WHERE company_id=$1 AND status='UNMATCHED')::int AS unmatched_bank`, [companyId]);

  return {
    period: { from, to }, comparison: longRange ? 'same period last year' : 'previous period',
    kpis: {
      revenue: pl.summary.revenue, revenue_prev: pl.summary.previous?.revenue,
      expenses: fromCents(toCents(pl.summary.cost_of_sales) + toCents(pl.summary.expenses)),
      expenses_prev: pl.summary.previous ? fromCents(toCents(pl.summary.previous.cost_of_sales) + toCents(pl.summary.previous.expenses)) : null,
      net_profit: pl.summary.net_profit, net_profit_prev: pl.summary.previous?.net_profit,
      cash_balance: cashBal, bank_balance: bankBal,
      receivables: ar.totals.total, payables: ap.totals.total,
      overdue_receivables: overdue(ar.totals), overdue_invoices: oi.n,
      overdue_payables: overdue(ap.totals), outstanding_bills: ob.n,
    },
    trend: series,
    sales_by_customer: byCustomer,
    expenses_by_category: byCategory,
    receivables_aging: ar.totals, payables_aging: ap.totals,
    review: rev,
  };
}

export { cashFlow, addDays };
