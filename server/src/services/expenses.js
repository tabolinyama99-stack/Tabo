// Expenses paid directly from bank/cash, with approval workflow and receipt attachments.
import { toCents, fromCents, percentOf, formatK } from '../lib/money.js';
import { badRequest, conflict, notFound, forbidden } from '../lib/errors.js';
import { nextNumber } from '../lib/numbering.js';
import { audit, diff } from '../lib/audit.js';
import { createJournal, reverseJournal, checkLimit, can, assertPeriodOpen, withinLimit, accountBalance } from './ledger.js';
import { resolveTaxRate, splitInclusive } from './tax.js';

export async function getExpense(db, companyId, id) {
  const { rows: [e] } = await db.query(
    `SELECT e.*, a.code AS account_code, a.name AS account_name, pa.name AS payment_account_name, s.name AS supplier_name, t.code AS tax_code,
            b.name AS branch_name, dpt.name AS department_name, cu.name AS created_by_name, au.name AS approved_by_name, je.number AS journal_number
       FROM expenses e JOIN accounts a ON a.id=e.account_id JOIN accounts pa ON pa.id=e.payment_account_id
       LEFT JOIN suppliers s ON s.id=e.supplier_id LEFT JOIN tax_rates t ON t.id=e.tax_rate_id LEFT JOIN branches b ON b.id=e.branch_id
       LEFT JOIN departments dpt ON dpt.id=e.department_id LEFT JOIN users cu ON cu.id=e.created_by LEFT JOIN users au ON au.id=e.approved_by
       LEFT JOIN journal_entries je ON je.id=e.journal_entry_id
      WHERE e.company_id=$1 AND e.id=$2`, [companyId, id]);
  if (!e) throw notFound('Expense');
  const { rows: documents } = await db.query(
    `SELECT id, original_name, mime_type, size_bytes FROM documents WHERE company_id=$1 AND ((linked_type='expense' AND linked_id=$2) OR id=$3)`, [companyId, id, e.document_id || 0]);
  return { ...e, documents };
}

async function normalise(db, ctx, input) {
  const date = input.expense_date;
  if (!date) throw badRequest('Expense date is required.');
  if (!input.account_id) throw badRequest('Choose an expense category.');
  if (!input.payment_account_id) throw badRequest('Choose the bank or cash account it was paid from.');
  const { rows: [acc] } = await db.query(`SELECT * FROM accounts WHERE company_id=$1 AND id=$2 AND is_active`, [ctx.companyId, input.account_id]);
  if (!acc) throw badRequest('Expense category not found.');
  const { rows: [pay] } = await db.query(`SELECT a.* FROM accounts a JOIN bank_accounts b ON b.account_id=a.id WHERE a.company_id=$1 AND a.id=$2 AND a.is_active`, [ctx.companyId, input.payment_account_id]);
  if (!pay) throw badRequest('Payment account must be an active bank or cash account.');
  if (input.supplier_id) {
    const { rows } = await db.query('SELECT 1 FROM suppliers WHERE company_id=$1 AND id=$2', [ctx.companyId, input.supplier_id]);
    if (!rows[0]) throw badRequest('Supplier not found.');
  }
  const tax = await resolveTaxRate(db, ctx.companyId, input.tax_rate_id || null, date);
  let net, taxAmt;
  try {
    if (input.amount_includes_tax && tax) ({ net, tax: taxAmt } = splitInclusive(input.amount, tax.rate));
    else { net = toCents(input.amount); taxAmt = tax ? percentOf(fromCents(net), tax.rate) : 0n; }
  } catch { throw badRequest('Invalid amount.'); }
  if (net <= 0n) throw badRequest('Amount must be greater than zero.');
  if (taxAmt > 0n && !tax.purchase_account_id) throw badRequest(`Tax rate ${tax.code} has no input tax account configured.`);
  return { date, acc, pay, tax, net, taxAmt, total: net + taxAmt };
}

