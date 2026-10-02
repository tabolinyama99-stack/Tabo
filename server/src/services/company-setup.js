import { DEFAULT_ROLES } from '../lib/permissions.js';
import { SEQUENCE_DEFAULTS } from '../lib/numbering.js';

// Default chart of accounts for a Zambian SME. Everything is editable afterwards.
// [code, name, type, subtype, system_key, cash_flow_category]
export const DEFAULT_COA = [
  ['1000', 'Cash on Hand', 'ASSET', 'cash', 'CASH', 'CASH'],
  ['1010', 'Petty Cash', 'ASSET', 'cash', 'PETTY_CASH', 'CASH'],
  ['1020', 'Mobile Money Wallet', 'ASSET', 'cash', 'MOBILE_MONEY', 'CASH'],
  ['1100', 'Bank – Current Account', 'ASSET', 'bank', 'BANK', 'CASH'],
  ['1200', 'Accounts Receivable', 'ASSET', 'receivable', 'AR', 'OPERATING'],
  ['1300', 'Inventory', 'ASSET', 'current_asset', 'INVENTORY', 'OPERATING'],
  ['1350', 'Prepayments', 'ASSET', 'current_asset', null, 'OPERATING'],
  ['1400', 'VAT Input (Recoverable)', 'ASSET', 'tax', 'VAT_INPUT', 'OPERATING'],
  ['1410', 'Withholding Tax Receivable', 'ASSET', 'tax', 'WHT_RECEIVABLE', 'OPERATING'],
  ['1500', 'Property, Plant & Equipment', 'ASSET', 'fixed_asset', 'PPE', 'INVESTING'],
  ['1510', 'Motor Vehicles', 'ASSET', 'fixed_asset', null, 'INVESTING'],
  ['1520', 'Office Equipment & Furniture', 'ASSET', 'fixed_asset', null, 'INVESTING'],
  ['1590', 'Accumulated Depreciation', 'ASSET', 'fixed_asset', 'ACC_DEPRECIATION', 'OPERATING'],
  ['2000', 'Accounts Payable', 'LIABILITY', 'payable', 'AP', 'OPERATING'],
  ['2100', 'VAT Output (Payable)', 'LIABILITY', 'tax', 'VAT_OUTPUT', 'OPERATING'],
  ['2110', 'PAYE Payable', 'LIABILITY', 'tax', 'PAYE_PAYABLE', 'OPERATING'],
  ['2120', 'NAPSA Payable', 'LIABILITY', 'current_liability', 'NAPSA_PAYABLE', 'OPERATING'],
  ['2130', 'Withholding Tax Payable', 'LIABILITY', 'tax', 'WHT_PAYABLE', 'OPERATING'],
  ['2200', 'Accrued Expenses', 'LIABILITY', 'current_liability', null, 'OPERATING'],
  ['2300', 'Customer Deposits', 'LIABILITY', 'current_liability', null, 'OPERATING'],
  ['2500', 'Loans Payable', 'LIABILITY', 'long_term_liability', 'LOANS', 'FINANCING'],
  ['3000', "Owner's Capital", 'EQUITY', 'equity', 'CAPITAL', 'FINANCING'],
  ['3100', 'Retained Earnings', 'EQUITY', 'equity', 'RETAINED_EARNINGS', 'FINANCING'],
  ['3200', 'Drawings', 'EQUITY', 'equity', 'DRAWINGS', 'FINANCING'],
  ['3900', 'Opening Balance Equity', 'EQUITY', 'equity', 'OPENING_BALANCE', 'FINANCING'],
  ['4000', 'Sales Revenue', 'REVENUE', 'operating_revenue', 'SALES', 'OPERATING'],
  ['4100', 'Service Revenue', 'REVENUE', 'operating_revenue', 'SERVICE_REVENUE', 'OPERATING'],
  ['4200', 'Other Income', 'REVENUE', 'other_income', 'OTHER_INCOME', 'OPERATING'],
  ['4300', 'Interest Income', 'REVENUE', 'other_income', null, 'OPERATING'],
  ['5000', 'Cost of Goods Sold', 'COST_OF_SALES', 'cost_of_sales', 'COGS', 'OPERATING'],
  ['5100', 'Purchases', 'COST_OF_SALES', 'cost_of_sales', 'PURCHASES', 'OPERATING'],
  ['5200', 'Freight & Clearing', 'COST_OF_SALES', 'cost_of_sales', null, 'OPERATING'],
  ['6000', 'Salaries & Wages', 'EXPENSE', 'payroll', 'SALARIES', 'OPERATING'],
  ['6010', 'NAPSA – Employer Contribution', 'EXPENSE', 'payroll', null, 'OPERATING'],
  ['6100', 'Rent', 'EXPENSE', 'operating_expense', 'RENT', 'OPERATING'],
  ['6110', 'Utilities (Electricity & Water)', 'EXPENSE', 'operating_expense', null, 'OPERATING'],
  ['6120', 'Telephone & Internet', 'EXPENSE', 'operating_expense', null, 'OPERATING'],
  ['6200', 'Fuel', 'EXPENSE', 'operating_expense', 'FUEL', 'OPERATING'],
  ['6210', 'Transport & Travel', 'EXPENSE', 'operating_expense', 'TRANSPORT', 'OPERATING'],
  ['6220', 'Motor Vehicle Expenses', 'EXPENSE', 'operating_expense', null, 'OPERATING'],
  ['6300', 'Office Supplies & Stationery', 'EXPENSE', 'operating_expense', 'OFFICE_SUPPLIES', 'OPERATING'],
  ['6310', 'Printing & Photocopying', 'EXPENSE', 'operating_expense', null, 'OPERATING'],
  ['6400', 'Repairs & Maintenance', 'EXPENSE', 'operating_expense', null, 'OPERATING'],
  ['6500', 'Professional Fees', 'EXPENSE', 'operating_expense', null, 'OPERATING'],
  ['6510', 'Bank Charges', 'EXPENSE', 'operating_expense', 'BANK_CHARGES', 'OPERATING'],
  ['6520', 'Mobile Money Charges', 'EXPENSE', 'operating_expense', null, 'OPERATING'],
  ['6600', 'Advertising & Marketing', 'EXPENSE', 'operating_expense', null, 'OPERATING'],
  ['6700', 'Insurance', 'EXPENSE', 'operating_expense', null, 'OPERATING'],
  ['6800', 'Depreciation', 'EXPENSE', 'non_cash', 'DEPRECIATION', 'OPERATING'],
  ['6900', 'Meals & Entertainment', 'EXPENSE', 'operating_expense', null, 'OPERATING'],
  ['6950', 'Training & Development', 'EXPENSE', 'operating_expense', null, 'OPERATING'],
  ['6960', 'Interest Expense', 'EXPENSE', 'finance_cost', null, 'OPERATING'],
  ['6990', 'General Expenses', 'EXPENSE', 'operating_expense', 'GENERAL_EXPENSE', 'OPERATING'],
  ['6999', 'Rounding & Exchange Differences', 'EXPENSE', 'operating_expense', 'ROUNDING', 'OPERATING'],
];

