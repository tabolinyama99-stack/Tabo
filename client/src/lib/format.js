// Display helpers. Amounts arrive from the API as exact decimal strings.
export function fmtK(v, { symbol = 'K', blankZero = false } = {}) {
  if (v === null || v === undefined || v === '') return '';
  const s = String(v);
  if (!/^-?\d+(\.\d+)?$/.test(s)) return s;
  const neg = s.startsWith('-');
  const [i, f = ''] = s.replace('-', '').split('.');
  const frac = (f + '00').slice(0, 2);
  if (blankZero && Number(i) === 0 && Number(frac) === 0) return '';
  return `${neg ? '-' : ''}${symbol}${i.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${frac}`;
}
export const isNeg = (v) => String(v || '').startsWith('-') && Number(v) !== 0;
export const fmtDate = (v) => (v ? String(v).slice(0, 10).split('-').reverse().join('/') : '');
export const fmtDateTime = (v) => { if (!v) return ''; const d = new Date(v); return `${fmtDate(d.toISOString())} ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`; };
export const today = () => new Date().toISOString().slice(0, 10);
export const monthStart = (d = today()) => `${d.slice(0, 7)}-01`;
export const yearStart = (d = today()) => `${d.slice(0, 4)}-01-01`;
export function addMonths(d, n) { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(1); x.setUTCMonth(x.getUTCMonth() + n); return x.toISOString().slice(0, 10); }
export function monthEnd(d) { const x = new Date(`${d.slice(0, 7)}-01T00:00:00Z`); x.setUTCMonth(x.getUTCMonth() + 1); x.setUTCDate(0); return x.toISOString().slice(0, 10); }
export const titleCase = (s) => String(s || '').toLowerCase().replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
/** cents-safe sum of decimal strings (for UI totals only; the server recomputes everything) */
export function sumK(values) {
  let c = 0n;
  for (const v of values) { if (v === '' || v === null || v === undefined) continue; const s = String(v).replace(/,/g, ''); if (!/^-?\d*(\.\d*)?$/.test(s)) continue; const neg = s.startsWith('-'); const [i, f = ''] = s.replace('-', '').split('.'); const x = BigInt(i || '0') * 100n + BigInt((f + '00').slice(0, 2) || '0'); c += neg ? -x : x; }
  const neg = c < 0n; const a = neg ? -c : c; return `${neg ? '-' : ''}${a / 100n}.${String(a % 100n).padStart(2, '0')}`;
}

export const STATUS_TONE = {
  DRAFT: '', SENT: 'info', OPEN: 'info', PARTIALLY_PAID: 'warning', PAID: 'positive', OVERDUE: 'negative', CANCELLED: '', VOID: '', POSTED: 'brand', REVERSED: '',
  PENDING_APPROVAL: 'warning', ACCEPTED: 'positive', DECLINED: 'negative', CONVERTED: 'brand', INVOICED: 'brand', BILLED: 'brand', APPLIED: 'brand', COMPLETED: 'positive',
  IN_PROGRESS: 'warning', MATCHED: 'positive', UNMATCHED: 'warning', EXCLUDED: '', LOCKED: 'warning', CLOSED: 'negative', HIGH: 'negative', MEDIUM: 'warning', LOW: 'info', RESOLVED: 'positive', DISMISSED: '',
};
export const DOC_LABEL = { INVOICE: 'Invoice', QUOTE: 'Quotation', ORDER: 'Sales order', CREDIT_NOTE: 'Credit note', PO: 'Purchase order', BILL: 'Bill', DEBIT_NOTE: 'Debit note' };
