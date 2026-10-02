// Customers, suppliers, sales, purchases, payments and expenses.
import { Router } from 'express';
import { pool, tx } from '../db/pool.js';
import { asyncH } from '../middleware/errors.js';
import { need } from '../middleware/auth.js';
import { audit, diff } from '../lib/audit.js';
import { badRequest, notFound, forbidden } from '../lib/errors.js';
import { nextNumber } from '../lib/numbering.js';
import { toCents, fromCents } from '../lib/money.js';
import { can, requirePerm } from '../services/ledger.js';
import * as S from '../services/sales.js';
import * as P from '../services/purchases.js';
import * as Pay from '../services/payments.js';
import * as E from '../services/expenses.js';
import { salesDocumentPdf, purchaseDocumentPdf, receiptPdf } from '../services/documents-pdf.js';
import { sendEmail } from '../services/email.js';
import { notify } from '../services/notifications.js';
import { z, str, optStr, money, date, optDate, pid, paging } from './_util.js';

const r = Router();
const optFk = z.union([z.coerce.number().int().positive(), z.null(), z.literal('')]).optional().transform((v) => v || null);

// ───────────── Customers & suppliers ─────────────
for (const kind of ['customers', 'suppliers']) {
  const isC = kind === 'customers';
  const viewPerm = isC ? 'view_sales' : 'view_purchases';
  const managePerm = isC ? 'manage_customers' : 'manage_suppliers';
  const schema = z.object({ code: optStr(30), name: str(200).min(1), contact_person: optStr(120), email: z.union([z.string().trim().email().max(200), z.literal(''), z.null()]).optional(),
    phone: optStr(40), address: optStr(500), tpin: optStr(40), payment_terms_days: z.coerce.number().int().min(0).max(365).default(30), notes: optStr(2000),
    ...(isC ? { credit_limit: z.union([money, z.literal(''), z.null()]).optional() } : { bank_details: optStr(500), default_account_id: optFk }) , is_active: z.boolean().default(true) });

  r.get(`/${kind}`, need(viewPerm, 'create_payment', 'create_expense'), asyncH(async (req, res) => {
    const ctrl = isC ? 'AR' : 'AP';
    const sign = isC ? 'l.debit - l.credit' : 'l.credit - l.debit';
    const p = [req.ctx.companyId, ctrl]; let w = '';
    if (req.query.q) { p.push(`%${req.query.q}%`); w += ` AND (x.name ILIKE $${p.length} OR x.code ILIKE $${p.length} OR x.email ILIKE $${p.length})`; }
    if (req.query.active !== 'all') w += ' AND x.is_active';
    const { rows } = await pool.query(
      `SELECT x.*, COALESCE((SELECT SUM(${sign}) FROM ledger l JOIN accounts a ON a.id=l.account_id AND a.system_key=$2 WHERE l.${kind.slice(0, -1)}_id=x.id),0)::numeric(18,2) AS balance
         FROM ${kind} x WHERE x.company_id=$1 ${w} ORDER BY x.name`, p);
    res.json(rows);
  }));

  r.get(`/${kind}/:id`, need(viewPerm), asyncH(async (req, res) => {
    const id = pid(req);
    const { rows: [x] } = await pool.query(`SELECT * FROM ${kind} WHERE id=$1 AND company_id=$2`, [id, req.ctx.companyId]);
    if (!x) throw notFound(isC ? 'Customer' : 'Supplier');
    const balance = isC ? await S.customerBalance(pool, req.ctx.companyId, id) : await P.supplierBalance(pool, req.ctx.companyId, id);
    const t = isC ? 'sales_documents' : 'purchase_documents';
    const docType = isC ? 'INVOICE' : 'BILL';
    const status = isC ? S.EFFECTIVE_STATUS : P.EFFECTIVE_STATUS;
    const { rows: docs } = await pool.query(`SELECT d.id, d.doc_type, d.number, d.doc_date, d.due_date, d.total, (d.total-d.amount_paid-d.amount_credited)::numeric(18,2) AS balance_due, ${status} AS status
        FROM ${t} d WHERE d.company_id=$1 AND d.${kind.slice(0, -1)}_id=$2 AND d.status <> 'CANCELLED' ORDER BY d.doc_date DESC LIMIT 100`, [req.ctx.companyId, id]);
    const { rows: pays } = await pool.query(`SELECT id, number, payment_date, amount, method, status FROM payments WHERE company_id=$1 AND ${kind.slice(0, -1)}_id=$2 ORDER BY payment_date DESC LIMIT 100`, [req.ctx.companyId, id]);
    const { rows: [stats] } = await pool.query(`SELECT COALESCE(SUM(total) FILTER (WHERE doc_type='${docType}' AND status NOT IN ('DRAFT','CANCELLED','PENDING_APPROVAL')),0)::numeric(18,2) AS total_billed,
        COALESCE(SUM(amount_paid) FILTER (WHERE doc_type='${docType}'),0)::numeric(18,2) AS total_paid,
        COALESCE(SUM(total-amount_paid-amount_credited) FILTER (WHERE doc_type='${docType}' AND status NOT IN ('DRAFT','CANCELLED','PENDING_APPROVAL','PAID') AND due_date < CURRENT_DATE),0)::numeric(18,2) AS overdue,
        AVG(CASE WHEN status='PAID' THEN (updated_at::date - doc_date) END)::int AS avg_days_to_pay
        FROM ${t} WHERE company_id=$1 AND ${kind.slice(0, -1)}_id=$2`, [req.ctx.companyId, id]);
    res.json({ ...x, balance, documents: docs, payments: pays, stats });
  }));

  r.post(`/${kind}`, need(managePerm), asyncH(async (req, res) => {
    const b = schema.parse(req.body);
    const row = await tx(async (db) => {
      const code = b.code || (await nextNumber(db, req.ctx.companyId, isC ? 'customer' : 'supplier'));
      const cols = ['company_id', 'code', 'name', 'contact_person', 'email', 'phone', 'address', 'tpin', 'payment_terms_days', 'notes', 'is_active', ...(isC ? ['credit_limit'] : ['bank_details', 'default_account_id'])];
      const vals = [req.ctx.companyId, code, b.name, b.contact_person || null, b.email || null, b.phone || null, b.address || null, b.tpin || null, b.payment_terms_days, b.notes || null, b.is_active,
        ...(isC ? [b.credit_limit || null] : [b.bank_details || null, b.default_account_id || null])];
      const { rows: [x] } = await db.query(`INSERT INTO ${kind} (${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')}) RETURNING *`, vals);
      await audit(req.ctx, `${kind.slice(0, -1)}.created`, { entityType: kind.slice(0, -1), entityId: x.id, newValue: { code: x.code, name: x.name } }, db);
      return x;
    });
    res.status(201).json(row);
  }));

  r.put(`/${kind}/:id`, need(managePerm), asyncH(async (req, res) => {
    const id = pid(req);
    const b = schema.parse(req.body);
    const { rows: [before] } = await pool.query(`SELECT * FROM ${kind} WHERE id=$1 AND company_id=$2`, [id, req.ctx.companyId]);
    if (!before) throw notFound();
    const sets = ['code', 'name', 'contact_person', 'email', 'phone', 'address', 'tpin', 'payment_terms_days', 'notes', 'is_active', ...(isC ? ['credit_limit'] : ['bank_details', 'default_account_id'])];
    const vals = sets.map((k) => (k === 'code' ? b.code || before.code : b[k] === '' ? null : b[k] ?? null));
    const { rows: [after] } = await pool.query(`UPDATE ${kind} SET ${sets.map((k, i) => `${k}=$${i + 3}`).join(', ')} WHERE id=$1 AND company_id=$2 RETURNING *`, [id, req.ctx.companyId, ...vals]);
    await audit(req.ctx, `${kind.slice(0, -1)}.updated`, { entityType: kind.slice(0, -1), entityId: id, ...diff(before, after) });
    res.json(after);
  }));
}

