// Financial reports. Every figure is computed from posted journal lines (the `ledger` view)
// or from posted source documents — never from stored balances.
import { toCents, fromCents } from '../lib/money.js';
import { badRequest, notFound } from '../lib/errors.js';
import { accountBalances, accountBalance, naturalBalance, getSystemAccount } from './ledger.js';
import { prevDay, getReconciliation } from './banking.js';
import { fiscalYearFor } from './company-setup.js';

const M = (c) => fromCents(c);
function intId(v) { const n = Number(v); if (!Number.isSafeInteger(n) || n <= 0) throw badRequest('Invalid filter value.'); return n; }
const today = () => new Date().toISOString().slice(0, 10);
const col = (key, label, type = 'text', extra = {}) => ({ key, label, type, ...extra });
export const TYPE_LABEL = { ASSET: 'Assets', LIABILITY: 'Liabilities', EQUITY: 'Equity', REVENUE: 'Revenue', COST_OF_SALES: 'Cost of Sales', EXPENSE: 'Expenses' };

function range(q) {
  const to = q.to || today();
  const from = q.from || `${to.slice(0, 7)}-01`;
  if (from > to) throw badRequest('The start date must be on or before the end date.');
  return { from, to };
}
export function addDays(d, n) { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); }
export function addMonths(d, n) { const x = new Date(`${d}T00:00:00Z`); const day = x.getUTCDate(); x.setUTCDate(1); x.setUTCMonth(x.getUTCMonth() + n); const last = new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth() + 1, 0)).getUTCDate(); x.setUTCDate(Math.min(day, last)); return x.toISOString().slice(0, 10); }
const daysBetween = (a, b) => Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 86400000);

async function companyFy(db, companyId, date) {
  const { rows: [c] } = await db.query('SELECT fy_start_month FROM companies WHERE id=$1', [companyId]);
  const y = fiscalYearFor(date, c.fy_start_month);
  return `${y}-${String(c.fy_start_month).padStart(2, '0')}-01`;
}

// ───────────────────────── Trial balance ─────────────────────────
export async function trialBalance(db, companyId, q = {}) {
  const asOf = q.to || q.as_of || today();
  const bals = await accountBalances(db, companyId, { to: asOf, branchId: q.branch_id, departmentId: q.department_id });
  let td = 0n, tc = 0n;
  const rows = bals.filter((b) => toCents(b.balance) !== 0n || q.include_zero === 'true').map((b) => {
    const v = toCents(b.balance);
    const debit = v > 0n ? v : 0n, credit = v < 0n ? -v : 0n;
    td += debit; tc += credit;
    return { account_id: b.id, code: b.code, account: b.name, type: TYPE_LABEL[b.type], debit: debit ? M(debit) : null, credit: credit ? M(credit) : null };
  });
  rows.push({ _style: 'total', code: '', account: 'Total', type: '', debit: M(td), credit: M(tc) });
  return { title: 'Trial Balance', subtitle: `As at ${asOf}`, as_of: asOf, balanced: td === tc,
    columns: [col('code', 'Code'), col('account', 'Account'), col('type', 'Type'), col('debit', 'Debit', 'money'), col('credit', 'Credit', 'money')], rows,
    totals: { debit: M(td), credit: M(tc) } };
}

// ───────────────────────── General ledger ─────────────────────────
export async function generalLedger(db, companyId, q = {}) {
  const { from, to } = range(q);
  const accs = q.account_id
    ? (await db.query(`SELECT id, code, name, type FROM accounts WHERE company_id=$1 AND id=$2`, [companyId, q.account_id])).rows
    : (await db.query(`SELECT a.id, a.code, a.name, a.type FROM accounts a WHERE a.company_id=$1 AND EXISTS (SELECT 1 FROM ledger l WHERE l.account_id=a.id AND l.entry_date <= $2) ORDER BY a.code`, [companyId, to])).rows;
  const { rows: lines } = await db.query(
    `SELECT l.account_id, l.entry_id, l.entry_date, l.entry_number, l.reference, COALESCE(l.description, l.entry_description) AS description, l.source_type, l.debit, l.credit,
            c.name AS customer, s.name AS supplier
       FROM ledger l LEFT JOIN customers c ON c.id=l.customer_id LEFT JOIN suppliers s ON s.id=l.supplier_id
      WHERE l.company_id=$1 AND l.entry_date BETWEEN $2 AND $3 ${q.account_id ? 'AND l.account_id=$4' : ''}
      ORDER BY l.entry_date, l.entry_id, l.line_no`, q.account_id ? [companyId, from, to, q.account_id] : [companyId, from, to]);
  const byAcc = new Map();
  for (const l of lines) { if (!byAcc.has(l.account_id)) byAcc.set(l.account_id, []); byAcc.get(l.account_id).push(l); }
  const rows = [];
  for (const a of accs) {
    const opening = toCents(await accountBalance(db, companyId, a.id, prevDay(from)));
    const ls = byAcc.get(a.id) || [];
    if (!ls.length && opening === 0n) continue;
    rows.push({ _style: 'header', date: '', number: a.code, description: a.name });
    rows.push({ _style: 'subtle', date: from, number: '', description: 'Opening balance', balance: M(opening) });
    let run = opening, td = 0n, tc = 0n;
    for (const l of ls) {
      run += toCents(l.debit) - toCents(l.credit); td += toCents(l.debit); tc += toCents(l.credit);
      rows.push({ entry_id: l.entry_id, date: l.entry_date, number: l.entry_number, reference: l.reference, description: l.description + (l.customer ? ` · ${l.customer}` : l.supplier ? ` · ${l.supplier}` : ''),
        debit: toCents(l.debit) ? l.debit : null, credit: toCents(l.credit) ? l.credit : null, balance: M(run) });
    }
    rows.push({ _style: 'subtotal', date: to, description: `Closing balance — ${a.name}`, debit: M(td), credit: M(tc), balance: M(run) });
  }
  return { title: 'General Ledger', subtitle: `${from} to ${to}`, from, to,
    columns: [col('date', 'Date', 'date'), col('number', 'Journal'), col('reference', 'Reference'), col('description', 'Description'), col('debit', 'Debit', 'money'), col('credit', 'Credit', 'money'), col('balance', 'Balance', 'money')], rows };
}

