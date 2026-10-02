// The double-entry accounting engine. Every financial number in the system is derived
// from journal lines written here. Balances are never stored or edited directly.
import { toCents, fromCents, formatK } from '../lib/money.js';
import { badRequest, unprocessable, conflict, forbidden, notFound } from '../lib/errors.js';
import { nextNumber } from '../lib/numbering.js';
import { audit } from '../lib/audit.js';
import { ensurePeriods } from './company-setup.js';

export const can = (ctx, perm) => !!ctx && (ctx.isSuperAdmin || ctx.permissions?.has(perm));
export function requirePerm(ctx, perm, msg) {
  if (!can(ctx, perm)) throw forbidden(msg);
}

/** Throws if amount exceeds the user's role transaction limit. */
export function checkLimit(ctx, amountCents, what = 'transaction') {
  if (!ctx || ctx.isSuperAdmin || ctx.system) return;
  const lim = ctx.role?.transaction_limit;
  if (lim !== null && lim !== undefined && amountCents > toCents(lim)) {
    throw forbidden(`This ${what} (${formatK(fromCents(amountCents))}) exceeds your transaction limit of ${formatK(lim)}. Submit it for approval instead.`);
  }
}
export const withinLimit = (ctx, amountCents) => {
  try { checkLimit(ctx, amountCents); return true; } catch { return false; }
};

export async function getSystemAccount(db, companyId, key) {
  const { rows } = await db.query('SELECT * FROM accounts WHERE company_id=$1 AND system_key=$2', [companyId, key]);
  if (!rows[0]) throw unprocessable(`The system account "${key}" is missing from the chart of accounts. Restore it in Chart of Accounts.`);
  return rows[0];
}

export async function assertPeriodOpen(db, companyId, date) {
  await ensurePeriods(db, companyId, date);
  const { rows } = await db.query(
    `SELECT name, status FROM fiscal_periods WHERE company_id=$1 AND $2::date BETWEEN start_date AND end_date`, [companyId, date]);
  if (rows[0] && rows[0].status !== 'OPEN') {
    throw conflict(`Financial period ${rows[0].name} is ${rows[0].status.toLowerCase()}. Choose a date in an open period or ask an authorised user to reopen it.`);
  }
}

/** Validate and normalise journal lines. Returns { lines, debit, credit } in cents. */
export async function validateLines(db, companyId, lines, { requireBalanced = true } = {}) {
  if (!Array.isArray(lines) || lines.length < 2) throw badRequest('A journal needs at least two lines.');
  const accIds = [...new Set(lines.map((l) => Number(l.account_id)))];
  const { rows: accs } = await db.query('SELECT id, code, name, is_active, type, system_key FROM accounts WHERE company_id=$1 AND id = ANY($2)', [companyId, accIds]);
  const byId = new Map(accs.map((a) => [a.id, a]));
  let debit = 0n, credit = 0n;
  const out = lines.map((l, i) => {
    const acc = byId.get(Number(l.account_id));
    if (!acc) throw badRequest(`Line ${i + 1}: account not found in this company.`);
    if (!acc.is_active) throw badRequest(`Line ${i + 1}: account ${acc.code} ${acc.name} is inactive.`);
    let d, c;
    try { d = toCents(l.debit || 0); c = toCents(l.credit || 0); } catch { throw badRequest(`Line ${i + 1}: invalid amount.`); }
    if (d < 0n || c < 0n) throw badRequest(`Line ${i + 1}: amounts cannot be negative.`);
    if ((d === 0n) === (c === 0n)) throw badRequest(`Line ${i + 1}: enter either a debit or a credit (not both, not neither).`);
    if (requireBalanced && acc.system_key === 'AR' && !l.customer_id) throw badRequest(`Line ${i + 1}: choose the customer for ${acc.code} ${acc.name} so customer balances stay correct.`);
    if (requireBalanced && acc.system_key === 'AP' && !l.supplier_id) throw badRequest(`Line ${i + 1}: choose the supplier for ${acc.code} ${acc.name} so supplier balances stay correct.`);
    debit += d; credit += c;
    return { ...l, account_id: acc.id, debitC: d, creditC: c };
  });
  for (const key of ['customer_id', 'supplier_id']) {
    const ids = [...new Set(out.map((l) => l[key]).filter(Boolean).map(Number))];
    if (ids.length) {
      const t = key === 'customer_id' ? 'customers' : 'suppliers';
      const { rows } = await db.query(`SELECT id FROM ${t} WHERE company_id=$1 AND id = ANY($2)`, [companyId, ids]);
      if (rows.length !== ids.length) throw badRequest(`A ${t.slice(0, -1)} on this journal does not belong to this company.`);
    }
  }
  if (requireBalanced && debit !== credit) {
    throw unprocessable(`Journal cannot be posted because debits and credits do not balance (debits ${formatK(fromCents(debit))}, credits ${formatK(fromCents(credit))}).`);
  }
  if (requireBalanced && debit === 0n) throw unprocessable('Journal total cannot be zero.');
  return { lines: out, debit, credit };
}