// ───────────── Sales documents ─────────────
const docLine = z.object({ item_id: optFk, description: str(500).min(1), quantity: z.union([z.string(), z.number()]).transform(String), unit_price: money, discount_pct: z.union([z.string(), z.number()]).transform(String).default('0'),
  account_id: z.coerce.number().int().positive(), tax_rate_id: optFk });
const salesSchema = z.object({ doc_type: z.enum(['QUOTE', 'ORDER', 'INVOICE', 'CREDIT_NOTE']), customer_id: z.coerce.number().int().positive({ message: 'Choose a customer' }), doc_date: date, due_date: optDate,
  reference: optStr(100), notes: optStr(2000), terms: optStr(2000), related_document_id: optFk, branch_id: optFk, department_id: optFk, lines: z.array(docLine).min(1, 'Add at least one line'), action: z.enum(['draft', 'post']).default('draft') });
const createPerm = { QUOTE: 'create_quote', ORDER: 'create_quote', INVOICE: 'create_invoice', CREDIT_NOTE: 'create_credit_note' };

r.get('/sales/documents', need('view_sales'), asyncH(async (req, res) => {
  const { limit, offset } = paging(req.query);
  const p = [req.ctx.companyId]; let w = '';
  if (req.query.type) { p.push(String(req.query.type).split(',')); w += ` AND d.doc_type = ANY($${p.length})`; }
  if (req.query.status) { p.push(String(req.query.status).split(',')); w += ` AND (${S.EFFECTIVE_STATUS}) = ANY($${p.length})`; }
  if (req.query.customer_id) { p.push(Number(req.query.customer_id)); w += ` AND d.customer_id=$${p.length}`; }
  if (req.query.from) { p.push(req.query.from); w += ` AND d.doc_date >= $${p.length}`; }
  if (req.query.to) { p.push(req.query.to); w += ` AND d.doc_date <= $${p.length}`; }
  if (req.query.q) { p.push(`%${req.query.q}%`); w += ` AND (d.number ILIKE $${p.length} OR c.name ILIKE $${p.length} OR d.reference ILIKE $${p.length})`; }
  if (req.query.branch_id) { p.push(Number(req.query.branch_id)); w += ` AND d.branch_id=$${p.length}`; }
  const base = `FROM sales_documents d JOIN customers c ON c.id=d.customer_id WHERE d.company_id=$1 ${w}`;
  const { rows } = await pool.query(`SELECT d.id, d.doc_type, d.number, d.doc_date, d.due_date, d.reference, d.total, d.amount_paid, (d.total-d.amount_paid-d.amount_credited)::numeric(18,2) AS balance_due,
      ${S.EFFECTIVE_STATUS} AS status, c.name AS customer_name, d.customer_id ${base} ORDER BY d.doc_date DESC, d.id DESC LIMIT ${limit} OFFSET ${offset}`, p);
  const { rows: [t] } = await pool.query(`SELECT COUNT(*)::int AS n, COALESCE(SUM(d.total),0)::numeric(18,2) AS total, COALESCE(SUM(d.total-d.amount_paid-d.amount_credited),0)::numeric(18,2) AS balance ${base}`, p);
  res.json({ items: rows, total: t.n, sum_total: t.total, sum_balance: t.balance });
}));