// ───────────────────────── Profit & loss ─────────────────────────
async function plSections(db, companyId, from, to, q) {
  const bals = await accountBalances(db, companyId, { from, to, branchId: q.branch_id, departmentId: q.department_id });
  const sec = { REVENUE: [], COST_OF_SALES: [], EXPENSE: [] };
  for (const b of bals) if (sec[b.type]) sec[b.type].push({ ...b, amount: naturalBalance(b.type, b.balance) });
  const sum = (t) => sec[t].reduce((s, a) => s + a.amount, 0n);
  const revenue = sum('REVENUE'), cos = sum('COST_OF_SALES'), expenses = sum('EXPENSE');
  return { sec, revenue, cos, gross: revenue - cos, expenses, net: revenue - cos - expenses };
}

function previousRange(from, to, mode) {
  if (mode === 'previous_year') return { from: addMonths(from, -12), to: addMonths(to, -12) };
  const len = daysBetween(from, to);
  const pto = prevDay(from);
  // month-to-date compares with the same days of the previous month
  if (from.endsWith('-01') && from.slice(0, 7) === to.slice(0, 7) && !addDays(to, 1).endsWith('-01')) return { from: addMonths(from, -1), to: addMonths(to, -1) };
  // whole months stay whole months
  if (from.endsWith('-01') && addDays(to, 1).endsWith('-01')) {
    const months = (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 + Number(to.slice(5, 7)) - Number(from.slice(5, 7)) + 1;
    return { from: addMonths(from, -months), to: pto };
  }
  return { from: addDays(pto, -len), to: pto };
}

export async function profitAndLoss(db, companyId, q = {}) {
  const { from, to } = range(q);
  const cur = await plSections(db, companyId, from, to, q);
  const cmp = q.compare && q.compare !== 'none' ? previousRange(from, to, q.compare) : null;
  const prev = cmp ? await plSections(db, companyId, cmp.from, cmp.to, q) : null;
  const prevAmt = (type, id) => (prev ? prev.sec[type].find((a) => a.id === id)?.amount ?? 0n : null);
  const rows = [];
  const pct = (a, b) => (b === null || b === undefined || b === 0n ? null : (Number(((a - b) * 10000n) / (b < 0n ? -b : b)) / 100).toFixed(1));
  const line = (label, a, b, style, extra = {}) => rows.push({ _style: style, account: label, amount: a === null ? null : M(a), ...(prev ? { previous: b === null ? null : M(b), change_pct: b === null ? null : pct(a, b) } : {}), ...extra });
  const section = (type, title) => {
    rows.push({ _style: 'header', account: title });
    for (const a of cur.sec[type]) {
      const pa = prevAmt(type, a.id);
      if (a.amount === 0n && (!pa || pa === 0n)) continue;
      line(`${a.code} ${a.name}`, a.amount, pa, null, { account_id: a.id, _indent: 1 });
    }
  };
  section('REVENUE', 'Revenue'); line('Total Revenue', cur.revenue, prev?.revenue ?? null, 'subtotal');
  section('COST_OF_SALES', 'Cost of Sales'); line('Total Cost of Sales', cur.cos, prev?.cos ?? null, 'subtotal');
  line('Gross Profit', cur.gross, prev?.gross ?? null, 'total');
  section('EXPENSE', 'Operating Expenses'); line('Total Expenses', cur.expenses, prev?.expenses ?? null, 'subtotal');
  line(cur.net >= 0n ? 'Net Profit' : 'Net Loss', cur.net, prev?.net ?? null, 'grand');
  const columns = [col('account', 'Account'), col('amount', `${from} – ${to}`, 'money')];
  if (prev) columns.push(col('previous', `${cmp.from} – ${cmp.to}`, 'money'), col('change_pct', 'Change %', 'percent'));
  return { title: 'Profit and Loss Statement', subtitle: `${from} to ${to}`, from, to, compare: cmp, columns, rows,
    summary: { revenue: M(cur.revenue), cost_of_sales: M(cur.cos), gross_profit: M(cur.gross), expenses: M(cur.expenses), net_profit: M(cur.net),
      ...(prev ? { previous: { revenue: M(prev.revenue), cost_of_sales: M(prev.cos), gross_profit: M(prev.gross), expenses: M(prev.expenses), net_profit: M(prev.net) } } : {}) } };
}

// ───────────────────────── Balance sheet ─────────────────────────
export async function balanceSheet(db, companyId, q = {}) {
  const asOf = q.to || q.as_of || today();
  const bals = await accountBalances(db, companyId, { to: asOf, branchId: q.branch_id });
  const fyStart = await companyFy(db, companyId, asOf);
  const cy = await plSections(db, companyId, fyStart, asOf, q);
  const all = await plSections(db, companyId, '1900-01-01', asOf, q);
  const priorUnclosed = all.net - cy.net;
  const group = (type) => bals.filter((b) => b.type === type).map((b) => ({ ...b, amount: naturalBalance(type, b.balance) })).filter((b) => b.amount !== 0n);
  const assets = group('ASSET'), liabilities = group('LIABILITY'), equity = group('EQUITY');
  const current = (a) => !['fixed_asset', 'long_term_liability'].includes(a.subtype);
  const rows = [];
  const sum = (xs) => xs.reduce((s, a) => s + a.amount, 0n);
  const list = (xs) => xs.forEach((a) => rows.push({ account: `${a.code} ${a.name}`, amount: M(a.amount), account_id: a.id, _indent: 2 }));
  rows.push({ _style: 'header', account: 'ASSETS' });
  const ca = assets.filter(current), nca = assets.filter((a) => !current(a));
  rows.push({ _style: 'subheader', account: 'Current Assets', _indent: 1 }); list(ca); rows.push({ _style: 'subtotal', account: 'Total Current Assets', amount: M(sum(ca)) });
  rows.push({ _style: 'subheader', account: 'Non-current Assets', _indent: 1 }); list(nca); rows.push({ _style: 'subtotal', account: 'Total Non-current Assets', amount: M(sum(nca)) });
  const totalAssets = sum(assets);
  rows.push({ _style: 'total', account: 'TOTAL ASSETS', amount: M(totalAssets) });
  rows.push({ _style: 'header', account: 'LIABILITIES' });
  const cl = liabilities.filter(current), ncl = liabilities.filter((a) => !current(a));
  rows.push({ _style: 'subheader', account: 'Current Liabilities', _indent: 1 }); list(cl); rows.push({ _style: 'subtotal', account: 'Total Current Liabilities', amount: M(sum(cl)) });
  rows.push({ _style: 'subheader', account: 'Non-current Liabilities', _indent: 1 }); list(ncl); rows.push({ _style: 'subtotal', account: 'Total Non-current Liabilities', amount: M(sum(ncl)) });
  const totalLiab = sum(liabilities);
  rows.push({ _style: 'total', account: 'TOTAL LIABILITIES', amount: M(totalLiab) });
  rows.push({ _style: 'header', account: 'EQUITY' });
  list(equity);
  if (priorUnclosed !== 0n) rows.push({ account: 'Retained earnings – prior years (not yet closed)', amount: M(priorUnclosed), _indent: 2 });
  rows.push({ account: 'Current year earnings', amount: M(cy.net), _indent: 2 });
  const totalEquity = sum(equity) + priorUnclosed + cy.net;
  rows.push({ _style: 'total', account: 'TOTAL EQUITY', amount: M(totalEquity) });
  rows.push({ _style: 'grand', account: 'TOTAL LIABILITIES AND EQUITY', amount: M(totalLiab + totalEquity) });
  return { title: 'Statement of Financial Position', subtitle: `As at ${asOf}`, as_of: asOf, balanced: totalAssets === totalLiab + totalEquity,
    columns: [col('account', 'Account'), col('amount', 'Amount', 'money')], rows,
    summary: { total_assets: M(totalAssets), total_liabilities: M(totalLiab), total_equity: M(totalEquity), current_year_earnings: M(cy.net) } };
}

// ───────────────────────── Cash flow (direct method) ─────────────────────────
export async function cashFlow(db, companyId, q = {}) {
  const { from, to } = range(q);
  const { rows: cashAccs } = await db.query(`SELECT a.id FROM accounts a JOIN bank_accounts b ON b.account_id=a.id WHERE a.company_id=$1`, [companyId]);
  const cashIds = cashAccs.map((a) => a.id);
  const opening = (await Promise.all(cashIds.map((id) => accountBalance(db, companyId, id, prevDay(from))))).reduce((s, v) => s + toCents(v), 0n);
  const { rows: lines } = await db.query(
    `SELECT l.entry_id, l.account_id, l.debit, l.credit, a.type, a.subtype, a.cash_flow_category, a.name, a.system_key, l.source_type
       FROM ledger l JOIN accounts a ON a.id=l.account_id
      WHERE l.company_id=$1 AND l.entry_date BETWEEN $2 AND $3
        AND l.entry_id IN (SELECT entry_id FROM ledger WHERE company_id=$1 AND account_id = ANY($4) AND entry_date BETWEEN $2 AND $3)`, [companyId, from, to, cashIds]);
  const byEntry = new Map();
  for (const l of lines) { if (!byEntry.has(l.entry_id)) byEntry.set(l.entry_id, []); byEntry.get(l.entry_id).push(l); }
  const buckets = new Map(); // key: category|label → cents
  const put = (cat, label, v) => { const k = `${cat}|${label}`; buckets.set(k, (buckets.get(k) || 0n) + v); };
  const labelFor = (l) => {
    if (l.cash_flow_category !== 'OPERATING') return l.name;
    if (l.system_key === 'AR' || l.type === 'REVENUE') return 'Receipts from customers & other income';
    if (l.system_key === 'AP' || l.type === 'EXPENSE' || l.type === 'COST_OF_SALES') return 'Payments to suppliers & for expenses';
    if (l.subtype === 'tax') return 'Taxes paid / refunded';
    if (l.subtype === 'payroll' || ['PAYE_PAYABLE', 'NAPSA_PAYABLE'].includes(l.system_key)) return 'Payments to employees & statutory';
    return 'Other operating cash flows';
  };
  for (const ls of byEntry.values()) {
    const cash = ls.filter((l) => cashIds.includes(l.account_id));
    const other = ls.filter((l) => !cashIds.includes(l.account_id));
    const net = cash.reduce((s, l) => s + toCents(l.debit) - toCents(l.credit), 0n);
    if (net === 0n || !other.length) continue; // internal transfers net to zero
    const weights = other.map((l) => toCents(l.credit) - toCents(l.debit)); // cash in ↔ credit to other side
    const totalW = weights.reduce((s, w) => s + w, 0n);
    let allocated = 0n;
    other.forEach((l, i) => {
      const share = i === other.length - 1 ? net - allocated : (totalW === 0n ? 0n : (net * weights[i]) / totalW);
      allocated += share;
      put(l.cash_flow_category === 'CASH' ? 'OPERATING' : l.cash_flow_category, labelFor(l), share);
    });
  }
  const rows = []; let netChange = 0n;
  for (const [cat, title] of [['OPERATING', 'Cash flows from operating activities'], ['INVESTING', 'Cash flows from investing activities'], ['FINANCING', 'Cash flows from financing activities']]) {
    rows.push({ _style: 'header', item: title });
    let t = 0n;
    for (const [k, v] of [...buckets].filter(([k]) => k.startsWith(`${cat}|`)).sort()) { if (v === 0n) continue; rows.push({ item: k.split('|')[1], amount: M(v), _indent: 1 }); t += v; }
    rows.push({ _style: 'subtotal', item: `Net cash from ${cat.toLowerCase()} activities`, amount: M(t) });
    netChange += t;
  }
  rows.push({ _style: 'total', item: 'Net increase / (decrease) in cash', amount: M(netChange) });
  rows.push({ item: 'Cash and bank at beginning of period', amount: M(opening) });
  rows.push({ _style: 'grand', item: 'Cash and bank at end of period', amount: M(opening + netChange) });
  return { title: 'Cash Flow Statement', subtitle: `${from} to ${to} (direct method)`, from, to,
    columns: [col('item', 'Item'), col('amount', 'Amount', 'money')], rows, summary: { opening: M(opening), net_change: M(netChange), closing: M(opening + netChange) } };
}

// ───────────────────────── Aging ─────────────────────────
const BUCKETS = [['current', 'Current', -Infinity, 0], ['d1_30', '1–30', 1, 30], ['d31_60', '31–60', 31, 60], ['d61_90', '61–90', 61, 90], ['d90p', '90+', 91, Infinity]];

export async function aging(db, companyId, side, q = {}) {
  const asOf = q.to || q.as_of || today();
  const isAR = side === 'AR';
  const t = isAR ? 'sales_documents' : 'purchase_documents';
  const party = isAR ? 'customer' : 'supplier';
  const docType = isAR ? 'INVOICE' : 'BILL';
  const noteType = isAR ? 'CREDIT_NOTE' : 'DEBIT_NOTE';
  const { rows: docs } = await db.query(
    `SELECT d.id, d.number, d.doc_date, d.due_date, d.total, d.${party}_id AS party_id, p.name AS party_name,
       COALESCE((SELECT SUM(pa.amount) FROM payment_allocations pa JOIN payments pm ON pm.id=pa.payment_id
                  WHERE pa.${isAR ? 'sales' : 'purchase'}_document_id=d.id AND pm.status='POSTED' AND pm.payment_date <= $2),0) AS paid,
       COALESCE((SELECT SUM(n.total) FROM ${t} n WHERE n.related_document_id=d.id AND n.doc_type='${noteType}' AND n.status='APPLIED' AND n.doc_date <= $2),0) AS credited
       FROM ${t} d JOIN ${party}s p ON p.id=d.${party}_id
      WHERE d.company_id=$1 AND d.doc_type='${docType}' AND d.status NOT IN ('DRAFT','CANCELLED','PENDING_APPROVAL') AND d.doc_date <= $2
        ${q[`${party}_id`] ? `AND d.${party}_id = ${intId(q[`${party}_id`])}` : ''}`, [companyId, asOf]);
  const parties = new Map();
  const detail = [];
  for (const d of docs) {
    let out = toCents(d.total) - toCents(d.paid) - toCents(d.credited);
    if (out <= 0n) continue;
    const over = daysBetween(d.due_date || d.doc_date, asOf);
    const b = BUCKETS.find(([, , lo, hi]) => over >= lo && over <= hi) || BUCKETS[0];
    if (!parties.has(d.party_id)) parties.set(d.party_id, { party: d.party_name, party_id: d.party_id, ...Object.fromEntries(BUCKETS.map(([k]) => [k, 0n])), total: 0n });
    const p = parties.get(d.party_id); p[b[0]] += out; p.total += out;
    detail.push({ number: d.number, party: d.party_name, doc_date: d.doc_date, due_date: d.due_date, days_overdue: Math.max(over, 0), bucket: b[1], outstanding: M(out), document_id: d.id });
  }
  // Reconcile to the sub-ledger: receipts/payments not yet allocated, unapplied credit/debit notes and
  // party-tagged journals show as "Unapplied", so the aging total always equals the control account.
  const ctrl = await getSystemAccount(db, companyId, side);
  const partyFilter = q[`${party}_id`] ? `AND l.${party}_id = ${intId(q[`${party}_id`])}` : '';
  const { rows: subs } = await db.query(
    `SELECT l.${party}_id AS party_id, p.name AS party_name, SUM(${isAR ? 'l.debit - l.credit' : 'l.credit - l.debit'})::numeric(18,2) AS bal
       FROM ledger l LEFT JOIN ${party}s p ON p.id=l.${party}_id
      WHERE l.company_id=$1 AND l.account_id=$2 AND l.entry_date <= $3 ${partyFilter}
      GROUP BY l.${party}_id, p.name`, [companyId, ctrl.id, asOf]);
  for (const s of subs) {
    const key = s.party_id ?? 0;
    if (!parties.has(key)) parties.set(key, { party: s.party_name || `Unassigned (no ${party})`, party_id: s.party_id, ...Object.fromEntries(BUCKETS.map(([k]) => [k, 0n])), total: 0n });
    const p = parties.get(key);
    const diff = toCents(s.bal) - p.total;
    if (diff !== 0n) { p.unapplied = (p.unapplied || 0n) + diff; p.total += diff; }
  }
  for (const [key, p] of parties) if (p.total === 0n && !BUCKETS.some(([k]) => p[k] !== 0n)) parties.delete(key);
  const hasUnapplied = [...parties.values()].some((p) => p.unapplied);
  const totals = Object.fromEntries([...BUCKETS.map(([k]) => [k, 0n]), ...(hasUnapplied ? [['unapplied', 0n]] : []), ['total', 0n]]);
  const rows = [...parties.values()].sort((a, b) => (b.total > a.total ? 1 : -1)).map((p) => {
    for (const k of Object.keys(totals)) totals[k] += p[k] || 0n;
    return { party_id: p.party_id, party: p.party, ...Object.fromEntries(Object.keys(totals).map((k) => [k, p[k] ? M(p[k]) : null])) };
  });
  rows.push({ _style: 'total', party: 'Total', ...Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, M(v)])) });
  return { title: isAR ? 'Accounts Receivable Aging' : 'Accounts Payable Aging', subtitle: `As at ${asOf} (days past due date)`, as_of: asOf,
    columns: [col('party', isAR ? 'Customer' : 'Supplier'), ...BUCKETS.map(([k, l]) => col(k, l, 'money')),
      ...(hasUnapplied ? [col('unapplied', isAR ? 'Unapplied credits' : 'Unapplied payments', 'money')] : []), col('total', 'Total', 'money')], rows,
    detail: detail.sort((a, b) => b.days_overdue - a.days_overdue), totals: Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, M(v)])) };
}

