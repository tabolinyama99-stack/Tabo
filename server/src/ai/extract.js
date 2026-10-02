// AI bookkeeping: read an uploaded receipt / invoice and create a DRAFT for human approval.
// With an API key Claude reads the document; otherwise local OCR (tesseract / pdftotext) + rules.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pool, tx } from '../db/pool.js';
import { aiClient } from './provider.js';
import { resolveAccountByHint } from './tools.js';
import { toCents, fromCents } from './util.js';
import { getSystemAccount } from '../services/ledger.js';
import { createExpense } from '../services/expenses.js';
import { createPurchaseDoc } from '../services/purchases.js';
import { readDocument } from '../services/storage.js';
import { audit } from '../lib/audit.js';
import { badRequest } from '../lib/errors.js';
import { parseDate } from '../services/banking.js';

function run(cmd, args, timeoutMs = 45000) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args); let out = '';
    const timer = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.stdout.on('data', (d) => { out += d; });
    p.on('error', () => { clearTimeout(timer); resolve(''); });
    p.on('close', () => { clearTimeout(timer); resolve(out); });
  });
}

async function ocrText(doc, data) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tael-ocr-'));
  try {
    const f = path.join(dir, `in.${doc.mime_type === 'application/pdf' ? 'pdf' : 'img'}`);
    await fs.writeFile(f, data);
    if (doc.mime_type === 'application/pdf') {
      let text = await run('pdftotext', ['-layout', '-l', '3', f, '-']);
      if (text.trim().length < 20) { await run('pdftoppm', ['-r', '200', '-l', '1', '-png', f, path.join(dir, 'p')]); const pngs = (await fs.readdir(dir)).filter((x) => x.startsWith('p') && x.endsWith('.png')); if (pngs[0]) text = await run('tesseract', [path.join(dir, pngs[0]), '-', '--psm', '6']); }
      return text;
    }
    return await run('tesseract', [f, '-', '--psm', '6']);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
}

/** Rule-based reading of OCR text. Conservative: unknown fields stay empty. */
export function parseReceiptText(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const amt = (s) => { const m = s.replace(/\s/g, ' ').match(/(?:K|ZMW)?\s?(\d{1,3}(?:[ ,]\d{3})*(?:\.\d{2})|\d+\.\d{2})\b/i); return m ? m[1].replace(/[ ,]/g, '') : null; };
  let total = null, tax = null;
  for (const l of lines) {
    if (!total && /\b(grand total|total due|amount due|total amount|total|amount paid)\b/i.test(l) && !/sub ?total|vat|tax/i.test(l)) total = amt(l);
    if (!tax && /\b(vat|tax)\b/i.test(l) && !/tpin|tax ?id|incl/i.test(l)) tax = amt(l);
  }
  if (!total) { const all = lines.map(amt).filter(Boolean).map(Number); if (all.length) total = Math.max(...all).toFixed(2); }
  let date = null;
  for (const l of lines) { const m = l.match(/(\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}|\d{4}-\d{2}-\d{2}|\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4})/); if (m) { date = parseDate(m[1].replace(/\s+/g, ' ').replace(/^(\d{1,2}) ([A-Za-z]{3})[A-Za-z]* (\d{4})$/, '$1 $2 $3')); if (date) break; } }
  const invoice = lines.map((l) => l.match(/\b(?:invoice|inv|receipt|rcpt|bill)\s*(?:no|number|#)?[.:#\s]*([A-Z0-9-/]{3,})/i)?.[1]).find(Boolean) || null;
  const tpin = lines.map((l) => l.match(/\bTPIN[.:\s]*(\d{10})/i)?.[1]).find(Boolean) || null;
  const vendor = lines.find((l) => /[A-Za-z]{3,}/.test(l) && !/receipt|invoice|tax|date|tel|phone|tpin|www|@/i.test(l))?.slice(0, 80) || null;
  const payment = /cash/i.test(text) ? 'cash' : /card|visa|mastercard|pos/i.test(text) ? 'bank' : /mobile money|airtel|mtn|momo/i.test(text) ? 'mobile_money' : null;
  return { vendor, date, invoice_number: invoice, total, tax, tpin, payment_method: payment, description: vendor ? `Purchase from ${vendor}` : 'Receipt', raw_text: text.slice(0, 4000) };
}

async function claudeExtract(ai, doc, data) {
  const block = doc.mime_type === 'application/pdf'
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: data.toString('base64') } }
    : { type: 'image', source: { type: 'base64', media_type: doc.mime_type, data: data.toString('base64') } };
  const resp = await ai.client.messages.create({ model: ai.model, max_tokens: 800, messages: [{ role: 'user', content: [block, { type: 'text', text:
    'Extract the accounting data from this receipt or invoice (Zambia; currency normally Kwacha). Reply with ONLY a JSON object with keys: vendor, customer, date (YYYY-MM-DD), invoice_number, total (string, 2 decimals, tax inclusive), tax (string VAT amount or null), currency, tpin, description (short), suggested_category (one of: fuel, rent, office supplies, transport, utilities, telephone, repairs, meals, printing, professional fees, advertising, insurance, bank charges, purchases of goods, other), payment_method (cash|bank|mobile_money|credit|unknown), document_type (receipt|invoice), due_date, confidence (0-100). Use null for anything not visible. Do not guess numbers.' }] }] });
  const text = resp.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  const json = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
  return json;
}

