// Banking, reports, dashboard, performance, documents, review flags, notifications, search.
import { Router } from 'express';
import multer from 'multer';
import { pool, tx } from '../db/pool.js';
import { asyncH } from '../middleware/errors.js';
import { need } from '../middleware/auth.js';
import { audit } from '../lib/audit.js';
import { badRequest, forbidden, notFound, conflict } from '../lib/errors.js';
import { can } from '../services/ledger.js';
import * as B from '../services/banking.js';
import { REPORTS } from '../services/reports.js';
import { dashboard } from '../services/dashboard.js';
import { reportToPdf, reportToXlsx } from '../services/export.js';
import { companyBranding } from '../services/documents-pdf.js';
import { saveUpload, readDocument, removeDocumentFile } from '../services/storage.js';
import { scanAnomalies } from '../services/anomalies.js';
import { listNotifications, markRead } from '../services/notifications.js';
import { globalSearch } from '../services/search.js';
import { config } from '../config.js';
import { z, str, optStr, money, date, optDate, pid } from './_util.js';

const r = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: 1 } });

// ───────────── Banking ─────────────
r.get('/bank-accounts', need('view_banking', 'create_payment', 'create_expense'), asyncH(async (req, res) => res.json(await B.listBankAccounts(pool, req.ctx.companyId))));
const bankSchema = z.object({ code: str(20).min(1), name: str(150).min(1), bank_name: optStr(100), account_number: optStr(60), branch_name: optStr(100), currency: z.string().length(3).default('ZMW'),
  is_cash: z.boolean().default(false), low_balance_threshold: z.union([money, z.literal(''), z.null()]).optional() });
