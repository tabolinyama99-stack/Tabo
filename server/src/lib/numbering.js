// Atomic, gap-safe document numbering per company (row-locked inside the caller's transaction).
export const SEQUENCE_DEFAULTS = {
  invoice: { prefix: 'INV-', padding: 5 },
  credit_note: { prefix: 'CN-', padding: 5 },
  quote: { prefix: 'QT-', padding: 5 },
  sales_order: { prefix: 'SO-', padding: 5 },
  receipt: { prefix: 'RCT-', padding: 5 },
  payment: { prefix: 'PAY-', padding: 5 },
  purchase_order: { prefix: 'PO-', padding: 5 },
  bill: { prefix: 'BILL-', padding: 5 },
  debit_note: { prefix: 'DN-', padding: 5 },
  expense: { prefix: 'EXP-', padding: 5 },
  journal: { prefix: 'JNL-', padding: 6 },
  customer: { prefix: 'C', padding: 4 },
  supplier: { prefix: 'S', padding: 4 },
};

export async function nextNumber(db, companyId, key) {
  const d = SEQUENCE_DEFAULTS[key] || { prefix: `${key.toUpperCase()}-`, padding: 5 };
  await db.query(
    `INSERT INTO number_sequences (company_id, key, prefix, padding) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
    [companyId, key, d.prefix, d.padding],
  );
  const { rows } = await db.query(
    `UPDATE number_sequences SET next_value = next_value + 1 WHERE company_id = $1 AND key = $2
     RETURNING prefix, suffix, padding, next_value - 1 AS value`, [companyId, key]);
  const r = rows[0];
  return `${r.prefix}${String(r.value).padStart(r.padding, '0')}${r.suffix}`;
}
