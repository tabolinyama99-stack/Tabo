// Branded PDFs for invoices, quotations, credit notes, sales orders, receipts and purchase orders.
import PDFDocument from 'pdfkit';
import { formatK, toCents } from '../lib/money.js';
import { readDocument } from './storage.js';

const fmtDate = (v) => (v ? String(v).slice(0, 10).split('-').reverse().join('/') : '');

/** Logo as PNG/JPEG for PDFKit. SVG, WebP and GIF logos are converted to PNG so they appear on PDFs too. */
export async function pdfLogo(db, companyId, branding = {}) {
  const id = branding.logo_document_id || branding.logo_light_document_id;
  if (!id) return null;
  try {
    const { doc, data } = await readDocument(db, companyId, id);
    if (['image/png', 'image/jpeg'].includes(doc.mime_type)) return data;
    const sharp = (await import('sharp')).default;
    return await sharp(data, { density: 300 }).resize({ height: 240, withoutEnlargement: false, fit: 'inside' }).png().toBuffer();
  } catch { return null; /* logo missing or unreadable: fall back to the company name */ }
}

export async function companyBranding(db, companyId) {
  const { rows: [c] } = await db.query('SELECT * FROM companies WHERE id=$1', [companyId]);
  const b = c.settings?.branding || {};
  const logo = await pdfLogo(db, companyId, b);
  return { company: c, settings: c.settings || {}, logo, color: /^#[0-9a-f]{6}$/i.test(b.primary_color || '') ? b.primary_color : '#0f5c4a' };
}

function base(title) {
  const doc = new PDFDocument({ size: 'A4', margin: 40, info: { Title: title, Producer: 'TAEL Books' } });
  const chunks = []; doc.on('data', (c) => chunks.push(c));
  const done = new Promise((res, rej) => { doc.on('end', () => res(Buffer.concat(chunks))); doc.on('error', rej); });
  return { doc, done };
}

function header(doc, brand, title, number, layout) {
  const { company, logo, color } = brand;
  const L = doc.page.margins.left, W = doc.page.width - L - doc.page.margins.right;
  if (layout === 'modern') { doc.rect(0, 0, doc.page.width, 8).fill(color); }
  const top = 40;
  if (logo && brand.settings?.branding?.show_logo_on_documents !== false) { try { doc.image(logo, L, top, { fit: [150, 60] }); } catch { /* ignore */ } }
  else doc.font('Helvetica-Bold').fontSize(16).fillColor(color).text(company.name, L, top, { width: W / 2 });
  doc.font('Helvetica').fontSize(8.5).fillColor('#56635d').text(
    [company.legal_name || company.name, company.address, company.city, [company.phone, company.email].filter(Boolean).join(' · '), company.website,
      company.tpin ? `TPIN: ${company.tpin}` : null, company.vat_number ? `VAT No: ${company.vat_number}` : null].filter(Boolean).join('\n'),
    L + W / 2, top, { width: W / 2, align: 'right' });
  doc.y = Math.max(doc.y, top + 70) + 10;
  doc.font('Helvetica-Bold').fontSize(20).fillColor(color).text(title.toUpperCase(), L);
  doc.font('Helvetica').fontSize(10).fillColor('#17211d').text(`No. ${number}`);
  doc.moveDown(0.6);
}

function partyAndMeta(doc, label, party, meta) {
  const L = doc.page.margins.left, W = doc.page.width - L - doc.page.margins.right;
  const y = doc.y;
  doc.font('Helvetica-Bold').fontSize(8).fillColor('#56635d').text(label.toUpperCase(), L, y);
  doc.font('Helvetica-Bold').fontSize(10).fillColor('#17211d').text(party.name, L, doc.y + 2, { width: W * 0.55 });
  doc.font('Helvetica').fontSize(9).fillColor('#17211d').text([party.address, party.phone, party.email, party.tpin ? `TPIN: ${party.tpin}` : null].filter(Boolean).join('\n'), { width: W * 0.55 });
  const yEnd = doc.y;
  let my = y;
  for (const [k, v] of meta.filter(([, v]) => v)) {
    doc.font('Helvetica').fontSize(9).fillColor('#56635d').text(k, L + W * 0.6, my, { width: W * 0.2 });
    doc.font('Helvetica-Bold').fillColor('#17211d').text(v, L + W * 0.8, my, { width: W * 0.2, align: 'right' });
    my += 14;
  }
  doc.y = Math.max(yEnd, my) + 12;
}

function linesTable(doc, brand, lines, showTax = true) {
  const L = doc.page.margins.left, W = doc.page.width - L - doc.page.margins.right;
  const cols = [['Description', 0.42, 'left'], ['Qty', 0.08, 'right'], ['Unit price', 0.15, 'right'], ...(showTax ? [['Tax', 0.1, 'right']] : []), ['Amount', showTax ? 0.25 : 0.35, 'right']];
  const head = () => {
    const y = doc.y; let x = L;
    doc.rect(L, y, W, 18).fill(brand.color);
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#ffffff');
    for (const [t, w, a] of cols) { doc.text(t, x + 4, y + 5, { width: W * w - 8, align: a }); x += W * w; }
    doc.y = y + 22; doc.fillColor('#17211d');
  };
  head();
  lines.forEach((l, i) => {
    const vals = [l.description, Number(l.quantity).toLocaleString('en-GB', { maximumFractionDigits: 4 }), formatK(l.unit_price),
      ...(showTax ? [l.tax_code ? `${Number(l.tax_rate)}%` : '—'] : []), formatK(l.line_subtotal)];
    doc.font('Helvetica').fontSize(9);
    const h = Math.max(...vals.map((v, j) => doc.heightOfString(String(v), { width: W * cols[j][1] - 8 }))) + 8;
    if (doc.y + h > doc.page.height - 140) { doc.addPage(); head(); }
    const y = doc.y; let x = L;
    if (i % 2) doc.rect(L, y - 2, W, h).fill('#f6f7f5').fillColor('#17211d');
    vals.forEach((v, j) => { doc.fillColor('#17211d').text(String(v), x + 4, y + 2, { width: W * cols[j][1] - 8, align: cols[j][2] }); x += W * cols[j][1]; });
    doc.y = y + h;
  });
  doc.moveDown(0.5);
}

function totals(doc, brand, rows) {
  const L = doc.page.margins.left, W = doc.page.width - L - doc.page.margins.right;
  for (const [k, v, strong] of rows) {
    const y = doc.y;
    if (strong) doc.rect(L + W * 0.55, y - 3, W * 0.45, 20).fill(brand.color).fillColor('#ffffff'); else doc.fillColor('#17211d');
    doc.font(strong ? 'Helvetica-Bold' : 'Helvetica').fontSize(strong ? 11 : 9.5).text(k, L + W * 0.57, y + (strong ? 1 : 0), { width: W * 0.2 });
    doc.text(v, L + W * 0.75, y + (strong ? 1 : 0), { width: W * 0.24, align: 'right' });
    doc.y = y + (strong ? 22 : 15);
  }
  doc.fillColor('#17211d').moveDown(0.8);
}

function footerBlock(doc, sections, footer) {
  const L = doc.page.margins.left, W = doc.page.width - L - doc.page.margins.right;
  for (const [title, text] of sections) {
    if (!text) continue;
    if (doc.y > doc.page.height - 120) doc.addPage();
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#56635d').text(title.toUpperCase(), L);
    doc.font('Helvetica').fontSize(9).fillColor('#17211d').text(text, { width: W }).moveDown(0.6);
  }
  if (footer) doc.font('Helvetica-Oblique').fontSize(9).fillColor('#56635d').text(footer, L, doc.page.height - 70, { width: W, align: 'center' });
}

const DOC_KEY = { INVOICE: 'invoice', QUOTE: 'quote', ORDER: 'sales_order', CREDIT_NOTE: 'credit_note' };

export async function salesDocumentPdf(db, companyId, d) {
  const brand = await companyBranding(db, companyId);
  const cfg = brand.settings.documents?.[DOC_KEY[d.doc_type]] || {};
  const { doc, done } = base(`${cfg.title || d.doc_type} ${d.number}`);
  header(doc, brand, cfg.title || d.doc_type, d.number, cfg.layout);
  partyAndMeta(doc, d.doc_type === 'CREDIT_NOTE' ? 'Credit to' : 'Bill to', { name: d.customer_name, address: d.customer_address, phone: d.customer_phone, email: d.customer_email, tpin: cfg.show_tpin === false ? null : d.customer_tpin }, [
    ['Date', fmtDate(d.doc_date)], [d.doc_type === 'QUOTE' ? 'Valid until' : 'Due date', fmtDate(d.due_date)], ['Reference', d.reference], ['Status', d.doc_type === 'INVOICE' ? (d.effective_status || d.status).replace('_', ' ') : null],
    ...(d.related_number ? [['Related', d.related_number]] : [])]);
  linesTable(doc, brand, d.lines);
  const rows = [['Subtotal', formatK(d.subtotal)], ['VAT', formatK(d.tax_total)], ['Total', formatK(d.total), true]];
  if (d.doc_type === 'INVOICE' && toCents(d.amount_paid) + toCents(d.amount_credited) > 0n) rows.push(['Paid / credited', formatK(toCents(d.amount_paid) + toCents(d.amount_credited))], ['Balance due', formatK(d.balance_due), true]);
  totals(doc, brand, rows);
  footerBlock(doc, [['Notes', d.notes], ['Terms', d.terms || cfg.terms], ['Payment details', d.doc_type === 'INVOICE' && cfg.show_bank_details !== false ? brand.settings.documents?.bank_details : null]], cfg.footer);
  doc.end();
  return done;
}

export async function purchaseDocumentPdf(db, companyId, d) {
  const brand = await companyBranding(db, companyId);
  const cfg = brand.settings.documents?.purchase_order || {};
  const title = d.doc_type === 'PO' ? cfg.title || 'Purchase Order' : d.doc_type === 'BILL' ? 'Supplier Bill' : 'Debit Note';
  const { doc, done } = base(`${title} ${d.number}`);
  header(doc, brand, title, d.number, cfg.layout);
  partyAndMeta(doc, 'Supplier', { name: d.supplier_name, address: d.supplier_address, phone: d.supplier_phone, email: d.supplier_email, tpin: d.supplier_tpin },
    [['Date', fmtDate(d.doc_date)], ['Due / delivery', fmtDate(d.due_date)], ['Supplier ref', d.supplier_reference]]);
  linesTable(doc, brand, d.lines);
  totals(doc, brand, [['Subtotal', formatK(d.subtotal)], ['VAT', formatK(d.tax_total)], ['Total', formatK(d.total), true]]);
  footerBlock(doc, [['Notes', d.notes], ['Terms', cfg.terms]], d.doc_type === 'PO' ? cfg.footer : null);
  doc.end();
  return done;
}

export async function receiptPdf(db, companyId, p) {
  const brand = await companyBranding(db, companyId);
  const cfg = brand.settings.documents?.receipt || {};
  const title = p.direction === 'IN' ? cfg.title || 'Official Receipt' : 'Payment Voucher';
  const { doc, done } = base(`${title} ${p.number}`);
  header(doc, brand, title, p.number, cfg.layout);
  partyAndMeta(doc, p.direction === 'IN' ? 'Received from' : 'Paid to', { name: p.customer_name || p.supplier_name }, [
    ['Date', fmtDate(p.payment_date)], ['Method', p.method.replace('_', ' ')], ['Reference', p.reference], ['Account', p.bank_account_name], ['Status', p.status]]);
  if (p.allocations?.length) {
    const L = doc.page.margins.left;
    doc.font('Helvetica-Bold').fontSize(9).text('Applied to', L).moveDown(0.3);
    for (const a of p.allocations) doc.font('Helvetica').fontSize(9).text(`${a.document_number}  —  ${formatK(a.amount)}`);
    doc.moveDown(0.6);
  }
  const rows = [['Amount', formatK(p.amount), true]];
  if (toCents(p.wht_amount) > 0n) rows.unshift(['Withholding tax deducted', formatK(p.wht_amount)]);
  totals(doc, brand, rows);
  footerBlock(doc, [['Notes', p.notes]], p.direction === 'IN' ? cfg.footer : null);
  doc.end();
  return done;
}