// ───────────────────────── Sales / purchases / expenses / income ─────────────────────────
export async function salesReport(db, companyId, q = {}) {
  const { from, to } = range(q);
  const group = q.group_by || 'customer';
  const keyExpr = { customer: 'c.name', month: `to_char(d.doc_date,'YYYY-MM')`, account: `a.code || ' ' || a.name`, item: `COALESCE(i.name, l.description)` }[group];
  if (!keyExpr) throw badRequest('Invalid grouping.');
  const { rows } = await db.query(
    `SELECT ${keyExpr} AS grp,
            COUNT(DISTINCT d.id) FILTER (WHERE d.doc_type='INVOICE')::int AS invoices,
            COALESCE(SUM(CASE WHEN d.doc_type='INVOICE' THEN l.line_subtotal ELSE -l.line_subtotal END),0)::numeric(18,2) AS net_sales,
            COALESCE(SUM(CASE WHEN d.doc_type='INVOICE' THEN l.line_tax ELSE -l.line_tax END),0)::numeric(18,2) AS tax,
            COALESCE(SUM(CASE WHEN d.doc_type='INVOICE' THEN l.line_total ELSE -l.line_total END),0)::numeric(18,2) AS gross
       FROM sales_documents d JOIN sales_document_lines l ON l.document_id=d.id JOIN customers c ON c.id=d.customer_id JOIN accounts a ON a.id=l.account_id LEFT JOIN items i ON i.id=l.item_id
      WHERE d.company_id=$1 AND d.doc_type IN ('INVOICE','CREDIT_NOTE') AND d.status NOT IN ('DRAFT','CANCELLED') AND d.doc_date BETWEEN $2 AND $3
        ${q.customer_id ? `AND d.customer_id=${intId(q.customer_id)}` : ''} ${q.branch_id ? `AND d.branch_id=${intId(q.branch_id)}` : ''}
      GROUP BY 1 ORDER BY ${group === 'month' ? '1' : 'net_sales DESC'}`, [companyId, from, to]);
  const tot = rows.reduce((s, r) => ({ invoices: s.invoices + r.invoices, net: s.net + toCents(r.net_sales), tax: s.tax + toCents(r.tax), gross: s.gross + toCents(r.gross) }), { invoices: 0, net: 0n, tax: 0n, gross: 0n });
  return { title: 'Sales Report', subtitle: `${from} to ${to} · by ${group}`, from, to,
    columns: [col('grp', group[0].toUpperCase() + group.slice(1)), col('invoices', 'Invoices', 'number'), col('net_sales', 'Net sales', 'money'), col('tax', 'VAT', 'money'), col('gross', 'Gross', 'money')],
    rows: [...rows, { _style: 'total', grp: 'Total', invoices: tot.invoices, net_sales: M(tot.net), tax: M(tot.tax), gross: M(tot.gross) }] };
}

