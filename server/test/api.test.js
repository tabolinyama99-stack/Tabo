import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, login, app, request, pool, accountId, taxId, today, ADMIN } from './helpers.js';

let admin, company, cid, ids = {};

before(async () => {
  company = await resetDb();
  cid = company.id;
  admin = await login();
});
after(async () => { await pool.end(); });

describe('Authentication', () => {
  it('rejects wrong password with a friendly message', async () => {
    const r = await request(app).post('/api/auth/login').send({ email: ADMIN.email, password: 'nope' });
    assert.equal(r.status, 401);
    assert.match(r.body.error.message, /Incorrect email or password/);
  });
  it('rejects unauthenticated API calls', async () => {
    const r = await request(app).get('/api/dashboard');
    assert.equal(r.status, 401);
  });
  it('returns the session with permissions for the super admin', async () => {
    const r = await admin.get('/api/auth/me');
    assert.equal(r.status, 200);
    assert.equal(r.body.user.is_super_admin, true);
    assert.equal(r.body.role, 'Super Admin');
    assert.ok(r.body.permissions.includes('manage_users'));
    assert.equal(r.body.company.base_currency, 'ZMW');
  });
  it('enforces CSRF tokens on state-changing requests', async () => {
    const r = await admin.agent.post('/api/customers').send({ name: 'No CSRF' });
    assert.equal(r.status, 403);
    assert.match(r.body.error.message, /Security token/);
  });
  it('locks an account after repeated failures', async () => {
    await admin.post('/api/admin/users').send({ email: 'lockme@test.local', name: 'Lock Me', role_id: (await pool.query(`SELECT id FROM roles WHERE company_id=$1 AND name='Viewer'`, [cid])).rows[0].id, password: 'Viewer12345x', must_change_password: false });
    for (let i = 0; i < 5; i++) await request(app).post('/api/auth/login').send({ email: 'lockme@test.local', password: 'wrong' });
    const r = await request(app).post('/api/auth/login').send({ email: 'lockme@test.local', password: 'Viewer12345x' });
    assert.equal(r.status, 401);
    assert.match(r.body.error.message, /temporarily locked/);
  });
});

describe('Customers & suppliers', () => {
  it('creates a customer with an automatic code', async () => {
    const r = await admin.post('/api/customers').send({ name: 'Acme Zambia Ltd', email: 'ap@acme.zm', payment_terms_days: 30 });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.match(r.body.code, /^C\d{4}$/);
    ids.customer = r.body.id;
  });
  it('validates required fields', async () => {
    const r = await admin.post('/api/customers').send({ name: '' });
    assert.equal(r.status, 400);
  });
  it('creates a supplier', async () => {
    const r = await admin.post('/api/suppliers').send({ name: 'Copper Supplies Ltd', payment_terms_days: 14 });
    assert.equal(r.status, 201);
    ids.supplier = r.body.id;
  });
});

