// Creates a clearly-labelled DEMO company with realistic sample data, posted through the
// real accounting services (so every figure has proper journals). Safe to run more than once:
// an existing demo company is left untouched unless RESET_DEMO=true.
import { pool, tx } from './pool.js';
import { migrate } from './migrate.js';
import { setupCompany, DEFAULT_SETTINGS, mergeSettings } from '../services/company-setup.js';
import { hashPassword } from '../lib/password.js';
import { ALL_PERMISSIONS } from '../lib/permissions.js';
import { createSalesDoc, postSalesDoc } from '../services/sales.js';
import { createPurchaseDoc, postPurchaseDoc } from '../services/purchases.js';
import { createPayment } from '../services/payments.js';
import { createExpense, postExpense } from '../services/expenses.js';
import { createJournal, getSystemAccount } from '../services/ledger.js';
import { recordBankTransaction, importStatement } from '../services/banking.js';
import { scanAnomalies } from '../services/anomalies.js';
import { addDays, addMonths } from '../services/reports.js';

const DEMO_PASSWORD = process.env.DEMO_PASSWORD || 'DemoPass2026';

const weekday = (d) => { const x = new Date(`${d}T00:00:00Z`); const w = x.getUTCDay(); if (w === 6) x.setUTCDate(x.getUTCDate() + 2); if (w === 0) x.setUTCDate(x.getUTCDate() + 1); return x.toISOString().slice(0, 10); };
function rng(seed) { let s = seed; return () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; }; }