export async function purchaseReport(db, companyId, q = {}) {
  const { from, to } = range(q);
  const group = q.group_by || 'supplier';
  const keyExpr = { supplier: 's.name', month: `to_char(d.doc_date,'YYYY-MM')`, account: `a.code || ' ' || a.name` }[group];
  if (!keyExpr) throw badRequest('Invalid grouping.');
  const { rows } = await db.query(
    `SELECT ${keyExpr} AS grp, COUNT(DISTINCT d.id) FILTER (WHERE d.doc_type='BILL')::int AS bills,
            COALESCE(SUM(CASE WHEN d.doc_type='BILL' THEN l.line_subtotal ELSE -l.line_subtotal END),0)::numeric(18,2) AS net,
            COALESCE(SUM(CASE WHEN d.doc_type='BILL' THEN l.line_tax ELSE -l.line_tax END),0)::numeric(18,2) AS tax,
            COALESCE(SUM(CASE WHEN d.doc_type='BILL' THEN l.line_total ELSE -l.line_total END),0)::numeric(18,2) AS gross
       FROM purchase_documents d JOIN purchase_document_lines l ON l.document_id=d.id JOIN suppliers s ON s.id=d.supplier_id JOIN accounts a ON a.id=l.account_id
      WHERE d.company_id=$1 AND d.doc_type IN ('BILL','DEBIT_NOTE') AND d.status NOT IN ('DRAFT','CANCELLED','PENDING_APPROVAL') AND d.doc_date BETWEEN $2 AND $3
        ${q.supplier_id ? `AND d.supplier_id=${intId(q.supplier_id)}` : ''}
      GROUP BY 1 ORDER BY ${group === 'month' ? '1' : 'net DESC'}`, [companyId, from, to]);
  const tot = rows.reduce((s, r) => ({ bills: s.bills + r.bills, net: s.net + toCents(r.net), tax: s.tax + toCents(r.tax), gross: s.gross + toCents(r.gross) }), { bills: 0, net: 0n, tax: 0n, gross: 0n });
  return { title: 'Purchase Report', subtitle: `${from} to ${to} · by ${group}`, from, to,
    columns: [col('grp', group[0].toUpperCase() + group.slice(1)), col('bills', 'Bills', 'number'), col('net', 'Net', 'money'), col('tax', 'VAT', 'money'), col('gross', 'Gross', 'money')],
    rows: [...rows, { _style: 'total', grp: 'Total', bills: tot.bills, net: M(tot.net), tax: M(tot.tax), gross: M(tot.gross) }] };
}

