// Exact money arithmetic using BigInt minor units (ngwee). Never use floats for money.

/** Parse '1,234.56' | 1234.56 | '1234' | bigint(cents) → bigint cents. Rounds half-up beyond 2dp. */
export function toCents(v) {
  if (typeof v === 'bigint') return v;
  if (v === null || v === undefined || v === '') return 0n;
  let s = String(v).trim().replace(/,/g, '').replace(/^K\s?/i, '').replace(/^ZMW\s?/i, '');
  if (!/^-?\d*(\.\d*)?$/.test(s) || s === '' || s === '-' || s === '.') throw new Error(`Invalid amount: ${v}`);
  const neg = s.startsWith('-');
  if (neg) s = s.slice(1);
  const [intPart, frac = ''] = s.split('.');
  const f3 = (frac + '000').slice(0, 3);
  let cents = BigInt(intPart || '0') * 100n + BigInt(f3.slice(0, 2));
  if (Number(f3[2]) >= 5) cents += 1n;
  return neg ? -cents : cents;
}

/** bigint cents → '1234.56' (string suitable for NUMERIC). */
export function fromCents(c) {
  const neg = c < 0n;
  const a = neg ? -c : c;
  const s = `${a / 100n}.${String(a % 100n).padStart(2, '0')}`;
  return neg ? `-${s}` : s;
}

export const add = (...xs) => xs.reduce((s, x) => s + toCents(x), 0n);
export const sub = (a, b) => toCents(a) - toCents(b);
export const isZero = (v) => toCents(v) === 0n;
export const cmp = (a, b) => { const d = toCents(a) - toCents(b); return d > 0n ? 1 : d < 0n ? -1 : 0; };
export const abs = (v) => { const c = toCents(v); return c < 0n ? -c : c; };

/** Multiply an amount by a decimal factor given as string/number (e.g. quantity or rate%), rounding half-up to cents. */
export function mulRound(amount, factor, divisor = 1n) {
  const cents = toCents(amount);
  const [i, f = ''] = String(factor).replace(/,/g, '').split('.');
  const scale = 10n ** BigInt(f.length);
  const neg = (cents < 0n) !== String(factor).trim().startsWith('-');
  const num = (cents < 0n ? -cents : cents) * BigInt((i.replace('-', '') || '0') + f);
  const den = scale * BigInt(divisor);
  let q = num / den;
  if ((num % den) * 2n >= den) q += 1n;
  return neg && q !== 0n ? -q : q;
}

/** amount × rate% rounded to cents (rate as '16' or '16.0000'). */
export const percentOf = (amount, ratePct) => mulRound(amount, ratePct, 100n);

export function formatK(v, { symbol = 'K' } = {}) {
  const c = toCents(v);
  const neg = c < 0n;
  const s = fromCents(neg ? -c : c);
  const [i, f] = s.split('.');
  const grouped = i.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${neg ? '-' : ''}${symbol}${grouped}.${f}`;
}

export const toNumber = (v) => Number(fromCents(toCents(v))); // for charts only, never for accounting