r.post('/bank-accounts', need('manage_banking'), asyncH(async (req, res) => {
  const b = bankSchema.parse(req.body);
  if (!can(req.ctx, 'edit_chart_of_accounts') && !req.ctx.isSuperAdmin) throw forbidden('Creating a bank account adds a ledger account; you need permission to edit the chart of accounts.');
  res.status(201).json(await tx((db) => B.createBankAccount(db, req.ctx, { ...b, low_balance_threshold: b.low_balance_threshold || null })));
}));
r.put('/bank-accounts/:id', need('manage_banking'), asyncH(async (req, res) => { await tx((db) => B.updateBankAccount(db, req.ctx, pid(req), bankSchema.partial().parse(req.body))); res.json({ ok: true }); }));
r.get('/bank-accounts/:id/register', need('view_banking'), asyncH(async (req, res) => res.json(await B.bankRegister(pool, req.ctx.companyId, pid(req), req.query))));
r.post('/bank-transactions', need('manage_banking'), asyncH(async (req, res) => {
  const b = z.object({ kind: z.enum(['DEPOSIT', 'WITHDRAWAL', 'TRANSFER']), bank_account_id: z.coerce.number().int().positive(), to_account_id: z.coerce.number().int().positive().optional(),
    contra_account_id: z.coerce.number().int().positive().optional(), amount: money, date, reference: optStr(100), description: optStr(300) }).parse(req.body);
  res.status(201).json(await tx((db) => B.recordBankTransaction(db, req.ctx, b)));
}));
r.post('/bank-accounts/:id/import', need('manage_banking'), upload.single('file'), asyncH(async (req, res) => {
  if (!req.file) throw badRequest('Choose a CSV or Excel bank statement.');
  if (!/\.(csv|txt|xlsx)$/i.test(req.file.originalname)) throw badRequest('Upload a .csv or .xlsx bank statement.');
  let mapping = null;
  if (req.body?.mapping) { try { mapping = JSON.parse(req.body.mapping); } catch { throw badRequest('Invalid column mapping.'); } }
  const result = await tx((db) => B.importStatement(db, req.ctx, pid(req), { buffer: req.file.buffer, filename: req.file.originalname, mapping }));
  res.status(201).json(result);
}));
r.get('/bank-accounts/:id/statement-lines', need('view_banking'), asyncH(async (req, res) => {
  const p = [req.ctx.companyId, pid(req)]; let w = '';
  if (req.query.status) { p.push(String(req.query.status).split(',')); w = ` AND s.status = ANY($3)`; }
  const { rows } = await pool.query(`SELECT s.*, l.entry_id, e.number AS entry_number, e.description AS entry_description FROM bank_statement_lines s
      LEFT JOIN journal_lines l ON l.id=s.matched_line_id LEFT JOIN journal_entries e ON e.id=l.entry_id WHERE s.company_id=$1 AND s.bank_account_id=$2 ${w} ORDER BY s.txn_date DESC, s.id DESC LIMIT 1000`, p);
  res.json(rows);
}));
r.get('/bank-accounts/:id/suggestions', need('reconcile_bank', 'manage_banking'), asyncH(async (req, res) => res.json(await B.suggestMatches(pool, req.ctx.companyId, pid(req), req.query.line ? Number(req.query.line) : null))));
r.post('/bank-accounts/:id/auto-match', need('reconcile_bank', 'manage_banking'), asyncH(async (req, res) => res.json(await tx((db) => B.autoMatch(db, req.ctx, pid(req), { apply: true, minScore: Number(req.body?.min_score) || 80 })))));
r.post('/statement-lines/:id/match', need('reconcile_bank', 'manage_banking'), asyncH(async (req, res) => {
  const { journal_line_id } = z.object({ journal_line_id: z.coerce.number().int().positive() }).parse(req.body);
  await tx((db) => B.matchLine(db, req.ctx, pid(req), journal_line_id)); res.json({ ok: true });
}));
r.post('/statement-lines/:id/unmatch', need('reconcile_bank', 'manage_banking'), asyncH(async (req, res) => { await tx((db) => B.unmatchLine(db, req.ctx, pid(req))); res.json({ ok: true }); }));
r.post('/statement-lines/:id/exclude', need('reconcile_bank', 'manage_banking'), asyncH(async (req, res) => { await tx((db) => B.excludeLine(db, req.ctx, pid(req), req.body?.exclude !== false)); res.json({ ok: true }); }));
r.post('/statement-lines/:id/create-entry', need('manage_banking'), asyncH(async (req, res) => {
  const b = z.object({ contra_account_id: z.coerce.number().int().positive(), description: optStr(300) }).parse(req.body);
  res.status(201).json(await tx((db) => B.createFromStatementLine(db, req.ctx, pid(req), b)));
}));
r.get('/reconciliations', need('view_banking'), asyncH(async (req, res) => {
  const { rows } = await pool.query(`SELECT r.*, a.name AS bank_account_name, u.name AS completed_by_name FROM reconciliations r JOIN accounts a ON a.id=r.bank_account_id LEFT JOIN users u ON u.id=r.completed_by
      WHERE r.company_id=$1 ${req.query.bank_account_id ? 'AND r.bank_account_id=$2' : ''} ORDER BY r.statement_date DESC`, req.query.bank_account_id ? [req.ctx.companyId, Number(req.query.bank_account_id)] : [req.ctx.companyId]);
  res.json(rows);
}));
r.post('/reconciliations', need('reconcile_bank'), asyncH(async (req, res) => {
  const b = z.object({ bank_account_id: z.coerce.number().int().positive(), statement_date: date, statement_balance: money }).parse(req.body);
  res.status(201).json(await tx((db) => B.startReconciliation(db, req.ctx, b)));
}));
r.get('/reconciliations/:id', need('view_banking'), asyncH(async (req, res) => res.json(await B.getReconciliation(pool, req.ctx.companyId, pid(req)))));
r.post('/reconciliations/:id/clear', need('reconcile_bank'), asyncH(async (req, res) => {
  const b = z.object({ line_ids: z.array(z.coerce.number().int().positive()), cleared: z.boolean() }).parse(req.body);
  res.json(await tx((db) => B.toggleCleared(db, req.ctx, pid(req), b.line_ids, b.cleared)));
}));
r.post('/reconciliations/:id/complete', need('reconcile_bank'), asyncH(async (req, res) => res.json(await tx((db) => B.completeReconciliation(db, req.ctx, pid(req))))));
r.delete('/reconciliations/:id', need('reconcile_bank'), asyncH(async (req, res) => { await tx((db) => B.deleteReconciliation(db, req.ctx, pid(req))); res.json({ ok: true }); }));