async function ledgerByType(db, companyId, types, q, title) {
  const { from, to } = range(q);
  const group = q.group_by || 'account';
  const keyExpr = { account: `a.code || ' ' || a.name`, month: `to_char(l.entry_date,'YYYY-MM')`, department: `COALESCE(dp.name,'Unassigned')`, branch: `COALESCE(b.name,'Unassigned')`,
    supplier: `COALESCE(s.name, 'No supplier')`, customer: `COALESCE(c.name,'No customer')` }[group];
  if (!keyExpr) throw badRequest('Invalid grouping.');
  const debitNormal = types.some((t) => t !== 'REVENUE');
  const { rows } = await db.query(
    `SELECT ${keyExpr} AS grp, COUNT(*)::int AS transactions,
            SUM(${debitNormal ? 'l.debit - l.credit' : 'l.credit - l.debit'})::numeric(18,2) AS amount
       FROM ledger l JOIN accounts a ON a.id=l.account_id LEFT JOIN departments dp ON dp.id=l.department_id LEFT JOIN branches b ON b.id=l.branch_id
       LEFT JOIN suppliers s ON s.id=l.supplier_id LEFT JOIN customers c ON c.id=l.customer_id
      WHERE l.company_id=$1 AND a.type = ANY($4::account_type[]) AND l.entry_date BETWEEN $2 AND $3
        ${q.account_id ? `AND l.account_id=${intId(q.account_id)}` : ''} ${q.branch_id ? `AND l.branch_id=${intId(q.branch_id)}` : ''} ${q.department_id ? `AND l.department_id=${intId(q.department_id)}` : ''}
      GROUP BY 1 HAVING SUM(l.debit - l.credit) <> 0 ORDER BY ${group === 'month' ? '1' : 'amount DESC'}`, [companyId, from, to, types]);
  const total = rows.reduce((s, r) => s + toCents(r.amount), 0n);
  return { title, subtitle: `${from} to ${to} · by ${group}`, from, to,
    columns: [col('grp', group[0].toUpperCase() + group.slice(1)), col('transactions', 'Transactions', 'number'), col('amount', 'Amount', 'money'), col('share', '% of total', 'percent')],
    rows: [...rows.map((r) => ({ ...r, share: total ? (Number((toCents(r.amount) * 10000n) / total) / 100).toFixed(1) : null })), { _style: 'total', grp: 'Total', transactions: rows.reduce((s, r) => s + r.transactions, 0), amount: M(total) }] };
}
export const expenseReport = (db, cid, q) => ledgerByType(db, cid, ['EXPENSE', 'COST_OF_SALES'], q, 'Expense Report');
export const incomeReport = (db, cid, q) => ledgerByType(db, cid, ['REVENUE'], q, 'Income Report');

