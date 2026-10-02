// Customer/supplier sub-ledger integrity: on-account credits, note application, aging = control account, atomic rollback.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, login, pool, accountId, today } from './helpers.js';

let admin, cid, cust, supp, other;
const c = (v) => Math.round(Number(v) * 100);
const ctrl = async (key) => (await pool.query(
  `SELECT COALESCE(SUM(debit-credit),0)::numeric AS b FROM ledger WHERE company_id=$1 AND account_id=$2`, [cid, await accountId(cid, key)])).rows[0].b;
const invoice = async (amount, customer = cust) => {
  const r = await admin.post('/api/sales/documents').send({ doc_type: 'INVOICE', customer_id: customer, doc_date: today(), action: 'post',
    lines: [{ description: 'Service', quantity: 1, unit_price: amount, account_id: await accountId(cid, 'SALES') }] });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body;
};

before(async () => {
  cid = (await resetDb()).id;
  admin = await login();
  cust = (await admin.post('/api/customers').send({ name: 'Mwila Traders' })).body.id;
  other = (await admin.post('/api/customers').send({ name: 'Other Customer' })).body.id;
  supp = (await admin.post('/api/suppliers').send({ name: 'Lusaka Wholesale' })).body.id;
  // fund the bank so supplier payments are allowed
  await admin.post('/api/journals').send({ date: today(), description: 'Capital', action: 'post', lines: [
    { account_id: await accountId(cid, 'BANK'), debit: '100000' }, { account_id: await accountId(cid, '3000'), credit: '100000' }] });
});
after(async () => { await pool.end(); });

describe('Receivables sub-ledger', () => {
  let rct, inv2;
  it('an overpayment leaves an unapplied credit and AR aging still equals the AR account', async () => {
    const inv = await invoice('1000');
    const r = await admin.post('/api/payments').send({ direction: 'IN', payment_date: today(), customer_id: cust, amount: '1500', bank_account_id: await accountId(cid, 'BANK'),
      allocations: [{ document_id: inv.id, amount: '1000' }] });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.unallocated, '500.00');
    rct = r.body.id;
    const ag = await admin.get('/api/reports/ar-aging');
    assert.equal(c(ag.body.totals.total), c(await ctrl('AR')));
    assert.equal(c(ag.body.totals.unapplied), -50000);
  });
  it('applies the on-account credit to a later invoice without a new journal', async () => {
    inv2 = await invoice('800');
    const before = (await pool.query('SELECT COUNT(*)::int n FROM journal_entries WHERE company_id=$1', [cid])).rows[0].n;
    const r = await admin.post(`/api/payments/${rct}/allocate`).send({ allocations: [{ document_id: inv2.id, amount: '500' }] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.unallocated, '0.00');
    const after = (await pool.query('SELECT COUNT(*)::int n FROM journal_entries WHERE company_id=$1', [cid])).rows[0].n;
    assert.equal(after, before);
    const d = await admin.get(`/api/sales/documents/${inv2.id}`);
    assert.equal(d.body.status, 'PARTIALLY_PAID');
    assert.equal(d.body.amount_paid, '500.00');
    const ag = await admin.get('/api/reports/ar-aging');
    assert.equal(c(ag.body.totals.total), c(await ctrl('AR')));
    assert.equal(ag.body.totals.unapplied, undefined);
  });
  it('refuses to over-allocate or allocate to another customer', async () => {
    const r1 = await admin.post(`/api/payments/${rct}/allocate`).send({ allocations: [{ document_id: inv2.id, amount: '1' }] });
    assert.equal(r1.status, 400);
    const inv3 = await invoice('100', other);
    const r2 = await admin.post('/api/payments').send({ direction: 'IN', payment_date: today(), customer_id: cust, amount: '50', bank_account_id: await accountId(cid, 'BANK') });
    const r3 = await admin.post(`/api/payments/${r2.body.id}/allocate`).send({ allocations: [{ document_id: inv3.id, amount: '50' }] });
    assert.equal(r3.status, 400);
    assert.match(r3.body.error.message, /different customer/);
  });
  it('a credit note for a paid invoice posts as an unapplied credit (refund case)', async () => {
    const inv = await invoice('300');
    await admin.post('/api/payments').send({ direction: 'IN', payment_date: today(), customer_id: cust, amount: '300', bank_account_id: await accountId(cid, 'BANK'), allocations: [{ document_id: inv.id, amount: '300' }] });
    const cn = await admin.post(`/api/sales/documents/${inv.id}/convert`).send({ to: 'CREDIT_NOTE' });
    assert.equal(cn.status, 201, JSON.stringify(cn.body));
    const p = await admin.post(`/api/sales/documents/${cn.body.id}/post`);
    assert.equal(p.status, 200, JSON.stringify(p.body));
    assert.equal(p.body.status, 'POSTED');
    const ag = await admin.get('/api/reports/ar-aging');
    assert.equal(c(ag.body.totals.total), c(await ctrl('AR')));
  });
  it('applies an unapplied credit note to an open invoice', async () => {
    const inv = await invoice('400');
    const cn = await admin.post('/api/sales/documents').send({ doc_type: 'CREDIT_NOTE', customer_id: cust, doc_date: today(), action: 'post',
      lines: [{ description: 'Discount', quantity: 1, unit_price: '150', account_id: await accountId(cid, 'SALES') }] });
    assert.equal(cn.body.status, 'POSTED');
    const r = await admin.post(`/api/sales/documents/${cn.body.id}/apply`).send({ invoice_id: inv.id });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.status, 'APPLIED');
    const d = await admin.get(`/api/sales/documents/${inv.id}`);
    assert.equal(d.body.amount_credited, '150.00');
    const again = await admin.post(`/api/sales/documents/${cn.body.id}/apply`).send({ invoice_id: inv.id });
    assert.equal(again.status, 409);
    const ag = await admin.get('/api/reports/ar-aging');
    assert.equal(c(ag.body.totals.total), c(await ctrl('AR')));
  });
  it('a manual journal to Accounts Receivable must name the customer', async () => {
    const lines = [{ account_id: await accountId(cid, 'AR'), debit: '10' }, { account_id: await accountId(cid, 'SALES'), credit: '10' }];
    const r = await admin.post('/api/journals').send({ date: today(), description: 'Adj', action: 'post', lines });
    assert.equal(r.status, 400);
    assert.match(r.body.error.message, /choose the customer/);
    lines[0].customer_id = cust;
    const ok = await admin.post('/api/journals').send({ date: today(), description: 'Adj', action: 'post', lines });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
  });
});

