// AI-assisted anomaly detection. Rules + simple statistics over posted data.
// Wording is deliberately neutral: a flag means "requires review", never an accusation.
import { toCents, fromCents, formatK } from '../lib/money.js';
import { notify } from './notifications.js';
import { audit } from '../lib/audit.js';

const KEYWORDS = [
  { re: /\b(fuel|petrol|diesel|puma|total ?energies|engen)\b/i, key: 'FUEL', label: 'Fuel' },
  { re: /\b(rent|rental|lease)\b/i, key: 'RENT', label: 'Rent' },
  { re: /\b(stationery|paper|toner|pens?|office supplies)\b/i, key: 'OFFICE_SUPPLIES', label: 'Office Supplies & Stationery' },
  { re: /\b(bank charges?|ledger fee|service fee|commission)\b/i, key: 'BANK_CHARGES', label: 'Bank Charges' },
  { re: /\b(taxi|bus fare|flight|transport|travel)\b/i, key: 'TRANSPORT', label: 'Transport & Travel' },
  { re: /\b(salary|salaries|wages)\b/i, key: 'SALARIES', label: 'Salaries & Wages' },
];

async function flag(db, companyId, f) {
  const { rows } = await db.query(
    `INSERT INTO review_flags (company_id, kind, severity, entity_type, entity_id, message, details) VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (company_id, kind, entity_type, entity_id) DO NOTHING RETURNING id`,
    [companyId, f.kind, f.severity || 'MEDIUM', f.entity_type, f.entity_id, f.message, JSON.stringify(f.details || {})]);
  return rows[0]?.id ? 1 : 0;
}