// ───────────────────────── Tax (VAT / WHT) ─────────────────────────
export async function taxReport(db, companyId, q = {}) {
  const { from, to } = range(q);
  const { rows: sales } = await db.query(
    `SELECT t.code, t.name, t.rate,
            SUM(CASE WHEN d.doc_type='INVOICE' THEN l.line_subtotal ELSE -l.line_subtotal END)::numeric(18,2) AS taxable,
            SUM(CASE WHEN d.doc_type='INVOICE' THEN l.line_tax ELSE -l.line_tax END)::numeric(18,2) AS tax
       FROM sales_document_lines l JOIN sales_documents d ON d.id=l.document_id JOIN tax_rates t ON t.id=l.tax_rate_id
      WHERE d.company_id=$1 AND d.doc_type IN ('INVOICE','CREDIT_NOTE') AND d.status NOT IN ('DRAFT','CANCELLED') AND d.doc_date BETWEEN $2 AND $3
      GROUP BY t.code, t.name, t.rate ORDER BY t.code`, [companyId, from, to]);
  const { rows: purch } = await db.query(
    `SELECT code, name, rate, SUM(taxable)::numeric(18,2) AS taxable, SUM(tax)::numeric(18,2) AS tax FROM (
       SELECT t.code, t.name, t.rate, CASE WHEN d.doc_type='BILL' THEN l.line_subtotal ELSE -l.line_subtotal END AS taxable, CASE WHEN d.doc_type='BILL' THEN l.line_tax ELSE -l.line_tax END AS tax
         FROM purchase_document_lines l JOIN purchase_documents d ON d.id=l.document_id JOIN tax_rates t ON t.id=l.tax_rate_id
        WHERE d.company_id=$1 AND d.doc_type IN ('BILL','DEBIT_NOTE') AND d.status NOT IN ('DRAFT','CANCELLED','PENDING_APPROVAL') AND d.doc_date BETWEEN $2 AND $3
       UNION ALL
       SELECT t.code, t.name, t.rate, e.amount, e.tax_amount FROM expenses e JOIN tax_rates t ON t.id=e.tax_rate_id
        WHERE e.company_id=$1 AND e.status='POSTED' AND e.expense_date BETWEEN $2 AND $3) x
      GROUP BY code, name, rate ORDER BY code`, [companyId, from, to]);
  // Ledger cross-check: movement on VAT control accounts in the period
  const out = await getSystemAccount(db, companyId, 'VAT_OUTPUT').catch(() => null);
  const inp = await getSystemAccount(db, companyId, 'VAT_INPUT').catch(() => null);
  const mv = async (a, credit) => {
    if (!a) return 0n;
    const { rows: [r] } = await db.query(`SELECT COALESCE(SUM(${credit ? 'credit-debit' : 'debit-credit'}),0)::numeric(18,2) AS v FROM ledger WHERE company_id=$1 AND account_id=$2 AND entry_date BETWEEN $3 AND $4 AND source_type <> 'TAX_SETTLEMENT'`, [companyId, a.id, from, to]);
    return toCents(r.v);
  };
  const outputL = await mv(out, true), inputL = await mv(inp, false);
  const { rows: [wht] } = await db.query(`SELECT COALESCE(SUM(wht_amount),0)::numeric(18,2) AS v FROM payments WHERE company_id=$1 AND status='POSTED' AND payment_date BETWEEN $2 AND $3`, [companyId, from, to]);
  const rows = [{ _style: 'header', item: 'Output tax (sales)' }];
  let so = 0n; for (const r of sales) { so += toCents(r.tax); rows.push({ item: `${r.code} — ${r.name} @ ${Number(r.rate)}%`, taxable: r.taxable, tax: r.tax, _indent: 1 }); }
  rows.push({ _style: 'subtotal', item: 'Total output tax', tax: M(so) });
  rows.push({ _style: 'header', item: 'Input tax (purchases & expenses)' });
  let si = 0n; for (const r of purch) { si += toCents(r.tax); rows.push({ item: `${r.code} — ${r.name} @ ${Number(r.rate)}%`, taxable: r.taxable, tax: r.tax, _indent: 1 }); }
  rows.push({ _style: 'subtotal', item: 'Total input tax', tax: M(si) });
  rows.push({ _style: 'grand', item: so - si >= 0n ? 'Net VAT payable' : 'Net VAT refundable', tax: M(so - si) });
  rows.push({ _style: 'subtle', item: 'Ledger check — VAT output account movement', tax: M(outputL) });
  rows.push({ _style: 'subtle', item: 'Ledger check — VAT input account movement', tax: M(inputL) });
  rows.push({ item: 'Withholding tax deducted from supplier payments', tax: wht.v });
  return { title: 'Tax Report (VAT & WHT)', subtitle: `${from} to ${to}`, from, to,
    note: 'Calculated using the tax rates configured in Admin Center → Tax. Confirm current rates and filing requirements with ZRA.',
    columns: [col('item', 'Item'), col('taxable', 'Taxable amount', 'money'), col('tax', 'Tax', 'money')], rows,
    summary: { output_tax: M(so), input_tax: M(si), net_vat: M(so - si), withholding_tax: wht.v, ledger_output: M(outputL), ledger_input: M(inputL) } };
}