r.get('/sales/documents/:id', need('view_sales'), asyncH(async (req, res) => res.json(await S.getSalesDoc(pool, req.ctx.companyId, pid(req)))));

r.post('/sales/documents', asyncH(async (req, res) => {
  const b = salesSchema.parse(req.body);
  requirePerm(req.ctx, createPerm[b.doc_type]);
  const out = await tx(async (db) => {
    const d = await S.createSalesDoc(db, req.ctx, b);
    if (b.action === 'post' && ['INVOICE', 'CREDIT_NOTE'].includes(b.doc_type)) return S.postSalesDoc(db, req.ctx, d.id);
    return d;
  });
  res.status(201).json(out);
}));

r.put('/sales/documents/:id', asyncH(async (req, res) => {
  const b = salesSchema.parse(req.body);
  requirePerm(req.ctx, b.doc_type === 'INVOICE' ? 'edit_invoice' : createPerm[b.doc_type]);
  const out = await tx(async (db) => {
    const d = await S.updateSalesDoc(db, req.ctx, pid(req), b);
    if (b.action === 'post' && ['INVOICE', 'CREDIT_NOTE'].includes(d.doc_type)) return S.postSalesDoc(db, req.ctx, d.id);
    return d;
  });
  res.json(out);
}));

r.post('/sales/documents/:id/post', need('approve_invoice', 'create_credit_note'), asyncH(async (req, res) => res.json(await tx((db) => S.postSalesDoc(db, req.ctx, pid(req))))));
r.post('/sales/documents/:id/cancel', need('delete_invoice', 'create_quote', 'create_credit_note'), asyncH(async (req, res) => res.json(await tx((db) => S.cancelSalesDoc(db, req.ctx, pid(req), { reason: req.body?.reason })))));
r.post('/sales/documents/:id/convert', asyncH(async (req, res) => {
  const { to } = z.object({ to: z.enum(['ORDER', 'INVOICE', 'CREDIT_NOTE']) }).parse(req.body);
  requirePerm(req.ctx, createPerm[to]);
  res.status(201).json(await tx((db) => S.convertSalesDoc(db, req.ctx, pid(req), to)));
}));
r.post('/sales/documents/:id/apply', need('create_credit_note'), asyncH(async (req, res) => {
  const { invoice_id } = z.object({ invoice_id: z.coerce.number().int().positive() }).parse(req.body || {});
  await tx((db) => S.applyCreditNote(db, req.ctx, pid(req), invoice_id));
  res.json(await S.getSalesDoc(pool, req.ctx.companyId, pid(req)));
}));
r.post('/sales/documents/:id/status', need('create_quote'), asyncH(async (req, res) => res.json(await tx((db) => S.setQuoteStatus(db, req.ctx, pid(req), String(req.body?.status))))));
r.delete('/sales/documents/:id', need('create_quote', 'create_invoice', 'create_credit_note'), asyncH(async (req, res) => { await tx((db) => S.deleteDraftSalesDoc(db, req.ctx, pid(req))); res.json({ ok: true }); }));
r.get('/sales/documents/:id/pdf', need('view_sales'), asyncH(async (req, res) => {
  const d = await S.getSalesDoc(pool, req.ctx.companyId, pid(req));
  const pdf = await salesDocumentPdf(pool, req.ctx.companyId, d);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `${req.query.download ? 'attachment' : 'inline'}; filename="${d.number}.pdf"`);
  res.send(pdf);
}));
r.post('/sales/documents/:id/email', need('send_documents'), asyncH(async (req, res) => {
  const d = await S.getSalesDoc(pool, req.ctx.companyId, pid(req));
  if (d.status === 'DRAFT' && d.doc_type === 'INVOICE') throw badRequest('Post the invoice before sending it.');
  const to = req.body?.to || d.customer_email;
  if (!to) throw badRequest('This customer has no email address. Add one or enter a recipient.');
  const pdf = await salesDocumentPdf(pool, req.ctx.companyId, d);
  const label = { INVOICE: 'Invoice', QUOTE: 'Quotation', ORDER: 'Sales order', CREDIT_NOTE: 'Credit note' }[d.doc_type];
  await sendEmail(req.ctx, { to, subject: req.body?.subject || `${label} ${d.number} from ${req.ctx.company.name}`,
    text: req.body?.message || `Dear ${d.customer_name},\n\nPlease find attached ${label.toLowerCase()} ${d.number} for K${d.total}.\n\nKind regards,\n${req.ctx.company.name}`,
    attachments: [{ filename: `${d.number}.pdf`, content: pdf }], relatedType: 'sales_document', relatedId: d.id });
  await S.markSent(pool, req.ctx, d.id);
  await audit(req.ctx, `${d.doc_type.toLowerCase()}.emailed`, { entityType: 'sales_document', entityId: d.id, newValue: { to } });
  res.json({ ok: true });
}));

