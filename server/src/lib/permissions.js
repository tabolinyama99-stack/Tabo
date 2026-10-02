// Granular permissions. The backend checks these on every route; the UI only mirrors them.
export const PERMISSIONS = {
  // general
  view_dashboard: 'View dashboard',
  use_ai: 'Use the AI assistant',
  view_audit_logs: 'View audit logs',
  search: 'Use global search',
  // sales
  view_sales: 'View sales documents and customers',
  manage_customers: 'Create and edit customers',
  create_quote: 'Create quotations and sales orders',
  create_invoice: 'Create invoices',
  edit_invoice: 'Edit draft invoices',
  delete_invoice: 'Delete draft invoices / cancel invoices',
  approve_invoice: 'Approve and post invoices',
  create_credit_note: 'Create credit notes',
  send_documents: 'Email documents to customers/suppliers',
  // purchases
  view_purchases: 'View purchase documents and suppliers',
  manage_suppliers: 'Create and edit suppliers',
  create_purchase: 'Create purchase orders and bills',
  edit_purchase: 'Edit draft purchase documents',
  approve_purchase: 'Approve and post bills',
  // payments
  view_payments: 'View receipts and payments',
  create_payment: 'Record receipts and payments',
  edit_payment: 'Edit payments',
  delete_payment: 'Void payments',
  // expenses
  view_expenses: 'View expenses',
  create_expense: 'Record expenses',
  approve_expense: 'Approve and post expenses',
  // banking
  view_banking: 'View bank and cash accounts',
  manage_banking: 'Record deposits, withdrawals, transfers and import statements',
  reconcile_bank: 'Perform bank reconciliations',
  // ledger
  view_ledger: 'View journals and chart of accounts',
  create_journal: 'Create journal entries',
  post_journal: 'Post journal entries',
  approve_transactions: 'Approve transactions awaiting approval',
  reverse_journal: 'Reverse posted journals',
  edit_chart_of_accounts: 'Create and edit accounts',
  manage_periods: 'Lock and close financial periods',
  reopen_periods: 'Reopen locked financial periods',
  // reports
  view_reports: 'View financial reports',
  export_reports: 'Export reports to PDF/Excel',
  // documents
  upload_documents: 'Upload documents and receipts',
  // review
  review_anomalies: 'Review and resolve flagged transactions',
  // admin
  manage_users: 'Manage users',
  manage_roles: 'Manage roles and permissions',
  manage_settings: 'Manage company settings',
  manage_company: 'Manage company information and branding',
  manage_tax: 'Manage tax configuration',
  manage_ai: 'Manage AI configuration',
  manage_integrations: 'Manage integrations and API keys',
  manage_backups: 'Create configuration backups',
};
export const ALL_PERMISSIONS = Object.keys(PERMISSIONS);

const P = ALL_PERMISSIONS;
const pick = (...prefixes) => P.filter((p) => prefixes.some((x) => (x.endsWith('*') ? p.startsWith(x.slice(0, -1)) : p === x)));
const readOnly = ['view_dashboard', 'view_sales', 'view_purchases', 'view_payments', 'view_expenses', 'view_banking', 'view_ledger', 'view_reports', 'search'];

export const DEFAULT_ROLES = [
  { name: 'Super Admin', description: 'Platform owner — unrestricted configuration (granted via user flag).', permissions: P },
  { name: 'Admin', description: 'Company administrator.', permissions: P.filter((p) => p !== 'reopen_periods') },
  { name: 'Finance Manager', description: 'Approves, posts and closes periods.', permissions: P.filter((p) => !['manage_users', 'manage_roles', 'manage_integrations', 'manage_ai', 'manage_backups'].includes(p)) },
  { name: 'Accountant', description: 'Day-to-day bookkeeping and reporting.', permissions: [...readOnly, 'use_ai', 'manage_customers', 'manage_suppliers', ...pick('create_*', 'edit_*'), 'approve_invoice', 'approve_purchase', 'approve_expense', 'post_journal', 'reverse_journal', 'edit_chart_of_accounts', 'manage_banking', 'reconcile_bank', 'export_reports', 'upload_documents', 'review_anomalies', 'send_documents'], transaction_limit: '500000.00' },
  { name: 'Cashier', description: 'Receipts, payments and cash expenses.', permissions: ['view_dashboard', 'view_sales', 'view_payments', 'view_expenses', 'view_banking', 'search', 'create_payment', 'create_expense', 'upload_documents', 'use_ai'], transaction_limit: '20000.00' },
  { name: 'Sales User', description: 'Customers, quotations and invoices.', permissions: ['view_dashboard', 'view_sales', 'search', 'manage_customers', 'create_quote', 'create_invoice', 'edit_invoice', 'send_documents', 'upload_documents', 'use_ai'] },
  { name: 'Purchase User', description: 'Suppliers, purchase orders and bills.', permissions: ['view_dashboard', 'view_purchases', 'search', 'manage_suppliers', 'create_purchase', 'edit_purchase', 'upload_documents', 'use_ai'] },
  { name: 'Auditor', description: 'Read-only access including audit logs.', permissions: [...readOnly, 'view_payments', 'view_audit_logs', 'export_reports', 'use_ai'] },
  { name: 'Viewer', description: 'Read-only dashboards and reports.', permissions: ['view_dashboard', 'view_reports', 'search'] },
];
