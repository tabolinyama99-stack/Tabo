// Tools the AI assistant can call. Each one reads real data through the same services the
// reports use, checks the user's permissions, and returns figures together with their sources.
// The AI never writes to the ledger: the only write tool creates DRAFTS that a human approves.
import { pool, tx } from '../db/pool.js';
import { toCents, fromCents, formatK, splitInclusiveSafe } from './util.js';
import { can, createJournal, getSystemAccount } from '../services/ledger.js';
import { profitAndLoss, aging, cashFlow, salesReport, expenseReport, addMonths, addDays } from '../services/reports.js';
import { scanAnomalies } from '../services/anomalies.js';
import { createExpense } from '../services/expenses.js';
import { createSalesDoc } from '../services/sales.js';
import { createPurchaseDoc } from '../services/purchases.js';
import { audit } from '../lib/audit.js';
import { badRequest, forbidden } from '../lib/errors.js';

const today = () => new Date().toISOString().slice(0, 10);
const monthStart = (d = today()) => `${d.slice(0, 7)}-01`;
const link = (type, id) => ({ sales_document: `/sales/documents/${id}`, purchase_document: `/purchases/documents/${id}`, expense: `/expenses/${id}`, journal_entry: `/journals/${id}`, payment: `/payments/${id}`, customer: `/sales/customers/${id}`, supplier: `/purchases/suppliers/${id}` }[type]);
const src = (type, id, label, amount, date) => ({ type, id, label, amount, date, link: link(type, id) });

function requireAny(ctx, ...perms) {
  if (!perms.some((p) => can(ctx, p))) throw forbidden(`You do not have permission to view this information (needs ${perms.join(' or ')}).`);
}
const period = (i) => ({ from: i.from || monthStart(), to: i.to || today() });

// Keyword → system account / name fragments, for spend questions and draft classification
export const CATEGORY_HINTS = [
  { words: ['fuel', 'petrol', 'diesel'], key: 'FUEL', name: 'fuel' },
  { words: ['rent', 'rental', 'lease'], key: 'RENT', name: 'rent' },
  { words: ['office supplies', 'stationery', 'supplies', 'paper', 'toner'], key: 'OFFICE_SUPPLIES', name: 'office supplies' },
  { words: ['transport', 'travel', 'taxi', 'bus', 'flight'], key: 'TRANSPORT', name: 'transport' },
  { words: ['bank charge', 'bank fee', 'charges'], key: 'BANK_CHARGES', name: 'bank charges' },
  { words: ['salary', 'salaries', 'wages'], key: 'SALARIES', name: 'salaries' },
  { words: ['electricity', 'zesco', 'water', 'utilities'], name: 'utilities' },
  { words: ['airtime', 'internet', 'data bundle', 'telephone', 'phone'], name: 'telephone' },
  { words: ['repair', 'maintenance', 'service'], name: 'repairs' },
  { words: ['advert', 'marketing', 'promotion'], name: 'advertising' },
  { words: ['insurance'], name: 'insurance' },
  { words: ['meal', 'lunch', 'food', 'entertainment', 'refreshment'], name: 'meals' },
  { words: ['printing', 'photocopy'], name: 'printing' },
  { words: ['training', 'course', 'workshop'], name: 'training' },
  { words: ['professional', 'legal', 'audit fee', 'consult'], name: 'professional' },
];

export async function resolveAccountByHint(db, companyId, hint, types = ['EXPENSE', 'COST_OF_SALES']) {
  const h = String(hint || '').toLowerCase().trim();
  if (!h) return null;
  const cat = CATEGORY_HINTS.find((c) => c.words.some((w) => h.includes(w)));
  if (cat?.key) {
    const { rows: [a] } = await db.query('SELECT * FROM accounts WHERE company_id=$1 AND system_key=$2 AND is_active', [companyId, cat.key]);
    if (a) return a;
  }
  const term = cat?.name || h;
  const { rows: [b] } = await db.query(
    `SELECT *, similarity(lower(name), $3) AS sim FROM accounts WHERE company_id=$1 AND is_active AND type = ANY($2::account_type[])
      AND (lower(name) LIKE '%' || $3 || '%' OR similarity(lower(name), $3) > 0.25) ORDER BY (lower(name) LIKE '%' || $3 || '%') DESC, sim DESC LIMIT 1`, [companyId, types, term]);
  return b || null;
}

