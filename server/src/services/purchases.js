// Purchases: purchase orders, supplier bills and debit notes (supplier credits).
import { toCents, fromCents } from '../lib/money.js';
import { badRequest, conflict, notFound, AppError } from '../lib/errors.js';
import { nextNumber } from '../lib/numbering.js';
import { audit, diff } from '../lib/audit.js';
import { computeDocumentLines } from './tax.js';
import { createJournal, reverseJournal, getSystemAccount, checkLimit, requirePerm, assertPeriodOpen } from './ledger.js';

const SEQ = { PO: 'purchase_order', BILL: 'bill', DEBIT_NOTE: 'debit_note' };
const LABEL = { PO: 'Purchase order', BILL: 'Bill', DEBIT_NOTE: 'Debit note' };
export const EFFECTIVE_STATUS = `CASE WHEN d.doc_type='BILL' AND d.status IN ('POSTED','PARTIALLY_PAID') AND d.due_date < CURRENT_DATE THEN 'OVERDUE' ELSE d.status END`;

export async function getPurchaseDoc(db, companyId, id) {
  const { rows: [d] } = await db.query(
    `SELECT d.*, ${EFFECTIVE_STATUS} AS effective_status, (d.total - d.amount_paid - d.amount_credited)::numeric(18,2) AS balance_due,
            s.name AS supplier_name, s.email AS supplier_email, s.address AS supplier_address, s.tpin AS supplier_tpin, s.phone AS supplier_phone,
            r.number AS related_number, je.number AS journal_number, u.name AS created_by_name
       FROM purchase_documents d JOIN suppliers s ON s.id=d.supplier_id LEFT JOIN purchase_documents r ON r.id=d.related_document_id
       LEFT JOIN journal_entries je ON je.id=d.journal_entry_id LEFT JOIN users u ON u.id=d.created_by
      WHERE d.company_id=$1 AND d.id=$2`, [companyId, id]);
  if (!d) throw notFound('Purchase document');
  const { rows: lines } = await db.query(
    `SELECT l.*, a.code AS account_code, a.name AS account_name, t.code AS tax_code, t.rate AS tax_rate
       FROM purchase_document_lines l JOIN accounts a ON a.id=l.account_id LEFT JOIN tax_rates t ON t.id=l.tax_rate_id WHERE l.document_id=$1 ORDER BY l.line_no`, [id]);
  const { rows: payments } = await db.query(
    `SELECT p.id, p.number, p.payment_date, p.method, pa.amount, p.status FROM payment_allocations pa JOIN payments p ON p.id=pa.payment_id WHERE pa.purchase_document_id=$1`, [id]);
  const { rows: docs } = await db.query(`SELECT id, original_name, mime_type FROM documents WHERE company_id=$1 AND ((linked_type='purchase_document' AND linked_id=$2) OR id=$3)`, [companyId, id, d.document_id || 0]);
  return { ...d, lines, payments, documents: docs };
}

async function assertSupplier(db, companyId, id, label = 'Bill') {
  if (!id) throw badRequest(`${label} cannot be saved because the supplier is missing.`);
  const { rows: [s] } = await db.query('SELECT * FROM suppliers WHERE company_id=$1 AND id=$2', [companyId, id]);
  if (!s) throw badRequest('Supplier not found.');
  if (!s.is_active) throw badRequest(`Supplier ${s.name} is inactive.`);
  return s;
}