// ───────────────────────── Statements ─────────────────────────
export async function partyStatement(db, companyId, kind, q = {}) {
  const isC = kind === 'customer';
  const id = q[`${kind}_id`];
  if (!id) throw badRequest(`Choose a ${kind}.`);
  const { rows: [p] } = await db.query(`SELECT * FROM ${kind}s WHERE company_id=$1 AND id=$2`, [companyId, id]);
  if (!p) throw notFound(isC ? 'Customer' : 'Supplier');
  const to = q.to || today();
  const from = q.from || addMonths(to, -3);
  const ctrl = await getSystemAccount(db, companyId, isC ? 'AR' : 'AP');
  const sign = isC ? 'debit - credit' : 'credit - debit';
  const { rows: [o] } = await db.query(`SELECT COALESCE(SUM(${sign}),0)::numeric(18,2) AS v FROM ledger WHERE company_id=$1 AND account_id=$2 AND ${kind}_id=$3 AND entry_date < $4`, [companyId, ctrl.id, id, from]);
  const { rows: lines } = await db.query(
    `SELECT entry_id, entry_date, entry_number, reference, entry_description AS description, source_type, debit, credit FROM ledger
      WHERE company_id=$1 AND account_id=$2 AND ${kind}_id=$3 AND entry_date BETWEEN $4 AND $5 ORDER BY entry_date, entry_id`, [companyId, ctrl.id, id, from, to]);
  let run = toCents(o.v);
  const rows = [{ _style: 'subtle', date: from, description: 'Balance brought forward', balance: o.v }];
  for (const l of lines) {
    const inc = isC ? toCents(l.debit) : toCents(l.credit), dec = isC ? toCents(l.credit) : toCents(l.debit);
    run += inc - dec;
    rows.push({ entry_id: l.entry_id, date: l.entry_date, reference: l.reference || l.entry_number, description: l.description, type: l.source_type.replace('_', ' ').toLowerCase(),
      charges: inc ? M(inc) : null, payments: dec ? M(dec) : null, balance: M(run) });
  }
  rows.push({ _style: 'total', date: to, description: 'Balance due', balance: M(run) });
  const ag = await aging(db, companyId, isC ? 'AR' : 'AP', { as_of: to, [`${kind}_id`]: id });
  return { title: isC ? 'Customer Statement' : 'Supplier Statement', subtitle: `${p.name} · ${from} to ${to}`, party: p, from, to, balance: M(run),
    columns: [col('date', 'Date', 'date'), col('reference', 'Reference'), col('description', 'Description'), col('type', 'Type'), col('charges', isC ? 'Invoiced' : 'Billed', 'money'), col('payments', isC ? 'Paid / credited' : 'Paid / credited', 'money'), col('balance', 'Balance', 'money')],
    rows, aging: ag.totals, open_items: ag.detail };
}

export async function cashbook(db, companyId, q = {}) {
  const { from, to } = range(q);
  const { rows: accs } = await db.query(`SELECT a.id, a.code, a.name FROM accounts a JOIN bank_accounts b ON b.account_id=a.id WHERE a.company_id=$1 ${q.account_id ? 'AND a.id=$2' : ''} ORDER BY a.code`, q.account_id ? [companyId, q.account_id] : [companyId]);
  const rows = [];
  for (const a of accs) {
    const opening = toCents(await accountBalance(db, companyId, a.id, prevDay(from)));
    const { rows: ls } = await db.query(
      `SELECT entry_id, entry_date, entry_number, reference, COALESCE(description, entry_description) AS description, debit, credit FROM ledger
        WHERE company_id=$1 AND account_id=$2 AND entry_date BETWEEN $3 AND $4 ORDER BY entry_date, entry_id, line_no`, [companyId, a.id, from, to]);
    if (!ls.length && opening === 0n) continue;
    rows.push({ _style: 'header', date: '', description: `${a.code} ${a.name}` });
    rows.push({ _style: 'subtle', date: from, description: 'Opening balance', balance: M(opening) });
    let run = opening, ti = 0n, tout = 0n;
    for (const l of ls) { run += toCents(l.debit) - toCents(l.credit); ti += toCents(l.debit); tout += toCents(l.credit);
      rows.push({ entry_id: l.entry_id, date: l.entry_date, number: l.entry_number, reference: l.reference, description: l.description, receipts: toCents(l.debit) ? l.debit : null, payments: toCents(l.credit) ? l.credit : null, balance: M(run) }); }
    rows.push({ _style: 'subtotal', date: to, description: 'Closing balance', receipts: M(ti), payments: M(tout), balance: M(run) });
  }
  return { title: 'Cashbook', subtitle: `${from} to ${to}`, from, to,
    columns: [col('date', 'Date', 'date'), col('number', 'Journal'), col('reference', 'Reference'), col('description', 'Description'), col('receipts', 'Receipts', 'money'), col('payments', 'Payments', 'money'), col('balance', 'Balance', 'money')], rows };
}

export async function reconciliationReport(db, companyId, q = {}) {
  if (!q.reconciliation_id) {
    const { rows } = await db.query(`SELECT r.id, r.statement_date, a.name AS bank, r.statement_balance, r.book_balance, r.status, u.name AS completed_by, r.completed_at
      FROM reconciliations r JOIN accounts a ON a.id=r.bank_account_id LEFT JOIN users u ON u.id=r.completed_by WHERE r.company_id=$1 ORDER BY r.statement_date DESC`, [companyId]);
    return { title: 'Bank Reconciliation History', subtitle: 'All reconciliations',
      columns: [col('statement_date', 'Statement date', 'date'), col('bank', 'Account'), col('statement_balance', 'Statement balance', 'money'), col('book_balance', 'Book balance', 'money'), col('status', 'Status'), col('completed_by', 'Completed by')],
      rows: rows.map((r) => ({ ...r, _link: { reconciliation_id: r.id } })) };
  }
  const r = await getReconciliation(db, companyId, q.reconciliation_id);
  const rows = [
    { item: 'Balance per bank statement', amount: r.statement_balance, _style: 'subtotal' },
    { _style: 'header', item: 'Less: uncleared payments (cheques/transfers not yet on statement)' },
    ...r.lines.filter((l) => !l.cleared && toCents(l.credit)).map((l) => ({ item: `${l.entry_date} ${l.entry_number} ${l.description || ''}`, amount: fromCents(-toCents(l.credit)), _indent: 1 })),
    { _style: 'header', item: 'Add: uncleared deposits' },
    ...r.lines.filter((l) => !l.cleared && toCents(l.debit)).map((l) => ({ item: `${l.entry_date} ${l.entry_number} ${l.description || ''}`, amount: l.debit, _indent: 1 })),
    { _style: 'total', item: 'Adjusted bank balance', amount: fromCents(toCents(r.statement_balance) - toCents(r.uncleared_payments) + toCents(r.uncleared_deposits)) },
    { _style: 'total', item: 'Balance per books', amount: r.book_balance },
    { _style: 'grand', item: 'Unreconciled difference', amount: r.difference },
  ];
  return { title: 'Bank Reconciliation Report', subtitle: `${r.bank_account_name} · statement ${r.statement_date} · ${r.status}`, columns: [col('item', 'Item'), col('amount', 'Amount', 'money')], rows };
}