async function findParty(db, companyId, kind, name) {
  if (!name) return null;
  const { rows: [p] } = await db.query(`SELECT id, name, similarity(lower(name), lower($2)) AS sim FROM ${kind} WHERE company_id=$1 AND is_active AND (name ILIKE '%' || $2 || '%' OR similarity(lower(name), lower($2)) > 0.3) ORDER BY (name ILIKE '%' || $2 || '%') DESC, sim DESC LIMIT 1`, [companyId, name]);
  return p || null;
}

// ───────────────────────── Tool definitions ─────────────────────────
export const TOOLS = [
  {
    name: 'get_financial_summary',
    description: 'Revenue, cost of sales, expenses, net profit for a date range plus current cash/bank balances, receivables and payables. Use for "how are we doing", "what were our sales this month" etc.',
    input_schema: { type: 'object', properties: { from: { type: 'string', description: 'YYYY-MM-DD, default first day of current month' }, to: { type: 'string', description: 'YYYY-MM-DD, default today' } } },
    async run(ctx, i) {
      requireAny(ctx, 'view_reports', 'view_dashboard');
      const { from, to } = period(i);
      const pl = await profitAndLoss(pool, ctx.companyId, { from, to });
      const { rows: cash } = await pool.query(`SELECT a.id, a.name, b.is_cash, COALESCE(SUM(l.debit-l.credit),0)::numeric(18,2) AS balance FROM bank_accounts b JOIN accounts a ON a.id=b.account_id LEFT JOIN ledger l ON l.account_id=a.id AND l.entry_date <= $2 WHERE b.company_id=$1 GROUP BY a.id, a.name, b.is_cash`, [ctx.companyId, to]);
      const ar = await aging(pool, ctx.companyId, 'AR', { as_of: to });
      const ap = await aging(pool, ctx.companyId, 'AP', { as_of: to });
      return { data: { period: { from, to }, ...pl.summary, cash_and_bank: cash.map((c) => ({ account: c.name, balance: c.balance })), total_cash_and_bank: fromCents(cash.reduce((s, c) => s + toCents(c.balance), 0n)), receivables: ar.totals.total, payables: ap.totals.total },
        sources: [{ type: 'report', label: `Profit and Loss ${from} to ${to}`, link: `/reports/profit-and-loss?from=${from}&to=${to}` }, { type: 'report', label: 'Receivables aging', link: '/reports/ar-aging' }] };
    },
  },
  {
    name: 'compare_periods',
    description: 'Compare profit & loss between a period and the previous period (or same period last year), with the accounts that changed most. Use for "why did profit decrease", "compare this month with last month".',
    input_schema: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' }, compare: { type: 'string', enum: ['previous_period', 'previous_year'] } } },
    async run(ctx, i) {
      requireAny(ctx, 'view_reports');
      const { from, to } = period(i);
      const pl = await profitAndLoss(pool, ctx.companyId, { from, to, compare: i.compare || 'previous_period' });
      const changes = pl.rows.filter((r) => r.account_id && r.previous !== undefined).map((r) => ({ account: r.account, current: r.amount, previous: r.previous, change: fromCents(toCents(r.amount) - toCents(r.previous || 0)), change_pct: r.change_pct }))
        .sort((a, b) => (toCents(b.change) < 0n ? -toCents(b.change) : toCents(b.change)) > (toCents(a.change) < 0n ? -toCents(a.change) : toCents(a.change)) ? 1 : -1).slice(0, 8);
      return { data: { current_period: { from, to }, previous_period: pl.compare, current: { ...pl.summary, previous: undefined }, previous: pl.summary.previous, biggest_changes: changes },
        sources: [{ type: 'report', label: 'Profit and Loss (comparative)', link: `/reports/profit-and-loss?from=${from}&to=${to}&compare=${i.compare || 'previous_period'}` }] };
    },
  },
  {
    name: 'get_sales',
    description: 'Sales for a date range grouped by customer, month, item or account, from posted invoices and credit notes.',
    input_schema: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' }, group_by: { type: 'string', enum: ['customer', 'month', 'item', 'account'] } } },
    async run(ctx, i) {
      requireAny(ctx, 'view_sales', 'view_reports');
      const { from, to } = period(i);
      const rep = await salesReport(pool, ctx.companyId, { from, to, group_by: i.group_by || 'customer' });
      const { rows: inv } = await pool.query(`SELECT d.id, d.number, d.doc_date, d.total, c.name FROM sales_documents d JOIN customers c ON c.id=d.customer_id WHERE d.company_id=$1 AND d.doc_type='INVOICE' AND d.status NOT IN ('DRAFT','CANCELLED') AND d.doc_date BETWEEN $2 AND $3 ORDER BY d.total DESC LIMIT 10`, [ctx.companyId, from, to]);
      return { data: { period: { from, to }, rows: rep.rows.slice(0, 25) }, sources: inv.map((d) => src('sales_document', d.id, `${d.number} ${d.name}`, d.total, d.doc_date)) };
    },
  },
  {
    name: 'get_receivables',
    description: 'How much customers owe, aged into buckets, with the largest debtors and overdue invoices.',
    input_schema: { type: 'object', properties: { as_of: { type: 'string' } } },
    async run(ctx, i) {
      requireAny(ctx, 'view_sales', 'view_reports');
      const ag = await aging(pool, ctx.companyId, 'AR', { as_of: i.as_of || today() });
      return { data: { as_of: ag.as_of, totals: ag.totals, by_customer: ag.rows.filter((r) => !r._style).slice(0, 15) }, sources: ag.detail.slice(0, 15).map((d) => src('sales_document', d.document_id, `${d.number} ${d.party} (${d.days_overdue}d overdue)`, d.outstanding, d.due_date)) };
    },
  },
  {
    name: 'list_overdue_invoices',
    description: 'List customer invoices that are past their due date and not fully paid.',
    input_schema: { type: 'object', properties: {} },
    async run(ctx) {
      requireAny(ctx, 'view_sales');
      const { rows } = await pool.query(`SELECT d.id, d.number, d.doc_date, d.due_date, (d.total-d.amount_paid-d.amount_credited)::numeric(18,2) AS balance_due, c.name AS customer, CURRENT_DATE - d.due_date AS days_overdue
          FROM sales_documents d JOIN customers c ON c.id=d.customer_id WHERE d.company_id=$1 AND d.doc_type='INVOICE' AND d.status IN ('SENT','PARTIALLY_PAID') AND d.due_date < CURRENT_DATE ORDER BY d.due_date`, [ctx.companyId]);
      return { data: { count: rows.length, total_overdue: fromCents(rows.reduce((s, r) => s + toCents(r.balance_due), 0n)), invoices: rows.slice(0, 30) },
        sources: rows.slice(0, 30).map((r) => src('sales_document', r.id, `${r.number} ${r.customer}`, r.balance_due, r.due_date)) };
    },
  },
  {
    name: 'get_payables',
    description: 'How much the business owes suppliers, aged, with bills due.',
    input_schema: { type: 'object', properties: { as_of: { type: 'string' } } },
    async run(ctx, i) {
      requireAny(ctx, 'view_purchases', 'view_reports');
      const ag = await aging(pool, ctx.companyId, 'AP', { as_of: i.as_of || today() });
      return { data: { as_of: ag.as_of, totals: ag.totals, by_supplier: ag.rows.filter((r) => !r._style).slice(0, 15) }, sources: ag.detail.slice(0, 15).map((d) => src('purchase_document', d.document_id, `${d.number} ${d.party}`, d.outstanding, d.due_date)) };
    },
  },
  {
    name: 'top_expenses',
    description: 'Biggest expense categories and the largest individual expense transactions in a date range.',
    input_schema: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' }, limit: { type: 'number' } } },
    async run(ctx, i) {
      requireAny(ctx, 'view_expenses', 'view_reports');
      const { from, to } = period(i);
      const rep = await expenseReport(pool, ctx.companyId, { from, to, group_by: 'account' });
      const { rows: big } = await pool.query(`SELECT l.entry_id, l.entry_number, l.entry_date, COALESCE(l.description, l.entry_description) AS description, a.name AS account, l.debit
          FROM ledger l JOIN accounts a ON a.id=l.account_id WHERE l.company_id=$1 AND a.type IN ('EXPENSE','COST_OF_SALES') AND l.debit > 0 AND l.entry_date BETWEEN $2 AND $3 ORDER BY l.debit DESC LIMIT $4`, [ctx.companyId, from, to, Math.min(Number(i.limit) || 10, 25)]);
      return { data: { period: { from, to }, by_category: rep.rows.slice(0, 12), largest: big }, sources: big.map((b) => src('journal_entry', b.entry_id, `${b.entry_number} ${b.account}: ${b.description}`, b.debit, b.entry_date)) };
    },
  },
  {
    name: 'spend_on',
    description: 'Total spent on a topic (e.g. fuel, rent, transport) in a date range, matching expense account names and transaction descriptions.',
    input_schema: { type: 'object', properties: { keyword: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' } }, required: ['keyword'] },
    async run(ctx, i) {
      requireAny(ctx, 'view_expenses', 'view_reports');
      const { from, to } = { from: i.from || `${today().slice(0, 4)}-01-01`, to: i.to || today() };
      const acc = await resolveAccountByHint(pool, ctx.companyId, i.keyword);
      const kw = `%${String(i.keyword).toLowerCase()}%`;
      const { rows } = await pool.query(`SELECT l.entry_id, l.entry_number, l.entry_date, COALESCE(l.description, l.entry_description) AS description, a.name AS account, (l.debit - l.credit)::numeric(18,2) AS amount
          FROM ledger l JOIN accounts a ON a.id=l.account_id WHERE l.company_id=$1 AND a.type IN ('EXPENSE','COST_OF_SALES') AND l.entry_date BETWEEN $2 AND $3
            AND (l.account_id = $4 OR lower(COALESCE(l.description,'') || ' ' || l.entry_description) LIKE $5) ORDER BY l.entry_date`, [ctx.companyId, from, to, acc?.id || 0, kw]);
      const total = rows.reduce((s, r) => s + toCents(r.amount), 0n);
      return { data: { keyword: i.keyword, matched_account: acc?.name || null, period: { from, to }, total: fromCents(total), transactions: rows.length, by_month: Object.entries(rows.reduce((m, r) => { const k = r.entry_date.slice(0, 7); m[k] = (m[k] || 0n) + toCents(r.amount); return m; }, {})).map(([month, v]) => ({ month, amount: fromCents(v) })) },
        sources: rows.slice(-20).map((r) => src('journal_entry', r.entry_id, `${r.entry_number} ${r.account}: ${r.description}`, r.amount, r.entry_date)) };
    },
  },
  {
    name: 'search_transactions',
    description: 'Search posted ledger transactions by text (description, reference, customer or supplier name), optional date range and minimum amount.',
    input_schema: { type: 'object', properties: { query: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' }, min_amount: { type: 'number' } }, required: ['query'] },
    async run(ctx, i) {
      requireAny(ctx, 'view_ledger', 'view_reports');
      const q = `%${String(i.query).toLowerCase()}%`;
      const { rows } = await pool.query(`SELECT e.id, e.number, e.entry_date, e.description, e.reference, e.total, e.source_type FROM journal_entries e
          WHERE e.company_id=$1 AND e.status IN ('POSTED','REVERSED') AND ($2::date IS NULL OR e.entry_date >= $2) AND ($3::date IS NULL OR e.entry_date <= $3) AND e.total >= $5
            AND (lower(e.description || ' ' || COALESCE(e.reference,'')) LIKE $4 OR EXISTS (SELECT 1 FROM journal_lines l LEFT JOIN customers c ON c.id=l.customer_id LEFT JOIN suppliers s ON s.id=l.supplier_id
                 WHERE l.entry_id=e.id AND lower(COALESCE(c.name,'') || ' ' || COALESCE(s.name,'') || ' ' || COALESCE(l.description,'')) LIKE $4))
          ORDER BY e.entry_date DESC LIMIT 30`, [ctx.companyId, i.from || null, i.to || null, q, Number(i.min_amount) || 0]);
      return { data: { count: rows.length, transactions: rows }, sources: rows.map((r) => src('journal_entry', r.id, `${r.number} ${r.description}`, r.total, r.entry_date)) };
    },
  },
  {
    name: 'party_transactions',
    description: 'Invoices, bills and payments for a named customer or supplier, with their current balance from the ledger.',
    input_schema: { type: 'object', properties: { name: { type: 'string' }, kind: { type: 'string', enum: ['customer', 'supplier'] } }, required: ['name'] },
    async run(ctx, i) {
      let kind = i.kind;
      let p = kind !== 'supplier' ? await findParty(pool, ctx.companyId, 'customers', i.name) : null;
      if (p) kind = 'customer'; else { p = await findParty(pool, ctx.companyId, 'suppliers', i.name); if (p) kind = 'supplier'; }
      if (!p) return { data: { found: false, message: `No customer or supplier matching "${i.name}".` }, sources: [] };
      requireAny(ctx, kind === 'customer' ? 'view_sales' : 'view_purchases');
      const ctrl = await getSystemAccount(pool, ctx.companyId, kind === 'customer' ? 'AR' : 'AP');
      const { rows: [b] } = await pool.query(`SELECT COALESCE(SUM(${kind === 'customer' ? 'debit-credit' : 'credit-debit'}),0)::numeric(18,2) AS v FROM ledger WHERE account_id=$1 AND ${kind}_id=$2`, [ctrl.id, p.id]);
      const t = kind === 'customer' ? 'sales_documents' : 'purchase_documents';
      const { rows: docs } = await pool.query(`SELECT id, doc_type, number, doc_date, due_date, total, (total-amount_paid-amount_credited)::numeric(18,2) AS balance_due, status FROM ${t} WHERE company_id=$1 AND ${kind}_id=$2 AND status <> 'CANCELLED' ORDER BY doc_date DESC LIMIT 20`, [ctx.companyId, p.id]);
      const { rows: pays } = await pool.query(`SELECT id, number, payment_date, amount, status FROM payments WHERE company_id=$1 AND ${kind}_id=$2 ORDER BY payment_date DESC LIMIT 20`, [ctx.companyId, p.id]);
      return { data: { kind, name: p.name, ledger_balance: b.v, documents: docs, payments: pays },
        sources: [src(kind, p.id, p.name), ...docs.map((d) => src(kind === 'customer' ? 'sales_document' : 'purchase_document', d.id, `${d.number} (${d.status})`, d.total, d.doc_date)), ...pays.map((x) => src('payment', x.id, x.number, x.amount, x.payment_date))] };
    },
  },
  {
    name: 'cash_flow_summary',
    description: 'Cash flow statement (direct method) for a date range: operating, investing, financing, opening and closing cash.',
    input_schema: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } } },
    async run(ctx, i) {
      requireAny(ctx, 'view_reports', 'view_banking');
      const { from, to } = period(i);
      const cf = await cashFlow(pool, ctx.companyId, { from, to });
      return { data: { period: { from, to }, lines: cf.rows.map((r) => ({ item: r.item, amount: r.amount ?? null, kind: r._style || 'line' })), ...cf.summary },
        sources: [{ type: 'report', label: `Cash Flow ${from} to ${to}`, link: `/reports/cash-flow?from=${from}&to=${to}` }] };
    },
  },
  {
    name: 'find_anomalies',
    description: 'Run the anomaly scan and list open items that require review: duplicates, unusually large expenses, unusual payments, possible misclassification, missing receipts. Use kind="duplicates" to list only duplicates.',
    input_schema: { type: 'object', properties: { kind: { type: 'string', enum: ['all', 'duplicates'] } } },
    async run(ctx, i) {
      requireAny(ctx, 'review_anomalies', 'view_reports');
      await scanAnomalies(pool, ctx.companyId);
      const { rows } = await pool.query(`SELECT id, kind, severity, entity_type, entity_id, message, created_at FROM review_flags WHERE company_id=$1 AND status='OPEN' ${i.kind === 'duplicates' ? "AND kind LIKE 'duplicate%'" : ''}
          ORDER BY CASE severity WHEN 'HIGH' THEN 0 WHEN 'MEDIUM' THEN 1 ELSE 2 END, created_at DESC LIMIT 30`, [ctx.companyId]);
      return { data: { open_items: rows.length, items: rows.map((r) => ({ severity: r.severity, kind: r.kind, message: r.message })) }, sources: rows.map((r) => ({ ...src(r.entity_type, r.entity_id, r.message), link: link(r.entity_type, r.entity_id) || '/review' })) };
    },
  },
  {
    name: 'prepare_transaction_draft',
    description: 'Prepare a DRAFT accounting transaction from a natural-language instruction. Nothing is posted: the draft waits for an authorised user to review and approve it. ' +
      'type: cash_sale (money received now for a sale), credit_sale (invoice a customer), expense (paid now), bill (supplier invoice to pay later), owner_contribution, owner_drawing, journal (explicit lines by account code). ' +
      'customer_receipt / supplier_payment return a pre-filled form for the user to confirm instead of a draft.',
    input_schema: { type: 'object', properties: {
      type: { type: 'string', enum: ['cash_sale', 'credit_sale', 'expense', 'bill', 'owner_contribution', 'owner_drawing', 'customer_receipt', 'supplier_payment', 'journal'] },
      amount: { type: 'string', description: 'Amount in Kwacha, e.g. "5000.00"' }, date: { type: 'string' }, description: { type: 'string' },
      paid_via: { type: 'string', enum: ['cash', 'bank', 'mobile_money'] }, category: { type: 'string', description: 'e.g. fuel, rent, office supplies, services' },
      party_name: { type: 'string', description: 'customer or supplier name if mentioned' }, includes_vat: { type: 'boolean' },
      lines: { type: 'array', items: { type: 'object', properties: { account_code: { type: 'string' }, debit: { type: 'string' }, credit: { type: 'string' } } } },
    }, required: ['type', 'description'] },
    async run(ctx, i) { return prepareDraft(ctx, i); },
  },
];

const PAY_KEY = { cash: 'CASH', bank: 'BANK', mobile_money: 'MOBILE_MONEY' };

export async function prepareDraft(ctx, i) {
  if (ctx.settings?.ai?.allow_transaction_drafts === false) throw forbidden('AI transaction drafts are disabled in AI settings.');
  const date = /^\d{4}-\d{2}-\d{2}$/.test(i.date || '') ? i.date : today();
  const type = i.type;
  let amountC = 0n;
  if (type !== 'journal') {
    try { amountC = toCents(i.amount); } catch { throw badRequest('I could not read the amount. Please state it like "K5,000".'); }
    if (amountC <= 0n) throw badRequest('The amount must be greater than zero.');
  }
  const amount = fromCents(amountC);
  const description = String(i.description || '').slice(0, 280) || 'AI-prepared transaction';
  const rationale = `Prepared by the AI assistant from: "${description}"`;
  const actx = { ...ctx, viaAi: true };

  if (type === 'customer_receipt' || type === 'supplier_payment') {
    requireAny(ctx, 'create_payment');
    const kind = type === 'customer_receipt' ? 'customers' : 'suppliers';
    const party = await findParty(pool, ctx.companyId, kind, i.party_name);
    const bank = await getSystemAccount(pool, ctx.companyId, PAY_KEY[i.paid_via] || 'BANK');
    return { data: { status: 'FORM_PREFILLED', note: 'Payments are recorded by the user after review. Open the pre-filled form to allocate it to invoices/bills and confirm.', party: party?.name || null, amount },
      proposal: { kind: 'payment', link: `/payments/new?direction=${type === 'customer_receipt' ? 'IN' : 'OUT'}&amount=${amount}&party_id=${party?.id || ''}&bank_account_id=${bank.id}&date=${date}&reference=${encodeURIComponent(description.slice(0, 60))}` }, sources: [] };
  }

  if (type === 'expense') {
    requireAny(ctx, 'create_expense');
    const acc = (await resolveAccountByHint(pool, ctx.companyId, i.category || description)) || (await getSystemAccount(pool, ctx.companyId, 'GENERAL_EXPENSE'));
    const pay = await getSystemAccount(pool, ctx.companyId, PAY_KEY[i.paid_via] || 'CASH');
    const supplier = await findParty(pool, ctx.companyId, 'suppliers', i.party_name);
    let taxId = null;
    if (i.includes_vat) { const { rows: [t] } = await pool.query(`SELECT id FROM tax_rates WHERE company_id=$1 AND code='VAT16' AND is_active ORDER BY effective_from DESC LIMIT 1`, [ctx.companyId]); taxId = t?.id || null; }
    const e = await tx((db) => createExpense(db, actx, { expense_date: date, supplier_id: supplier?.id || null, payee_name: supplier ? null : i.party_name || null, account_id: acc.id, amount, amount_includes_tax: !!taxId, tax_rate_id: taxId,
      payment_account_id: pay.id, payment_method: (i.paid_via || 'cash').toUpperCase().replace('BANK', 'BANK_TRANSFER'), description, ai_generated: true, ai_confidence: 80 }, { submit: false }));
    const lines = [{ account: `${acc.code} ${acc.name}`, debit: e.amount }, ...(toCents(e.tax_amount) ? [{ account: 'VAT Input', debit: e.tax_amount }] : []), { account: `${pay.code} ${pay.name}`, credit: e.total }];
    return { data: { status: 'DRAFT — NEEDS APPROVAL', record: `Expense ${e.number}`, proposed_entry: lines, total: e.total }, draft: { type: 'expense', id: e.id, number: e.number, link: `/expenses/${e.id}`, lines }, sources: [src('expense', e.id, `${e.number} (draft)`, e.total, date)] };
  }

  if (type === 'credit_sale' || type === 'bill') {
    const isSale = type === 'credit_sale';
    requireAny(ctx, isSale ? 'create_invoice' : 'create_purchase');
    const party = await findParty(pool, ctx.companyId, isSale ? 'customers' : 'suppliers', i.party_name);
    if (!party) throw badRequest(`I could not find a ${isSale ? 'customer' : 'supplier'} named "${i.party_name || ''}". Create them first or tell me the exact name.`);
    const acc = isSale ? ((await resolveAccountByHint(pool, ctx.companyId, i.category, ['REVENUE'])) || (await getSystemAccount(pool, ctx.companyId, /service/i.test(`${i.category} ${description}`) ? 'SERVICE_REVENUE' : 'SALES')))
      : ((await resolveAccountByHint(pool, ctx.companyId, i.category || description)) || (await getSystemAccount(pool, ctx.companyId, 'PURCHASES')));
    let taxId = null, unit = amount;
    if (i.includes_vat) {
      const { rows: [t] } = await pool.query(`SELECT id, rate FROM tax_rates WHERE company_id=$1 AND code='VAT16' AND is_active ORDER BY effective_from DESC LIMIT 1`, [ctx.companyId]);
      if (t) { taxId = t.id; unit = fromCents(splitInclusiveSafe(amount, t.rate).net); }
    }
    const line = { description, quantity: '1', unit_price: unit, discount_pct: '0', account_id: acc.id, tax_rate_id: taxId };
    const d = await tx((db) => (isSale ? createSalesDoc(db, actx, { doc_type: 'INVOICE', customer_id: party.id, doc_date: date, lines: [line], notes: rationale })
      : createPurchaseDoc(db, actx, { doc_type: 'BILL', supplier_id: party.id, doc_date: date, lines: [line], notes: rationale, ai_generated: true, allow_duplicate: false })));
    const lines = isSale ? [{ account: 'Accounts Receivable', debit: d.total }, { account: `${acc.code} ${acc.name}`, credit: d.subtotal }, ...(toCents(d.tax_total) ? [{ account: 'VAT Output', credit: d.tax_total }] : [])]
      : [{ account: `${acc.code} ${acc.name}`, debit: d.subtotal }, ...(toCents(d.tax_total) ? [{ account: 'VAT Input', debit: d.tax_total }] : []), { account: 'Accounts Payable', credit: d.total }];
    const t = isSale ? 'sales_document' : 'purchase_document';
    return { data: { status: 'DRAFT — NEEDS APPROVAL', record: `${isSale ? 'Invoice' : 'Bill'} ${d.number} for ${party.name}`, proposed_entry: lines, total: d.total }, draft: { type: t, id: d.id, number: d.number, link: link(t, d.id), lines }, sources: [src(t, d.id, `${d.number} (draft)`, d.total, date)] };
  }

  // Journal-based drafts
  requireAny(ctx, 'create_journal');
  let lines = [];
  if (type === 'cash_sale') {
    const pay = await getSystemAccount(pool, ctx.companyId, PAY_KEY[i.paid_via] || 'CASH');
    const rev = (await resolveAccountByHint(pool, ctx.companyId, i.category, ['REVENUE'])) || (await getSystemAccount(pool, ctx.companyId, /service/i.test(`${i.category} ${description}`) ? 'SERVICE_REVENUE' : 'SALES'));
    lines.push({ account_id: pay.id, debit: amount, description });
    if (i.includes_vat) {
      const { rows: [t] } = await pool.query(`SELECT * FROM tax_rates WHERE company_id=$1 AND code='VAT16' AND is_active ORDER BY effective_from DESC LIMIT 1`, [ctx.companyId]);
      const { net, tax } = splitInclusiveSafe(amount, t?.rate || '0');
      lines.push({ account_id: rev.id, credit: fromCents(net), description });
      if (tax > 0n) lines.push({ account_id: t.sales_account_id, credit: fromCents(tax), tax_rate_id: t.id, description: 'Output VAT' });
    } else lines.push({ account_id: rev.id, credit: amount, description });
  } else if (type === 'owner_contribution' || type === 'owner_drawing') {
    const pay = await getSystemAccount(pool, ctx.companyId, PAY_KEY[i.paid_via] || 'BANK');
    const eq = await getSystemAccount(pool, ctx.companyId, type === 'owner_contribution' ? 'CAPITAL' : 'DRAWINGS');
    lines = type === 'owner_contribution' ? [{ account_id: pay.id, debit: amount }, { account_id: eq.id, credit: amount }] : [{ account_id: eq.id, debit: amount }, { account_id: pay.id, credit: amount }];
  } else if (type === 'journal') {
    if (!Array.isArray(i.lines) || i.lines.length < 2) throw badRequest('A journal needs at least two lines with account codes.');
    for (const l of i.lines) {
      const { rows: [a] } = await pool.query('SELECT id FROM accounts WHERE company_id=$1 AND code=$2', [ctx.companyId, String(l.account_code)]);
      if (!a) throw badRequest(`Account code ${l.account_code} does not exist.`);
      lines.push({ account_id: a.id, debit: l.debit || 0, credit: l.credit || 0 });
    }
  } else throw badRequest('Unknown transaction type.');
  const je = await tx((db) => createJournal(db, actx, { date, description, reference: 'AI draft', source_type: 'AI', status: 'DRAFT', lines, ai_generated: true, ai_rationale: rationale }));
  const { rows: shown } = await pool.query(`SELECT a.code, a.name, l.debit, l.credit FROM journal_lines l JOIN accounts a ON a.id=l.account_id WHERE l.entry_id=$1 ORDER BY l.line_no`, [je.id]);
  const prop = shown.map((s) => ({ account: `${s.code} ${s.name}`, ...(toCents(s.debit) ? { debit: s.debit } : { credit: s.credit }) }));
  const d = shown.reduce((s, x) => s + toCents(x.debit), 0n), c = shown.reduce((s, x) => s + toCents(x.credit), 0n);
  return { data: { status: 'DRAFT — NEEDS APPROVAL', record: `Journal ${je.number}`, proposed_entry: prop, balanced: d === c, total: fromCents(d) }, draft: { type: 'journal_entry', id: je.id, number: je.number, link: `/journals/${je.id}`, lines: prop }, sources: [src('journal_entry', je.id, `${je.number} (draft)`, fromCents(d), date)] };
}

export async function runTool(ctx, name, input) {
  const t = TOOLS.find((x) => x.name === name);
  if (!t) throw badRequest(`Unknown tool ${name}`);
  const out = await t.run(ctx, input || {});
  await audit({ ...ctx, viaAi: true }, name === 'prepare_transaction_draft' ? 'ai.tool_draft' : 'ai.tool_query', { entityType: 'ai_tool', entityId: name, newValue: { input } });
  return out;
}

export { formatK, addMonths, addDays, monthStart, today };