// ───────────── Purchase documents ─────────────
const purchaseSchema = z.object({ doc_type: z.enum(['PO', 'BILL', 'DEBIT_NOTE']), supplier_id: z.coerce.number().int().positive({ message: 'Choose a supplier' }), supplier_reference: optStr(100), doc_date: date, due_date: optDate,
  notes: optStr(2000), related_document_id: optFk, document_id: optFk, branch_id: optFk, department_id: optFk, lines: z.array(docLine).min(1, 'Add at least one line'),
  allow_duplicate: z.boolean().optional(), action: z.enum(['draft', 'post']).default('draft') });

r.get('/purchases/documents', need('view_purchases'), asyncH(async (req, res) => {
  const { limit, offset } = paging(req.query);
  const p = [req.ctx.companyId]; let w = '';
  if (req.query.type) { p.push(String(req.query.type).split(',')); w += ` AND d.doc_type = ANY($${p.length})`; }
  if (req.query.status) { p.push(String(req.query.status).split(',')); w += ` AND (${P.EFFECTIVE_STATUS}) = ANY($${p.length})`; }
  if (req.query.supplier_id) { p.push(Number(req.query.supplier_id)); w += ` AND d.supplier_id=$${p.length}`; }
  if (req.query.from) { p.push(req.query.from); w += ` AND d.doc_date >= $${p.length}`; }
  if (req.query.to) { p.push(req.query.to); w += ` AND d.doc_date <= $${p.length}`; }
  if (req.query.q) { p.push(`%${req.query.q}%`); w += ` AND (d.number ILIKE $${p.length} OR s.name ILIKE $${p.length} OR d.supplier_reference ILIKE $${p.length})`; }
  const base = `FROM purchase_documents d JOIN suppliers s ON s.id=d.supplier_id WHERE d.company_id=$1 ${w}`;
  const { rows } = await pool.query(`SELECT d.id, d.doc_type, d.number, d.supplier_reference, d.doc_date, d.due_date, d.total, d.amount_paid, (d.total-d.amount_paid-d.amount_credited)::numeric(18,2) AS balance_due,
      ${P.EFFECTIVE_STATUS} AS status, d.ai_generated, s.name AS supplier_name, d.supplier_id ${base} ORDER BY d.doc_date DESC, d.id DESC LIMIT ${limit} OFFSET ${offset}`, p);
  const { rows: [t] } = await pool.query(`SELECT COUNT(*)::int AS n, COALESCE(SUM(d.total),0)::numeric(18,2) AS total, COALESCE(SUM(d.total-d.amount_paid-d.amount_credited),0)::numeric(18,2) AS balance ${base}`, p);
  res.json({ items: rows, total: t.n, sum_total: t.total, sum_balance: t.balance });
}));
r.get('/purchases/documents/:id', need('view_purchases'), asyncH(async (req, res) => res.json(await P.getPurchaseDoc(pool, req.ctx.companyId, pid(req)))));
r.post('/purchases/documents', need('create_purchase'), asyncH(async (req, res) => {
  const b = purchaseSchema.parse(req.body);
  const out = await tx(async (db) => {
    const d = await P.createPurchaseDoc(db, req.ctx, b);
    if (b.action === 'post' && ['BILL', 'DEBIT_NOTE'].includes(b.doc_type)) {
      if (!can(req.ctx, 'approve_purchase')) { await db.query(`UPDATE purchase_documents SET status='PENDING_APPROVAL' WHERE id=$1`, [d.id]); return { ...(await P.getPurchaseDoc(db, req.ctx.companyId, d.id)), _pendingApproval: true }; }
      return P.postPurchaseDoc(db, req.ctx, d.id);
    }
    if (b.doc_type === 'PO') await db.query(`UPDATE purchase_documents SET status='OPEN' WHERE id=$1 AND $2`, [d.id, b.action === 'post']);
    return P.getPurchaseDoc(db, req.ctx.companyId, d.id);
  });
  res.status(201).json(out);
}));
r.put('/purchases/documents/:id', need('edit_purchase'), asyncH(async (req, res) => {
  const b = purchaseSchema.parse(req.body);
  const out = await tx(async (db) => {
    const d = await P.updatePurchaseDoc(db, req.ctx, pid(req), b);
    if (b.action === 'post' && ['BILL', 'DEBIT_NOTE'].includes(d.doc_type)) {
      if (!can(req.ctx, 'approve_purchase')) { await db.query(`UPDATE purchase_documents SET status='PENDING_APPROVAL' WHERE id=$1`, [d.id]); return { ...(await P.getPurchaseDoc(db, req.ctx.companyId, d.id)), _pendingApproval: true }; }
      return P.postPurchaseDoc(db, req.ctx, d.id);
    }
    return d;
  });
  res.json(out);
}));
r.post('/purchases/documents/:id/post', need('approve_purchase'), asyncH(async (req, res) => res.json(await tx((db) => P.postPurchaseDoc(db, req.ctx, pid(req))))));
r.post('/purchases/documents/:id/cancel', need('edit_purchase', 'approve_purchase'), asyncH(async (req, res) => res.json(await tx((db) => P.cancelPurchaseDoc(db, req.ctx, pid(req), { reason: req.body?.reason })))));
r.post('/purchases/documents/:id/convert', need('create_purchase'), asyncH(async (req, res) => {
  const { to } = z.object({ to: z.enum(['BILL', 'DEBIT_NOTE']) }).parse(req.body);
  res.status(201).json(await tx((db) => P.convertPurchaseDoc(db, req.ctx, pid(req), to)));
}));
r.post('/purchases/documents/:id/apply', need('approve_purchase', 'edit_purchase'), asyncH(async (req, res) => {
  const { bill_id } = z.object({ bill_id: z.coerce.number().int().positive() }).parse(req.body || {});
  await tx((db) => P.applyDebitNote(db, req.ctx, pid(req), bill_id));
  res.json(await P.getPurchaseDoc(pool, req.ctx.companyId, pid(req)));
}));
r.post('/purchases/documents/:id/status', need('create_purchase'), asyncH(async (req, res) => res.json(await tx((db) => P.setPoStatus(db, req.ctx, pid(req), String(req.body?.status))))));
r.get('/purchases/documents/:id/pdf', need('view_purchases'), asyncH(async (req, res) => {
  const d = await P.getPurchaseDoc(pool, req.ctx.companyId, pid(req));
  const pdf = await purchaseDocumentPdf(pool, req.ctx.companyId, d);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `${req.query.download ? 'attachment' : 'inline'}; filename="${d.number}.pdf"`);
  res.send(pdf);
}));
r.post('/purchases/documents/:id/email', need('send_documents'), asyncH(async (req, res) => {
  const d = await P.getPurchaseDoc(pool, req.ctx.companyId, pid(req));
  const to = req.body?.to || d.supplier_email;
  if (!to) throw badRequest('This supplier has no email address.');
  const pdf = await purchaseDocumentPdf(pool, req.ctx.companyId, d);
  await sendEmail(req.ctx, { to, subject: `Purchase order ${d.number} from ${req.ctx.company.name}`, text: req.body?.message || `Please find attached purchase order ${d.number}.\n\n${req.ctx.company.name}`,
    attachments: [{ filename: `${d.number}.pdf`, content: pdf }], relatedType: 'purchase_document', relatedId: d.id });
  await audit(req.ctx, 'po.emailed', { entityType: 'purchase_document', entityId: d.id, newValue: { to } });
  res.json({ ok: true });
}));