describe('Sales invoices', () => {
  it('refuses an invoice without a customer', async () => {
    const r = await admin.post('/api/sales/documents').send({ doc_type: 'INVOICE', doc_date: today(), lines: [{ description: 'x', quantity: 1, unit_price: '10', account_id: await accountId(cid, 'SALES') }] });
    assert.equal(r.status, 400);
    assert.match(r.body.error.message, /customer/i);
  });
  it('creates a draft invoice with exact VAT calculation', async () => {
    const r = await admin.post('/api/sales/documents').send({ doc_type: 'INVOICE', customer_id: ids.customer, doc_date: today(), lines: [
      { description: 'Consulting', quantity: '3', unit_price: '1,000.10', account_id: await accountId(cid, 'SERVICE_REVENUE'), tax_rate_id: await taxId(cid) },
      { description: 'Materials', quantity: '2.5', unit_price: '99.99', discount_pct: '10', account_id: await accountId(cid, 'SALES'), tax_rate_id: await taxId(cid) }] });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    // 3 × 1000.10 = 3000.30 ; 2.5 × 99.99 = 249.975 → 249.98, less 10% (25.00) = 224.98
    assert.equal(r.body.subtotal, '3225.28');
    // VAT 16%: 480.048 → 480.05 ; 35.9968 → 36.00
    assert.equal(r.body.tax_total, '516.05');
    assert.equal(r.body.total, '3741.33');
    assert.equal(r.body.status, 'DRAFT');
    ids.invoice = r.body.id;
  });
  it('posts the invoice and generates a balanced journal', async () => {
    const r = await admin.post(`/api/sales/documents/${ids.invoice}/post`).send({});
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.status, 'SENT');
    const j = await admin.get(`/api/journals/${r.body.journal_entry_id}`);
    const d = j.body.lines.reduce((s, l) => s + Math.round(Number(l.debit) * 100), 0);
    const c = j.body.lines.reduce((s, l) => s + Math.round(Number(l.credit) * 100), 0);
    assert.equal(d, c);
    assert.equal(d, 374133);
    assert.ok(j.body.lines.some((l) => l.account_name === 'Accounts Receivable' && l.debit === '3741.33'));
    assert.ok(j.body.lines.some((l) => l.account_name === 'VAT Output (Payable)' && l.credit === '516.05'));
  });
  it('cannot edit a posted invoice', async () => {
    const r = await admin.put(`/api/sales/documents/${ids.invoice}`).send({ doc_type: 'INVOICE', customer_id: ids.customer, doc_date: today(), lines: [{ description: 'x', quantity: 1, unit_price: '1', account_id: await accountId(cid, 'SALES') }] });
    assert.equal(r.status, 409);
  });
  it('generates a branded PDF', async () => {
    const r = await admin.get(`/api/sales/documents/${ids.invoice}/pdf`).buffer(true).parse((res, cb) => { const c = []; res.on('data', (x) => c.push(x)); res.on('end', () => cb(null, Buffer.concat(c))); });
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-type'], 'application/pdf');
    assert.equal(r.body.slice(0, 5).toString(), '%PDF-');
  });
});

describe('Receipts and payments', () => {
  it('rejects an allocation larger than the invoice balance', async () => {
    const r = await admin.post('/api/payments').send({ direction: 'IN', payment_date: today(), customer_id: ids.customer, amount: '5000', bank_account_id: await accountId(cid, 'BANK'), allocations: [{ document_id: ids.invoice, amount: '5000' }] });
    assert.equal(r.status, 400);
    assert.match(r.body.error.message, /exceeds its balance/);
  });
  it('records a part payment and updates invoice status', async () => {
    const r = await admin.post('/api/payments').send({ direction: 'IN', payment_date: today(), customer_id: ids.customer, amount: '1000.00', bank_account_id: await accountId(cid, 'BANK'), method: 'BANK_TRANSFER', allocations: [{ document_id: ids.invoice, amount: '1000.00' }] });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    ids.receipt = r.body.id;
    const inv = await admin.get(`/api/sales/documents/${ids.invoice}`);
    assert.equal(inv.body.status, 'PARTIALLY_PAID');
    assert.equal(inv.body.balance_due, '2741.33');
  });
  it('customer balance comes from the ledger', async () => {
    const r = await admin.get(`/api/customers/${ids.customer}`);
    assert.equal(r.body.balance, '2741.33');
  });
  it('voiding the payment reverses it and restores the invoice', async () => {
    const r = await admin.post(`/api/payments/${ids.receipt}/void`).send({ reason: 'Bounced transfer' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const inv = await admin.get(`/api/sales/documents/${ids.invoice}`);
    assert.equal(inv.body.status, 'SENT');
    assert.equal(inv.body.balance_due, '3741.33');
    const c = await admin.get(`/api/customers/${ids.customer}`);
    assert.equal(c.body.balance, '3741.33');
  });
  it('pays the invoice in full', async () => {
    const r = await admin.post('/api/payments').send({ direction: 'IN', payment_date: today(), customer_id: ids.customer, amount: '3741.33', bank_account_id: await accountId(cid, 'BANK'), allocations: [{ document_id: ids.invoice, amount: '3741.33' }] });
    assert.equal(r.status, 201);
    const inv = await admin.get(`/api/sales/documents/${ids.invoice}`);
    assert.equal(inv.body.status, 'PAID');
  });
  it('blocks a supplier payment that would overdraw the bank', async () => {
    const r = await admin.post('/api/payments').send({ direction: 'OUT', payment_date: today(), supplier_id: ids.supplier, amount: '999999', bank_account_id: await accountId(cid, 'BANK') });
    assert.equal(r.status, 409);
    assert.match(r.body.error.message, /Insufficient funds/);
  });
});

describe('Purchases', () => {
  it('posts a supplier bill with input VAT', async () => {
    const r = await admin.post('/api/purchases/documents').send({ doc_type: 'BILL', supplier_id: ids.supplier, supplier_reference: 'CS-1001', doc_date: today(), action: 'post',
      lines: [{ description: 'Copper wire', quantity: '10', unit_price: '100', account_id: await accountId(cid, 'PURCHASES'), tax_rate_id: await taxId(cid) }] });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.status, 'POSTED');
    assert.equal(r.body.total, '1160.00');
    ids.bill = r.body.id;
  });
  it('detects a duplicate supplier invoice number', async () => {
    const r = await admin.post('/api/purchases/documents').send({ doc_type: 'BILL', supplier_id: ids.supplier, supplier_reference: 'cs-1001', doc_date: today(),
      lines: [{ description: 'Copper wire', quantity: '1', unit_price: '5', account_id: await accountId(cid, 'PURCHASES') }] });
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, 'POSSIBLE_DUPLICATE');
  });
  it('pays the bill with withholding tax', async () => {
    const wht = (await pool.query(`SELECT id FROM tax_rates WHERE company_id=$1 AND code='WHT15'`, [cid])).rows[0].id;
    const r = await admin.post('/api/payments').send({ direction: 'OUT', payment_date: today(), supplier_id: ids.supplier, amount: '1160.00', wht_rate_id: wht, bank_account_id: await accountId(cid, 'BANK'), allocations: [{ document_id: ids.bill, amount: '1160.00' }] });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.wht_amount, '174.00');
    const s = await admin.get(`/api/suppliers/${ids.supplier}`);
    assert.equal(s.body.balance, '0.00');
  });
});

