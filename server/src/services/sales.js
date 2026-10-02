// Sales: quotations, sales orders, invoices and credit notes, with automatic journals.
import { toCents, fromCents, formatK } from '../lib/money.js';
import { badRequest, conflict, notFound, forbidden, AppError } from '../lib/errors.js';
import { nextNumber } from '../lib/numbering.js';
import { audit, diff } from '../lib/audit.js';
import { computeDocumentLines } from './tax.js';
import { createJournal, reverseJournal, getSystemAccount, checkLimit, requirePerm, assertPeriodOpen } from './ledger.js';

const SEQ = { QUOTE: 'quote', ORDER: 'sales_order', INVOICE: 'invoice', CREDIT_NOTE: 'credit_note' };
const LABEL = { QUOTE: 'Quotation', ORDER: 'Sales order', INVOICE: 'Invoice', CREDIT_NOTE: 'Credit note' };

/** SQL expression for the status shown to users (OVERDUE is derived from the due date). */
export const EFFECTIVE_STATUS = `CASE WHEN d.doc_type='INVOICE' AND d.status IN ('SENT','PARTIALLY_PAID') AND d.due_date < CURRENT_DATE THEN 'OVERDUE' ELSE d.status END`;

export async function getSalesDoc(db, companyId, id) {
  const { rows: [d] } = await db.query(
    `SELECT d.*, ${EFFECTIVE_STATUS} AS effective_status, (d.total - d.amount_paid - d.amount_credited)::numeric(18,2) AS balance_due,
            c.name AS customer_name, c.email AS customer_email, c.address AS customer_address, c.tpin AS customer_tpin, c.phone AS customer_phone,
            r.number AS related_number, u.name AS created_by_name, je.number AS journal_number
       FROM sales_documents d JOIN customers c ON c.id=d.customer_id
       LEFT JOIN sales_documents r ON r.id=d.related_document_id LEFT JOIN users u ON u.id=d.created_by
       LEFT JOIN journal_entries je ON je.id=d.journal_entry_id
      WHERE d.company_id=$1 AND d.id=$2`, [companyId, id]);
  if (!d) throw notFound('Sales document');
  const { rows: lines } = await db.query(
    `SELECT l.*, a.code AS account_code, a.name AS account_name, t.code AS tax_code, t.rate AS tax_rate
       FROM sales_document_lines l JOIN accounts a ON a.id=l.account_id LEFT JOIN tax_rates t ON t.id=l.tax_rate_id
      WHERE l.document_id=$1 ORDER BY l.line_no`, [id]);
  const { rows: payments } = await db.query(
    `SELECT p.id, p.number, p.payment_date, p.method, pa.amount, p.status FROM payment_allocations pa JOIN payments p ON p.id=pa.payment_id
      WHERE pa.sales_document_id=$1 ORDER BY p.payment_date`, [id]);
  const { rows: credits } = await db.query(
    `SELECT id, number, doc_date, total, status FROM sales_documents WHERE related_document_id=$1 AND doc_type='CREDIT_NOTE' AND status <> 'CANCELLED'`, [id]);
  return { ...d, lines, payments, credit_notes: credits };
}

async function assertCustomer(db, companyId, customerId) {
  if (!customerId) throw badRequest(`${'Invoice'} cannot be saved because the customer is missing.`);
  const { rows: [c] } = await db.query('SELECT * FROM customers WHERE company_id=$1 AND id=$2', [companyId, customerId]);
  if (!c) throw badRequest('Customer not found.');
  if (!c.is_active) throw badRequest(`Customer ${c.name} is inactive.`);
  return c;
}