// ───────────── Payments & receipts ─────────────
r.get('/payments', need('view_payments'), asyncH(async (req, res) => {
  const { limit, offset } = paging(req.query);
  const p = [req.ctx.companyId]; let w = '';
  if (req.query.direction) { p.push(req.query.direction); w += ` AND p.direction=$${p.length}`; }
  if (req.query.customer_id) { p.push(Number(req.query.customer_id)); w += ` AND p.customer_id=$${p.length}`; }
  if (req.query.supplier_id) { p.push(Number(req.query.supplier_id)); w += ` AND p.supplier_id=$${p.length}`; }
  if (req.query.from) { p.push(req.query.from); w += ` AND p.payment_date >= $${p.length}`; }
  if (req.query.to) { p.push(req.query.to); w += ` AND p.payment_date <= $${p.length}`; }
  if (req.query.q) { p.push(`%${req.query.q}%`); w += ` AND (p.number ILIKE $${p.length} OR p.reference ILIKE $${p.length} OR c.name ILIKE $${p.length} OR s.name ILIKE $${p.length})`; }
  const base = `FROM payments p LEFT JOIN customers c ON c.id=p.customer_id LEFT JOIN suppliers s ON s.id=p.supplier_id JOIN accounts a ON a.id=p.bank_account_id WHERE p.company_id=$1 ${w}`;
  const { rows } = await pool.query(`SELECT p.id, p.number, p.direction, p.payment_date, p.amount, p.method, p.reference, p.status, COALESCE(c.name, s.name) AS party_name, a.name AS bank_account_name ${base}
      ORDER BY p.payment_date DESC, p.id DESC LIMIT ${limit} OFFSET ${offset}`, p);
  const { rows: [t] } = await pool.query(`SELECT COUNT(*)::int AS n, COALESCE(SUM(p.amount) FILTER (WHERE p.status='POSTED'),0)::numeric(18,2) AS total ${base}`, p);
  res.json({ items: rows, total: t.n, sum_total: t.total });
}));
r.get('/payments/open-documents', need('create_payment'), asyncH(async (req, res) => {
  const dir = req.query.direction === 'OUT' ? 'OUT' : 'IN';
  const partyId = Number(req.query.party_id);
  if (!partyId) return res.json([]);
  const { rows } = dir === 'IN'
    ? await pool.query(`SELECT id, number, doc_date, due_date, total, (total-amount_paid-amount_credited)::numeric(18,2) AS balance_due FROM sales_documents WHERE company_id=$1 AND customer_id=$2 AND doc_type='INVOICE' AND status IN ('SENT','PARTIALLY_PAID') ORDER BY due_date, doc_date`, [req.ctx.companyId, partyId])
    : await pool.query(`SELECT id, number, supplier_reference, doc_date, due_date, total, (total-amount_paid-amount_credited)::numeric(18,2) AS balance_due FROM purchase_documents WHERE company_id=$1 AND supplier_id=$2 AND doc_type='BILL' AND status IN ('POSTED','PARTIALLY_PAID') ORDER BY due_date, doc_date`, [req.ctx.companyId, partyId]);
  res.json(rows);
}));
r.get('/payments/:id', need('view_payments'), asyncH(async (req, res) => res.json(await Pay.getPayment(pool, req.ctx.companyId, pid(req)))));
r.post('/payments', need('create_payment'), asyncH(async (req, res) => {
  const b = z.object({ direction: z.enum(['IN', 'OUT']), payment_date: date, customer_id: optFk, supplier_id: optFk, amount: money, bank_account_id: z.coerce.number().int().positive({ message: 'Choose a bank or cash account' }),
    method: z.enum(['CASH', 'BANK_TRANSFER', 'MOBILE_MONEY', 'CHEQUE', 'CARD', 'OTHER']).optional(), reference: optStr(100), notes: optStr(1000), wht_rate_id: optFk,
    allocations: z.array(z.object({ document_id: z.coerce.number().int().positive(), amount: money })).default([]) }).parse(req.body);
  const out = await tx((db) => Pay.createPayment(db, req.ctx, b));
  if (b.direction === 'IN') await notify(pool, req.ctx.companyId, { kind: 'payment_received', title: `Payment received: K${out.amount}`, body: `${out.customer_name} · ${out.number}`, link: `/payments/${out.id}`, dedupeKey: `pay-${out.id}` });
  res.status(201).json(out);
}));
r.put('/payments/:id', need('edit_payment'), asyncH(async (req, res) => {
  const b = z.object({ reference: optStr(100), notes: optStr(1000), method: z.enum(['CASH', 'BANK_TRANSFER', 'MOBILE_MONEY', 'CHEQUE', 'CARD', 'OTHER']).optional() }).parse(req.body || {});
  res.json(await tx((db) => Pay.editPaymentDetails(db, req.ctx, pid(req), b)));
}));
r.post('/payments/:id/allocate', need('create_payment'), asyncH(async (req, res) => {
  const b = z.object({ allocations: z.array(z.object({ document_id: z.coerce.number().int().positive(), amount: money })).min(1) }).parse(req.body || {});
  res.json(await tx((db) => Pay.allocatePayment(db, req.ctx, pid(req), b.allocations)));
}));
r.post('/payments/:id/void', need('delete_payment'), asyncH(async (req, res) => res.json(await tx((db) => Pay.voidPayment(db, req.ctx, pid(req), { reason: req.body?.reason })))));
r.get('/payments/:id/pdf', need('view_payments'), asyncH(async (req, res) => {
  const p = await Pay.getPayment(pool, req.ctx.companyId, pid(req));
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${p.number}.pdf"`);
  res.send(await receiptPdf(pool, req.ctx.companyId, p));
}));

