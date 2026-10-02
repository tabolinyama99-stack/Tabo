// Small cached lookups used by forms (accounts, parties, tax rates, bank accounts...).
import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';

const cache = new Map();
export function invalidate(prefix) { for (const k of cache.keys()) if (k.startsWith(prefix)) cache.delete(k); }
export function useLookup(url) {
  const [data, setData] = useState(() => cache.get(url)?.data || []);
  useEffect(() => {
    if (!url) return undefined;
    let alive = true;
    const c = cache.get(url);
    if (c && Date.now() - c.at < 60_000) { setData(c.data); return undefined; }
    api.get(url).then((d) => { cache.set(url, { data: d, at: Date.now() }); if (alive) setData(d); }).catch(() => {});
    return () => { alive = false; };
  }, [url]);
  return data;
}

const TYPE_ORDER = ['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'COST_OF_SALES', 'EXPENSE'];
const TYPE_LABEL = { ASSET: 'Assets', LIABILITY: 'Liabilities', EQUITY: 'Equity', REVENUE: 'Revenue', COST_OF_SALES: 'Cost of sales', EXPENSE: 'Expenses' };
/** Grouped <Select> options for accounts, optionally restricted by type. */
export function accountOptions(accounts, types) {
  return TYPE_ORDER.filter((t) => !types || types.includes(t)).map((t) => ({ group: TYPE_LABEL[t], options: accounts.filter((a) => a.type === t && a.is_active).map((a) => ({ value: a.id, label: `${a.code} · ${a.name}` })) })).filter((g) => g.options.length);
}
export const partyOptions = (list) => list.filter((p) => p.is_active !== false).map((p) => ({ value: p.id, label: p.name }));
export const taxOptions = (rates, appliesTo) => {
  const today = new Date().toISOString().slice(0, 10);
  return rates.filter((t) => t.is_active && t.tax_type !== 'WHT' && t.effective_from <= today && (!t.effective_to || t.effective_to >= today) && (!appliesTo || ['BOTH', appliesTo].includes(t.applies_to)))
    .map((t) => ({ value: t.id, label: `${t.code} (${Number(t.rate)}%)` }));
};
export const bankOptions = (banks) => banks.filter((b) => b.is_active).map((b) => ({ value: b.id, label: `${b.name}${b.is_cash ? ' (cash)' : ''}` }));
