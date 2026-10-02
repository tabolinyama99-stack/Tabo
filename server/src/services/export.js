// Turn any report object { title, subtitle, columns, rows } into PDF or Excel.
import PDFDocument from 'pdfkit';
import ExcelJS from 'exceljs';
import { formatK, toCents } from '../lib/money.js';

const fmtDate = (v) => (v ? String(v).slice(0, 10).split('-').reverse().join('/') : '');
export function cellText(c, v) {
  if (v === null || v === undefined || v === '') return '';
  if (c.type === 'money') return formatK(v);
  if (c.type === 'percent') return `${v}%`;
  if (c.type === 'date') return fmtDate(v);
  if (c.type === 'datetime') { const d = new Date(v); return `${fmtDate(d.toISOString())} ${d.toISOString().slice(11, 16)}`; }
  return String(v);
}

export async function reportToXlsx(report, company) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'TAEL Books';
  const ws = wb.addWorksheet(report.title.slice(0, 31));
  ws.addRow([company?.name || '']).font = { bold: true, size: 13 };
  ws.addRow([report.title]).font = { bold: true, size: 12 };
  ws.addRow([report.subtitle || '']);
  if (report.note) ws.addRow([report.note]).font = { italic: true, size: 9 };
  ws.addRow([]);
  const header = ws.addRow(report.columns.map((c) => c.label));
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.eachCell((cell) => { cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F5C4A' } }; });
  for (const r of report.rows) {
    const row = ws.addRow(report.columns.map((c, i) => {
      const v = r[c.key];
      if (v === null || v === undefined || v === '') return null;
      if (c.type === 'money') return Number(v); // exported value; ledger stays exact NUMERIC
      if (c.type === 'number') return Number(v);
      if (c.type === 'percent') return Number(v) / 100;
      if (c.type === 'date') return fmtDate(v);
      return i === 0 && r._indent ? `${'  '.repeat(r._indent)}${v}` : String(v);
    }));
    if (['total', 'grand', 'subtotal', 'header', 'subheader'].includes(r._style)) row.font = { bold: true };
    if (r._style === 'grand') row.eachCell((c) => { c.border = { top: { style: 'thin' }, bottom: { style: 'double' } }; });
  }
  report.columns.forEach((c, i) => {
    const col = ws.getColumn(i + 1);
    if (c.type === 'money') col.numFmt = '"K"#,##0.00;[Red]-"K"#,##0.00';
    if (c.type === 'percent') col.numFmt = '0.0%';
    col.width = c.type === 'money' ? 16 : c.type === 'date' ? 12 : Math.min(48, Math.max(12, c.label.length + 4));
  });
  ws.getColumn(1).width = Math.max(ws.getColumn(1).width, 28);
  ws.views = [{ state: 'frozen', ySplit: report.note ? 6 : 5 }];
  return wb.xlsx.writeBuffer();
}

export function pdfHeader(doc, company, { title, subtitle, logo }) {
  const top = doc.y;
  if (logo) { try { doc.image(logo, doc.page.margins.left, top, { fit: [120, 48] }); } catch { /* unsupported image type for pdf (e.g. svg) */ } }
  doc.fontSize(9).fillColor('#56635d').text([company?.name, company?.address, [company?.phone, company?.email].filter(Boolean).join(' · '), company?.tpin ? `TPIN ${company.tpin}` : null].filter(Boolean).join('\n'),
    doc.page.margins.left, top, { align: 'right' });
  doc.moveDown(2);
  doc.y = Math.max(doc.y, top + 56);
  doc.fillColor('#17211d').fontSize(16).font('Helvetica-Bold').text(title, doc.page.margins.left);
  if (subtitle) doc.font('Helvetica').fontSize(10).fillColor('#56635d').text(subtitle);
  doc.moveDown(0.8).fillColor('#17211d');
}

export function reportToPdf(report, company, { logo, footer } = {}) {
  return new Promise((resolve, reject) => {
    const wide = report.columns.length > 5;
    const doc = new PDFDocument({ size: 'A4', layout: wide ? 'landscape' : 'portrait', margin: 36, bufferPages: true, info: { Title: report.title, Producer: 'TAEL Books' } });
    const chunks = []; doc.on('data', (c) => chunks.push(c)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject);
    pdfHeader(doc, company, { title: report.title, subtitle: report.subtitle, logo });
    if (report.note) doc.fontSize(8).fillColor('#56635d').text(report.note).moveDown(0.5).fillColor('#17211d');
    const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const weights = report.columns.map((c, i) => (i === 0 || ['account', 'description', 'item', 'party', 'grp', 'changes'].includes(c.key) ? 3 : c.type === 'money' ? 1.4 : 1));
    const tw = weights.reduce((a, b) => a + b, 0);
    const widths = weights.map((w) => (w / tw) * width);
    const drawHeader = () => {
      const y = doc.y; let x = doc.page.margins.left;
      doc.rect(x, y - 2, width, 16).fill('#0f5c4a');
      doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(8);
      report.columns.forEach((c, i) => { doc.text(c.label, x + 3, y + 2, { width: widths[i] - 6, align: ['money', 'number', 'percent'].includes(c.type) ? 'right' : 'left', lineBreak: false }); x += widths[i]; });
      doc.fillColor('#17211d').font('Helvetica'); doc.y = y + 18;
    };
    drawHeader();
    for (const r of report.rows) {
      const bold = ['total', 'grand', 'subtotal', 'header', 'subheader'].includes(r._style);
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8);
      const texts = report.columns.map((c, i) => `${i === 0 && r._indent ? '   '.repeat(r._indent) : ''}${cellText(c, r[c.key])}`);
      const h = Math.max(12, ...texts.map((t, i) => doc.heightOfString(t, { width: widths[i] - 6 }))) + 3;
      if (doc.y + h > doc.page.height - doc.page.margins.bottom - 20) { doc.addPage(); drawHeader(); doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8); }
      const y = doc.y; let x = doc.page.margins.left;
      if (r._style === 'header') doc.rect(x, y - 1, width, h).fill('#eef1ee').fillColor('#17211d');
      report.columns.forEach((c, i) => {
        const neg = c.type === 'money' && r[c.key] && toCents(r[c.key]) < 0n;
        doc.fillColor(neg ? '#b42318' : '#17211d').text(texts[i], x + 3, y + 1, { width: widths[i] - 6, align: ['money', 'number', 'percent'].includes(c.type) ? 'right' : 'left' });
        x += widths[i];
      });
      if (['total', 'grand'].includes(r._style)) { doc.moveTo(doc.page.margins.left, y - 1).lineTo(doc.page.margins.left + width, y - 1).strokeColor('#b7c1bb').lineWidth(0.5).stroke(); }
      doc.y = y + h;
    }
    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(i);
      doc.fontSize(7).fillColor('#7a867f').text(`${footer || 'Generated by TAEL Books'} · ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC · Page ${i + 1} of ${range.count}`,
        doc.page.margins.left, doc.page.height - doc.page.margins.bottom - 4, { width, align: 'center', lineBreak: false });
    }
    doc.end();
  });
}