describe('Payables sub-ledger', () => {
  it('on-account supplier payment, later allocation and debit note keep AP aging = AP account', async () => {
    const bill = await admin.post('/api/purchases/documents').send({ doc_type: 'BILL', supplier_id: supp, supplier_reference: 'LW-1', doc_date: today(), action: 'post',
      lines: [{ description: 'Stock', quantity: 1, unit_price: '2000', account_id: await accountId(cid, 'PURCHASES') }] });
    assert.equal(bill.status, 201, JSON.stringify(bill.body));
    const pay = await admin.post('/api/payments').send({ direction: 'OUT', payment_date: today(), supplier_id: supp, amount: '700', bank_account_id: await accountId(cid, 'BANK') });
    assert.equal(pay.status, 201, JSON.stringify(pay.body));
    let ag = await admin.get('/api/reports/ap-aging');
    assert.equal(c(ag.body.totals.total), -c(await ctrl('AP')));
    const al = await admin.post(`/api/payments/${pay.body.id}/allocate`).send({ allocations: [{ document_id: bill.body.id, amount: '700' }] });
    assert.equal(al.status, 200, JSON.stringify(al.body));
    const dn = await admin.post('/api/purchases/documents').send({ doc_type: 'DEBIT_NOTE', supplier_id: supp, doc_date: today(), action: 'post',
      lines: [{ description: 'Return', quantity: 1, unit_price: '300', account_id: await accountId(cid, 'PURCHASES') }] });
    assert.equal(dn.status, 201, JSON.stringify(dn.body));
    const ap = await admin.post(`/api/purchases/documents/${dn.body.id}/apply`).send({ bill_id: bill.body.id });
    assert.equal(ap.status, 200, JSON.stringify(ap.body));
    const b = await admin.get(`/api/purchases/documents/${bill.body.id}`);
    assert.equal(b.body.amount_paid, '700.00');
    assert.equal(b.body.amount_credited, '300.00');
    ag = await admin.get('/api/reports/ap-aging');
    assert.equal(c(ag.body.totals.total), -c(await ctrl('AP')));
    assert.equal(c(ag.body.totals.total), 100000);
  });
});

describe('Atomicity', () => {
  it('a failed posting leaves no partial records behind', async () => {
    const count = async () => (await pool.query(`SELECT (SELECT COUNT(*) FROM payments WHERE company_id=$1) + (SELECT COUNT(*) FROM journal_entries WHERE company_id=$1) AS n`, [cid])).rows[0].n;
    const before = await count();
    const inv = await invoice('100');
    const mid = await count();
    // allocation larger than the invoice balance fails after validation of the party; nothing must be written
    const r = await admin.post('/api/payments').send({ direction: 'IN', payment_date: today(), customer_id: cust, amount: '100', bank_account_id: await accountId(cid, 'BANK'),
      allocations: [{ document_id: inv.id, amount: '60' }, { document_id: inv.id, amount: '60' }] });
    assert.equal(r.status, 400);
    assert.equal(await count(), mid);
    assert.ok(Number(mid) > Number(before));
  });
  it('the database itself rejects an unbalanced posted journal', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: [e] } = await client.query(`INSERT INTO journal_entries (company_id, number, entry_date, description, status) VALUES ($1,'X-1',$2,'bad','POSTED') RETURNING id`, [cid, today()]);
      await client.query(`INSERT INTO journal_lines (entry_id, company_id, line_no, account_id, debit) VALUES ($1,$2,1,$3,10)`, [e.id, cid, await accountId(cid, 'BANK')]);
      await client.query(`INSERT INTO journal_lines (entry_id, company_id, line_no, account_id, credit) VALUES ($1,$2,2,$3,9)`, [e.id, cid, await accountId(cid, 'SALES')]);
      await assert.rejects(client.query('COMMIT'), /unbalanced/);
    } finally { await client.query('ROLLBACK').catch(() => {}); client.release(); }
  });
});