async function insertLines(db, companyId, entryId, lines, defaults = {}) {
  let n = 1;
  for (const l of lines) {
    await db.query(
      `INSERT INTO journal_lines (entry_id, company_id, line_no, account_id, description, debit, credit, customer_id, supplier_id, tax_rate_id, branch_id, department_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [entryId, companyId, n++, l.account_id, l.description || null, fromCents(l.debitC), fromCents(l.creditC),
       l.customer_id || null, l.supplier_id || null, l.tax_rate_id || null, l.branch_id || defaults.branch_id || null, l.department_id || defaults.department_id || null]);
  }
}

/**
 * Create a journal entry. status: 'POSTED' | 'DRAFT' | 'PENDING_APPROVAL'.
 * Must be called inside a transaction (db = client). Posting is atomic with the caller's work.
 */
export async function createJournal(db, ctx, input) {
  const companyId = ctx.companyId;
  const status = input.status || 'POSTED';
  const date = input.date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) throw badRequest('A valid date is required.');
  if (!input.description || !String(input.description).trim()) throw badRequest('A description is required.');
  const requireBalanced = status !== 'DRAFT';
  const { lines, debit } = await validateLines(db, companyId, input.lines, { requireBalanced });
  if (status === 'POSTED') await assertPeriodOpen(db, companyId, date);
  else await ensurePeriods(db, companyId, date);

  const number = await nextNumber(db, companyId, 'journal');
  const now = status === 'POSTED';
  const { rows: [e] } = await db.query(
    `INSERT INTO journal_entries (company_id, number, entry_date, reference, description, source_type, source_id, status, is_adjusting,
        reversal_of, auto_reverse_on, recurring_id, branch_id, department_id, total, ai_generated, ai_rationale, created_by,
        posted_by, posted_at, approved_by, approved_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22) RETURNING *`,
    [companyId, number, date, input.reference || null, String(input.description).trim(), input.source_type || 'MANUAL', input.source_id || null,
     status, !!input.is_adjusting, input.reversal_of || null, input.auto_reverse_on || null, input.recurring_id || null,
     input.branch_id || null, input.department_id || null, fromCents(debit), !!input.ai_generated, input.ai_rationale || null,
     ctx.user?.id || null, now ? ctx.user?.id || null : null, now ? new Date() : null,
     now && input.approved ? ctx.user?.id || null : null, now && input.approved ? new Date() : null]);
  await insertLines(db, companyId, e.id, lines, input);
  await audit(ctx, status === 'POSTED' ? 'journal.posted' : input.ai_generated ? 'ai.draft_created' : 'journal.created', {
    entityType: 'journal_entry', entityId: e.id,
    newValue: { number, date, status, source_type: e.source_type, total: e.total, description: e.description,
      lines: lines.map((l) => ({ account_id: l.account_id, debit: fromCents(l.debitC), credit: fromCents(l.creditC) })) },
  }, db);
  return e;
}

export async function getJournal(db, companyId, id) {
  const { rows: [e] } = await db.query(
    `SELECT e.*, cu.name AS created_by_name, pu.name AS posted_by_name, au.name AS approved_by_name
       FROM journal_entries e LEFT JOIN users cu ON cu.id=e.created_by LEFT JOIN users pu ON pu.id=e.posted_by LEFT JOIN users au ON au.id=e.approved_by
      WHERE e.company_id=$1 AND e.id=$2`, [companyId, id]);
  if (!e) throw notFound('Journal entry');
  const { rows: lines } = await db.query(
    `SELECT l.*, a.code AS account_code, a.name AS account_name, a.type AS account_type, c.name AS customer_name, s.name AS supplier_name
       FROM journal_lines l JOIN accounts a ON a.id=l.account_id LEFT JOIN customers c ON c.id=l.customer_id LEFT JOIN suppliers s ON s.id=l.supplier_id
      WHERE l.entry_id=$1 ORDER BY l.line_no`, [id]);
  const { rows: docs } = await db.query(`SELECT id, original_name, mime_type, size_bytes FROM documents WHERE company_id=$1 AND linked_type='journal_entry' AND linked_id=$2`, [companyId, id]);
  return { ...e, lines, documents: docs };
}

/** Replace the lines of a draft/pending journal. */
export async function updateDraftJournal(db, ctx, id, input) {
  const e = await getJournal(db, ctx.companyId, id);
  if (!['DRAFT', 'PENDING_APPROVAL'].includes(e.status)) throw conflict('Only draft journals can be edited. Reverse a posted journal instead.');
  if (e.source_type !== 'MANUAL' && e.source_type !== 'AI' && e.source_type !== 'RECURRING') throw conflict('This journal belongs to a source document; edit the document instead.');
  const { lines, debit } = await validateLines(db, ctx.companyId, input.lines, { requireBalanced: false });
  await db.query('DELETE FROM journal_lines WHERE entry_id=$1', [id]);
  await insertLines(db, ctx.companyId, id, lines, input);
  await db.query(`UPDATE journal_entries SET entry_date=$2, reference=$3, description=$4, is_adjusting=$5, total=$6, branch_id=$7, department_id=$8,
                  auto_reverse_on=$9, status='DRAFT', updated_at=now() WHERE id=$1`,
    [id, input.date || e.entry_date, input.reference ?? e.reference, input.description || e.description, !!input.is_adjusting,
     fromCents(debit), input.branch_id || null, input.department_id || null, input.auto_reverse_on || null]);
  await audit(ctx, 'journal.edited', { entityType: 'journal_entry', entityId: id, oldValue: { total: e.total, lines: e.lines.map((l) => ({ account_id: l.account_id, debit: l.debit, credit: l.credit })) }, newValue: { total: fromCents(debit), lines: input.lines } }, db);
  return getJournal(db, ctx.companyId, id);
}

/** Decide whether this user may post `amount` directly, or it must wait for approval. */
export function approvalRequired(ctx, amountCents, { thresholdKey = 'journal_approval_threshold', postPerm = 'post_journal' } = {}) {
  if (ctx.isSuperAdmin || ctx.system) return false;
  if (!can(ctx, postPerm)) return true;
  if (!withinLimit(ctx, amountCents)) return true;
  const thr = ctx.settings?.accounting?.[thresholdKey];
  if (thr && amountCents > toCents(thr) && !can(ctx, 'approve_transactions')) return true;
  return false;
}

/** Submit a draft for approval, or post it when the user is allowed to. */
export async function postDraftJournal(db, ctx, id, { asApproval = false } = {}) {
  const e = await getJournal(db, ctx.companyId, id);
  if (e.status === 'POSTED') throw conflict('This journal is already posted.');
  if (!['DRAFT', 'PENDING_APPROVAL'].includes(e.status)) throw conflict(`A ${e.status.toLowerCase()} journal cannot be posted.`);
  const { debit } = await validateLines(db, ctx.companyId, e.lines.map((l) => ({ ...l })), { requireBalanced: true });
  const isOwn = e.created_by === ctx.user?.id;
  if (asApproval) {
    requirePerm(ctx, 'approve_transactions', 'You do not have permission to approve transactions.');
    checkLimit(ctx, debit, 'approval');
    const thr = ctx.settings?.accounting?.journal_approval_threshold;
    if (ctx.settings?.accounting?.segregation_of_duties && isOwn && !ctx.isSuperAdmin && thr && debit > toCents(thr)) {
      throw forbidden('Segregation of duties: another authorised user must approve a journal you created above the approval threshold.');
    }
  } else if (approvalRequired(ctx, debit)) {
    await db.query(`UPDATE journal_entries SET status='PENDING_APPROVAL', updated_at=now() WHERE id=$1`, [id]);
    await audit(ctx, 'journal.submitted_for_approval', { entityType: 'journal_entry', entityId: id, newValue: { total: fromCents(debit) } }, db);
    return { ...(await getJournal(db, ctx.companyId, id)), _pendingApproval: true };
  }
  await assertPeriodOpen(db, ctx.companyId, e.entry_date);
  await db.query(`UPDATE journal_entries SET status='POSTED', total=$2, posted_by=$3, posted_at=now(), approved_by=$4, approved_at=$5, updated_at=now() WHERE id=$1`,
    [id, fromCents(debit), ctx.user?.id || null, asApproval || e.ai_generated ? ctx.user?.id : null, asApproval || e.ai_generated ? new Date() : null]);
  await audit(ctx, e.ai_generated ? 'ai.draft_approved_and_posted' : asApproval ? 'journal.approved_and_posted' : 'journal.posted',
    { entityType: 'journal_entry', entityId: id, oldValue: { status: e.status }, newValue: { status: 'POSTED', total: fromCents(debit) } }, db);
  return getJournal(db, ctx.companyId, id);
}

/** Post the mirror image of a journal and mark the original REVERSED. */
export async function reverseJournal(db, ctx, id, { date, reason, fromSource = false } = {}) {
  const e = await getJournal(db, ctx.companyId, id);
  if (e.status !== 'POSTED') throw conflict('Only posted journals can be reversed.');
  if (!fromSource && !['MANUAL', 'AI', 'RECURRING', 'BANK', 'OPENING'].includes(e.source_type)) {
    throw conflict(`This journal was generated by a ${e.source_type.toLowerCase().replace('_', ' ')}. Cancel or void that document instead so the sub-ledgers stay correct.`);
  }
  const revDate = date || e.entry_date;
  const rev = await createJournal(db, ctx, {
    date: revDate, reference: e.number, description: `Reversal of ${e.number}${reason ? ` — ${reason}` : ''}`,
    source_type: fromSource ? e.source_type : 'REVERSAL', source_id: fromSource ? e.source_id : e.id, status: 'POSTED', reversal_of: e.id,
    lines: e.lines.map((l) => ({ account_id: l.account_id, debit: l.credit, credit: l.debit, description: l.description,
      customer_id: l.customer_id, supplier_id: l.supplier_id, tax_rate_id: l.tax_rate_id, branch_id: l.branch_id, department_id: l.department_id })),
  });
  await db.query(`UPDATE journal_entries SET status='REVERSED', reversed_by=$2, updated_at=now() WHERE id=$1`, [id, rev.id]);
  await audit(ctx, 'journal.reversed', { entityType: 'journal_entry', entityId: id, newValue: { reversal_id: rev.id, reason } }, db);
  return rev;
}

export async function deleteDraftJournal(db, ctx, id) {
  const e = await getJournal(db, ctx.companyId, id);
  if (!['DRAFT', 'PENDING_APPROVAL'].includes(e.status)) throw conflict('Only draft journals can be deleted. Reverse a posted journal instead.');
  await db.query(`UPDATE journal_entries SET status='VOID', updated_at=now() WHERE id=$1`, [id]);
  await audit(ctx, 'journal.voided_draft', { entityType: 'journal_entry', entityId: id, oldValue: { status: e.status } }, db);
}

/** Balance of each account (debit - credit) over a date range from the posted ledger. */
export async function accountBalances(db, companyId, { from, to, branchId, departmentId } = {}) {
  const p = [companyId];
  let w = '';
  if (from) { p.push(from); w += ` AND l.entry_date >= $${p.length}`; }
  if (to) { p.push(to); w += ` AND l.entry_date <= $${p.length}`; }
  if (branchId) { p.push(branchId); w += ` AND l.branch_id = $${p.length}`; }
  if (departmentId) { p.push(departmentId); w += ` AND l.department_id = $${p.length}`; }
  const { rows } = await db.query(
    `SELECT a.id, a.code, a.name, a.type, a.subtype, a.system_key, a.parent_id, a.is_active, a.cash_flow_category,
            COALESCE(SUM(l.debit),0)::numeric(18,2) AS debit, COALESCE(SUM(l.credit),0)::numeric(18,2) AS credit
       FROM accounts a LEFT JOIN ledger l ON l.account_id = a.id AND l.company_id = a.company_id ${w}
      WHERE a.company_id = $1 GROUP BY a.id ORDER BY a.code`, p);
  return rows.map((r) => ({ ...r, balance: fromCents(toCents(r.debit) - toCents(r.credit)) }));
}

export async function accountBalance(db, companyId, accountId, asOf) {
  const { rows: [r] } = await db.query(
    `SELECT COALESCE(SUM(debit - credit),0)::numeric(18,2) AS bal FROM ledger WHERE company_id=$1 AND account_id=$2 ${asOf ? 'AND entry_date <= $3' : ''}`,
    asOf ? [companyId, accountId, asOf] : [companyId, accountId]);
  return r.bal;
}

/** Normal-balance sign: assets/expenses are debit-normal; liabilities/equity/revenue credit-normal. */
export const isDebitNormal = (type) => ['ASSET', 'EXPENSE', 'COST_OF_SALES'].includes(type);
export const naturalBalance = (type, debitMinusCredit) => (isDebitNormal(type) ? toCents(debitMinusCredit) : -toCents(debitMinusCredit));
