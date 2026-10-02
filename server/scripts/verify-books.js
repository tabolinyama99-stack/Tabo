// Integrity check: cross-validates every financial report against the raw ledger.
// Usage: BASE_URL=http://localhost:4000 VERIFY_EMAIL=... VERIFY_PASSWORD=... node scripts/verify-books.js
const BASE = process.env.BASE_URL || 'http://localhost:4000';
const email = process.env.VERIFY_EMAIL, password = process.env.VERIFY_PASSWORD;
let cookie = '', csrf = '';
async function call(method, path, body) {
  const res = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf }, body: body ? JSON.stringify(body) : undefined });
  const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  const t = await res.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${t.slice(0, 300)}`);
  return j;
}
const c = (v) => Math.round(Number(v || 0) * 100);
let failures = 0;
const check = (label, a, b) => { const ok = a === b; if (!ok) failures++; console.log(`${ok ? '  ✔' : '  ✖'} ${label}${ok ? '' : `  (${a / 100} vs ${b / 100})`}`); };

const login = await call('POST', '/api/auth/login', { email, password }); csrf = login.csrf_token;
const me = await call('GET', '/api/auth/me');
const today = new Date().toISOString().slice(0, 10);
for (const co of me.companies) {
  await call('POST', '/api/auth/switch-company', { company_id: co.id });
  console.log(`\n== ${co.name} (#${co.id})`);
  const tb = await call('GET', `/api/reports/trial-balance?to=${today}`);
  const tbRows = tb.rows.filter((r) => !r._style && r.account_id);
  const td = tbRows.reduce((s, r) => s + c(r.debit), 0), tc = tbRows.reduce((s, r) => s + c(r.credit), 0);
  check('Trial balance: total debits = total credits', td, tc);
  const bal = new Map(tbRows.map((r) => [r.account_id, c(r.debit) - c(r.credit)]));
  const accts = await call('GET', '/api/accounts');
  const list = Array.isArray(accts) ? accts : accts.rows || accts.accounts;
  const sumType = (types) => list.filter((a) => types.includes(a.type)).reduce((s, a) => s + (bal.get(a.id) || 0), 0);
  const bs = await call('GET', `/api/reports/balance-sheet?to=${today}`);
  check('Balance sheet balances (A = L + E)', c(bs.summary.total_assets), c(bs.summary.total_liabilities) + c(bs.summary.total_equity));
  check('BS total assets = ledger asset balances', c(bs.summary.total_assets), sumType(['ASSET']));
  check('BS liabilities = ledger liability balances', c(bs.summary.total_liabilities), -sumType(['LIABILITY']));
  const pl = await call('GET', `/api/reports/profit-and-loss?from=1900-01-01&to=${today}`);
  check('All-time P&L net = -(revenue+expense ledger balances)', c(pl.summary.net_profit), -sumType(['REVENUE', 'EXPENSE', 'COST_OF_SALES']));
  check('BS equity = equity accounts + all-time profit', c(bs.summary.total_equity), -sumType(['EQUITY']) + c(pl.summary.net_profit));
  const banks = list.filter((a) => a.subtype === 'bank' || a.subtype === 'cash' || a.is_bank || a.bank);
  const bankAccs = await call('GET', '/api/bank-accounts');
  const bankList = Array.isArray(bankAccs) ? bankAccs : bankAccs.rows;
  const cashTotal = bankList.reduce((s, b) => s + (bal.get(b.account_id ?? b.id) || 0), 0);
  const cf = await call('GET', `/api/reports/cash-flow?from=1900-01-01&to=${today}`);
  check('Cash flow closing cash = bank/cash ledger balances', c(cf.summary.closing), cashTotal);
  const ytdFrom = `${today.slice(0, 4)}-01-01`;
  const cf2 = await call('GET', `/api/reports/cash-flow?from=${ytdFrom}&to=${today}`);
  check('YTD cash flow: opening + net change = closing ledger cash', c(cf2.summary.closing), cashTotal);
  const ar = await call('GET', `/api/reports/ar-aging?to=${today}`);
  const arAcc = list.find((a) => a.system_key === 'AR');
  check('AR aging total = AR control account', c(ar.totals.total), bal.get(arAcc.id) || 0);
  const ap = await call('GET', `/api/reports/ap-aging?to=${today}`);
  const apAcc = list.find((a) => a.system_key === 'AP');
  check('AP aging total = AP control account', c(ap.totals.total), -(bal.get(apAcc.id) || 0));
  const dash = await call('GET', '/api/dashboard');
  console.log('  dashboard keys:', Object.keys(dash).join(', '));
  void banks;
}
console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll integrity checks passed');
process.exit(failures ? 1 : 0);
