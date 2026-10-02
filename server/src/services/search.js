// Global search across the company's records, filtered by what the user may see.
import { can } from './ledger.js';
import { REPORTS } from './reports.js';

export async function globalSearch(db, ctx, q) {
  const term = String(q || '').trim();
  if (term.length < 2) return [];
  const like = `%${term.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
  const cid = ctx.companyId;
  const out = [];
  const run = async (perm, type, sql, map) => {
    if (perm && !can(ctx, perm)) return;
    const { rows } = await db.query(sql, sql.includes('$3') ? [cid, like, term] : [cid, like]);
    out.push(...rows.map((r) => ({ type, ...map(r) })));
  };
  await run('view_sales', 'customer', `SELECT id, name, code, email FROM customers WHERE company_id=$1 AND (name ILIKE $2 OR code ILIKE $2 OR email ILIKE $2 OR tpin ILIKE $2) ORDER BY similarity(name,$3) DESC LIMIT 6`,
    (r) => ({ id: r.id, title: r.name, subtitle: [r.code, r.email].filter(Boolean).join(' · '), link: `/sales/customers/${r.id}` }));
  await run('view_purchases', 'supplier', `SELECT id, name, code FROM suppliers WHERE company_id=$1 AND (name ILIKE $2 OR code ILIKE $2 OR tpin ILIKE $2) ORDER BY similarity(name,$3) DESC LIMIT 6`,
    (r) => ({ id: r.id, title: r.name, subtitle: r.code, link: `/purchases/suppliers/${r.id}` }));
  await run('view_sales', 'sales_document', `SELECT d.id, d.number, d.doc_type, d.total, d.status, c.name FROM sales_documents d JOIN customers c ON c.id=d.customer_id
      WHERE d.company_id=$1 AND (d.number ILIKE $2 OR d.reference ILIKE $2 OR c.name ILIKE $2) ORDER BY d.doc_date DESC LIMIT 8`,
    (r) => ({ id: r.id, title: `${r.number} · ${r.name}`, subtitle: `${r.doc_type.replace('_', ' ')} · K${r.total} · ${r.status}`, link: `/sales/documents/${r.id}` }));
  await run('view_purchases', 'purchase_document', `SELECT d.id, d.number, d.doc_type, d.total, d.status, s.name FROM purchase_documents d JOIN suppliers s ON s.id=d.supplier_id
      WHERE d.company_id=$1 AND (d.number ILIKE $2 OR d.supplier_reference ILIKE $2 OR s.name ILIKE $2) ORDER BY d.doc_date DESC LIMIT 8`,
    (r) => ({ id: r.id, title: `${r.number} · ${r.name}`, subtitle: `${r.doc_type.replace('_', ' ')} · K${r.total} · ${r.status}`, link: `/purchases/documents/${r.id}` }));
  await run('view_payments', 'payment', `SELECT p.id, p.number, p.amount, p.direction, COALESCE(c.name, s.name) AS party FROM payments p LEFT JOIN customers c ON c.id=p.customer_id LEFT JOIN suppliers s ON s.id=p.supplier_id
      WHERE p.company_id=$1 AND (p.number ILIKE $2 OR p.reference ILIKE $2 OR c.name ILIKE $2 OR s.name ILIKE $2) ORDER BY p.payment_date DESC LIMIT 6`,
    (r) => ({ id: r.id, title: `${r.number} · ${r.party}`, subtitle: `${r.direction === 'IN' ? 'Receipt' : 'Payment'} · K${r.amount}`, link: `/payments/${r.id}` }));
  await run('view_expenses', 'expense', `SELECT e.id, e.number, e.total, e.description, e.payee_name FROM expenses e WHERE e.company_id=$1 AND (e.number ILIKE $2 OR e.description ILIKE $2 OR e.payee_name ILIKE $2 OR e.reference ILIKE $2) ORDER BY e.expense_date DESC LIMIT 6`,
    (r) => ({ id: r.id, title: `${r.number} · ${r.payee_name || r.description || ''}`, subtitle: `Expense · K${r.total}`, link: `/expenses/${r.id}` }));
  await run('view_ledger', 'journal_entry', `SELECT id, number, description, total, status FROM journal_entries WHERE company_id=$1 AND (number ILIKE $2 OR description ILIKE $2 OR reference ILIKE $2) ORDER BY entry_date DESC LIMIT 6`,
    (r) => ({ id: r.id, title: `${r.number} · ${r.description}`, subtitle: `Journal · K${r.total} · ${r.status}`, link: `/journals/${r.id}` }));
  await run('view_ledger', 'account', `SELECT id, code, name, type FROM accounts WHERE company_id=$1 AND (name ILIKE $2 OR code ILIKE $2) ORDER BY code LIMIT 6`,
    (r) => ({ id: r.id, title: `${r.code} ${r.name}`, subtitle: r.type.replace('_', ' '), link: `/accounts?highlight=${r.id}` }));
  await run('upload_documents', 'document', `SELECT id, original_name, category, linked_type, linked_id FROM documents WHERE company_id=$1 AND original_name ILIKE $2 ORDER BY created_at DESC LIMIT 5`,
    (r) => ({ id: r.id, title: r.original_name, subtitle: `Document · ${r.category}`, link: `/documents?highlight=${r.id}` }));
  if (can(ctx, 'view_reports')) {
    for (const [slug, r] of Object.entries(REPORTS)) if (r.label.toLowerCase().includes(term.toLowerCase())) out.push({ type: 'report', title: r.label, subtitle: 'Report', link: `/reports/${slug}` });
  }
  return out;
}