describe('Journals & double entry', () => {
  it('refuses to post an unbalanced journal', async () => {
    const r = await admin.post('/api/journals').send({ date: today(), description: 'Bad', action: 'post', lines: [
      { account_id: await accountId(cid, 'RENT'), debit: '100' }, { account_id: await accountId(cid, 'CASH'), credit: '90' }] });
    assert.equal(r.status, 422);
    assert.match(r.body.error.message, /debits and credits do not balance/);
    const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM journal_entries WHERE description='Bad'`);
    assert.equal(rows[0].n, 0, 'the whole transaction must roll back');
  });
  it('refuses a line with both debit and credit', async () => {
    const r = await admin.post('/api/journals').send({ date: today(), description: 'Both', lines: [
      { account_id: await accountId(cid, 'RENT'), debit: '100', credit: '100' }, { account_id: await accountId(cid, 'CASH'), credit: '100' }] });
    assert.equal(r.status, 400);
  });
  it('database itself rejects an unbalanced posted entry', async () => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const { rows: [e] } = await c.query(`INSERT INTO journal_entries (company_id, number, entry_date, description, status) VALUES ($1,'X-1',CURRENT_DATE,'direct','POSTED') RETURNING id`, [cid]);
      await c.query(`INSERT INTO journal_lines (entry_id, company_id, line_no, account_id, debit) VALUES ($1,$2,1,$3,50)`, [e.id, cid, await accountId(cid, 'RENT')]);
      await c.query(`INSERT INTO journal_lines (entry_id, company_id, line_no, account_id, credit) VALUES ($1,$2,2,$3,40)`, [e.id, cid, await accountId(cid, 'CASH')]);
      await assert.rejects(c.query('COMMIT'), /unbalanced/);
    } finally { await c.query('ROLLBACK').catch(() => {}); c.release(); }
  });
  it('posts a balanced manual journal, then reverses it', async () => {
    const r = await admin.post('/api/journals').send({ date: today(), description: 'Accrue rent', action: 'post', lines: [
      { account_id: await accountId(cid, 'RENT'), debit: '500.00' }, { account_id: await accountId(cid, '2200'), credit: '500.00' }] });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.status, 'POSTED');
    const rev = await admin.post(`/api/journals/${r.body.id}/reverse`).send({ reason: 'Posted in error' });
    assert.equal(rev.status, 200, JSON.stringify(rev.body));
    const orig = await admin.get(`/api/journals/${r.body.id}`);
    assert.equal(orig.body.status, 'REVERSED');
  });
  it('posted journal lines cannot be altered directly in the database', async () => {
    const { rows: [l] } = await pool.query(`SELECT l.id FROM journal_lines l JOIN journal_entries e ON e.id=l.entry_id WHERE e.status='POSTED' LIMIT 1`);
    await assert.rejects(pool.query('UPDATE journal_lines SET debit=debit+1 WHERE id=$1', [l.id]), /cannot be edited/);
    await assert.rejects(pool.query('DELETE FROM journal_lines WHERE id=$1', [l.id]), /cannot be deleted/);
  });
  it('generated journals must be reversed through their document', async () => {
    const inv = await admin.get(`/api/sales/documents/${ids.invoice}`);
    const r = await admin.post(`/api/journals/${inv.body.journal_entry_id}/reverse`).send({ reason: 'test' });
    assert.equal(r.status, 409);
  });
});

describe('Financial reports', () => {
  it('trial balance balances', async () => {
    const r = await admin.get('/api/reports/trial-balance');
    assert.equal(r.status, 200);
    assert.equal(r.body.balanced, true);
    assert.equal(r.body.totals.debit, r.body.totals.credit);
  });
  it('profit and loss reflects posted revenue and expenses', async () => {
    const r = await admin.get(`/api/reports/profit-and-loss?from=${today().slice(0, 8)}01&to=${today()}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.summary.revenue, '3225.28');
    assert.equal(r.body.summary.cost_of_sales, '1000.00');
    // accrued rent 500 reversed → 0 expense
    assert.equal(r.body.summary.net_profit, '2225.28');
  });
  it('balance sheet balances', async () => {
    const r = await admin.get('/api/reports/balance-sheet');
    assert.equal(r.body.balanced, true);
  });
  it('every report runs and exports to PDF and Excel', async () => {
    const list = await admin.get('/api/reports');
    for (const rep of list.body) {
      const q = rep.slug.includes('customer') ? `?customer_id=${ids.customer}` : rep.slug.includes('supplier') ? `?supplier_id=${ids.supplier}` : '';
      const r = await admin.get(`/api/reports/${rep.slug}${q}`);
      assert.equal(r.status, 200, `${rep.slug}: ${JSON.stringify(r.body)}`);
      assert.ok(Array.isArray(r.body.rows));
    }
    const pdf = await admin.get('/api/reports/profit-and-loss?format=pdf');
    assert.equal(pdf.headers['content-type'], 'application/pdf');
    const xlsx = await admin.get('/api/reports/trial-balance?format=xlsx');
    assert.match(xlsx.headers['content-type'], /spreadsheetml/);
  });
  it('tax report reconciles to the VAT ledger accounts', async () => {
    const r = await admin.get('/api/reports/tax');
    assert.equal(r.body.summary.output_tax, r.body.summary.ledger_output);
    assert.equal(r.body.summary.input_tax, r.body.summary.ledger_input);
    assert.equal(r.body.summary.withholding_tax, '174.00');
  });
  it('dashboard numbers come from the ledger', async () => {
    const r = await admin.get('/api/dashboard');
    assert.equal(r.status, 200);
    assert.equal(r.body.kpis.revenue, '3225.28');
    assert.equal(r.body.trend.length, 12);
  });
});

