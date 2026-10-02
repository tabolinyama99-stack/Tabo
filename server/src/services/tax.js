// Configurable tax engine — rates live in the tax_rates table with effective dates.
import { toCents, fromCents, percentOf, mulRound } from '../lib/money.js';
import { badRequest } from '../lib/errors.js';

/** Resolve a tax rate row valid on `date`. Accepts a tax_rates.id; if that version has expired,
 *  the version of the same code effective on `date` is used. */
export async function resolveTaxRate(db, companyId, taxRateId, date) {
  if (!taxRateId) return null;
  const { rows: [t] } = await db.query('SELECT * FROM tax_rates WHERE company_id=$1 AND id=$2', [companyId, taxRateId]);
  if (!t) throw badRequest('Tax rate not found.');
  if (date && (t.effective_from > date || (t.effective_to && t.effective_to < date))) {
    const { rows: [v] } = await db.query(
      `SELECT * FROM tax_rates WHERE company_id=$1 AND code=$2 AND is_active AND effective_from <= $3 AND (effective_to IS NULL OR effective_to >= $3)
        ORDER BY effective_from DESC LIMIT 1`, [companyId, t.code, date]);
    if (v) return v;
    throw badRequest(`Tax rate ${t.code} is not effective on ${date}.`);
  }
  if (!t.is_active) throw badRequest(`Tax rate ${t.code} is inactive.`);
  return t;
}

export async function taxRateByCode(db, companyId, code, date) {
  const { rows: [t] } = await db.query(
    `SELECT * FROM tax_rates WHERE company_id=$1 AND code=$2 AND is_active AND effective_from <= $3 AND (effective_to IS NULL OR effective_to >= $3)
      ORDER BY effective_from DESC LIMIT 1`, [companyId, code, date]);
  return t || null;
}

/**
 * Compute document lines: subtotal = round(qty × price × (1 − discount%)), tax = round(subtotal × rate%).
 * Returns lines with *_C (cents) values plus document totals and tax grouped by account.
 */
export async function computeDocumentLines(db, companyId, lines, date, side /* 'SALES' | 'PURCHASES' */) {
  if (!Array.isArray(lines) || lines.length === 0) throw badRequest('Add at least one line.');
  let subtotal = 0n, taxTotal = 0n;
  const taxByAccount = new Map();
  const out = [];
  for (const [i, l] of lines.entries()) {
    if (!l.description || !String(l.description).trim()) throw badRequest(`Line ${i + 1}: description is required.`);
    const qty = String(l.quantity ?? 1).replace(/,/g, '');
    if (!/^\d+(\.\d{1,4})?$/.test(qty) || Number(qty) <= 0) throw badRequest(`Line ${i + 1}: quantity must be greater than zero.`);
    let price;
    try { price = toCents(l.unit_price); } catch { throw badRequest(`Line ${i + 1}: invalid unit price.`); }
    if (price < 0n) throw badRequest(`Line ${i + 1}: unit price cannot be negative.`);
    const disc = String(l.discount_pct ?? 0);
    if (!/^\d+(\.\d+)?$/.test(disc) || Number(disc) > 100) throw badRequest(`Line ${i + 1}: discount must be between 0 and 100%.`);
    if (!l.account_id) throw badRequest(`Line ${i + 1}: choose an account.`);
    const gross = mulRound(fromCents(price), qty);
    const discount = percentOf(fromCents(gross), disc);
    const sub = gross - discount;
    const t = await resolveTaxRate(db, companyId, l.tax_rate_id, date);
    let tax = 0n;
    if (t) {
      tax = percentOf(fromCents(sub), t.rate);
      if (tax > 0n) {
        const acc = side === 'SALES' ? t.sales_account_id : t.purchase_account_id;
        if (!acc) throw badRequest(`Tax rate ${t.code} has no ${side === 'SALES' ? 'output' : 'input'} tax account configured.`);
        taxByAccount.set(acc, (taxByAccount.get(acc) || 0n) + tax);
      }
    }
    subtotal += sub; taxTotal += tax;
    out.push({ ...l, line_no: i + 1, quantity: qty, unit_price: fromCents(price), discount_pct: disc, tax_rate_id: t?.id || null,
      subC: sub, taxC: tax, line_subtotal: fromCents(sub), line_tax: fromCents(tax), line_total: fromCents(sub + tax) });
  }
  return { lines: out, subtotal, taxTotal, total: subtotal + taxTotal, taxByAccount };
}

/** Split a tax-inclusive amount into net + tax at rate%. */
export function splitInclusive(totalAmount, ratePct) {
  const total = toCents(totalAmount);
  const r = String(ratePct);
  if (Number(r) === 0) return { net: total, tax: 0n };
  // net = total × 100 / (100 + rate) — computed with 4dp precision then rounded
  const [i, f = ''] = r.split('.');
  const scale = 10n ** BigInt(f.length);
  const rateScaled = BigInt(i + f);
  const den = 100n * scale + rateScaled;
  const num = total * 100n * scale;
  let net = num / den;
  if ((num % den) * 2n >= den) net += 1n;
  return { net, tax: total - net };
}