async function writeLines(db, docId, lines) {
  await db.query('DELETE FROM sales_document_lines WHERE document_id=$1', [docId]);
  for (const l of lines) {
    await db.query(
      `INSERT INTO sales_document_lines (document_id, line_no, item_id, description, quantity, unit_price, discount_pct, account_id, tax_rate_id, line_subtotal, line_tax, line_total)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [docId, l.line_no, l.item_id || null, String(l.description).trim(), l.quantity, l.unit_price, l.discount_pct, l.account_id, l.tax_rate_id, l.line_subtotal, l.line_tax, l.line_total]);
  }
}

async function assertLineAccounts(db, companyId, lines) {
  const ids = [...new Set(lines.map((l) => Number(l.account_id)))];
  const { rows } = await db.query(`SELECT id FROM accounts WHERE company_id=$1 AND id = ANY($2) AND is_active`, [companyId, ids]);
  if (rows.length !== ids.length) throw badRequest('One of the line accounts is missing or inactive.');
}

export async function createSalesDoc(db, ctx, input) {
  const type = input.doc_type;
  if (!SEQ[type]) throw badRequest('Unknown document type.');
  if (!input.customer_id) throw badRequest(`${LABEL[type]} cannot be saved because the customer is missing.`);
  const customer = await assertCustomer(db, ctx.companyId, input.customer_id);
  const date = input.doc_date;
  if (!date) throw badRequest('Document date is required.');
  const calc = await computeDocumentLines(db, ctx.companyId, input.lines, date, 'SALES');
  await assertLineAccounts(db, ctx.companyId, calc.lines);
  let due = input.due_date || null;
  if (type === 'INVOICE' && !due) {
    const d = new Date(`${date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + Number(customer.payment_terms_days ?? 30));
    due = d.toISOString().slice(0, 10);
  }
  if (due && due < date) throw badRequest('Due date cannot be before the document date.');
  const number = await nextNumber(db, ctx.companyId, SEQ[type]);
  const { rows: [doc] } = await db.query(
    `INSERT INTO sales_documents (company_id, doc_type, number, customer_id, doc_date, due_date, reference, notes, terms, status, subtotal, tax_total, total,
       related_document_id, branch_id, department_id, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'DRAFT',$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
    [ctx.companyId, type, number, customer.id, date, due, input.reference || null, input.notes || null, input.terms || null,
     fromCents(calc.subtotal), fromCents(calc.taxTotal), fromCents(calc.total), input.related_document_id || null,
     input.branch_id || null, input.department_id || null, ctx.user?.id || null]);
  await writeLines(db, doc.id, calc.lines);
  await audit(ctx, `${type.toLowerCase()}.created`, { entityType: 'sales_document', entityId: doc.id, newValue: { number, customer: customer.name, total: doc.total, status: 'DRAFT' } }, db);
  return getSalesDoc(db, ctx.companyId, doc.id);
}

export async function updateSalesDoc(db, ctx, id, input) {
  const d = await getSalesDoc(db, ctx.companyId, id);
  const editable = d.doc_type === 'QUOTE' ? ['DRAFT', 'SENT'] : ['DRAFT'];
  if (!editable.includes(d.status)) throw conflict(`This ${LABEL[d.doc_type].toLowerCase()} is ${d.status.toLowerCase()} and can no longer be edited.${d.doc_type === 'INVOICE' ? ' Issue a credit note instead.' : ''}`);
  const customer = await assertCustomer(db, ctx.companyId, input.customer_id || d.customer_id);
  const date = input.doc_date || d.doc_date;
  const calc = await computeDocumentLines(db, ctx.companyId, input.lines || d.lines, date, 'SALES');
  await assertLineAccounts(db, ctx.companyId, calc.lines);
  const due = input.due_date !== undefined ? input.due_date || null : d.due_date;
  if (due && due < date) throw badRequest('Due date cannot be before the document date.');
  await db.query(
    `UPDATE sales_documents SET customer_id=$2, doc_date=$3, due_date=$4, reference=$5, notes=$6, terms=$7, subtotal=$8, tax_total=$9, total=$10,
       branch_id=$11, department_id=$12, updated_at=now() WHERE id=$1`,
    [id, customer.id, date, due, input.reference ?? d.reference, input.notes ?? d.notes, input.terms ?? d.terms,
     fromCents(calc.subtotal), fromCents(calc.taxTotal), fromCents(calc.total), input.branch_id ?? d.branch_id, input.department_id ?? d.department_id]);
  await writeLines(db, id, calc.lines);
  const after = await getSalesDoc(db, ctx.companyId, id);
  await audit(ctx, `${d.doc_type.toLowerCase()}.modified`, { entityType: 'sales_document', entityId: id,
    ...diff({ customer_id: d.customer_id, doc_date: d.doc_date, due_date: d.due_date, total: d.total }, { customer_id: after.customer_id, doc_date: after.doc_date, due_date: after.due_date, total: after.total }) }, db);
  return after;
}

/** Approve & post an invoice or credit note: generates the journal and makes it a receivable. */
export async function postSalesDoc(db, ctx, id) {
  const d = await getSalesDoc(db, ctx.companyId, id);
  if (!['INVOICE', 'CREDIT_NOTE'].includes(d.doc_type)) throw badRequest('Only invoices and credit notes are posted to the ledger.');
  if (d.status !== 'DRAFT') throw conflict(`This ${LABEL[d.doc_type].toLowerCase()} has already been posted.`);
  if (!d.customer_id) throw badRequest('Invoice cannot be posted because the customer is missing.');
  if (toCents(d.total) <= 0n) throw badRequest(`${LABEL[d.doc_type]} cannot be posted with a zero total.`);
  requirePerm(ctx, d.doc_type === 'INVOICE' ? 'approve_invoice' : 'create_credit_note');
  checkLimit(ctx, toCents(d.total), LABEL[d.doc_type].toLowerCase());
  await assertPeriodOpen(db, ctx.companyId, d.doc_date);
  const ar = await getSystemAccount(db, ctx.companyId, 'AR');
  const sign = d.doc_type === 'INVOICE' ? 1 : -1;  // credit note mirrors the invoice
  const L = (account_id, amountC, isDebit, extra = {}) => ({ account_id, debit: (isDebit === (sign > 0)) ? fromCents(amountC) : 0, credit: (isDebit === (sign > 0)) ? 0 : fromCents(amountC), ...extra });
  const lines = [L(ar.id, toCents(d.total), true, { customer_id: d.customer_id, description: `${d.number} ${d.customer_name}` })];
  // revenue grouped by account
  const rev = new Map(), tax = new Map();
  for (const l of d.lines) {
    rev.set(l.account_id, (rev.get(l.account_id) || 0n) + toCents(l.line_subtotal));
    if (toCents(l.line_tax) > 0n) {
      const { rows: [t] } = await db.query('SELECT sales_account_id FROM tax_rates WHERE id=$1', [l.tax_rate_id]);
      if (!t?.sales_account_id) throw badRequest(`Tax rate ${l.tax_code} has no output tax account configured.`);
      const k = `${t.sales_account_id}:${l.tax_rate_id}`;
      tax.set(k, (tax.get(k) || 0n) + toCents(l.line_tax));
    }
  }
  for (const [acc, amt] of rev) if (amt > 0n) lines.push(L(acc, amt, false, { customer_id: d.customer_id }));
  for (const [k, amt] of tax) { const [acc, rate] = k.split(':'); lines.push(L(Number(acc), amt, false, { tax_rate_id: Number(rate), description: 'Output VAT' })); }
  const je = await createJournal(db, ctx, {
    date: d.doc_date, reference: d.number, description: `${LABEL[d.doc_type]} ${d.number} — ${d.customer_name}`,
    source_type: d.doc_type, source_id: d.id, status: 'POSTED', lines, branch_id: d.branch_id, department_id: d.department_id, approved: true,
  });
  const newStatus = d.doc_type === 'INVOICE' ? 'SENT' : 'POSTED';
  await db.query(`UPDATE sales_documents SET status=$2, journal_entry_id=$3, posted_at=now(), updated_at=now() WHERE id=$1`, [id, newStatus, je.id]);
  if (d.doc_type === 'CREDIT_NOTE' && d.related_document_id) {
    // Apply to the original invoice when it can absorb the credit; otherwise it stays as an unapplied credit on account (e.g. refunds).
    try { await applyCreditNote(db, ctx, d.id, d.related_document_id); } catch (e) {
      if (!(e instanceof AppError)) throw e;
      await db.query('UPDATE sales_documents SET related_document_id=NULL WHERE id=$1', [d.id]);
    }
  }
  await audit(ctx, `${d.doc_type.toLowerCase()}.approved_and_posted`, { entityType: 'sales_document', entityId: id, oldValue: { status: 'DRAFT' }, newValue: { status: newStatus, journal: je.number, total: d.total } }, db);
  return getSalesDoc(db, ctx.companyId, id);
}

/** Recalculate an invoice's paid/credited totals and status from allocations (never edited by hand). */
export async function refreshInvoice(db, invoiceId) {
  const { rows: [r] } = await db.query(
    `SELECT d.total, d.status,
       COALESCE((SELECT SUM(pa.amount) FROM payment_allocations pa JOIN payments p ON p.id=pa.payment_id WHERE pa.sales_document_id=d.id AND p.status='POSTED'),0) AS paid,
       COALESCE((SELECT SUM(cn.total) FROM sales_documents cn WHERE cn.related_document_id=d.id AND cn.doc_type='CREDIT_NOTE' AND cn.status='APPLIED'),0) AS credited
     FROM sales_documents d WHERE d.id=$1 FOR UPDATE`, [invoiceId]);
  if (!r || ['DRAFT', 'CANCELLED'].includes(r.status)) return;
  const total = toCents(r.total), paid = toCents(r.paid);
  let credited = toCents(r.credited);
  if (credited > total - paid) credited = total - paid < 0n ? 0n : total - paid;
  const out = total - paid - credited;
  const status = out <= 0n ? 'PAID' : paid + credited > 0n ? 'PARTIALLY_PAID' : 'SENT';
  await db.query(`UPDATE sales_documents SET amount_paid=$2, amount_credited=$3, status=$4, updated_at=now() WHERE id=$1`, [invoiceId, fromCents(paid), fromCents(credited), status]);
}

export async function applyCreditNote(db, ctx, creditNoteId, invoiceId) {
  const { rows: [inv] } = await db.query(`SELECT * FROM sales_documents WHERE id=$1 AND company_id=$2 AND doc_type='INVOICE' FOR UPDATE`, [invoiceId, ctx.companyId]);
  const { rows: [cn] } = await db.query(`SELECT * FROM sales_documents WHERE id=$1 AND company_id=$2 AND doc_type='CREDIT_NOTE' FOR UPDATE`, [creditNoteId, ctx.companyId]);
  if (!inv || !cn) throw notFound('Invoice or credit note');
  if (inv.customer_id !== cn.customer_id) throw badRequest('The credit note and invoice belong to different customers.');
  if (cn.status !== 'POSTED') throw conflict(`Credit note ${cn.number} must be posted and not yet applied.`);
  if (!['SENT', 'PARTIALLY_PAID', 'OVERDUE'].includes(inv.status)) throw conflict(`Invoice ${inv.number} is ${inv.status.toLowerCase()} and cannot take a credit.`);
  const outstanding = toCents(inv.total) - toCents(inv.amount_paid) - toCents(inv.amount_credited);
  if (toCents(cn.total) > outstanding) throw badRequest(`Credit note ${cn.number} (${formatK(cn.total)}) is more than the invoice balance of ${formatK(fromCents(outstanding))}.`);
  await db.query(`UPDATE sales_documents SET related_document_id=$2, status='APPLIED', updated_at=now() WHERE id=$1`, [creditNoteId, invoiceId]);
  await refreshInvoice(db, invoiceId);
  await audit(ctx, 'credit_note.applied', { entityType: 'sales_document', entityId: creditNoteId, newValue: { invoice: inv.number, amount: cn.total } }, db);
}

export async function cancelSalesDoc(db, ctx, id, { reason } = {}) {
  const d = await getSalesDoc(db, ctx.companyId, id);
  if (d.status === 'CANCELLED') throw conflict('Already cancelled.');
  if (d.doc_type === 'INVOICE' && d.status !== 'DRAFT') {
    const paid = d.payments.filter((p) => p.status === 'POSTED');
    if (paid.length) throw conflict('This invoice has payments allocated. Void the payments or issue a credit note instead.');
    if (d.credit_notes.length) throw conflict('This invoice has credit notes applied. Cancel them first.');
    requirePerm(ctx, 'delete_invoice');
    await reverseJournal(db, ctx, d.journal_entry_id, { reason: reason || `Cancelled ${d.number}`, fromSource: true });
  } else if (d.doc_type === 'CREDIT_NOTE' && d.status !== 'DRAFT') {
    await reverseJournal(db, ctx, d.journal_entry_id, { reason: reason || `Cancelled ${d.number}`, fromSource: true });
  }
  await db.query(`UPDATE sales_documents SET status='CANCELLED', cancelled_at=now(), updated_at=now() WHERE id=$1`, [id]);
  if (d.doc_type === 'CREDIT_NOTE' && d.related_document_id) await refreshInvoice(db, d.related_document_id);
  await audit(ctx, `${d.doc_type.toLowerCase()}.cancelled`, { entityType: 'sales_document', entityId: id, oldValue: { status: d.status }, newValue: { status: 'CANCELLED', reason } }, db);
  return getSalesDoc(db, ctx.companyId, id);
}

/** Quote → order/invoice, order → invoice, invoice → credit note (copies lines). */
export async function convertSalesDoc(db, ctx, id, toType) {
  const d = await getSalesDoc(db, ctx.companyId, id);
  const allowed = { QUOTE: ['ORDER', 'INVOICE'], ORDER: ['INVOICE'], INVOICE: ['CREDIT_NOTE'] };
  if (!allowed[d.doc_type]?.includes(toType)) throw badRequest(`A ${LABEL[d.doc_type].toLowerCase()} cannot be converted to a ${LABEL[toType]?.toLowerCase() || toType}.`);
  if (d.status === 'CANCELLED') throw conflict('Cancelled documents cannot be converted.');
  if (toType === 'CREDIT_NOTE' && d.status === 'DRAFT') throw conflict('Post the invoice before issuing a credit note against it.');
  const today = new Date().toISOString().slice(0, 10);
  const created = await createSalesDoc(db, ctx, {
    doc_type: toType, customer_id: d.customer_id, doc_date: today, reference: d.number, notes: d.notes, terms: d.terms,
    related_document_id: d.id, branch_id: d.branch_id, department_id: d.department_id,
    lines: d.lines.map((l) => ({ item_id: l.item_id, description: l.description, quantity: l.quantity, unit_price: l.unit_price, discount_pct: l.discount_pct, account_id: l.account_id, tax_rate_id: l.tax_rate_id })),
  });
  if (d.doc_type === 'QUOTE') await db.query(`UPDATE sales_documents SET status='CONVERTED', updated_at=now() WHERE id=$1`, [id]);
  if (d.doc_type === 'ORDER' && toType === 'INVOICE') await db.query(`UPDATE sales_documents SET status='INVOICED', updated_at=now() WHERE id=$1`, [id]);
  await audit(ctx, `${d.doc_type.toLowerCase()}.converted`, { entityType: 'sales_document', entityId: id, newValue: { to: toType, number: created.number } }, db);
  return created;
}

export async function setQuoteStatus(db, ctx, id, status) {
  const d = await getSalesDoc(db, ctx.companyId, id);
  if (!['QUOTE', 'ORDER'].includes(d.doc_type)) throw badRequest('Only quotations and orders use this action.');
  const ok = d.doc_type === 'QUOTE' ? ['SENT', 'ACCEPTED', 'DECLINED'] : ['OPEN', 'CANCELLED'];
  if (!ok.includes(status)) throw badRequest('Invalid status.');
  await db.query(`UPDATE sales_documents SET status=$2, updated_at=now() WHERE id=$1`, [id, status]);
  await audit(ctx, `${d.doc_type.toLowerCase()}.status_changed`, { entityType: 'sales_document', entityId: id, oldValue: { status: d.status }, newValue: { status } }, db);
  return getSalesDoc(db, ctx.companyId, id);
}

export async function deleteDraftSalesDoc(db, ctx, id) {
  const d = await getSalesDoc(db, ctx.companyId, id);
  if (d.status !== 'DRAFT' && !(d.doc_type === 'QUOTE' && d.status === 'SENT')) throw conflict('Only drafts can be deleted. Cancel posted documents instead.');
  if (d.doc_type === 'INVOICE') requirePerm(ctx, 'delete_invoice');
  await db.query(`UPDATE sales_documents SET status='CANCELLED', cancelled_at=now() WHERE id=$1`, [id]);
  await audit(ctx, `${d.doc_type.toLowerCase()}.deleted_draft`, { entityType: 'sales_document', entityId: id, oldValue: { number: d.number, total: d.total } }, db);
}

export async function markSent(db, ctx, id) {
  await db.query(`UPDATE sales_documents SET sent_at=now(), status=CASE WHEN doc_type='QUOTE' AND status='DRAFT' THEN 'SENT' ELSE status END WHERE id=$1 AND company_id=$2`, [id, ctx.companyId]);
}

/** Customer balance straight from the ledger (AR lines tagged with the customer). */
export async function customerBalance(db, companyId, customerId, asOf) {
  const ar = await getSystemAccount(db, companyId, 'AR');
  const p = [companyId, ar.id, customerId];
  const { rows: [r] } = await db.query(
    `SELECT COALESCE(SUM(debit-credit),0)::numeric(18,2) AS balance FROM ledger WHERE company_id=$1 AND account_id=$2 AND customer_id=$3 ${asOf ? 'AND entry_date <= $4' : ''}`,
    asOf ? [...p, asOf] : p);
  return r.balance;
}

export { formatK, forbidden };
