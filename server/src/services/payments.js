// Receipts (money in from customers) and payments (money out to suppliers), with allocations.
import { toCents, fromCents, formatK, percentOf } from '../lib/money.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { nextNumber } from '../lib/numbering.js';
import { audit } from '../lib/audit.js';
import { createJournal, reverseJournal, getSystemAccount, checkLimit, assertPeriodOpen, accountBalance } from './ledger.js';
import { refreshInvoice } from './sales.js';
import { refreshBill } from './purchases.js';
import { resolveTaxRate } from './tax.js';

export async function getPayment(db, companyId, id) {
  const { rows: [p] } = await db.query(
    `SELECT p.*, c.name AS customer_name, s.name AS supplier_name, a.name AS bank_account_name, a.code AS bank_account_code, je.number AS journal_number, u.name AS created_by_name
       FROM payments p LEFT JOIN customers c ON c.id=p.customer_id LEFT JOIN suppliers s ON s.id=p.supplier_id
       JOIN accounts a ON a.id=p.bank_account_id LEFT JOIN journal_entries je ON je.id=p.journal_entry_id LEFT JOIN users u ON u.id=p.created_by
      WHERE p.company_id=$1 AND p.id=$2`, [companyId, id]);
  if (!p) throw notFound('Payment');
  const { rows: allocations } = await db.query(
    `SELECT pa.*, COALESCE(sd.number, pd.number) AS document_number, COALESCE(sd.total, pd.total) AS document_total
       FROM payment_allocations pa LEFT JOIN sales_documents sd ON sd.id=pa.sales_document_id LEFT JOIN purchase_documents pd ON pd.id=pa.purchase_document_id
      WHERE pa.payment_id=$1`, [id]);
  const used = allocations.reduce((t, a) => t + toCents(a.amount), 0n);
  return { ...p, allocations, unallocated: fromCents(toCents(p.amount) - used) };
}

async function assertBankAccount(db, companyId, accountId) {
  const { rows: [a] } = await db.query(
    `SELECT a.*, b.is_cash FROM accounts a JOIN bank_accounts b ON b.account_id=a.id WHERE a.company_id=$1 AND a.id=$2`, [companyId, accountId]);
  if (!a) throw badRequest('Choose a valid bank or cash account.');
  if (!a.is_active) throw badRequest(`${a.name} is inactive.`);
  return a;
}

/**
 * Record a receipt (direction IN) or supplier payment (direction OUT).
 * allocations: [{ document_id, amount }] against invoices (IN) or bills (OUT). Unallocated remainder stays as credit on account.
 */