export async function journalReport(db, companyId, q = {}) {
  const { from, to } = range(q);
  const p = [companyId, from, to]; let w = '';
  if (q.source_type) { p.push(q.source_type); w += ` AND e.source_type=$${p.length}`; }
  if (q.status) { p.push(q.status); w += ` AND e.status=$${p.length}`; } else w += ` AND e.status IN ('POSTED','REVERSED')`;
  const { rows } = await db.query(
    `SELECT e.id AS entry_id, e.entry_date, e.number, e.reference, e.description, e.source_type, e.status, l.line_no, a.code, a.name AS account, l.debit, l.credit, u.name AS posted_by
       FROM journal_entries e JOIN journal_lines l ON l.entry_id=e.id JOIN accounts a ON a.id=l.account_id LEFT JOIN users u ON u.id=e.posted_by
      WHERE e.company_id=$1 AND e.entry_date BETWEEN $2 AND $3 ${w} ORDER BY e.entry_date, e.id, l.line_no LIMIT 20000`, p);
  const out = []; let last = null, td = 0n, tc = 0n;
  for (const r of rows) {
    if (r.entry_id !== last) { out.push({ _style: 'header', entry_id: r.entry_id, date: r.entry_date, number: r.number, account: `${r.description}${r.reference ? ` (${r.reference})` : ''}`, source: r.source_type, status: r.status }); last = r.entry_id; }
    td += toCents(r.debit); tc += toCents(r.credit);
    out.push({ entry_id: r.entry_id, account: `${r.code} ${r.account}`, debit: toCents(r.debit) ? r.debit : null, credit: toCents(r.credit) ? r.credit : null, _indent: 1 });
  }
  out.push({ _style: 'total', account: 'Total', debit: M(td), credit: M(tc) });
  return { title: 'Journal Report', subtitle: `${from} to ${to}`, from, to,
    columns: [col('date', 'Date', 'date'), col('number', 'Journal'), col('account', 'Account / description'), col('source', 'Source'), col('debit', 'Debit', 'money'), col('credit', 'Credit', 'money')], rows: out };
}

export async function auditReport(db, companyId, q = {}) {
  const { from, to } = range({ from: q.from || addDays(today(), -30), to: q.to });
  const p = [companyId, from, to]; let w = '';
  if (q.user_id) { p.push(q.user_id); w += ` AND l.user_id=$${p.length}`; }
  if (q.action) { p.push(`%${q.action}%`); w += ` AND l.action ILIKE $${p.length}`; }
  if (q.entity_type) { p.push(q.entity_type); w += ` AND l.entity_type=$${p.length}`; }
  const { rows } = await db.query(
    `SELECT l.id, l.created_at, COALESCE(u.name, l.user_email, 'System') AS user_name, l.action, l.entity_type, l.entity_id, l.old_value, l.new_value, l.ip, l.via_ai
       FROM audit_logs l LEFT JOIN users u ON u.id=l.user_id
      WHERE (l.company_id=$1 OR (l.company_id IS NULL AND l.user_id IN (SELECT user_id FROM memberships WHERE company_id=$1)))
        AND l.created_at::date BETWEEN $2 AND $3 ${w} ORDER BY l.id DESC LIMIT 5000`, p);
  return { title: 'Audit Report', subtitle: `${from} to ${to}`, from, to,
    columns: [col('created_at', 'Date & time', 'datetime'), col('user_name', 'User'), col('action', 'Action'), col('entity', 'Record'), col('changes', 'Changes'), col('ip', 'IP')],
    rows: rows.map((r) => ({ ...r, entity: r.entity_type ? `${r.entity_type} #${r.entity_id}` : '', changes: summariseChange(r.old_value, r.new_value), action: r.via_ai ? `${r.action} (AI)` : r.action })) };
}
function summariseChange(o, n) {
  const parts = [];
  for (const k of new Set([...Object.keys(o || {}), ...Object.keys(n || {})])) {
    if (['lines'].includes(k)) continue;
    const a = o?.[k], b = n?.[k];
    const f = (v) => (v === null || v === undefined ? '—' : typeof v === 'object' ? JSON.stringify(v).slice(0, 60) : String(v));
    parts.push(o && k in o ? `${k}: ${f(a)} → ${f(b)}` : `${k}: ${f(b)}`);
  }
  return parts.join('; ').slice(0, 400);
}

export const REPORTS = {
  'trial-balance': { fn: trialBalance, label: 'Trial Balance', params: ['to', 'branch_id', 'department_id'] },
  'general-ledger': { fn: generalLedger, label: 'General Ledger', params: ['from', 'to', 'account_id'] },
  'profit-and-loss': { fn: profitAndLoss, label: 'Profit and Loss', params: ['from', 'to', 'compare', 'branch_id', 'department_id'] },
  'balance-sheet': { fn: balanceSheet, label: 'Balance Sheet', params: ['to', 'branch_id'] },
  'cash-flow': { fn: cashFlow, label: 'Cash Flow Statement', params: ['from', 'to'] },
  'ar-aging': { fn: (db, c, q) => aging(db, c, 'AR', q), label: 'Accounts Receivable Aging', params: ['to', 'customer_id'] },
  'ap-aging': { fn: (db, c, q) => aging(db, c, 'AP', q), label: 'Accounts Payable Aging', params: ['to', 'supplier_id'] },
  sales: { fn: salesReport, label: 'Sales Report', params: ['from', 'to', 'group_by', 'customer_id', 'branch_id'] },
  purchases: { fn: purchaseReport, label: 'Purchase Report', params: ['from', 'to', 'group_by', 'supplier_id'] },
  expenses: { fn: expenseReport, label: 'Expense Report', params: ['from', 'to', 'group_by', 'account_id', 'branch_id', 'department_id'] },
  income: { fn: incomeReport, label: 'Income Report', params: ['from', 'to', 'group_by', 'account_id'] },
  tax: { fn: taxReport, label: 'Tax Report', params: ['from', 'to'] },
  'customer-statement': { fn: (db, c, q) => partyStatement(db, c, 'customer', q), label: 'Customer Statement', params: ['customer_id', 'from', 'to'] },
  'supplier-statement': { fn: (db, c, q) => partyStatement(db, c, 'supplier', q), label: 'Supplier Statement', params: ['supplier_id', 'from', 'to'] },
  cashbook: { fn: cashbook, label: 'Cashbook', params: ['from', 'to', 'account_id'] },
  'bank-reconciliation': { fn: reconciliationReport, label: 'Bank Reconciliation Report', params: ['reconciliation_id'] },
  journal: { fn: journalReport, label: 'Journal Report', params: ['from', 'to', 'source_type', 'status'] },
  audit: { fn: auditReport, label: 'Audit Report', params: ['from', 'to', 'user_id', 'action'], permission: 'view_audit_logs' },
};