export const DEFAULT_SETTINGS = {
  branding: {
    primary_color: '#0f5c4a', secondary_color: '#9a5520', theme: 'system',
    logo_document_id: null, logo_light_document_id: null, logo_dark_document_id: null, favicon_document_id: null,
    login_title: 'Welcome back', login_tagline: 'Accounting for Zambian businesses',
    show_logo_on_documents: true, show_logo_on_reports: true,
  },
  documents: {
    invoice: { title: 'Tax Invoice', footer: 'Thank you for your business.', terms: 'Payment due within 30 days of invoice date.', show_bank_details: true, show_tpin: true, layout: 'classic' },
    quote: { title: 'Quotation', footer: 'This quotation is valid for 30 days.', terms: '', layout: 'classic' },
    sales_order: { title: 'Sales Order', footer: '', terms: '', layout: 'classic' },
    credit_note: { title: 'Credit Note', footer: '', terms: '', layout: 'classic' },
    receipt: { title: 'Official Receipt', footer: 'Thank you for your payment.', layout: 'classic' },
    purchase_order: { title: 'Purchase Order', footer: 'Please quote our PO number on your invoice.', terms: '', layout: 'classic' },
    report: { header_note: '', footer_note: 'Generated by TAEL Books', show_logo: true },
    bank_details: '',
  },
  accounting: {
    default_payment_terms_days: 30,
    journal_approval_threshold: '50000.00',
    expense_approval_threshold: '5000.00',
    segregation_of_duties: true,            // creator cannot approve own transaction above threshold
    allow_negative_cash: false,
    ai_drafts_require_approval: true,
  },
  tax: {
    vat_registered: true, default_sales_tax_code: 'VAT16', default_purchase_tax_code: 'VAT16',
    vat_return_due_day: 18, tax_reminder_days_before: 5,
    note: 'Tax rates are configured by your administrator. Confirm current rates with the Zambia Revenue Authority (ZRA).',
  },
  dashboard: {
    widgets: ['revenue', 'expenses', 'net_profit', 'cash_balance', 'bank_balance', 'receivables', 'payables', 'overdue_invoices', 'outstanding_bills',
      'chart_revenue_trend', 'chart_expense_trend', 'chart_profit_trend', 'chart_sales_by_customer', 'chart_expenses_by_category',
      'chart_receivables_aging', 'chart_payables_aging', 'chart_cash_flow', 'review_queue'],
  },
  notifications: {
    invoice_overdue: true, payment_received: true, bill_due: true, bill_due_days: 3,
    reconciliation_required: true, reconciliation_days: 30, unusual_transaction: true, ai_review: true,
    low_cash: true, low_cash_threshold: '10000.00', period_closing: true, tax_deadline: true, approval_required: true, email_notifications: false,
  },
  email: { enabled: false, smtp_host: '', smtp_port: 587, smtp_secure: false, smtp_user: '', from_name: '', from_email: '' },
  ai: {
    enabled: true, provider: 'anthropic', model: '', assistant_name: 'TAEL Assistant',
    allow_transaction_drafts: true, auto_extract_documents: true, anomaly_detection: true,
    large_expense_multiplier: 3, duplicate_window_days: 3, missing_document_threshold: '2000.00',
  },
  security: { session_timeout_hours: 12, password_min_length: 10, max_failed_logins: 5, lockout_minutes: 15 },
  appearance: { density: 'comfortable', date_format: 'DD/MM/YYYY', default_theme: 'system' },
  terminology: { customer: 'Customer', customers: 'Customers', supplier: 'Supplier', suppliers: 'Suppliers', invoice: 'Invoice', bill: 'Bill', expense: 'Expense', branch: 'Branch', department: 'Department' },
  features: { branches: true, departments: true, warehouses: false, multi_currency: false },
  integrations: { webhooks: [], api_enabled: true },
  backup: { retention_count: 30 },
};