export async function scanAnomalies(db, companyId, { since } = {}) {
  const { rows: [c] } = await db.query('SELECT settings FROM companies WHERE id=$1', [companyId]);
  const ai = c.settings?.ai || {};
  if (ai.anomaly_detection === false) return { created: 0, skipped: true };
  const win = Number(ai.duplicate_window_days ?? 3);
  const mult = Number(ai.large_expense_multiplier ?? 3);
  const docThreshold = ai.missing_document_threshold || '2000.00';
  const from = since || new Date(Date.now() - 120 * 86400000).toISOString().slice(0, 10);
  let created = 0;

  // 1. Duplicate expenses (same payee/supplier + same total within window)
  const { rows: dupExp } = await db.query(
    `SELECT a.id, a.number, b.id AS other_id, b.number AS other_number, a.total, a.expense_date, COALESCE(s.name, a.payee_name) AS payee
       FROM expenses a JOIN expenses b ON b.company_id=a.company_id AND b.id < a.id AND b.total=a.total AND b.status <> 'VOID'
            AND (b.supplier_id = a.supplier_id OR lower(COALESCE(b.payee_name,'')) = lower(COALESCE(a.payee_name,'-')))
            AND abs(b.expense_date - a.expense_date) <= $3
       LEFT JOIN suppliers s ON s.id=a.supplier_id
      WHERE a.company_id=$1 AND a.status <> 'VOID' AND a.expense_date >= $2`, [companyId, from, win]);
  for (const d of dupExp) created += await flag(db, companyId, { kind: 'duplicate_transaction', severity: 'HIGH', entity_type: 'expense', entity_id: d.id,
    message: `Transaction requires review: expense ${d.number} (${formatK(d.total)} to ${d.payee || 'unknown payee'}) looks similar to ${d.other_number} recorded within ${win} days.`,
    details: { similar_to: d.other_id, similar_number: d.other_number, amount: d.total, date: d.expense_date } });

  // 2. Duplicate invoices (same customer + total within window)
  const { rows: dupInv } = await db.query(
    `SELECT a.id, a.number, b.id AS other_id, b.number AS other_number, a.total, c.name
       FROM sales_documents a JOIN sales_documents b ON b.company_id=a.company_id AND b.id < a.id AND b.doc_type='INVOICE' AND b.customer_id=a.customer_id AND b.total=a.total
            AND b.status <> 'CANCELLED' AND abs(b.doc_date - a.doc_date) <= $3
       JOIN customers c ON c.id=a.customer_id
      WHERE a.company_id=$1 AND a.doc_type='INVOICE' AND a.status <> 'CANCELLED' AND a.doc_date >= $2`, [companyId, from, win]);
  for (const d of dupInv) created += await flag(db, companyId, { kind: 'duplicate_invoice', severity: 'MEDIUM', entity_type: 'sales_document', entity_id: d.id,
    message: `Invoice requires review: ${d.number} for ${d.name} has the same amount (${formatK(d.total)}) as ${d.other_number} issued within ${win} days.`, details: { similar_to: d.other_id, similar_number: d.other_number } });

  // 3. Duplicate supplier invoices (same supplier reference)
  const { rows: dupBill } = await db.query(
    `SELECT a.id, a.number, b.id AS other_id, b.number AS other_number, a.supplier_reference, s.name
       FROM purchase_documents a JOIN purchase_documents b ON b.company_id=a.company_id AND b.id < a.id AND b.doc_type='BILL' AND b.supplier_id=a.supplier_id
            AND b.status <> 'CANCELLED' AND lower(b.supplier_reference)=lower(a.supplier_reference)
       JOIN suppliers s ON s.id=a.supplier_id
      WHERE a.company_id=$1 AND a.doc_type='BILL' AND a.status <> 'CANCELLED' AND a.supplier_reference IS NOT NULL AND a.supplier_reference <> ''`, [companyId]);
  for (const d of dupBill) created += await flag(db, companyId, { kind: 'duplicate_supplier_invoice', severity: 'HIGH', entity_type: 'purchase_document', entity_id: d.id,
    message: `Supplier bill requires review: ${d.number} from ${d.name} uses supplier invoice number "${d.supplier_reference}", already used on ${d.other_number}.`, details: { similar_to: d.other_id } });

  // 4. Unusually large expense lines vs the account's own history
  const { rows: large } = await db.query(
    `WITH lines AS (
       SELECT l.id, l.entry_id, l.account_id, l.debit, l.entry_date, l.entry_number, a.name AS account
         FROM ledger l JOIN accounts a ON a.id=l.account_id
        WHERE l.company_id=$1 AND a.type IN ('EXPENSE','COST_OF_SALES') AND l.debit > 0 AND l.source_type NOT IN ('REVERSAL','OPENING'))
     SELECT x.*, s.avg, s.n FROM lines x
       JOIN LATERAL (SELECT AVG(y.debit) AS avg, COUNT(*) AS n FROM lines y WHERE y.account_id=x.account_id AND y.id <> x.id AND y.entry_date BETWEEN x.entry_date - 180 AND x.entry_date) s ON true
      WHERE x.entry_date >= $2 AND s.n >= 3 AND x.debit > s.avg * $3 AND x.debit > 1000`, [companyId, from, mult]);
  for (const l of large) created += await flag(db, companyId, { kind: 'unusually_large_expense', severity: 'MEDIUM', entity_type: 'journal_entry', entity_id: l.entry_id,
    message: `Transaction requires review: ${formatK(l.debit)} posted to ${l.account} on ${l.entry_date} (${l.entry_number}) is more than ${mult}× the recent average of ${formatK(fromCents(toCents(Number(l.avg).toFixed(2))))}.`,
    details: { amount: l.debit, average: Number(l.avg).toFixed(2), sample_size: Number(l.n), account_id: l.account_id } });

  // 5. Unusual payment patterns: weekend supplier payments, or large round-sum payments without allocations
  const { rows: pays } = await db.query(
    `SELECT p.id, p.number, p.amount, p.payment_date, s.name, EXTRACT(ISODOW FROM p.payment_date)::int AS dow,
            (SELECT COUNT(*) FROM payment_allocations pa WHERE pa.payment_id=p.id)::int AS allocs
       FROM payments p JOIN suppliers s ON s.id=p.supplier_id WHERE p.company_id=$1 AND p.direction='OUT' AND p.status='POSTED' AND p.payment_date >= $2`, [companyId, from]);
  for (const p of pays) {
    const round = toCents(p.amount) % 100000n === 0n && toCents(p.amount) >= 1000000n;
    if (p.dow >= 6 || (round && p.allocs === 0)) {
      created += await flag(db, companyId, { kind: 'unusual_payment_pattern', severity: 'LOW', entity_type: 'payment', entity_id: p.id,
        message: `Payment requires review: ${p.number} (${formatK(p.amount)} to ${p.name}) ${p.dow >= 6 ? 'was dated on a weekend' : 'is a large round amount not matched to any bill'}.`, details: { weekend: p.dow >= 6, unallocated_round_sum: round && !p.allocs } });
    }
  }

  // 6. Possible misclassification (description keywords vs account)
  const { rows: exps } = await db.query(
    `SELECT e.id, e.number, e.description, e.payee_name, a.system_key, a.name AS account FROM expenses e JOIN accounts a ON a.id=e.account_id
      WHERE e.company_id=$1 AND e.status IN ('POSTED','PENDING_APPROVAL','DRAFT') AND e.expense_date >= $2`, [companyId, from]);
  for (const e of exps) {
    const text = `${e.description || ''} ${e.payee_name || ''}`;
    const k = KEYWORDS.find((x) => x.re.test(text));
    if (k && e.system_key !== k.key) {
      const { rows: [target] } = await db.query('SELECT id, name FROM accounts WHERE company_id=$1 AND system_key=$2', [companyId, k.key]);
      if (target) created += await flag(db, companyId, { kind: 'possible_misclassification', severity: 'LOW', entity_type: 'expense', entity_id: e.id,
        message: `Classification requires review: ${e.number} ("${text.trim().slice(0, 60)}") is posted to ${e.account}; it may belong to ${target.name}.`, details: { suggested_account_id: target.id, suggested_account: target.name } });
    }
  }

  // 7. Missing documentation above threshold
  const { rows: nodoc } = await db.query(
    `SELECT e.id, e.number, e.total FROM expenses e JOIN accounts a ON a.id=e.account_id WHERE e.company_id=$1 AND e.status='POSTED' AND e.total >= $3 AND e.expense_date >= $2 AND a.subtype <> 'payroll'
        AND e.document_id IS NULL AND NOT EXISTS (SELECT 1 FROM documents d WHERE d.linked_type='expense' AND d.linked_id=e.id)`, [companyId, from, docThreshold]);
  for (const e of nodoc) created += await flag(db, companyId, { kind: 'missing_documentation', severity: 'LOW', entity_type: 'expense', entity_id: e.id,
    message: `Documentation requires review: expense ${e.number} (${formatK(e.total)}) has no receipt attached.`, details: { threshold: docThreshold } });

  // 8. Unexpected month-on-month change per expense account (last full month vs prior)
  const { rows: mom } = await db.query(
    `WITH m AS (SELECT a.id, a.name, date_trunc('month', l.entry_date)::date AS mon, SUM(l.debit - l.credit) AS amt
                  FROM ledger l JOIN accounts a ON a.id=l.account_id WHERE l.company_id=$1 AND a.type IN ('EXPENSE','COST_OF_SALES')
                   AND l.entry_date >= date_trunc('month', CURRENT_DATE) - interval '2 months' AND l.entry_date < date_trunc('month', CURRENT_DATE)
                 GROUP BY 1,2,3)
     SELECT cur.id, cur.name, cur.mon, cur.amt AS cur, prev.amt AS prev FROM m cur JOIN m prev ON prev.id=cur.id AND prev.mon = cur.mon - interval '1 month'
      WHERE cur.mon = (date_trunc('month', CURRENT_DATE) - interval '1 month')::date AND prev.amt > 0 AND cur.amt > prev.amt * 1.5 AND cur.amt - prev.amt > 5000`, [companyId]);
  for (const m of mom) created += await flag(db, companyId, { kind: `expense_change_${String(m.mon).slice(0, 7)}`, severity: 'LOW', entity_type: 'account', entity_id: m.id,
    message: `Change requires review: ${m.name} rose from ${formatK(Number(m.prev).toFixed(2))} to ${formatK(Number(m.cur).toFixed(2))} in ${String(m.mon).slice(0, 7)} (+${Math.round((m.cur / m.prev - 1) * 100)}%).`, details: { previous: m.prev, current: m.cur } });

  if (created) await notify(db, companyId, { kind: 'unusual_transaction', title: `${created} transaction${created > 1 ? 's' : ''} require review`, body: 'The anomaly scan flagged new items for review.', link: '/review', dedupeKey: `anomaly-scan-${Date.now()}` });
  await audit({ system: true }, 'ai.anomaly_scan', { companyId, newValue: { created } }, db);
  return { created };
}