// ───────────── Reports ─────────────
r.get('/reports', need('view_reports'), (req, res) => res.json(Object.entries(REPORTS).filter(([, v]) => !v.permission || can(req.ctx, v.permission)).map(([slug, v]) => ({ slug, label: v.label, params: v.params }))));
r.get('/reports/:slug', need('view_reports'), asyncH(async (req, res) => {
  const def = REPORTS[req.params.slug];
  if (!def) throw notFound('Report');
  if (def.permission && !can(req.ctx, def.permission)) throw forbidden();
  for (const k of ['from', 'to', 'as_of']) if (req.query[k] && !/^\d{4}-\d{2}-\d{2}$/.test(String(req.query[k]))) throw badRequest(`${k} must be a date (YYYY-MM-DD).`);
  const report = await def.fn(pool, req.ctx.companyId, req.query);
  const fmt = req.query.format;
  if (fmt === 'pdf' || fmt === 'xlsx') {
    if (!can(req.ctx, 'export_reports')) throw forbidden('You do not have permission to export reports.');
    await audit(req.ctx, 'report.exported', { entityType: 'report', entityId: req.params.slug, newValue: { format: fmt, params: req.query } });
    const brand = await companyBranding(pool, req.ctx.companyId);
    const name = `${req.params.slug}-${new Date().toISOString().slice(0, 10)}.${fmt}`;
    if (fmt === 'pdf') {
      const buf = await reportToPdf(report, brand.company, { logo: brand.settings?.branding?.show_logo_on_reports !== false ? brand.logo : null, footer: brand.settings?.documents?.report?.footer_note });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `${req.query.inline ? 'inline' : 'attachment'}; filename="${name}"`);
      return res.send(buf);
    }
    const buf = await reportToXlsx(report, brand.company);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    return res.send(Buffer.from(buf));
  }
  res.json(report);
}));

// ───────────── Dashboard & performance ─────────────
r.get('/dashboard', need('view_dashboard'), asyncH(async (req, res) => res.json(await dashboard(pool, req.ctx.companyId, req.query))));

r.get('/performance/:kind', need('view_reports', 'view_sales', 'view_purchases'), asyncH(async (req, res) => {
  const kind = req.params.kind;
  if (!['customers', 'suppliers'].includes(kind)) throw notFound();
  if (kind === 'customers' && !can(req.ctx, 'view_sales') && !can(req.ctx, 'view_reports')) throw forbidden();
  const to = req.query.to || new Date().toISOString().slice(0, 10);
  const from = req.query.from || `${to.slice(0, 4)}-01-01`;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) throw badRequest('Dates must be YYYY-MM-DD.');
  const isC = kind === 'customers';
  const t = isC ? 'sales_documents' : 'purchase_documents', party = isC ? 'customer' : 'supplier', doc = isC ? 'INVOICE' : 'BILL', note = isC ? 'CREDIT_NOTE' : 'DEBIT_NOTE';
  const p = [req.ctx.companyId, from, to]; let dw = '', xw = '';
  if (req.query.branch_id) { p.push(Number(req.query.branch_id)); dw += ` AND d.branch_id=$${p.length}`; }
  if (req.query.department_id) { p.push(Number(req.query.department_id)); dw += ` AND d.department_id=$${p.length}`; }
  if (req.query[`${party}_id`]) { p.push(Number(req.query[`${party}_id`])); xw += ` AND x.id=$${p.length}`; }
  const w = dw + xw;
  const { rows } = await pool.query(`
    SELECT x.id, x.name,
      COALESCE(SUM(CASE WHEN d.doc_type='${doc}' THEN d.subtotal WHEN d.doc_type='${note}' THEN -d.subtotal END),0)::numeric(18,2) AS net_amount,
      COALESCE(SUM(d.total) FILTER (WHERE d.doc_type='${doc}'),0)::numeric(18,2) AS gross_amount,
      COUNT(*) FILTER (WHERE d.doc_type='${doc}')::int AS documents,
      COALESCE(SUM(d.amount_paid) FILTER (WHERE d.doc_type='${doc}'),0)::numeric(18,2) AS amount_paid,
      COALESCE(SUM(d.total-d.amount_paid-d.amount_credited) FILTER (WHERE d.doc_type='${doc}'),0)::numeric(18,2) AS outstanding,
      COALESCE(SUM(d.total-d.amount_paid-d.amount_credited) FILTER (WHERE d.doc_type='${doc}' AND d.due_date < CURRENT_DATE),0)::numeric(18,2) AS overdue,
      AVG(CASE WHEN d.status='PAID' THEN d.updated_at::date - d.doc_date END)::numeric(8,1) AS avg_days_to_pay,
      COALESCE((SELECT SUM(${isC ? 'l.debit - l.credit' : 'l.credit - l.debit'}) FROM ledger l JOIN accounts a ON a.id=l.account_id AND a.system_key='${isC ? 'AR' : 'AP'}' WHERE l.${party}_id=x.id),0)::numeric(18,2) AS ledger_balance
      ${isC ? `, COALESCE((SELECT SUM(l.debit - l.credit) FROM ledger l JOIN accounts a ON a.id=l.account_id AND a.type='COST_OF_SALES' WHERE l.customer_id=x.id AND l.entry_date BETWEEN $2 AND $3),0)::numeric(18,2) AS direct_costs` : ''}
    FROM ${party}s x LEFT JOIN ${t} d ON d.${party}_id=x.id AND d.status NOT IN ('DRAFT','CANCELLED','PENDING_APPROVAL') AND d.doc_date BETWEEN $2 AND $3 ${dw}
    WHERE x.company_id=$1 ${xw}
    GROUP BY x.id, x.name HAVING COUNT(d.id) > 0 ORDER BY net_amount DESC`, p);
  const { rows: monthly } = await pool.query(`SELECT to_char(d.doc_date,'YYYY-MM') AS month, SUM(CASE WHEN d.doc_type='${doc}' THEN d.subtotal ELSE -d.subtotal END)::numeric(18,2) AS amount
      FROM ${t} d JOIN ${party}s x ON x.id=d.${party}_id WHERE d.company_id=$1 AND d.doc_type IN ('${doc}','${note}') AND d.status NOT IN ('DRAFT','CANCELLED','PENDING_APPROVAL') AND d.doc_date BETWEEN $2 AND $3 ${w} GROUP BY 1 ORDER BY 1`, p);
  const { rows: payments } = await pool.query(`SELECT to_char(p.payment_date,'YYYY-MM') AS month, SUM(p.amount)::numeric(18,2) AS amount FROM payments p
      WHERE p.company_id=$1 AND p.direction='${isC ? 'IN' : 'OUT'}' AND p.status='POSTED' AND p.payment_date BETWEEN $2 AND $3 AND ($4::bigint IS NULL OR p.${party}_id=$4) GROUP BY 1 ORDER BY 1`, [req.ctx.companyId, from, to, Number(req.query[`${party}_id`]) || null]);
  res.json({ from, to, rows: rows.map((x) => (isC ? { ...x, gross_profit: (Number(x.net_amount) - Number(x.direct_costs)).toFixed(2) } : x)), monthly, payments });
}));