/** Deep-merge settings so new keys added in later releases appear for existing companies. */
export function mergeSettings(base, over) {
  if (Array.isArray(base) || typeof base !== 'object' || base === null) return over === undefined ? base : over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over || {})) {
    out[k] = typeof v === 'object' && v !== null && !Array.isArray(v) && typeof base[k] === 'object' && !Array.isArray(base[k]) ? mergeSettings(base[k], v) : v;
  }
  return out;
}

export function fiscalYearFor(date, fyStartMonth) {
  const d = new Date(`${date}T00:00:00Z`);
  const m = d.getUTCMonth() + 1;
  const startYear = m >= fyStartMonth ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
  return startYear;
}

/** Make sure monthly periods exist for the fiscal year containing `date`. */
export async function ensurePeriods(db, companyId, date) {
  const { rows: [c] } = await db.query('SELECT fy_start_month FROM companies WHERE id=$1', [companyId]);
  const y = fiscalYearFor(date, c.fy_start_month);
  for (let i = 0; i < 12; i++) {
    const start = new Date(Date.UTC(y, c.fy_start_month - 1 + i, 1));
    const end = new Date(Date.UTC(y, c.fy_start_month + i, 0));
    const iso = (d) => d.toISOString().slice(0, 10);
    const name = start.toLocaleString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' });
    await db.query(
      `INSERT INTO fiscal_periods (company_id, name, start_date, end_date) VALUES ($1,$2,$3,$4) ON CONFLICT (company_id, start_date) DO NOTHING`,
      [companyId, name, iso(start), iso(end)]);
  }
}

