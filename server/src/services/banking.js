// Banking: bank & cash accounts, deposits/withdrawals/transfers, statement import, matching, reconciliation.
import ExcelJS from 'exceljs';
import { toCents, fromCents, formatK, abs } from '../lib/money.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { sha256 } from '../lib/crypto.js';
import { createJournal, accountBalance, checkLimit } from './ledger.js';

export async function listBankAccounts(db, companyId) {
  const { rows } = await db.query(
    `SELECT a.id, a.code, a.name, a.is_active, a.subtype, b.bank_name, b.account_number, b.branch_name, b.currency, b.is_cash, b.low_balance_threshold,
            COALESCE((SELECT SUM(debit-credit) FROM ledger l WHERE l.account_id=a.id),0)::numeric(18,2) AS balance,
            COALESCE((SELECT SUM(debit-credit) FROM ledger l WHERE l.account_id=a.id AND l.cleared),0)::numeric(18,2) AS cleared_balance,
            (SELECT COUNT(*) FROM bank_statement_lines s WHERE s.bank_account_id=a.id AND s.status='UNMATCHED')::int AS unmatched_lines,
            (SELECT MAX(statement_date) FROM reconciliations r WHERE r.bank_account_id=a.id AND r.status='COMPLETED') AS last_reconciled
       FROM accounts a JOIN bank_accounts b ON b.account_id=a.id WHERE a.company_id=$1 ORDER BY b.is_cash, a.code`, [companyId]);
  return rows;
}