export async function extractAndDraft(ctx, documentId, { create = true } = {}) {
  const { doc, data } = await readDocument(pool, ctx.companyId, documentId);
  if (!['image/png', 'image/jpeg', 'image/webp', 'application/pdf'].includes(doc.mime_type)) throw badRequest('Upload a photo (JPG/PNG) or PDF of the receipt or invoice.');
  const ai = await aiClient(ctx);
  let x, engine = 'ocr';
  if (ai) { try { x = await claudeExtract(ai, doc, data); engine = 'claude'; } catch (e) { console.error('[ai] extraction fallback:', e.message); } }
  if (!x) { const text = await ocrText(doc, data); x = { ...parseReceiptText(text), confidence: text.trim() ? 45 : 0 }; }
  // sanitise numbers
  for (const k of ['total', 'tax']) { try { x[k] = x[k] ? fromCents(toCents(String(x[k]))) : null; } catch { x[k] = null; } if (x[k] && toCents(x[k]) <= 0n) x[k] = null; }
  if (x.date && !/^\d{4}-\d{2}-\d{2}$/.test(x.date)) x.date = parseDate(x.date);
  const acc = (await resolveAccountByHint(pool, ctx.companyId, x.suggested_category || `${x.description || ''} ${x.vendor || ''} ${x.raw_text || ''}`)) || (await getSystemAccount(pool, ctx.companyId, 'GENERAL_EXPENSE'));
  const { rows: [sup] } = x.vendor ? await pool.query(`SELECT id, name FROM suppliers WHERE company_id=$1 AND is_active AND (similarity(lower(name), lower($2)) > 0.35 OR ($3::text IS NOT NULL AND tpin=$3)) ORDER BY similarity(lower(name), lower($2)) DESC LIMIT 1`, [ctx.companyId, x.vendor, x.tpin || null]) : { rows: [] };
  const suggestion = { ...x, suggested_account_id: acc.id, suggested_account: `${acc.code} ${acc.name}`, matched_supplier_id: sup?.id || null, matched_supplier: sup?.name || null, engine };
  await pool.query('UPDATE documents SET extracted=$2 WHERE id=$1', [doc.id, JSON.stringify(suggestion)]);
  await audit({ ...ctx, viaAi: true }, 'ai.document_extracted', { entityType: 'document', entityId: doc.id, newValue: { engine, total: x.total, vendor: x.vendor, confidence: x.confidence } });
  if (!create || !x.total) return { extraction: suggestion, draft: null, message: x.total ? null : 'I could not read a total from this document. Enter the details manually; the document is attached and saved.' };

  const actx = { ...ctx, viaAi: true };
  const date = x.date || new Date().toISOString().slice(0, 10);
  const vatTax = x.tax && toCents(x.tax) > 0n ? (await pool.query(`SELECT id FROM tax_rates WHERE company_id=$1 AND code='VAT16' AND is_active ORDER BY effective_from DESC LIMIT 1`, [ctx.companyId])).rows[0] : null;
  const isBill = (x.document_type === 'invoice' || x.payment_method === 'credit') && sup;
  if (isBill) {
    const net = vatTax ? fromCents(toCents(x.total) - toCents(x.tax)) : x.total;
    const d = await tx((db) => createPurchaseDoc(db, actx, { doc_type: 'BILL', supplier_id: sup.id, supplier_reference: x.invoice_number || null, doc_date: date, due_date: x.due_date && /^\d{4}-\d{2}-\d{2}$/.test(x.due_date) ? x.due_date : null,
      notes: `AI-extracted from ${doc.original_name} (confidence ${x.confidence ?? 'n/a'}%). Check before approving.`, document_id: doc.id, ai_generated: true, allow_duplicate: true,
      lines: [{ description: x.description || `Invoice ${x.invoice_number || ''}`.trim(), quantity: '1', unit_price: net, discount_pct: '0', account_id: acc.id, tax_rate_id: vatTax?.id || null }] }));
    return { extraction: suggestion, draft: { type: 'purchase_document', id: d.id, number: d.number, status: 'DRAFT — NEEDS APPROVAL', total: d.total, link: `/purchases/documents/${d.id}` } };
  }
  const pay = await getSystemAccount(pool, ctx.companyId, x.payment_method === 'bank' ? 'BANK' : x.payment_method === 'mobile_money' ? 'MOBILE_MONEY' : 'CASH');
  const e = await tx((db) => createExpense(db, actx, { expense_date: date, supplier_id: sup?.id || null, payee_name: sup ? null : x.vendor, account_id: acc.id, amount: x.total, amount_includes_tax: !!vatTax, tax_rate_id: vatTax?.id || null,
    payment_account_id: pay.id, payment_method: x.payment_method === 'bank' ? 'CARD' : x.payment_method === 'mobile_money' ? 'MOBILE_MONEY' : 'CASH', description: x.description || 'Receipt', reference: x.invoice_number || null,
    document_id: doc.id, ai_generated: true, ai_confidence: Number(x.confidence) || null }, { submit: false }));
  return { extraction: suggestion, draft: { type: 'expense', id: e.id, number: e.number, status: 'DRAFT — NEEDS APPROVAL', total: e.total, account: acc.name, payment: pay.name, link: `/expenses/${e.id}` } };
}