// ───────────── Expenses ─────────────
const expenseSchema = z.object({ expense_date: date, supplier_id: optFk, payee_name: optStr(200), account_id: z.coerce.number().int().positive({ message: 'Choose an expense category' }),
  amount: money, amount_includes_tax: z.boolean().optional(), tax_rate_id: optFk, payment_account_id: z.coerce.number().int().positive({ message: 'Choose the account paid from' }),
  payment_method: z.enum(['CASH', 'BANK_TRANSFER', 'MOBILE_MONEY', 'CHEQUE', 'CARD', 'OTHER']).default('CASH'), description: optStr(1000), reference: optStr(100),
  branch_id: optFk, department_id: optFk, document_id: optFk, action: z.enum(['draft', 'submit']).default('submit') });

r.get('/expenses', need('view_expenses'), asyncH(async (req, res) => {
  const { limit, offset } = paging(req.query);
  const p = [req.ctx.companyId]; let w = '';
  if (req.query.status) { p.push(String(req.query.status).split(',')); w += ` AND e.status = ANY($${p.length})`; }
  if (req.query.account_id) { p.push(Number(req.query.account_id)); w += ` AND e.account_id=$${p.length}`; }
  if (req.query.from) { p.push(req.query.from); w += ` AND e.expense_date >= $${p.length}`; }
  if (req.query.to) { p.push(req.query.to); w += ` AND e.expense_date <= $${p.length}`; }
  if (req.query.branch_id) { p.push(Number(req.query.branch_id)); w += ` AND e.branch_id=$${p.length}`; }
  if (req.query.department_id) { p.push(Number(req.query.department_id)); w += ` AND e.department_id=$${p.length}`; }
  if (req.query.ai === 'true') w += ' AND e.ai_generated';
  if (req.query.q) { p.push(`%${req.query.q}%`); w += ` AND (e.number ILIKE $${p.length} OR e.description ILIKE $${p.length} OR e.payee_name ILIKE $${p.length} OR s.name ILIKE $${p.length})`; }
  const base = `FROM expenses e JOIN accounts a ON a.id=e.account_id LEFT JOIN suppliers s ON s.id=e.supplier_id WHERE e.company_id=$1 ${w}`;
  const { rows } = await pool.query(`SELECT e.id, e.number, e.expense_date, COALESCE(s.name, e.payee_name) AS payee, a.name AS category, e.total, e.status, e.payment_method, e.description, e.ai_generated,
      (e.document_id IS NOT NULL OR EXISTS (SELECT 1 FROM documents d WHERE d.linked_type='expense' AND d.linked_id=e.id)) AS has_receipt ${base} ORDER BY e.expense_date DESC, e.id DESC LIMIT ${limit} OFFSET ${offset}`, p);
  const { rows: [t] } = await pool.query(`SELECT COUNT(*)::int AS n, COALESCE(SUM(e.total) FILTER (WHERE e.status='POSTED'),0)::numeric(18,2) AS total ${base}`, p);
  res.json({ items: rows, total: t.n, sum_total: t.total });
}));
r.get('/expenses/:id', need('view_expenses'), asyncH(async (req, res) => res.json(await E.getExpense(pool, req.ctx.companyId, pid(req)))));
r.post('/expenses', need('create_expense'), asyncH(async (req, res) => {
  const b = expenseSchema.parse(req.body);
  res.status(201).json(await tx((db) => E.createExpense(db, req.ctx, b, { submit: b.action === 'submit' })));
}));
r.put('/expenses/:id', need('create_expense'), asyncH(async (req, res) => {
  const b = expenseSchema.partial().parse(req.body);
  res.json(await tx(async (db) => {
    const e = await E.updateExpense(db, req.ctx, pid(req), b);
    return b.action === 'submit' ? E.submitExpense(db, req.ctx, e.id) : e;
  }));
}));
r.post('/expenses/:id/submit', need('create_expense'), asyncH(async (req, res) => res.json(await tx((db) => E.submitExpense(db, req.ctx, pid(req))))));
r.post('/expenses/:id/approve', need('approve_expense'), asyncH(async (req, res) => res.json(await tx((db) => E.postExpense(db, req.ctx, pid(req), { approving: true })))));
r.post('/expenses/:id/void', need('create_expense', 'approve_expense'), asyncH(async (req, res) => {
  const e = await E.getExpense(pool, req.ctx.companyId, pid(req));
  if (e.status === 'POSTED' && !can(req.ctx, 'approve_expense')) throw forbidden('Only users who can approve expenses can void a posted expense.');
  res.json(await tx((db) => E.voidExpense(db, req.ctx, e.id, { reason: req.body?.reason })));
}));