async function writeLines(db, docId, lines) {
  await db.query('DELETE FROM purchase_document_lines WHERE document_id=$1', [docId]);
  for (const l of lines) {
    await db.query(
      `INSERT INTO purchase_document_lines (document_id, line_no, item_id, description, quantity, unit_price, discount_pct, account_id, tax_rate_id, line_subtotal, line_tax, line_total)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [docId, l.line_no, l.item_id || null, String(l.description).trim(), l.quantity, l.unit_price, l.discount_pct, l.account_id, l.tax_rate_id, l.line_subtotal, l.line_tax, l.line_total]);
  }
}

/** Possible duplicate: same supplier + same supplier invoice reference, or same supplier + total within a few days. */
export async function findDuplicateBills(db, companyId, { supplier_id, supplier_reference, total, doc_date, excludeId }) {
  const { rows } = await db.query(
    `SELECT id, number, supplier_reference, doc_date, total, status FROM purchase_documents
      WHERE company_id=$1 AND supplier_id=$2 AND doc_type='BILL' AND status <> 'CANCELLED' AND id <> COALESCE($6, 0)
        AND ((NULLIF($3,'') IS NOT NULL AND lower(supplier_reference) = lower($3))
          OR (total = $4::numeric AND doc_date BETWEEN $5::date - 3 AND $5::date + 3))`,
    [companyId, supplier_id, supplier_reference || '', total, doc_date, excludeId || null]);
  return rows;
}

export async function createPurchaseDoc(db, ctx, input) {
  const type = input.doc_type;
  if (!SEQ[type]) throw badRequest('Unknown document type.');
  const supplier = await assertSupplier(db, ctx.companyId, input.supplier_id, LABEL[type]);
  const date = input.doc_date;
  if (!date) throw badRequest('Document date is required.');
  const calc = await computeDocumentLines(db, ctx.companyId, input.lines, date, 'PURCHASES');
  if (type === 'BILL' && !input.allow_duplicate) {
    const dups = await findDuplicateBills(db, ctx.companyId, { supplier_id: supplier.id, supplier_reference: input.supplier_reference, total: fromCents(calc.total), doc_date: date });
    if (dups.length) throw new AppError(409, `Possible duplicate supplier bill: ${dups.map((d) => d.number).join(', ')} has the same supplier reference or amount. Review it, or confirm to save anyway.`, { code: 'POSSIBLE_DUPLICATE', details: { duplicates: dups } });
  }
  let due = input.due_date || null;
  if (type === 'BILL' && !due) {
    const d = new Date(`${date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + Number(supplier.payment_terms_days ?? 30));
    due = d.toISOString().slice(0, 10);
  }
  const number = await nextNumber(db, ctx.companyId, SEQ[type]);
  const { rows: [doc] } = await db.query(
    `INSERT INTO purchase_documents (company_id, doc_type, number, supplier_id, supplier_reference, doc_date, due_date, notes, status, subtotal, tax_total, total,
        related_document_id, document_id, branch_id, department_id, ai_generated, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'DRAFT',$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING id`,
    [ctx.companyId, type, number, supplier.id, input.supplier_reference || null, date, due, input.notes || null,
     fromCents(calc.subtotal), fromCents(calc.taxTotal), fromCents(calc.total), input.related_document_id || null, input.document_id || null,
     input.branch_id || null, input.department_id || null, !!input.ai_generated, ctx.user?.id || null]);
  await writeLines(db, doc.id, calc.lines);
  if (input.document_id) await db.query(`UPDATE documents SET linked_type='purchase_document', linked_id=$2 WHERE id=$1 AND company_id=$3`, [input.document_id, doc.id, ctx.companyId]);
  await audit(ctx, input.ai_generated ? 'ai.draft_created' : `${type.toLowerCase()}.created`, { entityType: 'purchase_document', entityId: doc.id, newValue: { number, supplier: supplier.name, total: fromCents(calc.total) } }, db);
  return getPurchaseDoc(db, ctx.companyId, doc.id);
}

export async function updatePurchaseDoc(db, ctx, id, input) {
  const d = await getPurchaseDoc(db, ctx.companyId, id);
  if (!['DRAFT', 'PENDING_APPROVAL', ...(d.doc_type === 'PO' ? ['OPEN'] : [])].includes(d.status)) throw conflict(`This ${LABEL[d.doc_type].toLowerCase()} is ${d.status.toLowerCase()} and can no longer be edited.`);
  const supplier = await assertSupplier(db, ctx.companyId, input.supplier_id || d.supplier_id);
  const date = input.doc_date || d.doc_date;
  const calc = await computeDocumentLines(db, ctx.companyId, input.lines || d.lines, date, 'PURCHASES');
  await db.query(
    `UPDATE purchase_documents SET supplier_id=$2, supplier_reference=$3, doc_date=$4, due_date=$5, notes=$6, subtotal=$7, tax_total=$8, total=$9,
       branch_id=$10, department_id=$11, status='DRAFT', updated_at=now() WHERE id=$1`,
    [id, supplier.id, input.supplier_reference ?? d.supplier_reference, date, input.due_date ?? d.due_date, input.notes ?? d.notes,
     fromCents(calc.subtotal), fromCents(calc.taxTotal), fromCents(calc.total), input.branch_id ?? d.branch_id, input.department_id ?? d.department_id]);
  await writeLines(db, id, calc.lines);
  const after = await getPurchaseDoc(db, ctx.companyId, id);
  await audit(ctx, `${d.doc_type.toLowerCase()}.modified`, { entityType: 'purchase_document', entityId: id, ...diff({ total: d.total, doc_date: d.doc_date }, { total: after.total, doc_date: after.doc_date }) }, db);
  return after;
}

export async function postPurchaseDoc(db, ctx, id) {
  const d = await getPurchaseDoc(db, ctx.companyId, id);
  if (!['BILL', 'DEBIT_NOTE'].includes(d.doc_type)) throw badRequest('Only bills and debit notes are posted to the ledger.');
  if (!['DRAFT', 'PENDING_APPROVAL'].includes(d.status)) throw conflict('This document has already been posted.');
  requirePerm(ctx, 'approve_purchase');
  checkLimit(ctx, toCents(d.total), 'bill');
  if (d.ai_generated && d.created_by === ctx.user?.id && ctx.settings?.accounting?.segregation_of_duties && !ctx.isSuperAdmin && !ctx.permissions?.has('approve_transactions')) {
    throw conflict('AI-prepared bills must be approved by a user with the approve-transactions permission.');
  }
  await assertPeriodOpen(db, ctx.companyId, d.doc_date);
  const ap = await getSystemAccount(db, ctx.companyId, 'AP');
  const sign = d.doc_type === 'BILL' ? 1 : -1;
  const L = (account_id, amtC, isDebit, extra = {}) => ({ account_id, debit: (isDebit === (sign > 0)) ? fromCents(amtC) : 0, credit: (isDebit === (sign > 0)) ? 0 : fromCents(amtC), ...extra });
  const exp = new Map(), tax = new Map();
  for (const l of d.lines) {
    exp.set(l.account_id, (exp.get(l.account_id) || 0n) + toCents(l.line_subtotal));
    if (toCents(l.line_tax) > 0n) {
      const { rows: [t] } = await db.query('SELECT purchase_account_id FROM tax_rates WHERE id=$1', [l.tax_rate_id]);
      if (!t?.purchase_account_id) throw badRequest(`Tax rate ${l.tax_code} has no input tax account configured.`);
      const k = `${t.purchase_account_id}:${l.tax_rate_id}`;
      tax.set(k, (tax.get(k) || 0n) + toCents(l.line_tax));
    }
  }
  const lines = [];
  for (const [acc, amt] of exp) if (amt > 0n) lines.push(L(acc, amt, true, { supplier_id: d.supplier_id }));
  for (const [k, amt] of tax) { const [acc, rate] = k.split(':'); lines.push(L(Number(acc), amt, true, { tax_rate_id: Number(rate), description: 'Input VAT' })); }
  lines.push(L(ap.id, toCents(d.total), false, { supplier_id: d.supplier_id, description: `${d.number} ${d.supplier_name}` }));
  const je = await createJournal(db, ctx, {
    date: d.doc_date, reference: d.supplier_reference || d.number, description: `${LABEL[d.doc_type]} ${d.number} — ${d.supplier_name}`,
    source_type: d.doc_type, source_id: d.id, status: 'POSTED', lines, branch_id: d.branch_id, department_id: d.department_id, approved: true,
  });
  await db.query(`UPDATE purchase_documents SET status='POSTED', journal_entry_id=$2, approved_by=$3, posted_at=now(), updated_at=now() WHERE id=$1`, [id, je.id, ctx.user?.id || null]);
  if (d.doc_type === 'DEBIT_NOTE' && d.related_document_id) {
    try { await applyDebitNote(db, ctx, d.id, d.related_document_id); } catch (e) {
      if (!(e instanceof AppError)) throw e;
      await db.query('UPDATE purchase_documents SET related_document_id=NULL WHERE id=$1', [d.id]);
    }
  }
  await audit(ctx, d.ai_generated ? 'ai.draft_approved_and_posted' : `${d.doc_type.toLowerCase()}.approved_and_posted`, { entityType: 'purchase_document', entityId: id, oldValue: { status: d.status }, newValue: { status: 'POSTED', journal: je.number } }, db);
  return getPurchaseDoc(db, ctx.companyId, id);
}

export async function refreshBill(db, billId) {
  const { rows: [r] } = await db.query(
    `SELECT d.total, d.status,
       COALESCE((SELECT SUM(pa.amount) FROM payment_allocations pa JOIN payments p ON p.id=pa.payment_id WHERE pa.purchase_document_id=d.id AND p.status='POSTED'),0) AS paid,
       COALESCE((SELECT SUM(dn.total) FROM purchase_documents dn WHERE dn.related_document_id=d.id AND dn.doc_type='DEBIT_NOTE' AND dn.status='APPLIED'),0) AS credited
     FROM purchase_documents d WHERE d.id=$1 FOR UPDATE`, [billId]);
  if (!r || ['DRAFT', 'CANCELLED', 'PENDING_APPROVAL'].includes(r.status)) return;
  const total = toCents(r.total), paid = toCents(r.paid);
  let credited = toCents(r.credited);
  if (credited > total - paid) credited = total - paid < 0n ? 0n : total - paid;
  const out = total - paid - credited;
  const status = out <= 0n ? 'PAID' : paid + credited > 0n ? 'PARTIALLY_PAID' : 'POSTED';
  await db.query(`UPDATE purchase_documents SET amount_paid=$2, amount_credited=$3, status=$4, updated_at=now() WHERE id=$1`, [billId, fromCents(paid), fromCents(credited), status]);
}

export async function applyDebitNote(db, ctx, debitNoteId, billId) {
  const { rows: [bill] } = await db.query(`SELECT * FROM purchase_documents WHERE id=$1 AND company_id=$2 AND doc_type='BILL' FOR UPDATE`, [billId, ctx.companyId]);
  const { rows: [dn] } = await db.query(`SELECT * FROM purchase_documents WHERE id=$1 AND company_id=$2 AND doc_type='DEBIT_NOTE' FOR UPDATE`, [debitNoteId, ctx.companyId]);
  if (!bill || !dn) throw notFound('Bill or debit note');
  if (bill.supplier_id !== dn.supplier_id) throw badRequest('The debit note and bill belong to different suppliers.');
  if (dn.status !== 'POSTED') throw conflict(`Debit note ${dn.number} must be posted and not yet applied.`);
  if (!['POSTED', 'PARTIALLY_PAID', 'OVERDUE'].includes(bill.status)) throw conflict(`Bill ${bill.number} is ${bill.status.toLowerCase()} and cannot take a credit.`);
  const outstanding = toCents(bill.total) - toCents(bill.amount_paid) - toCents(bill.amount_credited);
  if (toCents(dn.total) > outstanding) throw badRequest(`Debit note ${dn.number} is more than the bill balance of K${fromCents(outstanding)}.`);
  await db.query(`UPDATE purchase_documents SET related_document_id=$2, status='APPLIED', updated_at=now() WHERE id=$1`, [debitNoteId, billId]);
  await refreshBill(db, billId);
  await audit(ctx, 'debit_note.applied', { entityType: 'purchase_document', entityId: debitNoteId, newValue: { bill: bill.number, amount: dn.total } }, db);
}

export async function cancelPurchaseDoc(db, ctx, id, { reason } = {}) {
  const d = await getPurchaseDoc(db, ctx.companyId, id);
  if (d.status === 'CANCELLED') throw conflict('Already cancelled.');
  if (d.payments.some((p) => p.status === 'POSTED')) throw conflict('This bill has payments allocated. Void the payments first.');
  if (d.journal_entry_id && !['DRAFT', 'PENDING_APPROVAL'].includes(d.status)) {
    await reverseJournal(db, ctx, d.journal_entry_id, { reason: reason || `Cancelled ${d.number}`, fromSource: true });
  }
  await db.query(`UPDATE purchase_documents SET status='CANCELLED', cancelled_at=now(), updated_at=now() WHERE id=$1`, [id]);
  if (d.doc_type === 'DEBIT_NOTE' && d.related_document_id) await refreshBill(db, d.related_document_id);
  await audit(ctx, `${d.doc_type.toLowerCase()}.cancelled`, { entityType: 'purchase_document', entityId: id, oldValue: { status: d.status }, newValue: { status: 'CANCELLED', reason } }, db);
  return getPurchaseDoc(db, ctx.companyId, id);
}

export async function convertPurchaseDoc(db, ctx, id, toType) {
  const d = await getPurchaseDoc(db, ctx.companyId, id);
  const allowed = { PO: ['BILL'], BILL: ['DEBIT_NOTE'] };
  if (!allowed[d.doc_type]?.includes(toType)) throw badRequest('This conversion is not allowed.');
  if (toType === 'DEBIT_NOTE' && !['POSTED', 'PARTIALLY_PAID', 'PAID'].includes(d.status)) throw conflict('Post the bill before recording a debit note against it.');
  const created = await createPurchaseDoc(db, ctx, {
    doc_type: toType, supplier_id: d.supplier_id, doc_date: new Date().toISOString().slice(0, 10), supplier_reference: toType === 'BILL' ? null : d.supplier_reference,
    notes: d.notes, related_document_id: d.id, branch_id: d.branch_id, department_id: d.department_id, allow_duplicate: true,
    lines: d.lines.map((l) => ({ item_id: l.item_id, description: l.description, quantity: l.quantity, unit_price: l.unit_price, discount_pct: l.discount_pct, account_id: l.account_id, tax_rate_id: l.tax_rate_id })),
  });
  if (d.doc_type === 'PO') await db.query(`UPDATE purchase_documents SET status='BILLED' WHERE id=$1`, [id]);
  await audit(ctx, `${d.doc_type.toLowerCase()}.converted`, { entityType: 'purchase_document', entityId: id, newValue: { to: toType, number: created.number } }, db);
  return created;
}

export async function setPoStatus(db, ctx, id, status) {
  const d = await getPurchaseDoc(db, ctx.companyId, id);
  if (d.doc_type !== 'PO') throw badRequest('Only purchase orders use this action.');
  if (!['OPEN', 'CANCELLED'].includes(status)) throw badRequest('Invalid status.');
  await db.query(`UPDATE purchase_documents SET status=$2 WHERE id=$1`, [id, status]);
  await audit(ctx, 'po.status_changed', { entityType: 'purchase_document', entityId: id, oldValue: { status: d.status }, newValue: { status } }, db);
  return getPurchaseDoc(db, ctx.companyId, id);
}

export async function supplierBalance(db, companyId, supplierId, asOf) {
  const ap = await getSystemAccount(db, companyId, 'AP');
  const p = [companyId, ap.id, supplierId];
  const { rows: [r] } = await db.query(
    `SELECT COALESCE(SUM(credit-debit),0)::numeric(18,2) AS balance FROM ledger WHERE company_id=$1 AND account_id=$2 AND supplier_id=$3 ${asOf ? 'AND entry_date <= $4' : ''}`,
    asOf ? [...p, asOf] : p);
  return r.balance;
}