export async function seedDemo({ adminUserId = null, log = console.log } = {}) {
  const { rows: existing } = await pool.query(`SELECT id FROM companies WHERE is_demo AND name LIKE 'DEMO%'`);
  if (existing[0] && process.env.RESET_DEMO !== 'true') { log('[demo] demo company already exists — skipping (set RESET_DEMO=true to rebuild)'); return existing[0].id; }
  if (existing[0]) {
    // Demo data only: allowed to remove completely. Posted journals are protected by triggers,
    // so the ledger rows are removed with replication-role triggers off, on one connection.
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      for (const id of existing.map((e) => e.id)) {
        await c.query(`SET LOCAL session_replication_role = replica`);
        await c.query(`DELETE FROM bank_statement_lines WHERE company_id=$1`, [id]);
        await c.query(`DELETE FROM payment_allocations WHERE payment_id IN (SELECT id FROM payments WHERE company_id=$1)`, [id]);
        for (const t of ['payments', 'expenses', 'reconciliations', 'review_flags', 'notifications']) await c.query(`DELETE FROM ${t} WHERE company_id=$1`, [id]);
        await c.query(`DELETE FROM sales_document_lines WHERE document_id IN (SELECT id FROM sales_documents WHERE company_id=$1)`, [id]);
        await c.query(`DELETE FROM sales_documents WHERE company_id=$1`, [id]);
        await c.query(`DELETE FROM purchase_document_lines WHERE document_id IN (SELECT id FROM purchase_documents WHERE company_id=$1)`, [id]);
        await c.query(`DELETE FROM purchase_documents WHERE company_id=$1`, [id]);
        await c.query(`DELETE FROM journal_lines WHERE company_id=$1`, [id]);
        await c.query(`DELETE FROM journal_entries WHERE company_id=$1`, [id]);
        await c.query(`SET LOCAL session_replication_role = origin`);
        await c.query('DELETE FROM companies WHERE id=$1', [id]);
      }
      await c.query('COMMIT');
    } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  }

  const companyId = await tx(async (db) => (await setupCompany(db, {
    name: 'DEMO – Kafue Hardware & Supplies Ltd', legal_name: 'Kafue Hardware & Supplies Limited (DEMO DATA)', tpin: '1000000000', vat_number: 'DEMO-VAT',
    address: 'Plot 12, Cairo Road', city: 'Lusaka', phone: '+260 97 000 0000', email: 'accounts@demo.example', website: 'demo.example', is_demo: true,
  }, { createdBy: adminUserId })).id);
  const { rows: [company] } = await pool.query('SELECT * FROM companies WHERE id=$1', [companyId]);
  const settings = mergeSettings(DEFAULT_SETTINGS, company.settings);
  settings.ai.missing_document_threshold = '10000.00';
  settings.documents.bank_details = 'Bank: DEMO Bank Zambia · Account: Kafue Hardware · No. 0000000000 · Branch: Cairo Road';
  await pool.query('UPDATE companies SET settings=$2 WHERE id=$1', [companyId, JSON.stringify(settings)]);

  // Demo users for each role
  const roles = (await pool.query('SELECT id, name FROM roles WHERE company_id=$1', [companyId])).rows;
  const hash = await hashPassword(DEMO_PASSWORD);
  const users = {};
  for (const [roleName, email, name] of [['Admin', 'admin@demo.tael', 'Demo Admin'], ['Finance Manager', 'finance@demo.tael', 'Mwila Banda'], ['Accountant', 'accountant@demo.tael', 'Chanda Phiri'],
    ['Cashier', 'cashier@demo.tael', 'Mutale Zulu'], ['Sales User', 'sales@demo.tael', 'Bwalya Mwanza'], ['Purchase User', 'purchases@demo.tael', 'Natasha Lungu'], ['Auditor', 'auditor@demo.tael', 'External Auditor'], ['Viewer', 'viewer@demo.tael', 'Board Viewer']]) {
    const { rows: [u] } = await pool.query(`INSERT INTO users (email, name, password_hash) VALUES ($1,$2,$3) ON CONFLICT ((lower(email))) DO UPDATE SET name=EXCLUDED.name RETURNING id`, [email, name, hash]);
    await pool.query(`INSERT INTO memberships (user_id, company_id, role_id) VALUES ($1,$2,$3) ON CONFLICT (user_id, company_id) DO UPDATE SET role_id=EXCLUDED.role_id`, [u.id, companyId, roles.find((r) => r.name === roleName).id]);
    users[roleName] = u.id;
  }
  const ctx = { user: { id: users['Finance Manager'], email: 'finance@demo.tael' }, companyId, company, settings: { ...settings, accounting: { ...settings.accounting, allow_negative_cash: true } }, isSuperAdmin: true, permissions: new Set(ALL_PERMISSIONS) };
  const acc = async (key) => (await getSystemAccount(pool, companyId, key)).id;
  const byCode = async (code) => (await pool.query('SELECT id FROM accounts WHERE company_id=$1 AND code=$2', [companyId, code])).rows[0].id;
  const vat = (await pool.query(`SELECT id FROM tax_rates WHERE company_id=$1 AND code='VAT16'`, [companyId])).rows[0].id;

  // Extra bank account
  await tx(async (db) => {
    const { rows: [a] } = await db.query(`INSERT INTO accounts (company_id, code, name, type, subtype, cash_flow_category) VALUES ($1,'1110','Bank – Savings Account','ASSET','bank','CASH') RETURNING id`, [companyId]);
    await db.query(`INSERT INTO bank_accounts (account_id, company_id, bank_name, account_number, branch_name) VALUES ($1,$2,'DEMO Bank Zambia','0000000002','Cairo Road')`, [a.id, companyId]);
    await db.query(`UPDATE bank_accounts SET bank_name='DEMO Bank Zambia', account_number='0000000001', branch_name='Cairo Road', low_balance_threshold=15000 WHERE account_id=(SELECT id FROM accounts WHERE company_id=$1 AND system_key='BANK')`, [companyId]);
  });

  const customers = [];
  for (const [name, email, terms] of [['Lusaka City Builders (Demo)', 'builders@demo.example', 30], ['Copperbelt Contractors (Demo)', 'ccc@demo.example', 30], ['Mwanza Farms (Demo)', 'farms@demo.example', 14],
    ['Chilenje School Board (Demo)', 'school@demo.example', 45], ['Kabwe Electricals (Demo)', 'kabwe@demo.example', 30], ['Walk-in Customer (Demo)', null, 0]]) {
    customers.push((await pool.query(`INSERT INTO customers (company_id, code, name, email, payment_terms_days) VALUES ($1,$2,$3,$4,$5) RETURNING id, name`, [companyId, `C${String(customers.length + 1).padStart(4, '0')}`, name, email, terms])).rows[0]);
  }
  await pool.query(`UPDATE number_sequences SET next_value=7 WHERE company_id=$1 AND key='customer'`, [companyId]);
  const suppliers = [];
  for (const [name, terms] of [['Zambia Cement Distributors (Demo)', 30], ['Puma Fuel Station Cairo Rd (Demo)', 0], ['Lusaka Property Holdings (Demo)', 0], ['ZESCO Electricity (Demo)', 14], ['Office World Lusaka (Demo)', 7], ['Steel Traders Zambia (Demo)', 30]]) {
    suppliers.push((await pool.query(`INSERT INTO suppliers (company_id, code, name, payment_terms_days) VALUES ($1,$2,$3,$4) RETURNING id, name`, [companyId, `S${String(suppliers.length + 1).padStart(4, '0')}`, name, terms])).rows[0]);
  }
  await pool.query(`UPDATE number_sequences SET next_value=7 WHERE company_id=$1 AND key='supplier'`, [companyId]);
  const sales = await acc('SALES'), service = await acc('SERVICE_REVENUE'), purchases = await acc('PURCHASES');
  const items = [['CEM-50', 'Cement 50kg bag', '165.00', '128.00'], ['REB-12', 'Reinforcing bar 12mm', '210.00', '160.00'], ['ROOF-3M', 'Roofing sheet 3m IBR', '285.00', '215.00'], ['PAINT-20', 'PVA paint 20L', '640.00', '470.00'], ['DEL', 'Delivery service', '450.00', '0.00']];
  for (const [code, name, sp, pp] of items) await pool.query(`INSERT INTO items (company_id, code, name, sale_price, purchase_price, income_account_id, expense_account_id, tax_rate_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [companyId, code, name, sp, pp, code === 'DEL' ? service : sales, purchases, vat]);

  const today = new Date().toISOString().slice(0, 10);
  const start = addMonths(`${today.slice(0, 7)}-01`, -5);
  const bank = await acc('BANK'), cash = await acc('CASH');
  const rand = rng(42);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];

  const inv0 = await acc('INVENTORY'), mv = await byCode('1510'), loans = await acc('LOANS'), capital = await acc('CAPITAL');
  await tx((db) => createJournal(db, ctx, { date: addDays(start, -1), description: 'Opening balances (DEMO)', source_type: 'OPENING', status: 'POSTED', approved: true, lines: [
    { account_id: bank, debit: '185000.00' }, { account_id: cash, debit: '12500.00' }, { account_id: inv0, debit: '96000.00' }, { account_id: mv, debit: '240000.00' },
    { account_id: loans, credit: '120000.00' }, { account_id: capital, credit: '413500.00' }] }));

  for (let m = 0; m < 6; m++) {
    const ms = addMonths(start, m);
    const growth = 1 + m * 0.06;
    // Sales invoices
    for (let k = 0; k < 9; k++) {
      const day = weekday(addDays(ms, 1 + Math.floor(rand() * 25)));
      if (day > today) continue;
      const cust = pick(customers.slice(0, 5));
      const lines = [{ description: 'Cement 50kg bag', quantity: String(20 + Math.floor(rand() * 80 * growth)), unit_price: '165.00', account_id: sales, tax_rate_id: vat },
        ...(rand() > 0.4 ? [{ description: 'Roofing sheet 3m IBR', quantity: String(10 + Math.floor(rand() * 40)), unit_price: '285.00', account_id: sales, tax_rate_id: vat }] : []),
        ...(rand() > 0.6 ? [{ description: 'Delivery service', quantity: '1', unit_price: '450.00', account_id: service, tax_rate_id: vat }] : [])];
      const inv = await tx(async (db) => postSalesDoc(db, ctx, (await createSalesDoc(db, ctx, { doc_type: 'INVOICE', customer_id: cust.id, doc_date: day, lines })).id));
      // Most invoices get paid; recent ones stay open (some overdue)
      const age = (new Date(today) - new Date(day)) / 86400000;
      const r = rand();
      if (age > 20 && r < 0.8) {
        const full = r < 0.65;
        const amount = full ? inv.total : (Number(inv.total) / 2).toFixed(2);
        const pd = weekday(addDays(day, 7 + Math.floor(rand() * 20)));
        if (pd <= today) await tx((db) => createPayment(db, ctx, { direction: 'IN', payment_date: pd, customer_id: cust.id, amount, bank_account_id: rand() > 0.2 ? bank : cash, method: 'BANK_TRANSFER', reference: `TRF${Math.floor(rand() * 900000 + 100000)}`, allocations: [{ document_id: inv.id, amount }] }));
      }
    }
    // Cash sales to walk-in customers via invoice + immediate receipt
    const cday = addDays(ms, 15);
    if (cday <= today) {
      const inv = await tx(async (db) => postSalesDoc(db, ctx, (await createSalesDoc(db, ctx, { doc_type: 'INVOICE', customer_id: customers[5].id, doc_date: cday, lines: [{ description: 'Counter sales (summary)', quantity: '1', unit_price: (8000 + rand() * 6000 * growth).toFixed(2), account_id: sales, tax_rate_id: vat }] })).id));
      await tx((db) => createPayment(db, ctx, { direction: 'IN', payment_date: cday, customer_id: customers[5].id, amount: inv.total, bank_account_id: cash, method: 'CASH', allocations: [{ document_id: inv.id, amount: inv.total }] }));
    }
    // Stock purchases on credit
    for (let k = 1; k < 3; k++) {
      const day = weekday(addDays(ms, 3 + k * 8));
      if (day > today) continue;
      const sup = k === 2 ? suppliers[5] : suppliers[0];
      const bill = await tx(async (db) => postPurchaseDoc(db, ctx, (await createPurchaseDoc(db, ctx, { doc_type: 'BILL', supplier_id: sup.id, supplier_reference: `INV-${m}${k}${Math.floor(rand() * 9000 + 1000)}`, doc_date: day,
        lines: [{ description: k === 2 ? 'Reinforcing bar 12mm' : 'Cement 50kg bag', quantity: String(k === 2 ? 90 + Math.floor(rand() * 60) : 220 + Math.floor(rand() * 120 * growth)), unit_price: k === 2 ? '160.00' : '128.00', account_id: purchases, tax_rate_id: vat }] })).id));
      const pd = weekday(addDays(day, 25));
      if (pd <= today) await tx((db) => createPayment(db, ctx, { direction: 'OUT', payment_date: pd, supplier_id: sup.id, amount: bill.total, bank_account_id: bank, method: 'BANK_TRANSFER', reference: `EFT${m}${k}`, allocations: [{ document_id: bill.id, amount: bill.total }] }));
    }
    // Monthly expenses
    const exp = async (day, accountId, amount, desc, supplierId, payAcc = bank, withVat = false, payee = null) => {
      if (day > today) return;
      await tx(async (db) => postExpense(db, ctx, (await createExpense(db, ctx, { expense_date: day, supplier_id: supplierId, payee_name: payee, account_id: accountId, amount, amount_includes_tax: withVat, tax_rate_id: withVat ? vat : null,
        payment_account_id: payAcc, payment_method: payAcc === cash ? 'CASH' : 'BANK_TRANSFER', description: desc }, { submit: false })).id));
    };
    await exp(addDays(ms, 0), await acc('RENT'), '12000.00', 'Shop rent', suppliers[2].id);
    await exp(addDays(ms, 9), await byCode('6110'), (1800 + rand() * 900).toFixed(2), 'ZESCO electricity', suppliers[3].id, bank, true);
    await exp(addDays(ms, 4), await acc('FUEL'), (2200 + rand() * 1500 * (m === 4 ? 2.4 : 1)).toFixed(2), 'Fuel for delivery truck', suppliers[1].id, cash, true);
    await exp(addDays(ms, 18), await acc('FUEL'), (1500 + rand() * 900).toFixed(2), 'Diesel top-up', suppliers[1].id, cash, true);
    await exp(addDays(ms, 12), await acc('OFFICE_SUPPLIES'), (350 + rand() * 400).toFixed(2), 'Printer paper and toner', suppliers[4].id, cash, true);
    await exp(addDays(ms, 27), await acc('SALARIES'), (24500 + m * 500).toFixed(2), 'Staff salaries', null, bank, false, 'Payroll');
    await exp(addDays(ms, 20), await byCode('6120'), (650 + rand() * 200).toFixed(2), 'Airtime and internet bundles', null, cash, false, 'Airtel Zambia');
    await exp(addDays(ms, 28), await acc('BANK_CHARGES'), (180 + rand() * 60).toFixed(2), 'Monthly bank charges', null, bank, false, 'DEMO Bank Zambia');
    if (m === 3) await exp(addDays(ms, 14), await byCode('6400'), '8750.00', 'Truck gearbox repair', null, bank, true, 'Lusaka Motors');
  }
  // Items that should trigger review: duplicate fuel expense, misclassified fuel, missing receipts
  const dupDay = addDays(today, -3);
  const fuelAmt = '2450.00';
  for (let i = 0; i < 2; i++) await tx(async (db) => postExpense(db, ctx, (await createExpense(db, ctx, { expense_date: dupDay, supplier_id: suppliers[1].id, account_id: await acc('FUEL'), amount: fuelAmt, payment_account_id: cash, payment_method: 'CASH', description: 'Fuel – delivery truck' }, { submit: false })).id));
  await tx(async (db) => postExpense(db, ctx, (await createExpense(db, ctx, { expense_date: addDays(today, -6), payee_name: 'Puma Fuel Station', account_id: await acc('OFFICE_SUPPLIES'), amount: '1200.00', payment_account_id: cash, payment_method: 'CASH', description: 'Diesel for generator' }, { submit: false })).id));
  // A draft awaiting approval (cashier recorded above threshold)
  const repairs = await byCode('6400');
  await tx((db) => createExpense(db, { ...ctx, isSuperAdmin: false, permissions: new Set(['create_expense']), role: { transaction_limit: '20000.00' }, user: { id: users.Cashier } },
    { expense_date: addDays(today, -1), account_id: repairs, amount: '6800.00', payment_account_id: bank, payment_method: 'BANK_TRANSFER', description: 'Generator service (awaiting approval)', payee_name: 'PowerGen Services' }));
  // Transfer between accounts & owner contribution
  await tx((db) => recordBankTransaction(db, ctx, { kind: 'TRANSFER', bank_account_id: bank, to_account_id: cash, amount: '5000.00', date: addDays(today, -20), description: 'Cash float top-up' }));

  // Bank statement import for the current month, so reconciliation has something to match
  const { rows: bl } = await pool.query(`SELECT entry_date, (debit - credit)::numeric(18,2) AS amount, entry_number, COALESCE(description, entry_description) AS d FROM ledger WHERE company_id=$1 AND account_id=$2 AND entry_date >= $3 ORDER BY entry_date`, [companyId, bank, addDays(today, -45)]);
  const csv = ['Date,Description,Reference,Amount', ...bl.map((l) => `${l.entry_date.split('-').reverse().join('/')},"${String(l.d).replace(/"/g, '')}",${l.entry_number},${l.amount}`), `${addDays(today, -2).split('-').reverse().join('/')},"SMS alert fees",BANK,-45.00`].join('\n');
  await tx((db) => importStatement(db, ctx, bank, { buffer: Buffer.from(csv), filename: 'demo-statement.csv' }));

  await scanAnomalies(pool, companyId);
  log(`[demo] demo company #${companyId} created. Demo user password: ${DEMO_PASSWORD} (e.g. accountant@demo.tael)`);
  return companyId;
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (isMain) {
  migrate().then(async () => {
    const { rows: [sa] } = await pool.query('SELECT id FROM users WHERE is_super_admin ORDER BY id LIMIT 1');
    await seedDemo({ adminUserId: sa?.id || null });
    await pool.end();
  }).catch((e) => { console.error(e); process.exit(1); });
}
