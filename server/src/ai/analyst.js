// AI Financial Analyst: deterministic analysis of the ledger with every figure shown,
// optionally narrated by Claude (which is given only these figures).
import { pool } from '../db/pool.js';
import { profitAndLoss, aging, cashFlow, expenseReport, addMonths } from '../services/reports.js';
import { toCents, fromCents, formatK, textOf, stopProblem } from './util.js';
import { aiClient } from './provider.js';
import { audit } from '../lib/audit.js';

const pct = (a, b) => (toCents(b) === 0n ? null : Number((((Number(a) - Number(b)) / Math.abs(Number(b))) * 100).toFixed(1)));
const monthEnd = (d) => { const x = new Date(`${d.slice(0, 7)}-01T00:00:00Z`); x.setUTCMonth(x.getUTCMonth() + 1); x.setUTCDate(0); return x.toISOString().slice(0, 10); };

export async function analyse(ctx, q = {}) {
  const cid = ctx.companyId;
  const to = q.to || new Date().toISOString().slice(0, 10);
  const from = q.from || `${to.slice(0, 7)}-01`;
  const pl = await profitAndLoss(pool, cid, { from, to, compare: 'previous_period' });
  const prev = pl.compare;
  const cur = pl.summary, pr = pl.summary.previous;
  const expCur = await expenseReport(pool, cid, { from, to, group_by: 'account' });
  const expPrev = await expenseReport(pool, cid, { from: prev.from, to: prev.to, group_by: 'account' });
  const pm = new Map(expPrev.rows.filter((r) => !r._style).map((r) => [r.grp, r.amount]));
  const catChanges = expCur.rows.filter((r) => !r._style).map((r) => ({ category: r.grp, current: r.amount, previous: pm.get(r.grp) || '0.00', change: fromCents(toCents(r.amount) - toCents(pm.get(r.grp) || 0)) }));
  for (const [k, v] of pm) if (!catChanges.find((c) => c.category === k)) catChanges.push({ category: k, current: '0.00', previous: v, change: fromCents(-toCents(v)) });
  catChanges.sort((a, b) => Math.abs(Number(b.change)) - Math.abs(Number(a.change)));
  const cf = await cashFlow(pool, cid, { from, to });
  const ar = await aging(pool, cid, 'AR', { as_of: to });
  const ap = await aging(pool, cid, 'AP', { as_of: to });
  const { rows: custCur } = await pool.query(`SELECT c.name, SUM(CASE WHEN d.doc_type='INVOICE' THEN d.subtotal ELSE -d.subtotal END)::numeric(18,2) AS amount FROM sales_documents d JOIN customers c ON c.id=d.customer_id
      WHERE d.company_id=$1 AND d.doc_type IN ('INVOICE','CREDIT_NOTE') AND d.status NOT IN ('DRAFT','CANCELLED') AND d.doc_date BETWEEN $2 AND $3 GROUP BY c.name ORDER BY 2 DESC LIMIT 5`, [cid, from, to]);
  const { rows: supCur } = await pool.query(`SELECT s.name, SUM(l.debit - l.credit)::numeric(18,2) AS amount FROM ledger l JOIN suppliers s ON s.id=l.supplier_id JOIN accounts a ON a.id=l.account_id
      WHERE l.company_id=$1 AND a.type IN ('EXPENSE','COST_OF_SALES','ASSET') AND a.system_key IS DISTINCT FROM 'VAT_INPUT' AND l.entry_date BETWEEN $2 AND $3 GROUP BY s.name ORDER BY 2 DESC LIMIT 5`, [cid, from, to]);

  const insights = [];
  const add = (severity, title, text, figures) => insights.push({ severity, title, text, figures });
  const opexCur = fromCents(toCents(cur.expenses) + toCents(cur.cost_of_sales)), opexPrev = fromCents(toCents(pr.expenses) + toCents(pr.cost_of_sales));
  const revP = pct(cur.revenue, pr.revenue), expP = pct(opexCur, opexPrev), npP = pct(cur.net_profit, pr.net_profit);
  add(revP !== null && revP < -10 ? 'warning' : 'info', 'Revenue', `Revenue was ${formatK(cur.revenue)} compared with ${formatK(pr.revenue)} in the previous period${revP !== null ? ` (${revP > 0 ? '+' : ''}${revP}%)` : ''}.`,
    [{ label: 'Current revenue', value: cur.revenue }, { label: 'Previous revenue', value: pr.revenue }]);
  const top = catChanges[0];
  add(expP !== null && expP > 10 ? 'warning' : 'info', 'Expenses', `Total costs (cost of sales + operating expenses) were ${formatK(opexCur)} versus ${formatK(opexPrev)}${expP !== null ? ` (${expP > 0 ? '+' : ''}${expP}%)` : ''}.${top && toCents(top.change) !== 0n ? ` The largest ${toCents(top.change) > 0n ? 'increase' : 'decrease'} came from ${top.category.replace(/^\d+\s/, '')} (${formatK(top.previous)} → ${formatK(top.current)}).` : ''}`,
    [{ label: 'Current costs', value: opexCur }, { label: 'Previous costs', value: opexPrev }, ...(top ? [{ label: `${top.category} change`, value: top.change }] : [])]);
  add(toCents(cur.net_profit) < 0n ? 'critical' : npP !== null && npP < -10 ? 'warning' : 'positive', 'Profit', `Net ${toCents(cur.net_profit) >= 0n ? 'profit' : 'loss'} was ${formatK(cur.net_profit)} against ${formatK(pr.net_profit)} previously${npP !== null ? ` (${npP > 0 ? '+' : ''}${npP}%)` : ''}. Gross margin ${toCents(cur.revenue) ? `${((Number(cur.gross_profit) / Number(cur.revenue)) * 100).toFixed(1)}%` : 'n/a'}.`,
    [{ label: 'Net profit', value: cur.net_profit }, { label: 'Previous net profit', value: pr.net_profit }, { label: 'Gross profit', value: cur.gross_profit }]);
  add(toCents(cf.summary.net_change) < 0n ? 'warning' : 'info', 'Cash flow', `Cash and bank moved from ${formatK(cf.summary.opening)} to ${formatK(cf.summary.closing)} (net ${formatK(cf.summary.net_change)}).`,
    [{ label: 'Opening cash', value: cf.summary.opening }, { label: 'Net change', value: cf.summary.net_change }, { label: 'Closing cash', value: cf.summary.closing }]);
  const overdueAR = fromCents(toCents(ar.totals.d1_30) + toCents(ar.totals.d31_60) + toCents(ar.totals.d61_90) + toCents(ar.totals.d90p));
  add(toCents(ar.totals.d90p) > 0n ? 'warning' : 'info', 'Receivables', `Customers owe ${formatK(ar.totals.total)}, of which ${formatK(overdueAR)} is overdue${toCents(ar.totals.d90p) ? ` and ${formatK(ar.totals.d90p)} is more than 90 days late` : ''}.`,
    [{ label: 'Total receivables', value: ar.totals.total }, { label: 'Overdue', value: overdueAR }, { label: 'Over 90 days', value: ar.totals.d90p }]);
  add('info', 'Payables', `You owe suppliers ${formatK(ap.totals.total)} (${formatK(fromCents(toCents(ap.totals.total) - toCents(ap.totals.current)))} past due).`, [{ label: 'Total payables', value: ap.totals.total }]);
  if (custCur.length) { const share = toCents(cur.revenue) ? ((Number(custCur[0].amount) / Number(cur.revenue)) * 100).toFixed(0) : null;
    add(share && Number(share) > 40 ? 'warning' : 'info', 'Customer concentration', `${custCur[0].name} is the largest customer with ${formatK(custCur[0].amount)}${share ? ` (${share}% of revenue)` : ''}.`, custCur.map((c) => ({ label: c.name, value: c.amount }))); }
  if (supCur.length) add('info', 'Supplier spending', `Highest supplier spend: ${supCur.map((s) => `${s.name} ${formatK(s.amount)}`).join(', ')}.`, supCur.map((s) => ({ label: s.name, value: s.amount })));

  const result = { period: { from, to }, previous: prev, summary: { current: { ...cur, previous: undefined }, previous: pr }, expense_changes: catChanges.slice(0, 10), insights, narrative: null, engine: 'built-in' };
  if (q.narrative !== 'false') {
    const ai = await aiClient(ctx);
    if (ai) {
      try {
        const resp = await ai.client.messages.create({ model: ai.model, max_tokens: 8000, messages: [{ role: 'user', content:
          `You are a financial analyst for a Zambian business. Write a short plain-English commentary (max 180 words, 3 short paragraphs) on these results for ${from} to ${to}. Use ONLY figures that appear in the data, quoted exactly with K prefix. Do not compute new numbers except simple percentages already given. Use neutral language.\n\nDATA:\n${JSON.stringify({ insights: insights.map((x) => x.text), expense_changes: result.expense_changes.slice(0, 5) })}` }] });
        if (!stopProblem(resp)) { result.narrative = textOf(resp); result.engine = 'claude'; }
      } catch (e) { console.error('[ai] analyst narrative failed:', e.message); }
    }
  }
  await audit({ ...ctx, viaAi: true }, 'ai.analysis', { entityType: 'report', entityId: 'ai-analysis', newValue: { from, to } });
  return result;
}
export { addMonths, monthEnd };