export async function createBankAccount(db, ctx, input) {
  if (!input.name) throw badRequest('Account name is required.');
  if (!input.code) throw badRequest('Account code is required.');
  const isCash = !!input.is_cash;
  const { rows: [a] } = await db.query(
    `INSERT INTO accounts (company_id, code, name, type, subtype, cash_flow_category) VALUES ($1,$2,$3,'ASSET',$4,'CASH') RETURNING id`,
    [ctx.companyId, input.code, input.name, isCash ? 'cash' : 'bank']);
  await db.query(`INSERT INTO bank_accounts (account_id, company_id, bank_name, account_number, branch_name, currency, is_cash, low_balance_threshold) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [a.id, ctx.companyId, input.bank_name || null, input.account_number || null, input.branch_name || null, input.currency || 'ZMW', isCash, input.low_balance_threshold || null]);
  await audit(ctx, 'bank_account.created', { entityType: 'account', entityId: a.id, newValue: { name: input.name, bank: input.bank_name, number: input.account_number } }, db);
  return a;
}

export async function updateBankAccount(db, ctx, id, input) {
  const { rows: [b] } = await db.query(`SELECT a.name, b.* FROM bank_accounts b JOIN accounts a ON a.id=b.account_id WHERE b.company_id=$1 AND b.account_id=$2`, [ctx.companyId, id]);
  if (!b) throw notFound('Bank account');
  await db.query(`UPDATE bank_accounts SET bank_name=$2, account_number=$3, branch_name=$4, low_balance_threshold=$5 WHERE account_id=$1`,
    [id, input.bank_name ?? b.bank_name, input.account_number ?? b.account_number, input.branch_name ?? b.branch_name, input.low_balance_threshold === '' ? null : input.low_balance_threshold ?? b.low_balance_threshold]);
  if (input.name) await db.query('UPDATE accounts SET name=$2 WHERE id=$1', [id, input.name]);
  await audit(ctx, 'bank_account.updated', { entityType: 'account', entityId: id, oldValue: b, newValue: input }, db);
}

async function assertBank(db, companyId, id) {
  const { rows: [a] } = await db.query(`SELECT a.* FROM accounts a JOIN bank_accounts b ON b.account_id=a.id WHERE a.company_id=$1 AND a.id=$2`, [companyId, id]);
  if (!a) throw badRequest('Bank/cash account not found.');
  return a;
}

/** kind: DEPOSIT (money in, from contra account), WITHDRAWAL (money out to contra), TRANSFER (bank → bank). */
export async function recordBankTransaction(db, ctx, input) {
  const kind = input.kind;
  const amt = toCents(input.amount);
  if (amt <= 0n) throw badRequest('Amount must be greater than zero.');
  checkLimit(ctx, amt);
  const bank = await assertBank(db, ctx.companyId, input.bank_account_id);
  let lines, description;
  if (kind === 'TRANSFER') {
    const to = await assertBank(db, ctx.companyId, input.to_account_id);
    if (to.id === bank.id) throw badRequest('Choose two different accounts for a transfer.');
    if (!ctx.settings?.accounting?.allow_negative_cash && toCents(await accountBalance(db, ctx.companyId, bank.id)) < amt) throw conflict(`Insufficient funds in ${bank.name}.`);
    lines = [{ account_id: to.id, debit: fromCents(amt) }, { account_id: bank.id, credit: fromCents(amt) }];
    description = input.description || `Transfer from ${bank.name} to ${to.name}`;
  } else if (kind === 'DEPOSIT' || kind === 'WITHDRAWAL') {
    if (!input.contra_account_id) throw badRequest('Choose the account this money came from / went to.');
    if (kind === 'WITHDRAWAL' && !ctx.settings?.accounting?.allow_negative_cash && toCents(await accountBalance(db, ctx.companyId, bank.id)) < amt) throw conflict(`Insufficient funds in ${bank.name}.`);
    lines = kind === 'DEPOSIT'
      ? [{ account_id: bank.id, debit: fromCents(amt) }, { account_id: input.contra_account_id, credit: fromCents(amt) }]
      : [{ account_id: input.contra_account_id, debit: fromCents(amt) }, { account_id: bank.id, credit: fromCents(amt) }];
    description = input.description || (kind === 'DEPOSIT' ? `Deposit to ${bank.name}` : `Withdrawal from ${bank.name}`);
  } else throw badRequest('Unknown transaction type.');
  return createJournal(db, ctx, { date: input.date, reference: input.reference, description, source_type: 'BANK', status: 'POSTED', lines, approved: true });
}

/** All ledger movements on a bank/cash account with running balance (the cashbook). */
export async function bankRegister(db, companyId, accountId, { from, to } = {}) {
  await assertBank(db, companyId, accountId);
  const opening = from ? await accountBalance(db, companyId, accountId, prevDay(from)) : '0.00';
  const p = [companyId, accountId]; let w = '';
  if (from) { p.push(from); w += ` AND entry_date >= $${p.length}`; }
  if (to) { p.push(to); w += ` AND entry_date <= $${p.length}`; }
  const { rows } = await db.query(
    `SELECT l.id, l.entry_id, l.entry_date, l.entry_number, l.reference, COALESCE(l.description, l.entry_description) AS description, l.source_type, l.source_id,
            l.debit, l.credit, l.cleared, l.reconciliation_id
       FROM ledger l WHERE l.company_id=$1 AND l.account_id=$2 ${w} ORDER BY l.entry_date, l.entry_id, l.line_no`, p);
  let run = toCents(opening);
  return { opening_balance: opening, rows: rows.map((r) => { run += toCents(r.debit) - toCents(r.credit); return { ...r, balance: fromCents(run) }; }), closing_balance: fromCents(run) };
}

export function prevDay(d) { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() - 1); return x.toISOString().slice(0, 10); }

// ───────────── Statement import ─────────────
export function parseCsv(text) {
  const rows = []; let row = []; let cur = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',' || ch === ';' || ch === '\t') { row.push(cur); cur = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cur); rows.push(row); row = []; cur = ''; }
    else cur += ch;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
/** Parse dates as used in Zambia (DD/MM/YYYY first), ISO, '05 Mar 2026', or Excel serials/Date objects. */
export function parseDate(v) {
  if (v instanceof Date && !isNaN(v)) return v.toISOString().slice(0, 10);
  const s = String(v ?? '').trim();
  if (!s) return null;
  let m;
  if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) return iso(+m[1], +m[2], +m[3]);
  if ((m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/))) return iso(m[3].length === 2 ? 2000 + +m[3] : +m[3], +m[2], +m[1]);
  if ((m = s.match(/^(\d{1,2})[\s-]([A-Za-z]{3})[A-Za-z]*[\s-](\d{2,4})$/))) return iso(m[3].length === 2 ? 2000 + +m[3] : +m[3], MONTHS[m[2].toLowerCase()], +m[1]);
  if (/^\d{5}$/.test(s)) { const d = new Date(Date.UTC(1899, 11, 30) + Number(s) * 86400000); return d.toISOString().slice(0, 10); }
  return null;
}
function iso(y, mo, d) {
  if (!y || !mo || !d || mo > 12 || d > 31) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCMonth() !== mo - 1) return null;
  return dt.toISOString().slice(0, 10);
}
function parseAmount(v) {
  if (v === null || v === undefined || String(v).trim() === '') return null;
  let s = String(typeof v === 'object' && v.result !== undefined ? v.result : v).trim().replace(/[K\s]|ZMW/gi, '');
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  if (/CR$/i.test(s)) s = s.slice(0, -2);
  if (/DR$/i.test(s)) { neg = true; s = s.slice(0, -2); }
  try { const c = toCents(s); return neg ? -c : c; } catch { return null; }
}

async function readRows(buffer, filename) {
  if (/\.xlsx?$/i.test(filename)) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    const ws = wb.worksheets[0];
    const rows = [];
    ws.eachRow((r) => rows.push(r.values.slice(1).map((c) => (c && typeof c === 'object' && !(c instanceof Date) ? (c.text ?? c.result ?? '') : c))));
    return rows;
  }
  return parseCsv(buffer.toString('utf8').replace(/^﻿/, ''));
}

/** Detect columns by header names. Returns indexes for date, description, reference, amount | debit/credit, balance. */
export function detectColumns(header) {
  const h = header.map((x) => String(x ?? '').toLowerCase().trim());
  const find = (...names) => h.findIndex((x) => names.some((n) => x === n || x.includes(n)));
  const cols = {
    date: find('transaction date', 'value date', 'posting date', 'date'),
    description: find('description', 'narration', 'details', 'particulars', 'memo'),
    reference: find('reference', 'ref', 'cheque', 'transaction id'),
    debit: find('debit', 'withdrawal', 'money out', 'paid out'),
    credit: find('credit', 'deposit', 'money in', 'paid in'),
    amount: find('amount', 'value'),
    balance: find('balance', 'running balance'),
  };
  if (cols.date < 0) throw badRequest('Could not find a Date column in the statement. Include a header row with Date, Description and Amount (or Debit/Credit).');
  if (cols.amount < 0 && (cols.debit < 0 || cols.credit < 0)) throw badRequest('Could not find an Amount column (or Debit and Credit columns) in the statement.');
  return cols;
}

export async function importStatement(db, ctx, bankAccountId, { buffer, filename, mapping }) {
  const bank = await assertBank(db, ctx.companyId, bankAccountId);
  const rows = await readRows(buffer, filename || 'statement.csv');
  if (rows.length < 2) throw badRequest('The statement file has no transactions.');
  const headerIdx = rows.findIndex((r) => r.some((c) => /date/i.test(String(c ?? ''))));
  if (headerIdx < 0) throw badRequest('Could not find the header row (a row containing "Date").');
  const cols = mapping || detectColumns(rows[headerIdx]);
  const { rows: [imp] } = await db.query(`INSERT INTO bank_statement_imports (company_id, bank_account_id, filename, imported_by) VALUES ($1,$2,$3,$4) RETURNING id`,
    [ctx.companyId, bank.id, filename || null, ctx.user?.id || null]);
  let imported = 0, skipped = 0; const errors = []; const seen = new Map();
  for (const [i, r] of rows.slice(headerIdx + 1).entries()) {
    const date = parseDate(r[cols.date]);
    let amount = cols.amount >= 0 && (cols.debit < 0 || cols.credit < 0) ? parseAmount(r[cols.amount]) : null;
    if (amount === null && cols.debit >= 0 && cols.credit >= 0) {
      const d = parseAmount(r[cols.debit]) || 0n, c = parseAmount(r[cols.credit]) || 0n;
      amount = abs(fromCents(c)) - abs(fromCents(d));
    }
    if (!date || amount === null || amount === 0n) { if (r.some((c) => String(c ?? '').trim())) errors.push(`Row ${headerIdx + i + 2}: skipped (no date or amount)`); skipped++; continue; }
    const description = cols.description >= 0 ? String(r[cols.description] ?? '').trim() : '';
    const reference = cols.reference >= 0 ? String(r[cols.reference] ?? '').trim() : '';
    const balance = cols.balance >= 0 ? parseAmount(r[cols.balance]) : null;
    const base = `${date}|${fromCents(amount)}|${description}|${reference}`;
    const occ = (seen.get(base) || 0) + 1; seen.set(base, occ);
    const fp = sha256(`${base}|${occ}`);
    const res = await db.query(
      `INSERT INTO bank_statement_lines (company_id, bank_account_id, import_id, txn_date, description, reference, amount, balance, fingerprint)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (company_id, bank_account_id, fingerprint) DO NOTHING`,
      [ctx.companyId, bank.id, imp.id, date, description || null, reference || null, fromCents(amount), balance === null ? null : fromCents(balance), fp]);
    if (res.rowCount) imported++; else skipped++;
  }
  await db.query('UPDATE bank_statement_imports SET line_count=$2 WHERE id=$1', [imp.id, imported]);
  await audit(ctx, 'bank.statement_imported', { entityType: 'account', entityId: bank.id, newValue: { filename, imported, skipped } }, db);
  const auto = await autoMatch(db, ctx, bank.id, { apply: true, minScore: 90 });
  return { import_id: imp.id, imported, skipped_duplicates_or_blank: skipped, errors: errors.slice(0, 20), auto_matched: auto.applied };
}

const words = (s) => new Set(String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2));

/** Score candidate ledger lines for each unmatched statement line (exact amount required). */
export async function suggestMatches(db, companyId, bankAccountId, statementLineId = null) {
  const p = [companyId, bankAccountId]; let w = '';
  if (statementLineId) { p.push(statementLineId); w = ` AND s.id=$${p.length}`; }
  const { rows: stmt } = await db.query(`SELECT * FROM bank_statement_lines s WHERE s.company_id=$1 AND s.bank_account_id=$2 AND s.status='UNMATCHED' ${w} ORDER BY txn_date`, p);
  const { rows: book } = await db.query(
    `SELECT l.id, l.entry_id, l.entry_date, l.entry_number, l.reference, COALESCE(l.description, l.entry_description) AS description, (l.debit - l.credit)::numeric(18,2) AS amount
       FROM ledger l WHERE l.company_id=$1 AND l.account_id=$2 AND NOT l.cleared
        AND NOT EXISTS (SELECT 1 FROM bank_statement_lines s WHERE s.matched_line_id = l.id)`, [companyId, bankAccountId]);
  return stmt.map((s) => {
    const sw = words(`${s.description} ${s.reference}`);
    const cands = book.filter((b) => toCents(b.amount) === toCents(s.amount)).map((b) => {
      const days = Math.abs((new Date(b.entry_date) - new Date(s.txn_date)) / 86400000);
      let score = 60 - Math.min(days, 30) * 2;
      const bw = words(`${b.description} ${b.reference} ${b.entry_number}`);
      const overlap = [...sw].filter((x) => bw.has(x)).length;
      score += Math.min(overlap * 10, 30);
      if (s.reference && b.reference && String(b.reference).toLowerCase() === String(s.reference).toLowerCase()) score += 20;
      if (days === 0) score += 10;
      return { ...b, days_apart: days, score: Math.max(0, Math.min(100, Math.round(score))) };
    }).filter((c) => c.days_apart <= 30).sort((a, b) => b.score - a.score).slice(0, 5);
    return { statement_line: s, candidates: cands };
  });
}

export async function matchLine(db, ctx, statementLineId, journalLineId) {
  const { rows: [s] } = await db.query(`SELECT * FROM bank_statement_lines WHERE company_id=$1 AND id=$2 FOR UPDATE`, [ctx.companyId, statementLineId]);
  if (!s) throw notFound('Statement line');
  if (s.status === 'MATCHED') throw conflict('This statement line is already matched.');
  const { rows: [l] } = await db.query(`SELECT * FROM ledger WHERE company_id=$1 AND id=$2`, [ctx.companyId, journalLineId]);
  if (!l || l.account_id !== s.bank_account_id) throw badRequest('The accounting transaction must be on the same bank account.');
  if (toCents(l.debit) - toCents(l.credit) !== toCents(s.amount)) throw badRequest(`Amounts differ: statement ${formatK(s.amount)} vs book ${formatK(fromCents(toCents(l.debit) - toCents(l.credit)))}.`);
  const { rows: used } = await db.query('SELECT id FROM bank_statement_lines WHERE matched_line_id=$1', [journalLineId]);
  if (used.length) throw conflict('That accounting transaction is already matched to another statement line.');
  await db.query(`UPDATE bank_statement_lines SET status='MATCHED', matched_line_id=$2, matched_by=$3, matched_at=now() WHERE id=$1`, [s.id, journalLineId, ctx.user?.id || null]);
  await db.query(`UPDATE journal_lines SET cleared=true WHERE id=$1`, [journalLineId]);
  await audit(ctx, 'bank.matched', { entityType: 'bank_statement_line', entityId: s.id, newValue: { journal_line_id: journalLineId, amount: s.amount } }, db);
}

export async function unmatchLine(db, ctx, statementLineId) {
  const { rows: [s] } = await db.query(`SELECT * FROM bank_statement_lines WHERE company_id=$1 AND id=$2`, [ctx.companyId, statementLineId]);
  if (!s) throw notFound('Statement line');
  if (s.reconciliation_id) {
    const { rows: [r] } = await db.query('SELECT status FROM reconciliations WHERE id=$1', [s.reconciliation_id]);
    if (r?.status === 'COMPLETED') throw conflict('This line is part of a completed reconciliation and cannot be unmatched.');
  }
  if (s.matched_line_id) await db.query(`UPDATE journal_lines SET cleared=false WHERE id=$1 AND reconciliation_id IS NULL`, [s.matched_line_id]);
  await db.query(`UPDATE bank_statement_lines SET status='UNMATCHED', matched_line_id=NULL, matched_by=NULL, matched_at=NULL WHERE id=$1`, [s.id]);
  await audit(ctx, 'bank.unmatched', { entityType: 'bank_statement_line', entityId: s.id, oldValue: { journal_line_id: s.matched_line_id } }, db);
}

export async function excludeLine(db, ctx, statementLineId, exclude = true) {
  await db.query(`UPDATE bank_statement_lines SET status=$3 WHERE company_id=$1 AND id=$2 AND status <> 'MATCHED'`, [ctx.companyId, statementLineId, exclude ? 'EXCLUDED' : 'UNMATCHED']);
  await audit(ctx, exclude ? 'bank.line_excluded' : 'bank.line_included', { entityType: 'bank_statement_line', entityId: statementLineId }, db);
}

/** Create the missing book entry for a statement line (e.g. bank charges) and match it. */
export async function createFromStatementLine(db, ctx, statementLineId, { contra_account_id, description }) {
  const { rows: [s] } = await db.query(`SELECT * FROM bank_statement_lines WHERE company_id=$1 AND id=$2`, [ctx.companyId, statementLineId]);
  if (!s) throw notFound('Statement line');
  if (s.status !== 'UNMATCHED') throw conflict('This statement line is already handled.');
  const amt = toCents(s.amount);
  const je = await recordBankTransaction(db, ctx, {
    kind: amt > 0n ? 'DEPOSIT' : 'WITHDRAWAL', bank_account_id: s.bank_account_id, contra_account_id, amount: fromCents(abs(s.amount)),
    date: s.txn_date, reference: s.reference, description: description || s.description || 'Bank statement entry',
  });
  const { rows: [line] } = await db.query(`SELECT id FROM journal_lines WHERE entry_id=$1 AND account_id=$2`, [je.id, s.bank_account_id]);
  await matchLine(db, ctx, s.id, line.id);
  return je;
}

export async function autoMatch(db, ctx, bankAccountId, { apply = true, minScore = 80 } = {}) {
  const sugg = await suggestMatches(db, ctx.companyId, bankAccountId);
  const used = new Set(); let applied = 0;
  for (const s of sugg) {
    const best = s.candidates.find((c) => !used.has(c.id));
    const second = s.candidates.filter((c) => !used.has(c.id))[1];
    if (best && best.score >= minScore && (!second || best.score - second.score >= 10)) {
      used.add(best.id);
      if (apply) { await matchLine(db, ctx, s.statement_line.id, best.id); applied++; }
    }
  }
  return { applied };
}

// ───────────── Reconciliation ─────────────
export async function startReconciliation(db, ctx, { bank_account_id, statement_date, statement_balance }) {
  await assertBank(db, ctx.companyId, bank_account_id);
  if (!statement_date) throw badRequest('Statement date is required.');
  const { rows: open } = await db.query(`SELECT id FROM reconciliations WHERE company_id=$1 AND bank_account_id=$2 AND status='IN_PROGRESS'`, [ctx.companyId, bank_account_id]);
  if (open[0]) throw conflict('A reconciliation is already in progress for this account. Complete or delete it first.');
  const { rows: [last] } = await db.query(`SELECT statement_balance, statement_date FROM reconciliations WHERE company_id=$1 AND bank_account_id=$2 AND status='COMPLETED' ORDER BY statement_date DESC LIMIT 1`, [ctx.companyId, bank_account_id]);
  if (last && last.statement_date >= statement_date) throw badRequest(`Statement date must be after the last reconciliation (${last.statement_date}).`);
  const { rows: [r] } = await db.query(
    `INSERT INTO reconciliations (company_id, bank_account_id, statement_date, statement_balance, opening_balance, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [ctx.companyId, bank_account_id, statement_date, fromCents(toCents(statement_balance)), last?.statement_balance || '0.00', ctx.user?.id || null]);
  await audit(ctx, 'reconciliation.started', { entityType: 'reconciliation', entityId: r.id, newValue: { statement_date, statement_balance } }, db);
  return getReconciliation(db, ctx.companyId, r.id);
}

export async function getReconciliation(db, companyId, id) {
  const { rows: [r] } = await db.query(`SELECT r.*, a.name AS bank_account_name, u.name AS completed_by_name FROM reconciliations r JOIN accounts a ON a.id=r.bank_account_id LEFT JOIN users u ON u.id=r.completed_by WHERE r.company_id=$1 AND r.id=$2`, [companyId, id]);
  if (!r) throw notFound('Reconciliation');
  const { rows: lines } = await db.query(
    `SELECT l.id, l.entry_id, l.entry_date, l.entry_number, l.reference, COALESCE(l.description, l.entry_description) AS description, l.debit, l.credit, l.cleared, l.reconciliation_id
       FROM ledger l WHERE l.company_id=$1 AND l.account_id=$2 AND l.entry_date <= $3 AND (l.reconciliation_id IS NULL OR l.reconciliation_id=$4)
      ORDER BY l.entry_date, l.entry_id`, [companyId, r.bank_account_id, r.statement_date, id]);
  const book = toCents(await accountBalance(db, companyId, r.bank_account_id, r.statement_date));
  const { rows: [prev] } = await db.query(
    `SELECT COALESCE(SUM(debit-credit),0)::numeric(18,2) AS v FROM ledger WHERE company_id=$1 AND account_id=$2 AND reconciliation_id IS NOT NULL AND reconciliation_id <> $3`, [companyId, r.bank_account_id, id]);
  const clearedNow = lines.filter((l) => l.cleared).reduce((s, l) => s + toCents(l.debit) - toCents(l.credit), 0n);
  const cleared = toCents(prev.v) + clearedNow;
  const difference = toCents(r.statement_balance) - cleared;
  const outstanding = lines.filter((l) => !l.cleared);
  return {
    ...r, lines, book_balance: fromCents(book), cleared_balance: fromCents(cleared), difference: fromCents(difference),
    uncleared_deposits: fromCents(outstanding.reduce((s, l) => s + toCents(l.debit), 0n)),
    uncleared_payments: fromCents(outstanding.reduce((s, l) => s + toCents(l.credit), 0n)),
  };
}

export async function toggleCleared(db, ctx, reconciliationId, journalLineIds, cleared) {
  const r = await getReconciliation(db, ctx.companyId, reconciliationId);
  if (r.status !== 'IN_PROGRESS') throw conflict('This reconciliation is completed.');
  const allowed = new Set(r.lines.map((l) => l.id));
  const ids = journalLineIds.map(Number).filter((i) => allowed.has(i));
  if (ids.length) await db.query(`UPDATE journal_lines SET cleared=$2 WHERE id = ANY($1) AND reconciliation_id IS NULL`, [ids, !!cleared]);
  return getReconciliation(db, ctx.companyId, reconciliationId);
}

export async function completeReconciliation(db, ctx, id) {
  const r = await getReconciliation(db, ctx.companyId, id);
  if (r.status !== 'IN_PROGRESS') throw conflict('This reconciliation is already completed.');
  if (toCents(r.difference) !== 0n) throw conflict(`The reconciliation is out by ${formatK(r.difference)}. Clear the matching transactions or record the missing ones before completing.`);
  const ids = r.lines.filter((l) => l.cleared && !l.reconciliation_id).map((l) => l.id);
  if (ids.length) await db.query(`UPDATE journal_lines SET reconciliation_id=$2 WHERE id = ANY($1)`, [ids, id]);
  await db.query(`UPDATE bank_statement_lines SET reconciliation_id=$2 WHERE matched_line_id = ANY($1)`, [ids, id]);
  await db.query(`UPDATE reconciliations SET status='COMPLETED', book_balance=$2, cleared_balance=$3, difference=0, completed_by=$4, completed_at=now() WHERE id=$1`,
    [id, r.book_balance, r.cleared_balance, ctx.user?.id || null]);
  await audit(ctx, 'reconciliation.completed', { entityType: 'reconciliation', entityId: id, newValue: { statement_balance: r.statement_balance, book_balance: r.book_balance, lines: ids.length } }, db);
  return getReconciliation(db, ctx.companyId, id);
}

export async function deleteReconciliation(db, ctx, id) {
  const r = await getReconciliation(db, ctx.companyId, id);
  if (r.status === 'COMPLETED') throw conflict('Completed reconciliations cannot be deleted.');
  await db.query('DELETE FROM reconciliations WHERE id=$1', [id]);
  await audit(ctx, 'reconciliation.deleted', { entityType: 'reconciliation', entityId: id }, db);
}