export async function setupCompany(db, data, { createdBy } = {}) {
  const { rows: [company] } = await db.query(
    `INSERT INTO companies (name, legal_name, tpin, vat_number, address, city, phone, email, website, base_currency, fy_start_month, is_demo, settings)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,COALESCE($10,'ZMW'),COALESCE($11,1),COALESCE($12,false),$13) RETURNING *`,
    [data.name, data.legal_name || null, data.tpin || null, data.vat_number || null, data.address || null, data.city || null,
     data.phone || null, data.email || null, data.website || null, data.base_currency || null, data.fy_start_month || null,
     data.is_demo ?? null, JSON.stringify(DEFAULT_SETTINGS)]);
  const cid = company.id;

  const ids = {};
  for (const [code, name, type, subtype, key, cf] of DEFAULT_COA) {
    const { rows: [a] } = await db.query(
      `INSERT INTO accounts (company_id, code, name, type, subtype, system_key, cash_flow_category) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [cid, code, name, type, subtype, key, cf]);
    ids[code] = a.id;
    if (subtype === 'bank' || subtype === 'cash') {
      await db.query(`INSERT INTO bank_accounts (account_id, company_id, bank_name, is_cash) VALUES ($1,$2,$3,$4)`,
        [a.id, cid, subtype === 'bank' ? 'Bank' : null, subtype === 'cash']);
    }
  }

  for (const r of DEFAULT_ROLES) {
    await db.query(`INSERT INTO roles (company_id, name, description, is_system, permissions, transaction_limit) VALUES ($1,$2,$3,true,$4,$5)`,
      [cid, r.name, r.description, r.permissions, r.transaction_limit || null]);
  }

  const taxes = [
    ['VAT16', 'VAT – Standard rated', 'VAT', '16', ids['2100'], ids['1400'], 'BOTH', 'Default standard VAT rate. Confirm the current rate with ZRA.'],
    ['VAT0', 'VAT – Zero rated', 'VAT', '0', ids['2100'], ids['1400'], 'BOTH', 'Zero-rated supplies.'],
    ['EXEMPT', 'VAT – Exempt', 'VAT', '0', null, null, 'BOTH', 'Exempt supplies (no VAT).'],
    ['WHT15', 'Withholding Tax', 'WHT', '15', ids['1410'], ids['2130'], 'BOTH', 'Default withholding rate — configure per payment type as required by ZRA.'],
    ['TOT', 'Turnover Tax', 'TURNOVER', '5', null, null, 'SALES', 'For turnover-tax registered businesses. Confirm the current rate with ZRA.'],
  ];
  for (const [code, name, type, rate, sAcc, pAcc, applies, desc] of taxes) {
    await db.query(
      `INSERT INTO tax_rates (company_id, code, name, tax_type, rate, effective_from, sales_account_id, purchase_account_id, applies_to, description)
       VALUES ($1,$2,$3,$4,$5,'2000-01-01',$6,$7,$8,$9)`, [cid, code, name, type, rate, sAcc, pAcc, applies, desc]);
  }

  for (const [key, d] of Object.entries(SEQUENCE_DEFAULTS)) {
    await db.query(`INSERT INTO number_sequences (company_id, key, prefix, padding) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [cid, key, d.prefix, d.padding]);
  }

  await db.query(`INSERT INTO branches (company_id, code, name) VALUES ($1,'HQ','Head Office')`, [cid]);
  await db.query(`INSERT INTO departments (company_id, code, name) VALUES ($1,'GEN','General'), ($1,'ADM','Administration'), ($1,'SAL','Sales'), ($1,'OPS','Operations')`, [cid]);

  const today = new Date().toISOString().slice(0, 10);
  await ensurePeriods(db, cid, today);

  if (createdBy) {
    const { rows: [role] } = await db.query(`SELECT id FROM roles WHERE company_id=$1 AND name='Super Admin'`, [cid]);
    await db.query(`INSERT INTO memberships (user_id, company_id, role_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [createdBy, cid, role.id]);
  }
  return company;
}