describe('Expenses & approvals', () => {
  it('posts an expense with tax-inclusive amount', async () => {
    const r = await admin.post('/api/expenses').send({ expense_date: today(), payee_name: 'Puma', account_id: await accountId(cid, 'FUEL'), amount: '1160.00', amount_includes_tax: true, tax_rate_id: await taxId(cid), payment_account_id: await accountId(cid, 'BANK') });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.status, 'POSTED');
    assert.equal(r.body.amount, '1000.00');
    assert.equal(r.body.tax_amount, '160.00');
  });
});

describe('Permissions are enforced by the API', () => {
  let cashier, viewer;
  before(async () => {
    const role = async (n) => (await pool.query(`SELECT id FROM roles WHERE company_id=$1 AND name=$2`, [cid, n])).rows[0].id;
    await admin.post('/api/admin/users').send({ email: 'cashier@test.local', name: 'Cash Ier', role_id: await role('Cashier'), password: 'Cashier12345', must_change_password: false });
    await admin.post('/api/admin/users').send({ email: 'viewer@test.local', name: 'View Er', role_id: await role('Viewer'), password: 'Viewer12345', must_change_password: false });
    cashier = await login('cashier@test.local', 'Cashier12345');
    viewer = await login('viewer@test.local', 'Viewer12345');
  });
  it('viewer cannot create invoices or customers', async () => {
    assert.equal((await viewer.post('/api/customers').send({ name: 'X' })).status, 403);
    const r = await viewer.post('/api/sales/documents').send({ doc_type: 'INVOICE', customer_id: ids.customer, doc_date: today(), lines: [{ description: 'x', quantity: 1, unit_price: '1', account_id: 1 }] });
    assert.equal(r.status, 403);
    assert.match(r.body.error.message, /permission/);
  });
  it('viewer cannot manage users or settings', async () => {
    assert.equal((await viewer.get('/api/admin/users')).status, 403);
    assert.equal((await viewer.put('/api/admin/settings/branding').send({ primary_color: '#000000' })).status, 403);
  });
  it('cashier expense above the approval threshold waits for approval', async () => {
    const r = await cashier.post('/api/expenses').send({ expense_date: today(), payee_name: 'Generator Co', account_id: await accountId(cid, '6400'), amount: '6000.00', payment_account_id: await accountId(cid, 'CASH') });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.status, 'PENDING_APPROVAL');
    ids.pendingExpense = r.body.id;
    assert.equal((await cashier.post(`/api/expenses/${ids.pendingExpense}/approve`).send({})).status, 403);
  });
  it('an approver posts the pending expense', async () => {
    // fund cash first
    await admin.post('/api/bank-transactions').send({ kind: 'TRANSFER', bank_account_id: await accountId(cid, 'BANK'), to_account_id: await accountId(cid, 'CASH'), amount: '1000', date: today() });
    const short = await admin.post(`/api/expenses/${ids.pendingExpense}/approve`).send({});
    assert.equal(short.status, 409, 'cash cannot be overdrawn by an expense');
    assert.match(short.body.error.message, /Insufficient funds/);
    const top = await admin.post('/api/journals').send({ date: today(), description: 'Owner capital into cash', action: 'post',
      lines: [{ account_id: await accountId(cid, 'CASH'), debit: '5000' }, { account_id: await accountId(cid, 'CAPITAL'), credit: '5000' }] });
    assert.equal(top.status, 201, JSON.stringify(top.body));
    const r = await admin.post(`/api/expenses/${ids.pendingExpense}/approve`).send({});
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.status, 'POSTED');
  });
  it('role transaction limits are enforced', async () => {
    const r = await cashier.post('/api/payments').send({ direction: 'IN', payment_date: today(), customer_id: ids.customer, amount: '25000', bank_account_id: await accountId(cid, 'CASH') });
    assert.equal(r.status, 403);
    assert.match(r.body.error.message, /transaction limit/);
  });
  it('a non-super-admin cannot grant permissions they do not hold', async () => {
    const role = (await pool.query(`SELECT id FROM roles WHERE company_id=$1 AND name='Admin'`, [cid])).rows[0].id;
    await admin.post('/api/admin/users').send({ email: 'admin2@test.local', name: 'Company Admin', role_id: role, password: 'Admin12345x', must_change_password: false });
    const a2 = await login('admin2@test.local', 'Admin12345x');
    const sa = (await pool.query(`SELECT id FROM roles WHERE company_id=$1 AND name='Super Admin'`, [cid])).rows[0].id;
    const r = await a2.post('/api/admin/users').send({ email: 'x@test.local', name: 'X', role_id: sa });
    assert.equal(r.status, 403);
  });
});