export async function createExpense(db, ctx, input, { submit = true } = {}) {
  const n = await normalise(db, ctx, input);
  const number = await nextNumber(db, ctx.companyId, 'expense');
  const { rows: [e] } = await db.query(
    `INSERT INTO expenses (company_id, number, expense_date, supplier_id, payee_name, account_id, amount, tax_rate_id, tax_amount, total, payment_account_id,
        payment_method, description, reference, branch_id, department_id, document_id, status, ai_generated, ai_confidence, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'DRAFT',$18,$19,$20) RETURNING id`,
    [ctx.companyId, number, n.date, input.supplier_id || null, input.payee_name || null, n.acc.id, fromCents(n.net), n.tax?.id || null, fromCents(n.taxAmt),
     fromCents(n.total), n.pay.id, input.payment_method || 'CASH', input.description || null, input.reference || null, input.branch_id || null,
     input.department_id || null, input.document_id || null, !!input.ai_generated, input.ai_confidence ?? null, ctx.user?.id || null]);
  if (input.document_id) await db.query(`UPDATE documents SET linked_type='expense', linked_id=$2 WHERE id=$1 AND company_id=$3`, [input.document_id, e.id, ctx.companyId]);
  await audit(ctx, input.ai_generated ? 'ai.draft_created' : 'expense.created', { entityType: 'expense', entityId: e.id, newValue: { number, total: fromCents(n.total), account: n.acc.name } }, db);
  if (submit && !input.ai_generated) return submitExpense(db, ctx, e.id);
  return getExpense(db, ctx.companyId, e.id);
}

export async function updateExpense(db, ctx, id, input) {
  const e = await getExpense(db, ctx.companyId, id);
  if (!['DRAFT', 'PENDING_APPROVAL'].includes(e.status)) throw conflict('Posted expenses cannot be edited. Void and re-enter it instead.');
  const merged = { ...e, ...input };
  const n = await normalise(db, ctx, merged);
  await db.query(
    `UPDATE expenses SET expense_date=$2, supplier_id=$3, payee_name=$4, account_id=$5, amount=$6, tax_rate_id=$7, tax_amount=$8, total=$9, payment_account_id=$10,
       payment_method=$11, description=$12, reference=$13, branch_id=$14, department_id=$15, status='DRAFT', updated_at=now() WHERE id=$1`,
    [id, n.date, merged.supplier_id || null, merged.payee_name || null, n.acc.id, fromCents(n.net), n.tax?.id || null, fromCents(n.taxAmt), fromCents(n.total),
     n.pay.id, merged.payment_method || 'CASH', merged.description || null, merged.reference || null, merged.branch_id || null, merged.department_id || null]);
  const after = await getExpense(db, ctx.companyId, id);
  await audit(ctx, e.ai_generated ? 'ai.draft_edited' : 'expense.edited', { entityType: 'expense', entityId: id,
    ...diff({ total: e.total, account_id: e.account_id, expense_date: e.expense_date }, { total: after.total, account_id: after.account_id, expense_date: after.expense_date }) }, db);
  return after;
}

function needsApproval(ctx, e) {
  if (ctx.isSuperAdmin) return false;
  if (e.ai_generated && ctx.settings?.accounting?.ai_drafts_require_approval && !can(ctx, 'approve_expense')) return true;
  if (!can(ctx, 'approve_expense')) return true;
  if (!withinLimit(ctx, toCents(e.total))) return true;
  const thr = ctx.settings?.accounting?.expense_approval_threshold;
  if (thr && toCents(e.total) > toCents(thr) && !can(ctx, 'approve_transactions')) return true;
  return false;
}

/** Post now if the user may, otherwise route to PENDING_APPROVAL. */
export async function submitExpense(db, ctx, id) {
  const e = await getExpense(db, ctx.companyId, id);
  if (!['DRAFT', 'PENDING_APPROVAL'].includes(e.status)) throw conflict(`This expense is already ${e.status.toLowerCase()}.`);
  if (needsApproval(ctx, e)) {
    await db.query(`UPDATE expenses SET status='PENDING_APPROVAL', updated_at=now() WHERE id=$1`, [id]);
    await audit(ctx, 'expense.submitted_for_approval', { entityType: 'expense', entityId: id, newValue: { total: e.total } }, db);
    return { ...(await getExpense(db, ctx.companyId, id)), _pendingApproval: true };
  }
  return postExpense(db, ctx, id);
}

