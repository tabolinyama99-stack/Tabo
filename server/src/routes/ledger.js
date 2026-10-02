// Chart of accounts, journals (manual/recurring/opening), tax rates and items.
import { Router } from 'express';
import { pool, tx } from '../db/pool.js';
import { asyncH } from '../middleware/errors.js';
import { need } from '../middleware/auth.js';
import { audit, diff } from '../lib/audit.js';
import { badRequest, conflict, notFound, forbidden } from '../lib/errors.js';
import { toCents, fromCents } from '../lib/money.js';
import { createJournal, getJournal, updateDraftJournal, postDraftJournal, reverseJournal, deleteDraftJournal, approvalRequired, accountBalances, getSystemAccount, can } from '../services/ledger.js';
import { runRecurring, nextRunDate } from '../services/jobs.js';
import { z, str, optStr, money, date, optDate, pid, paging } from './_util.js';

const r = Router();
const TYPES = ['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'COST_OF_SALES', 'EXPENSE'];

// ───────────── Accounts ─────────────
r.get('/accounts', need('view_ledger', 'create_expense', 'create_invoice', 'create_purchase', 'create_payment', 'manage_banking', 'view_reports'), asyncH(async (req, res) => {
  const bals = await accountBalances(pool, req.ctx.companyId, { to: req.query.as_of || undefined });
  const { rows: tx } = await pool.query(`SELECT account_id, COUNT(*)::int AS n FROM journal_lines l JOIN journal_entries e ON e.id=l.entry_id WHERE l.company_id=$1 AND e.status IN ('POSTED','REVERSED') GROUP BY account_id`, [req.ctx.companyId]);
  const used = new Map(tx.map((x) => [x.account_id, x.n]));
  const { rows: bank } = await pool.query('SELECT account_id FROM bank_accounts WHERE company_id=$1', [req.ctx.companyId]);
  const banks = new Set(bank.map((b) => b.account_id));
  const { rows: desc } = await pool.query('SELECT id, description FROM accounts WHERE company_id=$1', [req.ctx.companyId]);
  const d = new Map(desc.map((x) => [x.id, x.description]));
  res.json(bals.map((b) => ({ ...b, description: d.get(b.id), transactions: used.get(b.id) || 0, is_bank: banks.has(b.id) })));
}));

const accountSchema = z.object({ code: str(20).min(1).regex(/^[\w.-]+$/, 'letters, numbers, . and - only'), name: str(150).min(1), type: z.enum(TYPES), subtype: optStr(40),
  parent_id: z.union([z.coerce.number().int().positive(), z.null(), z.literal('')]).optional(), description: optStr(500),
  cash_flow_category: z.enum(['OPERATING', 'INVESTING', 'FINANCING', 'CASH']).optional() });

r.post('/accounts', need('edit_chart_of_accounts'), asyncH(async (req, res) => {
  const b = accountSchema.parse(req.body);
  if (b.parent_id) {
    const { rows: [p] } = await pool.query('SELECT type FROM accounts WHERE id=$1 AND company_id=$2', [b.parent_id, req.ctx.companyId]);
    if (!p) throw badRequest('Parent account not found.');
    if (p.type !== b.type) throw badRequest('A sub-account must have the same type as its parent.');
  }
  if (['bank', 'cash'].includes(b.subtype)) throw badRequest('Create bank and cash accounts from the Banking page.');
  const cf = b.cash_flow_category || (b.subtype === 'fixed_asset' ? 'INVESTING' : b.type === 'EQUITY' || b.subtype === 'long_term_liability' ? 'FINANCING' : 'OPERATING');
  const { rows: [a] } = await pool.query(`INSERT INTO accounts (company_id, code, name, type, subtype, parent_id, description, cash_flow_category) VALUES ($1,$2,$3,$4,COALESCE($5,'general'),$6,$7,$8) RETURNING *`,
    [req.ctx.companyId, b.code, b.name, b.type, b.subtype || null, b.parent_id || null, b.description || null, cf]);
  await audit(req.ctx, 'account.created', { entityType: 'account', entityId: a.id, newValue: { code: a.code, name: a.name, type: a.type } });
  res.status(201).json(a);
}));

r.put('/accounts/:id', need('edit_chart_of_accounts'), asyncH(async (req, res) => {
  const id = pid(req);
  const b = accountSchema.partial().parse(req.body);
  const { rows: [a] } = await pool.query('SELECT * FROM accounts WHERE id=$1 AND company_id=$2', [id, req.ctx.companyId]);
  if (!a) throw notFound('Account');
  const { rows: [{ n }] } = await pool.query(`SELECT COUNT(*)::int AS n FROM journal_lines WHERE account_id=$1`, [id]);
  if (b.type && b.type !== a.type && (n || a.system_key)) throw conflict('The type of an account with transactions (or a system account) cannot be changed.');
  if (b.parent_id && Number(b.parent_id) === id) throw badRequest('An account cannot be its own parent.');
  const { rows: [after] } = await pool.query(`UPDATE accounts SET code=$3, name=$4, type=$5, subtype=$6, parent_id=$7, description=$8, cash_flow_category=$9 WHERE id=$1 AND company_id=$2 RETURNING *`,
    [id, req.ctx.companyId, b.code ?? a.code, b.name ?? a.name, b.type ?? a.type, b.subtype ?? a.subtype, b.parent_id === '' ? null : b.parent_id ?? a.parent_id, b.description ?? a.description, b.cash_flow_category ?? a.cash_flow_category]);
  await audit(req.ctx, 'account.updated', { entityType: 'account', entityId: id, ...diff(a, after) });
  res.json(after);
}));

r.post('/accounts/:id/active', need('edit_chart_of_accounts'), asyncH(async (req, res) => {
  const id = pid(req);
  const { is_active } = z.object({ is_active: z.boolean() }).parse(req.body);
  const { rows: [a] } = await pool.query('SELECT * FROM accounts WHERE id=$1 AND company_id=$2', [id, req.ctx.companyId]);
  if (!a) throw notFound('Account');
  if (!is_active && a.system_key) throw conflict(`${a.name} is a system account used by automatic postings and cannot be deactivated.`);
  if (!is_active) {
    const { rows: [{ bal }] } = await pool.query(`SELECT COALESCE(SUM(debit-credit),0) AS bal FROM ledger WHERE account_id=$1`, [id]);
    if (Number(bal) !== 0) throw conflict('This account has a balance. Move the balance with a journal before archiving it.');
  }
  await pool.query('UPDATE accounts SET is_active=$2 WHERE id=$1', [id, is_active]);
  await audit(req.ctx, is_active ? 'account.reactivated' : 'account.archived', { entityType: 'account', entityId: id });
  res.json({ ok: true });
}));

r.delete('/accounts/:id', need('edit_chart_of_accounts'), asyncH(async (req, res) => {
  const id = pid(req);
  const { rows: [a] } = await pool.query('SELECT * FROM accounts WHERE id=$1 AND company_id=$2', [id, req.ctx.companyId]);
  if (!a) throw notFound('Account');
  if (a.system_key) throw conflict('System accounts cannot be deleted.');
  const { rows: [{ n }] } = await pool.query(`SELECT (SELECT COUNT(*) FROM journal_lines WHERE account_id=$1) + (SELECT COUNT(*) FROM sales_document_lines WHERE account_id=$1) + (SELECT COUNT(*) FROM purchase_document_lines WHERE account_id=$1) + (SELECT COUNT(*) FROM expenses WHERE account_id=$1) + (SELECT COUNT(*) FROM accounts WHERE parent_id=$1) AS n`, [id]);
  if (Number(n)) throw conflict('This account has transactions or sub-accounts and cannot be deleted. Archive (deactivate) it instead.');
  await pool.query('DELETE FROM accounts WHERE id=$1', [id]);
  await audit(req.ctx, 'account.deleted', { entityType: 'account', entityId: id, oldValue: { code: a.code, name: a.name } });
  res.json({ ok: true });
}));

r.post('/accounts/opening-balances', need('post_journal'), asyncH(async (req, res) => {
  const b = z.object({ date, lines: z.array(z.object({ account_id: z.coerce.number().int().positive(), debit: money.optional(), credit: money.optional() })).min(1) }).parse(req.body);
  const out = await tx(async (db) => {
    const obe = await getSystemAccount(db, req.ctx.companyId, 'OPENING_BALANCE');
    const { rows: ctrl } = await db.query(`SELECT id FROM accounts WHERE company_id=$1 AND system_key IN ('AR','AP')`, [req.ctx.companyId]);
    const lines = b.lines.filter((l) => toCents(l.debit || 0) || toCents(l.credit || 0));
    if (lines.some((l) => ctrl.some((c) => c.id === l.account_id))) throw badRequest('Enter customer and supplier opening balances as opening invoices/bills (using the Opening Balance Equity account) so aging stays accurate.');
    let diffC = 0n;
    for (const l of lines) diffC += toCents(l.debit || 0) - toCents(l.credit || 0);
    if (diffC !== 0n) lines.push({ account_id: obe.id, debit: diffC < 0n ? fromCents(-diffC) : 0, credit: diffC > 0n ? fromCents(diffC) : 0, description: 'Opening balance difference' });
    return createJournal(db, req.ctx, { date: b.date, description: 'Opening balances', source_type: 'OPENING', status: 'POSTED', lines, approved: true });
  });
  res.status(201).json(out);
}));

// ───────────── Journals ─────────────
r.get('/journals', need('view_ledger'), asyncH(async (req, res) => {
  const { limit, offset } = paging(req.query);
  const p = [req.ctx.companyId]; let w = '';
  if (req.query.status) { p.push(String(req.query.status).split(',')); w += ` AND e.status = ANY($${p.length})`; } else w += ` AND e.status <> 'VOID'`;
  if (req.query.source_type) { p.push(req.query.source_type); w += ` AND e.source_type=$${p.length}`; }
  if (req.query.from) { p.push(req.query.from); w += ` AND e.entry_date >= $${p.length}`; }
  if (req.query.to) { p.push(req.query.to); w += ` AND e.entry_date <= $${p.length}`; }
  if (req.query.q) { p.push(`%${req.query.q}%`); w += ` AND (e.number ILIKE $${p.length} OR e.description ILIKE $${p.length} OR e.reference ILIKE $${p.length})`; }
  if (req.query.account_id) { p.push(Number(req.query.account_id)); w += ` AND EXISTS (SELECT 1 FROM journal_lines l WHERE l.entry_id=e.id AND l.account_id=$${p.length})`; }
  if (req.query.ai === 'true') w += ' AND e.ai_generated';
  const { rows } = await pool.query(`SELECT e.id, e.number, e.entry_date, e.reference, e.description, e.source_type, e.source_id, e.status, e.total, e.ai_generated, e.is_adjusting, u.name AS created_by_name
      FROM journal_entries e LEFT JOIN users u ON u.id=e.created_by WHERE e.company_id=$1 ${w} ORDER BY e.entry_date DESC, e.id DESC LIMIT ${limit} OFFSET ${offset}`, p);
  const { rows: [{ n }] } = await pool.query(`SELECT COUNT(*)::int AS n FROM journal_entries e WHERE e.company_id=$1 ${w}`, p);
  res.json({ items: rows, total: n });
}));

r.get('/journals/:id', need('view_ledger'), asyncH(async (req, res) => res.json(await getJournal(pool, req.ctx.companyId, pid(req)))));

const lineSchema = z.object({ account_id: z.coerce.number().int().positive(), debit: money.optional().nullable(), credit: money.optional().nullable(), description: optStr(300),
  customer_id: z.union([z.coerce.number().int().positive(), z.null(), z.literal('')]).optional(), supplier_id: z.union([z.coerce.number().int().positive(), z.null(), z.literal('')]).optional(),
  branch_id: z.union([z.coerce.number().int().positive(), z.null(), z.literal('')]).optional(), department_id: z.union([z.coerce.number().int().positive(), z.null(), z.literal('')]).optional() });
const journalSchema = z.object({ date, reference: optStr(100), description: str(300).min(1), is_adjusting: z.boolean().optional(), auto_reverse_on: optDate,
  branch_id: z.union([z.coerce.number().int().positive(), z.null(), z.literal('')]).optional(), department_id: z.union([z.coerce.number().int().positive(), z.null(), z.literal('')]).optional(),
  lines: z.array(lineSchema).min(2), action: z.enum(['draft', 'post']).default('draft') });
const cleanLines = (lines) => lines.map((l) => ({ ...l, customer_id: l.customer_id || null, supplier_id: l.supplier_id || null, branch_id: l.branch_id || null, department_id: l.department_id || null, debit: l.debit || 0, credit: l.credit || 0 }));

r.post('/journals', need('create_journal'), asyncH(async (req, res) => {
  const b = journalSchema.parse(req.body);
  const out = await tx(async (db) => {
    const draft = await createJournal(db, req.ctx, { ...b, lines: cleanLines(b.lines), status: 'DRAFT', source_type: 'MANUAL', branch_id: b.branch_id || null, department_id: b.department_id || null });
    if (b.action === 'post') return postDraftJournal(db, req.ctx, draft.id);
    return getJournal(db, req.ctx.companyId, draft.id);
  });
  res.status(201).json(out);
}));

r.put('/journals/:id', need('create_journal'), asyncH(async (req, res) => {
  const b = journalSchema.parse(req.body);
  const out = await tx(async (db) => {
    const j = await updateDraftJournal(db, req.ctx, pid(req), { ...b, lines: cleanLines(b.lines) });
    if (b.action === 'post') return postDraftJournal(db, req.ctx, j.id);
    return j;
  });
  res.json(out);
}));

r.post('/journals/:id/post', need('create_journal', 'post_journal'), asyncH(async (req, res) => res.json(await tx((db) => postDraftJournal(db, req.ctx, pid(req))))));
r.post('/journals/:id/approve', need('approve_transactions'), asyncH(async (req, res) => res.json(await tx((db) => postDraftJournal(db, req.ctx, pid(req), { asApproval: true })))));
r.post('/journals/:id/reject', need('approve_transactions'), asyncH(async (req, res) => {
  const reason = String(req.body?.reason || '').trim();
  await tx(async (db) => {
    const j = await getJournal(db, req.ctx.companyId, pid(req));
    if (j.status !== 'PENDING_APPROVAL' && j.status !== 'DRAFT') throw conflict('Only pending journals can be rejected.');
    await db.query(`UPDATE journal_entries SET status='DRAFT', updated_at=now() WHERE id=$1`, [j.id]);
    await audit(req.ctx, j.ai_generated ? 'ai.draft_rejected' : 'journal.rejected', { entityType: 'journal_entry', entityId: j.id, newValue: { reason } }, db);
  });
  res.json({ ok: true });
}));
r.post('/journals/:id/reverse', need('reverse_journal'), asyncH(async (req, res) => {
  const b = z.object({ date: optDate, reason: str(300).min(3, 'give a reason') }).parse(req.body);
  res.json(await tx((db) => reverseJournal(db, req.ctx, pid(req), b)));
}));
r.delete('/journals/:id', need('create_journal'), asyncH(async (req, res) => { await tx((db) => deleteDraftJournal(db, req.ctx, pid(req))); res.json({ ok: true }); }));

// ───────────── Recurring journals ─────────────
r.get('/recurring-journals', need('view_ledger'), asyncH(async (req, res) => {
  res.json((await pool.query('SELECT * FROM recurring_journals WHERE company_id=$1 ORDER BY is_active DESC, next_run_date', [req.ctx.companyId])).rows);
}));
const recSchema = z.object({ name: str(120).min(1), description: str(300).min(1), frequency: z.enum(['WEEKLY', 'MONTHLY', 'QUARTERLY', 'YEARLY']), next_run_date: date, end_date: optDate,
  auto_post: z.boolean().default(false), is_active: z.boolean().default(true), lines: z.array(lineSchema).min(2) });
async function validateRecurring(ctx, b) {
  let d = 0n, c = 0n;
  for (const l of b.lines) { d += toCents(l.debit || 0); c += toCents(l.credit || 0); }
  if (d !== c || d === 0n) throw badRequest('Recurring journal lines must balance.');
  if (b.auto_post && !can(ctx, 'post_journal')) throw forbidden('You need permission to post journals to enable automatic posting.');
  if (b.auto_post && approvalRequired(ctx, d)) throw forbidden('This amount requires approval, so it cannot be auto-posted. Leave auto-post off to create drafts.');
}
r.post('/recurring-journals', need('create_journal'), asyncH(async (req, res) => {
  const b = recSchema.parse(req.body);
  await validateRecurring(req.ctx, b);
  const { rows: [row] } = await pool.query(`INSERT INTO recurring_journals (company_id, name, description, lines, frequency, next_run_date, end_date, auto_post, is_active, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [req.ctx.companyId, b.name, b.description, JSON.stringify(cleanLines(b.lines)), b.frequency, b.next_run_date, b.end_date, b.auto_post, b.is_active, req.ctx.user.id]);
  await audit(req.ctx, 'recurring_journal.created', { entityType: 'recurring_journal', entityId: row.id, newValue: { name: b.name, frequency: b.frequency, auto_post: b.auto_post } });
  res.status(201).json(row);
}));
r.put('/recurring-journals/:id', need('create_journal'), asyncH(async (req, res) => {
  const b = recSchema.parse(req.body);
  await validateRecurring(req.ctx, b);
  const { rows: [before] } = await pool.query('SELECT * FROM recurring_journals WHERE id=$1 AND company_id=$2', [pid(req), req.ctx.companyId]);
  if (!before) throw notFound('Recurring journal');
  const { rows: [row] } = await pool.query(`UPDATE recurring_journals SET name=$3, description=$4, lines=$5, frequency=$6, next_run_date=$7, end_date=$8, auto_post=$9, is_active=$10 WHERE id=$1 AND company_id=$2 RETURNING *`,
    [pid(req), req.ctx.companyId, b.name, b.description, JSON.stringify(cleanLines(b.lines)), b.frequency, b.next_run_date, b.end_date, b.auto_post, b.is_active]);
  await audit(req.ctx, 'recurring_journal.updated', { entityType: 'recurring_journal', entityId: row.id, ...diff(before, row) });
  res.json(row);
}));
r.post('/recurring-journals/run', need('create_journal'), asyncH(async (req, res) => res.json({ created: await runRecurring({ ...req.ctx.company, settings: req.ctx.settings }) })));
r.get('/recurring-journals/preview', need('view_ledger'), (req, res) => res.json({ next: nextRunDate(String(req.query.date), String(req.query.frequency || 'MONTHLY')) }));

// ───────────── Tax rates ─────────────
r.get('/tax-rates', asyncH(async (req, res) => {
  res.json((await pool.query(`SELECT t.*, sa.name AS sales_account_name, pa.name AS purchase_account_name FROM tax_rates t LEFT JOIN accounts sa ON sa.id=t.sales_account_id LEFT JOIN accounts pa ON pa.id=t.purchase_account_id WHERE t.company_id=$1 ORDER BY t.code, t.effective_from DESC`, [req.ctx.companyId])).rows);
}));
const taxSchema = z.object({ code: str(20).min(1).regex(/^[\w-]+$/), name: str(120).min(1), tax_type: z.enum(['VAT', 'WHT', 'PAYE', 'TURNOVER', 'EXCISE', 'OTHER']),
  rate: z.union([z.string(), z.number()]).transform(String).refine((v) => /^\d{1,3}(\.\d{1,4})?$/.test(v) && Number(v) <= 100, 'must be a percentage between 0 and 100'),
  effective_from: date, effective_to: optDate, sales_account_id: z.union([z.coerce.number().int().positive(), z.null(), z.literal('')]).optional(),
  purchase_account_id: z.union([z.coerce.number().int().positive(), z.null(), z.literal('')]).optional(), applies_to: z.enum(['SALES', 'PURCHASES', 'BOTH', 'PAYROLL']).default('BOTH'),
  description: optStr(500), is_active: z.boolean().default(true) });
r.post('/tax-rates', need('manage_tax'), asyncH(async (req, res) => {
  const b = taxSchema.parse(req.body);
  const row = await tx(async (db) => {
    // A new version of an existing code closes the previous open-ended version the day before.
    await db.query(`UPDATE tax_rates SET effective_to = $3::date - 1 WHERE company_id=$1 AND code=$2 AND effective_to IS NULL AND effective_from < $3`, [req.ctx.companyId, b.code, b.effective_from]);
    const { rows: [t] } = await db.query(`INSERT INTO tax_rates (company_id, code, name, tax_type, rate, effective_from, effective_to, sales_account_id, purchase_account_id, applies_to, description, is_active)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`, [req.ctx.companyId, b.code, b.name, b.tax_type, b.rate, b.effective_from, b.effective_to, b.sales_account_id || null, b.purchase_account_id || null, b.applies_to, b.description || null, b.is_active]);
    await audit(req.ctx, 'tax.rate_created', { entityType: 'tax_rate', entityId: t.id, newValue: { code: t.code, rate: t.rate, effective_from: t.effective_from } }, db);
    return t;
  });
  res.status(201).json(row);
}));
r.put('/tax-rates/:id', need('manage_tax'), asyncH(async (req, res) => {
  const b = taxSchema.parse(req.body);
  const { rows: [before] } = await pool.query('SELECT * FROM tax_rates WHERE id=$1 AND company_id=$2', [pid(req), req.ctx.companyId]);
  if (!before) throw notFound('Tax rate');
  const { rows: [{ n }] } = await pool.query(`SELECT (SELECT COUNT(*) FROM sales_document_lines WHERE tax_rate_id=$1) + (SELECT COUNT(*) FROM purchase_document_lines WHERE tax_rate_id=$1) + (SELECT COUNT(*) FROM expenses WHERE tax_rate_id=$1) AS n`, [before.id]);
  if (Number(n) && (b.rate !== String(Number(before.rate)) && b.rate !== before.rate)) throw conflict('This rate has been used on transactions. To change the percentage, add a new version with a new effective date.');
  const { rows: [after] } = await pool.query(`UPDATE tax_rates SET name=$3, effective_to=$4, sales_account_id=$5, purchase_account_id=$6, applies_to=$7, description=$8, is_active=$9, rate=$10 WHERE id=$1 AND company_id=$2 RETURNING *`,
    [before.id, req.ctx.companyId, b.name, b.effective_to, b.sales_account_id || null, b.purchase_account_id || null, b.applies_to, b.description || null, b.is_active, b.rate]);
  await audit(req.ctx, 'tax.rate_updated', { entityType: 'tax_rate', entityId: before.id, ...diff(before, after) });
  res.json(after);
}));

// ───────────── Items ─────────────
r.get('/items', asyncH(async (req, res) => res.json((await pool.query('SELECT * FROM items WHERE company_id=$1 ORDER BY name', [req.ctx.companyId])).rows)));
const itemSchema = z.object({ code: str(40).min(1), name: str(150).min(1), description: optStr(500), unit: optStr(20), sale_price: money.default('0'), purchase_price: money.default('0'),
  income_account_id: z.union([z.coerce.number().int().positive(), z.null(), z.literal('')]).optional(), expense_account_id: z.union([z.coerce.number().int().positive(), z.null(), z.literal('')]).optional(),
  tax_rate_id: z.union([z.coerce.number().int().positive(), z.null(), z.literal('')]).optional(), is_active: z.boolean().default(true) });
r.post('/items', need('create_invoice', 'create_purchase', 'manage_settings'), asyncH(async (req, res) => {
  const b = itemSchema.parse(req.body);
  const { rows: [i] } = await pool.query(`INSERT INTO items (company_id, code, name, description, unit, sale_price, purchase_price, income_account_id, expense_account_id, tax_rate_id, is_active) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [req.ctx.companyId, b.code, b.name, b.description || null, b.unit || 'each', fromCents(toCents(b.sale_price)), fromCents(toCents(b.purchase_price)), b.income_account_id || null, b.expense_account_id || null, b.tax_rate_id || null, b.is_active]);
  await audit(req.ctx, 'item.created', { entityType: 'item', entityId: i.id, newValue: { code: i.code, name: i.name, sale_price: i.sale_price } });
  res.status(201).json(i);
}));
r.put('/items/:id', need('create_invoice', 'create_purchase', 'manage_settings'), asyncH(async (req, res) => {
  const b = itemSchema.parse(req.body);
  const { rows: [before] } = await pool.query('SELECT * FROM items WHERE id=$1 AND company_id=$2', [pid(req), req.ctx.companyId]);
  if (!before) throw notFound('Item');
  const { rows: [i] } = await pool.query(`UPDATE items SET code=$3, name=$4, description=$5, unit=$6, sale_price=$7, purchase_price=$8, income_account_id=$9, expense_account_id=$10, tax_rate_id=$11, is_active=$12 WHERE id=$1 AND company_id=$2 RETURNING *`,
    [before.id, req.ctx.companyId, b.code, b.name, b.description || null, b.unit || 'each', fromCents(toCents(b.sale_price)), fromCents(toCents(b.purchase_price)), b.income_account_id || null, b.expense_account_id || null, b.tax_rate_id || null, b.is_active]);
  await audit(req.ctx, 'item.updated', { entityType: 'item', entityId: i.id, ...diff(before, i) });
  res.json(i);
}));

export default r;