export async function createPayment(db, ctx, input) {
  const dir = input.direction;
  if (!['IN', 'OUT'].includes(dir)) throw badRequest('Direction must be IN (receipt) or OUT (payment).');
  const date = input.payment_date;
  if (!date) throw badRequest('Payment date is required.');
  let amount;
  try { amount = toCents(input.amount); } catch { throw badRequest('Invalid amount.'); }
  if (amount <= 0n) throw badRequest('Amount must be greater than zero.');
  const bank = await assertBankAccount(db, ctx.companyId, input.bank_account_id);
  checkLimit(ctx, amount, dir === 'IN' ? 'receipt' : 'payment');
  await assertPeriodOpen(db, ctx.companyId, date);

  const partyKey = dir === 'IN' ? 'customer_id' : 'supplier_id';
  const partyTable = dir === 'IN' ? 'customers' : 'suppliers';
  if (!input[partyKey]) throw badRequest(`Choose the ${dir === 'IN' ? 'customer' : 'supplier'}.`);
  const { rows: [party] } = await db.query(`SELECT * FROM ${partyTable} WHERE company_id=$1 AND id=$2`, [ctx.companyId, input[partyKey]]);
  if (!party) throw badRequest(`${dir === 'IN' ? 'Customer' : 'Supplier'} not found.`);

  // Withholding tax deducted from a supplier payment
  let wht = 0n, whtRate = null;
  if (dir === 'OUT' && input.wht_rate_id) {
    whtRate = await resolveTaxRate(db, ctx.companyId, input.wht_rate_id, date);
    if (whtRate.tax_type !== 'WHT') throw badRequest('Choose a withholding tax rate.');
    wht = percentOf(fromCents(amount), whtRate.rate);
  }

  if (dir === 'OUT' && !ctx.settings?.accounting?.allow_negative_cash) {
    const bal = toCents(await accountBalance(db, ctx.companyId, bank.id));
    if (bal - (amount - wht) < 0n) throw conflict(`Insufficient funds in ${bank.name}: balance ${formatK(fromCents(bal))}. Record the deposit first or enable negative balances in settings.`);
  }

  const { allocs, allocated } = await validateAllocations(db, ctx, dir, party, input.allocations);
  if (allocated > amount) throw badRequest('Allocations exceed the payment amount.');

  const number = await nextNumber(db, ctx.companyId, dir === 'IN' ? 'receipt' : 'payment');
  const { rows: [p] } = await db.query(
    `INSERT INTO payments (company_id, direction, number, payment_date, customer_id, supplier_id, amount, bank_account_id, method, reference, notes, wht_rate_id, wht_amount, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
    [ctx.companyId, dir, number, date, dir === 'IN' ? party.id : null, dir === 'OUT' ? party.id : null, fromCents(amount), bank.id,
     input.method || (bank.is_cash ? 'CASH' : 'BANK_TRANSFER'), input.reference || null, input.notes || null, whtRate?.id || null, fromCents(wht), ctx.user?.id || null]);

  const ctrl = await getSystemAccount(db, ctx.companyId, dir === 'IN' ? 'AR' : 'AP');
  const lines = dir === 'IN'
    ? [{ account_id: bank.id, debit: fromCents(amount), description: `Receipt ${number}` },
       { account_id: ctrl.id, credit: fromCents(amount), customer_id: party.id, description: `Receipt ${number} ${party.name}` }]
    : [{ account_id: ctrl.id, debit: fromCents(amount), supplier_id: party.id, description: `Payment ${number} ${party.name}` },
       { account_id: bank.id, credit: fromCents(amount - wht), description: `Payment ${number}` },
       ...(wht > 0n ? [{ account_id: whtRate.purchase_account_id, credit: fromCents(wht), tax_rate_id: whtRate.id, supplier_id: party.id, description: 'Withholding tax deducted' }] : [])];
  if (wht > 0n && !whtRate.purchase_account_id) throw badRequest('The withholding tax rate has no payable account configured.');
  const je = await createJournal(db, ctx, {
    date, reference: input.reference || number, description: `${dir === 'IN' ? 'Receipt from' : 'Payment to'} ${party.name}`,
    source_type: dir === 'IN' ? 'RECEIPT' : 'PAYMENT', source_id: p.id, status: 'POSTED', lines, approved: true,
  });
  await db.query('UPDATE payments SET journal_entry_id=$2 WHERE id=$1', [p.id, je.id]);
  for (const a of allocs) {
    await db.query(`INSERT INTO payment_allocations (payment_id, ${dir === 'IN' ? 'sales_document_id' : 'purchase_document_id'}, amount) VALUES ($1,$2,$3)`, [p.id, a.id, fromCents(a.amount)]);
    if (dir === 'IN') await refreshInvoice(db, a.id); else await refreshBill(db, a.id);
  }
  await audit(ctx, dir === 'IN' ? 'receipt.created' : 'payment.created', { entityType: 'payment', entityId: p.id,
    newValue: { number, party: party.name, amount: fromCents(amount), allocations: allocs.map((a) => ({ document_id: a.id, amount: fromCents(a.amount) })) } }, db);
  return getPayment(db, ctx.companyId, p.id);
}

/** Validate allocations of a receipt (IN → invoices) or payment (OUT → bills) for one party. */
async function validateAllocations(db, ctx, dir, party, list) {
  const partyKey = dir === 'IN' ? 'customer_id' : 'supplier_id';
  const t = dir === 'IN' ? 'sales_documents' : 'purchase_documents';
  const allocs = [];
  let allocated = 0n;
  for (const a of list || []) {
    let amt;
    try { amt = toCents(a.amount); } catch { throw badRequest('Invalid allocation amount.'); }
    if (amt <= 0n) continue;
    const { rows: [doc] } = await db.query(
      `SELECT id, number, ${partyKey} AS party, doc_type, status, total, amount_paid, amount_credited FROM ${t} WHERE company_id=$1 AND id=$2 FOR UPDATE`, [ctx.companyId, a.document_id]);
    if (!doc) throw badRequest('An allocated document was not found.');
    if (doc.party !== party.id) throw badRequest(`${doc.number} belongs to a different ${dir === 'IN' ? 'customer' : 'supplier'}.`);
    if (doc.doc_type !== (dir === 'IN' ? 'INVOICE' : 'BILL')) throw badRequest(`${doc.number} cannot receive payments.`);
    if (!['SENT', 'PARTIALLY_PAID', 'POSTED', 'OVERDUE'].includes(doc.status)) throw badRequest(`${doc.number} is ${doc.status.toLowerCase()} and cannot be paid.`);
    const already = allocs.filter((x) => x.id === doc.id).reduce((s2, x) => s2 + x.amount, 0n);
    const outstanding = toCents(doc.total) - toCents(doc.amount_paid) - toCents(doc.amount_credited) - already;
    if (amt > outstanding) throw badRequest(`Allocation to ${doc.number} (${formatK(fromCents(amt))}) exceeds its balance of ${formatK(fromCents(outstanding))}.`);
    allocated += amt;
    allocs.push({ id: doc.id, amount: amt });
  }
  return { allocs, allocated };
}

/** Apply the unallocated (on-account) part of an existing receipt/payment to open invoices or bills. No new journal: the control account was already updated. */
export async function allocatePayment(db, ctx, id, list) {
  const { rows: [p] } = await db.query('SELECT * FROM payments WHERE company_id=$1 AND id=$2 FOR UPDATE', [ctx.companyId, id]);
  if (!p) throw notFound('Payment');
  if (p.status !== 'POSTED') throw conflict('Only posted receipts and payments can be allocated.');
  const partyTable = p.direction === 'IN' ? 'customers' : 'suppliers';
  const { rows: [party] } = await db.query(`SELECT * FROM ${partyTable} WHERE id=$1`, [p.customer_id || p.supplier_id]);
  const { rows: [u] } = await db.query('SELECT COALESCE(SUM(amount),0)::numeric(18,2) AS used FROM payment_allocations WHERE payment_id=$1', [id]);
  const available = toCents(p.amount) - toCents(u.used);
  const { allocs, allocated } = await validateAllocations(db, ctx, p.direction, party, list);
  if (!allocs.length) throw badRequest('Enter at least one allocation amount.');
  if (allocated > available) throw badRequest(`Allocations (${formatK(fromCents(allocated))}) exceed the unallocated amount of ${formatK(fromCents(available))}.`);
  for (const a of allocs) {
    await db.query(`INSERT INTO payment_allocations (payment_id, ${p.direction === 'IN' ? 'sales_document_id' : 'purchase_document_id'}, amount) VALUES ($1,$2,$3)`, [id, a.id, fromCents(a.amount)]);
    if (p.direction === 'IN') await refreshInvoice(db, a.id); else await refreshBill(db, a.id);
  }
  await audit(ctx, 'payment.allocated', { entityType: 'payment', entityId: id,
    newValue: { number: p.number, allocations: allocs.map((a) => ({ document_id: a.id, amount: fromCents(a.amount) })) } }, db);
  return getPayment(db, ctx.companyId, id);
}

export async function voidPayment(db, ctx, id, { reason } = {}) {
  const p = await getPayment(db, ctx.companyId, id);
  if (p.status === 'VOID') throw conflict('This payment is already void.');
  if (!reason) throw badRequest('A reason is required to void a payment.');
  await reverseJournal(db, ctx, p.journal_entry_id, { reason: `Void ${p.number}: ${reason}`, fromSource: true });
  await db.query(`UPDATE payments SET status='VOID' WHERE id=$1`, [id]);
  for (const a of p.allocations) {
    if (a.sales_document_id) await refreshInvoice(db, a.sales_document_id);
    if (a.purchase_document_id) await refreshBill(db, a.purchase_document_id);
  }
  await audit(ctx, 'payment.voided', { entityType: 'payment', entityId: id, oldValue: { status: 'POSTED' }, newValue: { status: 'VOID', reason } }, db);
  return getPayment(db, ctx.companyId, id);
}

/** Edit non-financial fields (reference, notes, method). Amounts are changed by voiding and re-entering. */
export async function editPaymentDetails(db, ctx, id, input) {
  const p = await getPayment(db, ctx.companyId, id);
  await db.query(`UPDATE payments SET reference=$2, notes=$3, method=$4 WHERE id=$1`, [id, input.reference ?? p.reference, input.notes ?? p.notes, input.method || p.method]);
  await audit(ctx, 'payment.edited', { entityType: 'payment', entityId: id, oldValue: { reference: p.reference, notes: p.notes, method: p.method }, newValue: { reference: input.reference, notes: input.notes, method: input.method } }, db);
  return getPayment(db, ctx.companyId, id);
}