// ───────────── Documents ─────────────
r.get('/documents', need('upload_documents', 'view_expenses', 'view_purchases'), asyncH(async (req, res) => {
  const { rows } = await pool.query(`SELECT d.id, d.original_name, d.category, d.mime_type, d.size_bytes, d.linked_type, d.linked_id, d.created_at, d.extracted IS NOT NULL AS has_extraction, u.name AS uploaded_by
      FROM documents d LEFT JOIN users u ON u.id=d.uploaded_by WHERE d.company_id=$1 AND d.category <> 'branding' ${req.query.category ? 'AND d.category=$2' : ''} ORDER BY d.created_at DESC LIMIT 500`,
    req.query.category ? [req.ctx.companyId, req.query.category] : [req.ctx.companyId]);
  res.json(rows);
}));
r.post('/documents', need('upload_documents'), upload.single('file'), asyncH(async (req, res) => {
  const linkedType = req.body?.linked_type || null, linkedId = req.body?.linked_id ? Number(req.body.linked_id) : null;
  const allowedLinks = { expense: 'expenses', purchase_document: 'purchase_documents', sales_document: 'sales_documents', journal_entry: 'journal_entries', payment: 'payments' };
  if (linkedType) {
    if (!allowedLinks[linkedType]) throw badRequest('Invalid link type.');
    const { rows } = await pool.query(`SELECT 1 FROM ${allowedLinks[linkedType]} WHERE id=$1 AND company_id=$2`, [linkedId, req.ctx.companyId]);
    if (!rows[0]) throw badRequest('The record to attach to was not found.');
  }
  const doc = await saveUpload(pool, req.ctx, req.file, { category: req.body?.category || (linkedType === 'expense' ? 'receipt' : 'general'), kind: 'any', linkedType, linkedId });
  await audit(req.ctx, 'document.uploaded', { entityType: 'document', entityId: doc.id, newValue: { name: doc.original_name, linked_type: linkedType, linked_id: linkedId } });
  res.status(201).json(doc);
}));
r.get('/documents/:id/file', asyncH(async (req, res) => {
  const { doc, data } = await readDocument(pool, req.ctx.companyId, pid(req));
  if (doc.category !== 'branding' && !can(req.ctx, 'upload_documents') && !can(req.ctx, 'view_expenses') && !can(req.ctx, 'view_purchases') && !can(req.ctx, 'view_ledger')) throw forbidden();
  res.setHeader('Content-Type', doc.mime_type);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (doc.mime_type === 'image/svg+xml') res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
  res.setHeader('Content-Disposition', `${req.query.download ? 'attachment' : 'inline'}; filename="${doc.original_name.replace(/"/g, '')}"`);
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.send(data);
}));
r.delete('/documents/:id', need('upload_documents'), asyncH(async (req, res) => {
  const { rows: [doc] } = await pool.query('SELECT * FROM documents WHERE id=$1 AND company_id=$2', [pid(req), req.ctx.companyId]);
  if (!doc) throw notFound('Document');
  // Supporting documents of posted transactions are kept for audit.
  const posted = doc.linked_type === 'expense' ? (await pool.query(`SELECT status FROM expenses WHERE id=$1`, [doc.linked_id])).rows[0]?.status === 'POSTED'
    : doc.linked_type === 'purchase_document' ? (await pool.query(`SELECT status FROM purchase_documents WHERE id=$1`, [doc.linked_id])).rows[0]?.status !== 'DRAFT' : !!doc.linked_type;
  if (posted || doc.category === 'branding') throw conflict('This document supports a posted transaction (or branding) and cannot be deleted.');
  await pool.query('DELETE FROM documents WHERE id=$1', [doc.id]);
  await removeDocumentFile(doc);
  await audit(req.ctx, 'document.deleted', { entityType: 'document', entityId: doc.id, oldValue: { name: doc.original_name } });
  res.json({ ok: true });
}));