// ───────────── Approvals queue ─────────────
r.get('/approvals', need('approve_transactions', 'approve_expense', 'approve_purchase', 'approve_invoice'), asyncH(async (req, res) => {
  const cid = req.ctx.companyId;
  const { rows: journals } = await pool.query(`SELECT e.id, e.number, e.entry_date AS date, e.description, e.total, e.status, e.ai_generated, e.ai_rationale, u.name AS created_by FROM journal_entries e LEFT JOIN users u ON u.id=e.created_by
      WHERE e.company_id=$1 AND (e.status='PENDING_APPROVAL' OR (e.status='DRAFT' AND e.ai_generated)) ORDER BY e.created_at`, [cid]);
  const { rows: expenses } = await pool.query(`SELECT e.id, e.number, e.expense_date AS date, COALESCE(e.description, e.payee_name) AS description, e.total, e.status, e.ai_generated, e.ai_confidence, a.name AS category, u.name AS created_by
      FROM expenses e JOIN accounts a ON a.id=e.account_id LEFT JOIN users u ON u.id=e.created_by WHERE e.company_id=$1 AND (e.status='PENDING_APPROVAL' OR (e.status='DRAFT' AND e.ai_generated)) ORDER BY e.created_at`, [cid]);
  const { rows: bills } = await pool.query(`SELECT d.id, d.number, d.doc_date AS date, s.name AS description, d.total, d.status, d.ai_generated, u.name AS created_by FROM purchase_documents d JOIN suppliers s ON s.id=d.supplier_id LEFT JOIN users u ON u.id=d.created_by
      WHERE d.company_id=$1 AND d.doc_type='BILL' AND (d.status='PENDING_APPROVAL' OR (d.status='DRAFT' AND d.ai_generated)) ORDER BY d.created_at`, [cid]);
  const { rows: invoices } = await pool.query(`SELECT d.id, d.number, d.doc_date AS date, c.name AS description, d.total, d.status, u.name AS created_by FROM sales_documents d JOIN customers c ON c.id=d.customer_id LEFT JOIN users u ON u.id=d.created_by
      WHERE d.company_id=$1 AND d.doc_type='INVOICE' AND d.status='DRAFT' ORDER BY d.created_at`, [cid]);
  res.json({ journals, expenses, bills, invoices });
}));

export default r;
export { toCents, fromCents };