describe('Banking & reconciliation', () => {
  it('imports a CSV statement, auto-matches and reconciles', async () => {
    const bank = await accountId(cid, 'BANK');
    const reg = await admin.get(`/api/bank-accounts/${bank}/register`);
    const lines = reg.body.rows;
    const csv = ['Date,Description,Reference,Amount', ...lines.map((l) => `${l.entry_date.split('-').reverse().join('/')},${l.description.replace(/,/g, ' ')},${l.reference || ''},${(Number(l.debit) - Number(l.credit)).toFixed(2)}`), `${today().split('-').reverse().join('/')},Ledger fees,FEE,-25.00`].join('\n');
    const imp = await admin.agent.post(`/api/bank-accounts/${bank}/import`).set('X-CSRF-Token', admin.csrf).attach('file', Buffer.from(csv), 'statement.csv');
    assert.equal(imp.status, 201, JSON.stringify(imp.body));
    assert.equal(imp.body.imported, lines.length + 1);
    assert.ok(imp.body.auto_matched >= lines.length - 1, `auto matched ${imp.body.auto_matched} of ${lines.length}`);
    // re-import is idempotent
    const again = await admin.agent.post(`/api/bank-accounts/${bank}/import`).set('X-CSRF-Token', admin.csrf).attach('file', Buffer.from(csv), 'statement.csv');
    assert.equal(again.body.imported, 0);
    // create the bank charge from the unmatched line
    const st = await admin.get(`/api/bank-accounts/${bank}/statement-lines?status=UNMATCHED`);
    for (const s of st.body) {
      if (s.reference === 'FEE') { const c = await admin.post(`/api/statement-lines/${s.id}/create-entry`).send({ contra_account_id: await accountId(cid, 'BANK_CHARGES') }); assert.equal(c.status, 201, JSON.stringify(c.body)); }
      else { const sug = await admin.get(`/api/bank-accounts/${bank}/suggestions?line=${s.id}`); if (sug.body[0]?.candidates[0]) await admin.post(`/api/statement-lines/${s.id}/match`).send({ journal_line_id: sug.body[0].candidates[0].id }); }
    }
    const bal = (await admin.get('/api/bank-accounts')).body.find((b) => b.id === bank).balance;
    const rec = await admin.post('/api/reconciliations').send({ bank_account_id: bank, statement_date: today(), statement_balance: bal });
    assert.equal(rec.status, 201, JSON.stringify(rec.body));
    const unc = rec.body.lines.filter((l) => !l.cleared).map((l) => l.id);
    const cleared = await admin.post(`/api/reconciliations/${rec.body.id}/clear`).send({ line_ids: unc, cleared: true });
    assert.equal(cleared.body.difference, '0.00');
    const done = await admin.post(`/api/reconciliations/${rec.body.id}/complete`).send({});
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.equal(done.body.status, 'COMPLETED');
  });
});