export async function postExpense(db, ctx, id, { approving = false } = {}) {
  const e = await getExpense(db, ctx.companyId, id);
  if (!['DRAFT', 'PENDING_APPROVAL'].includes(e.status)) throw conflict(`This expense is already ${e.status.toLowerCase()}.`);
  if (!ctx.isSuperAdmin && !can(ctx, 'approve_expense')) throw forbidden('You do not have permission to approve expenses.');
  checkLimit(ctx, toCents(e.total), 'expense');
  const thr = ctx.settings?.accounting?.expense_approval_threshold;
  if (approving && ctx.settings?.accounting?.segregation_of_duties && e.created_by === ctx.user?.id && !ctx.isSuperAdmin && thr && toCents(e.total) > toCents(thr)) {
    throw forbidden('Segregation of duties: another authorised user must approve an expense you recorded above the approval threshold.');
  }
  await assertPeriodOpen(db, ctx.companyId, e.expense_date);
  const lines = [{ account_id: e.account_id, debit: e.amount, supplier_id: e.supplier_id, description: e.description || e.payee_name || e.number, branch_id: e.branch_id, department_id: e.department_id }];
  if (toCents(e.tax_amount) > 0n) {
    const { rows: [t] } = await db.query('SELECT name, purchase_account_id FROM tax_rates WHERE id=$1', [e.tax_rate_id]);
    if (!t?.purchase_account_id) throw badRequest(`The tax rate on this expense has no input tax account configured. Set it in Admin Center → Tax.`);
    lines.push({ account_id: t.purchase_account_id, debit: e.tax_amount, tax_rate_id: e.tax_rate_id, description: 'Input VAT' });
  }
  if (!ctx.settings?.accounting?.allow_negative_cash) {
    const bal = toCents(await accountBalance(db, ctx.companyId, e.payment_account_id));
    if (bal < toCents(e.total)) throw conflict(`Insufficient funds in ${e.payment_account_name || 'the payment account'}: balance ${formatK(fromCents(bal))}. Record the deposit first or enable negative balances in Admin Center → Accounting.`);
  }
  lines.push({ account_id: e.payment_account_id, credit: e.total, description: `${e.number} ${e.payee_name || e.supplier_name || ''}`.trim() });
  const je = await createJournal(db, ctx, {
    date: e.expense_date, reference: e.reference || e.number, description: `Expense ${e.number} — ${e.description || e.account_name}`,
    source_type: 'EXPENSE', source_id: e.id, status: 'POSTED', lines, branch_id: e.branch_id, department_id: e.department_id, approved: true,
  });
  await db.query(`UPDATE expenses SET status='POSTED', journal_entry_id=$2, approved_by=$3, updated_at=now() WHERE id=$1`, [id, je.id, ctx.user?.id || null]);
  await audit(ctx, e.ai_generated ? 'ai.draft_approved_and_posted' : approving ? 'expense.approved_and_posted' : 'expense.posted',
    { entityType: 'expense', entityId: id, oldValue: { status: e.status }, newValue: { status: 'POSTED', journal: je.number } }, db);
  return getExpense(db, ctx.companyId, id);
}

export async function voidExpense(db, ctx, id, { reason } = {}) {
  const e = await getExpense(db, ctx.companyId, id);
  if (e.status === 'VOID') throw conflict('Already void.');
  if (e.status === 'POSTED') {
    if (!reason) throw badRequest('A reason is required to void a posted expense.');
    await reverseJournal(db, ctx, e.journal_entry_id, { reason: `Void ${e.number}: ${reason}`, fromSource: true });
  }
  await db.query(`UPDATE expenses SET status='VOID', updated_at=now() WHERE id=$1`, [id]);
  await audit(ctx, e.ai_generated && e.status !== 'POSTED' ? 'ai.draft_rejected' : 'expense.voided', { entityType: 'expense', entityId: id, oldValue: { status: e.status }, newValue: { status: 'VOID', reason } }, db);
  return getExpense(db, ctx.companyId, id);
}