// ───────────── Review flags (anomalies) ─────────────
r.get('/review-flags', need('review_anomalies', 'view_reports'), asyncH(async (req, res) => {
  const { rows } = await pool.query(`SELECT f.*, u.name AS resolved_by_name FROM review_flags f LEFT JOIN users u ON u.id=f.resolved_by WHERE f.company_id=$1 AND f.status = ANY($2) ORDER BY
      CASE f.severity WHEN 'HIGH' THEN 0 WHEN 'MEDIUM' THEN 1 ELSE 2 END, f.created_at DESC LIMIT 500`, [req.ctx.companyId, String(req.query.status || 'OPEN').split(',')]);
  res.json(rows);
}));
r.post('/review-flags/scan', need('review_anomalies'), asyncH(async (req, res) => res.json(await scanAnomalies(pool, req.ctx.companyId))));
r.post('/review-flags/:id/:action', need('review_anomalies'), asyncH(async (req, res) => {
  const action = req.params.action;
  if (!['resolve', 'dismiss', 'reopen'].includes(action)) throw notFound();
  const status = { resolve: 'RESOLVED', dismiss: 'DISMISSED', reopen: 'OPEN' }[action];
  const note = String(req.body?.note || '').slice(0, 500);
  if (action !== 'reopen' && !note) throw badRequest('Add a short note explaining the outcome of the review.');
  const { rowCount } = await pool.query(`UPDATE review_flags SET status=$3, resolved_by=$4, resolved_at=now(), resolution_note=$5 WHERE id=$1 AND company_id=$2`, [pid(req), req.ctx.companyId, status, req.ctx.user.id, note || null]);
  if (!rowCount) throw notFound('Flag');
  await audit(req.ctx, `review_flag.${action}d`.replace('dismissd', 'dismissed').replace('reopend', 'reopened'), { entityType: 'review_flag', entityId: pid(req), newValue: { status, note } });
  res.json({ ok: true });
}));

// ───────────── Notifications & search ─────────────
r.get('/notifications', asyncH(async (req, res) => res.json(await listNotifications(req.ctx))));
r.post('/notifications/read', asyncH(async (req, res) => {
  const { ids } = z.object({ ids: z.array(z.coerce.number().int().positive()).max(200) }).parse(req.body);
  await markRead(req.ctx, ids); res.json({ ok: true });
}));
r.get('/search', need('search', 'view_dashboard'), asyncH(async (req, res) => res.json(await globalSearch(pool, req.ctx, req.query.q))));

export default r;
export { optDate };