describe('Period locking', () => {
  it('locked period refuses postings; reopening needs a reason', async () => {
    const periods = (await admin.get('/api/admin/periods')).body;
    const cur = periods.find((p) => p.start_date <= today() && p.end_date >= today());
    assert.equal((await admin.post(`/api/admin/periods/${cur.id}/lock`).send({ force: true })).status, 200);
    const r = await admin.post('/api/journals').send({ date: today(), description: 'In locked period', action: 'post', lines: [{ account_id: await accountId(cid, 'RENT'), debit: '1' }, { account_id: await accountId(cid, 'CASH'), credit: '1' }] });
    assert.equal(r.status, 409);
    assert.match(r.body.error.message, /locked/);
    assert.equal((await admin.post(`/api/admin/periods/${cur.id}/reopen`).send({})).status, 400);
    assert.equal((await admin.post(`/api/admin/periods/${cur.id}/reopen`).send({ reason: 'Late adjustment' })).status, 200);
  });
});

describe('AI assistant', () => {
  it('answers sales questions with figures from the database and sources', async () => {
    const r = await admin.post('/api/ai/chat').send({ message: 'What were our sales this month?' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.match(r.body.answer, /K3,225\.28/);
    assert.ok(r.body.sources.length > 0);
  });
  it('answers overdue / receivable questions', async () => {
    const r = await admin.post('/api/ai/chat').send({ message: 'How much do customers owe us?' });
    assert.equal(r.status, 200);
    assert.match(r.body.answer, /K0\.00|owe/);
  });
  it('turns an instruction into a DRAFT, never a posting', async () => {
    const before = (await pool.query(`SELECT COUNT(*)::int AS n FROM journal_entries WHERE status='POSTED'`)).rows[0].n;
    const r = await admin.post('/api/ai/chat').send({ message: 'Record a K5,000 cash sale' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.draft, JSON.stringify(r.body));
    assert.match(r.body.answer, /DRAFT/);
    const j = await admin.get(`/api/journals/${r.body.draft.id}`);
    assert.equal(j.body.status, 'DRAFT');
    assert.equal(j.body.ai_generated, true);
    assert.equal(j.body.lines.find((l) => l.debit !== '0.00').account_name, 'Cash on Hand');
    const after = (await pool.query(`SELECT COUNT(*)::int AS n FROM journal_entries WHERE status='POSTED'`)).rows[0].n;
    assert.equal(after, before);
    const ap = await admin.post(`/api/journals/${r.body.draft.id}/approve`).send({});
    assert.equal(ap.status, 200, JSON.stringify(ap.body));
    assert.equal(ap.body.status, 'POSTED');
    const audit = await pool.query(`SELECT action FROM audit_logs WHERE entity_type='journal_entry' AND entity_id=$1`, [String(r.body.draft.id)]);
    assert.ok(audit.rows.some((a) => a.action === 'ai.draft_created'));
    assert.ok(audit.rows.some((a) => a.action === 'ai.draft_approved_and_posted'));
  });
  it('drafts an expense from natural language with the right category', async () => {
    const r = await admin.post('/api/ai/chat').send({ message: 'Paid K450 for fuel from bank' });
    assert.ok(r.body.draft);
    assert.equal(r.body.draft.type, 'expense');
    const e = await admin.get(`/api/expenses/${r.body.draft.id}`);
    assert.equal(e.body.account_name, 'Fuel');
    assert.equal(e.body.status, 'DRAFT');
  });
  it('respects permissions (viewer cannot read sales detail via AI)', async () => {
    const viewer = await login('viewer@test.local', 'Viewer12345');
    const r = await viewer.post('/api/ai/chat').send({ message: 'Which invoices are overdue?' });
    assert.equal(r.status, 403);
  });
  it('financial analyst returns insights with figures', async () => {
    const r = await admin.get('/api/ai/analysis?narrative=false');
    assert.equal(r.status, 200);
    assert.ok(r.body.insights.length >= 4);
    assert.ok(r.body.insights.every((i) => Array.isArray(i.figures)));
  });
  it('anomaly scan flags duplicates neutrally', async () => {
    for (let i = 0; i < 2; i++) await admin.post('/api/expenses').send({ expense_date: today(), payee_name: 'Same Vendor', account_id: await accountId(cid, 'OFFICE_SUPPLIES'), amount: '77.00', payment_account_id: await accountId(cid, 'BANK') });
    await admin.post('/api/review-flags/scan').send({});
    const flags = (await admin.get('/api/review-flags')).body;
    const dup = flags.find((f) => f.kind === 'duplicate_transaction');
    assert.ok(dup);
    assert.match(dup.message, /requires review/);
    assert.doesNotMatch(dup.message, /fraud/i);
  });
});

describe('Admin Center, branding and audit trail', () => {
  it('uploads, replaces and removes the company logo', async () => {
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360f8cfc00000030101009d8f4d0e0000000049454e44ae426082', 'hex');
    const up = await admin.agent.post('/api/admin/branding/logo').set('X-CSRF-Token', admin.csrf).attach('file', png, 'logo.png');
    assert.equal(up.status, 200, JSON.stringify(up.body));
    const pub = await request(app).get(`/api/public/branding/${cid}/logo`);
    assert.equal(pub.status, 200);
    assert.equal(pub.headers['content-type'], 'image/png');
    const bad = await admin.agent.post('/api/admin/branding/logo').set('X-CSRF-Token', admin.csrf).attach('file', Buffer.from('<svg><script>alert(1)</script></svg>'), 'evil.svg');
    assert.equal(bad.status, 400);
    const exe = await admin.agent.post('/api/admin/branding/logo').set('X-CSRF-Token', admin.csrf).attach('file', Buffer.from('MZ fake exe'), 'logo.png');
    assert.equal(exe.status, 400);
    assert.equal((await admin.del('/api/admin/branding/logo')).status, 200);
    assert.equal((await request(app).get(`/api/public/branding/${cid}/logo`)).status, 404);
  });
  it('updates company info and settings, and audits the change', async () => {
    const r = await admin.put('/api/admin/company').send({ name: 'Test Co Renamed', tpin: '1234567890', phone: '+260 211 000000' });
    assert.equal(r.status, 200);
    const s = await admin.put('/api/admin/settings/branding').send({ primary_color: '#123456' });
    assert.equal(s.body.primary_color, '#123456');
    const bad = await admin.put('/api/admin/settings/branding').send({ primary_color: 'red; background:url(x)' });
    assert.equal(bad.status, 400);
    const logs = await admin.get('/api/admin/audit-logs?action=settings');
    assert.ok(logs.body.items.some((l) => l.action === 'settings.changed'));
  });
  it('numbering is configurable', async () => {
    const r = await admin.put('/api/admin/numbering/invoice').send({ prefix: 'TAX-INV-', suffix: '', next_value: 100, padding: 4 });
    assert.equal(r.status, 200);
    const inv = await admin.post('/api/sales/documents').send({ doc_type: 'INVOICE', customer_id: ids.customer, doc_date: today(), lines: [{ description: 'x', quantity: 1, unit_price: '1', account_id: await accountId(cid, 'SALES') }] });
    assert.equal(inv.body.number, 'TAX-INV-0100');
  });
  it('custom roles with granular permissions can be created', async () => {
    const r = await admin.post('/api/admin/roles').send({ name: 'Credit Controller', permissions: ['view_sales', 'view_reports', 'send_documents'], transaction_limit: '1000' });
    assert.equal(r.status, 201);
    assert.deepEqual(r.body.permissions, ['view_sales', 'view_reports', 'send_documents']);
  });
  it('audit log is immutable and hash-chained', async () => {
    await assert.rejects(pool.query('UPDATE audit_logs SET action=$1 WHERE id=(SELECT MIN(id) FROM audit_logs)', ['tampered']), /immutable/);
    await assert.rejects(pool.query('DELETE FROM audit_logs'), /immutable/);
    const v = await admin.get('/api/admin/audit-logs/verify');
    assert.equal(v.body.intact, true, JSON.stringify(v.body));
    assert.ok(v.body.entries > 20);
  });
  it('creates a configuration backup and restores it', async () => {
    const b = await admin.post('/api/admin/backups/config').send({});
    assert.equal(b.status, 201, JSON.stringify(b.body));
    await admin.put('/api/admin/settings/branding').send({ primary_color: '#654321' });
    const r = await admin.post(`/api/admin/backups/${b.body.id}/restore`).send({ confirm: 'RESTORE' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const s = await admin.get('/api/admin/settings');
    assert.equal(s.body.branding.primary_color, '#123456');
  });
  it('global search finds records', async () => {
    const r = await admin.get('/api/search?q=Acme');
    assert.ok(r.body.some((x) => x.type === 'customer'));
  });
  it('API keys authenticate with limited permissions', async () => {
    const k = await admin.post('/api/admin/api-keys').send({ name: 'Reporting', permissions: ['view_reports'] });
    assert.equal(k.status, 201);
    const ok = await request(app).get('/api/reports/trial-balance').set('Authorization', `Bearer ${k.body.key}`);
    assert.equal(ok.status, 200);
    const no = await request(app).post('/api/customers').set('Authorization', `Bearer ${k.body.key}`).send({ name: 'nope' });
    assert.equal(no.status, 403);
  });
  it('multi-company: data is isolated between companies', async () => {
    const c2 = await admin.post('/api/admin/companies').send({ name: 'Second Co' });
    assert.equal(c2.status, 201);
    await admin.post('/api/auth/switch-company').send({ company_id: c2.body.id });
    const cust = await admin.get('/api/customers');
    assert.equal(cust.body.length, 0);
    assert.equal((await admin.get(`/api/sales/documents/${ids.invoice}`)).status, 404);
    await admin.post('/api/auth/switch-company').send({ company_id: cid });
    assert.equal((await admin.get(`/api/sales/documents/${ids.invoice}`)).status, 200);
  });
  it('friendly errors never expose stack traces', async () => {
    const r = await admin.get('/api/sales/documents/abc');
    assert.equal(r.status, 400);
    assert.doesNotMatch(JSON.stringify(r.body), /at .*\.js/);
  });
});
