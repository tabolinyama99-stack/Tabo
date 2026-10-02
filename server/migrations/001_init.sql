-- TAEL Books — initial schema
-- Money is always NUMERIC(18,2). Quantities NUMERIC(18,4). Rates NUMERIC(9,4).
-- Every business table is scoped by company_id (multi-company isolation).

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ───────────────────────── Platform ─────────────────────────
CREATE TABLE currencies (
  code        CHAR(3) PRIMARY KEY,
  name        TEXT NOT NULL,
  symbol      TEXT NOT NULL,
  decimals    SMALLINT NOT NULL DEFAULT 2,
  enabled     BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE companies (
  id              BIGSERIAL PRIMARY KEY,
  name            TEXT NOT NULL CHECK (length(trim(name)) > 0),
  legal_name      TEXT,
  tpin            TEXT,
  vat_number      TEXT,
  registration_no TEXT,
  address         TEXT,
  city            TEXT,
  country         TEXT NOT NULL DEFAULT 'Zambia',
  phone           TEXT,
  phone_alt       TEXT,
  email           TEXT,
  website         TEXT,
  base_currency   CHAR(3) NOT NULL DEFAULT 'ZMW' REFERENCES currencies(code),
  fy_start_month  SMALLINT NOT NULL DEFAULT 1 CHECK (fy_start_month BETWEEN 1 AND 12),
  timezone        TEXT NOT NULL DEFAULT 'Africa/Lusaka',
  is_demo         BOOLEAN NOT NULL DEFAULT FALSE,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  settings        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id                    BIGSERIAL PRIMARY KEY,
  email                 TEXT NOT NULL,
  name                  TEXT NOT NULL,
  phone                 TEXT,
  password_hash         TEXT NOT NULL,
  is_super_admin        BOOLEAN NOT NULL DEFAULT FALSE,
  is_active             BOOLEAN NOT NULL DEFAULT TRUE,
  must_change_password  BOOLEAN NOT NULL DEFAULT FALSE,
  failed_logins         INT NOT NULL DEFAULT 0,
  locked_until          TIMESTAMPTZ,
  last_login_at         TIMESTAMPTZ,
  password_changed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_uq ON users (lower(email));

CREATE TABLE roles (
  id                BIGSERIAL PRIMARY KEY,
  company_id        BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  description       TEXT,
  is_system         BOOLEAN NOT NULL DEFAULT FALSE,
  permissions       TEXT[] NOT NULL DEFAULT '{}',
  transaction_limit NUMERIC(18,2),          -- max amount this role may post/approve; NULL = unlimited
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, name)
);

CREATE TABLE branches (
  id          BIGSERIAL PRIMARY KEY,
  company_id  BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  code        TEXT NOT NULL,
  name        TEXT NOT NULL,
  address     TEXT,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE (company_id, code)
);
CREATE TABLE departments (
  id          BIGSERIAL PRIMARY KEY,
  company_id  BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  code        TEXT NOT NULL,
  name        TEXT NOT NULL,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE (company_id, code)
);
CREATE TABLE warehouses (
  id          BIGSERIAL PRIMARY KEY,
  company_id  BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  code        TEXT NOT NULL,
  name        TEXT NOT NULL,
  location    TEXT,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE (company_id, code)
);

CREATE TABLE memberships (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company_id  BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  role_id     BIGINT NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
  branch_id   BIGINT REFERENCES branches(id) ON DELETE SET NULL,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, company_id)
);

CREATE TABLE sessions (
  id           TEXT PRIMARY KEY,               -- sha256 of the cookie token
  user_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company_id   BIGINT REFERENCES companies(id) ON DELETE SET NULL,
  csrf_token   TEXT NOT NULL,
  ip           TEXT,
  user_agent   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL
);
CREATE INDEX sessions_user_idx ON sessions(user_id);

CREATE TABLE api_keys (
  id           BIGSERIAL PRIMARY KEY,
  company_id   BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  prefix       TEXT NOT NULL,
  key_hash     TEXT NOT NULL UNIQUE,
  permissions  TEXT[] NOT NULL DEFAULT '{}',
  created_by   BIGINT REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  revoked_at   TIMESTAMPTZ
);

-- Encrypted secrets (AI keys, SMTP passwords). company_id NULL = platform-wide.
CREATE TABLE secrets (
  id          BIGSERIAL PRIMARY KEY,
  company_id  BIGINT REFERENCES companies(id) ON DELETE CASCADE,
  key         TEXT NOT NULL,
  ciphertext  TEXT NOT NULL,
  updated_by  BIGINT REFERENCES users(id),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX secrets_uq ON secrets (COALESCE(company_id, 0), key);

CREATE TABLE number_sequences (
  company_id  BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  key         TEXT NOT NULL,
  prefix      TEXT NOT NULL DEFAULT '',
  suffix      TEXT NOT NULL DEFAULT '',
  next_value  BIGINT NOT NULL DEFAULT 1 CHECK (next_value > 0),
  padding     SMALLINT NOT NULL DEFAULT 5 CHECK (padding BETWEEN 1 AND 12),
  PRIMARY KEY (company_id, key)
);

-- ───────────────────────── Files ─────────────────────────
CREATE TABLE documents (
  id            BIGSERIAL PRIMARY KEY,
  company_id    BIGINT REFERENCES companies(id) ON DELETE CASCADE,
  category      TEXT NOT NULL DEFAULT 'general',   -- receipt, invoice, bank_statement, branding, general...
  original_name TEXT NOT NULL,
  storage_key   TEXT NOT NULL UNIQUE,
  mime_type     TEXT NOT NULL,
  size_bytes    BIGINT NOT NULL CHECK (size_bytes >= 0),
  sha256        TEXT NOT NULL,
  linked_type   TEXT,
  linked_id     BIGINT,
  extracted     JSONB,                             -- AI/OCR extraction result
  uploaded_by   BIGINT REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX documents_link_idx ON documents(company_id, linked_type, linked_id);

-- ───────────────────────── Ledger ─────────────────────────
CREATE TYPE account_type AS ENUM ('ASSET','LIABILITY','EQUITY','REVENUE','COST_OF_SALES','EXPENSE');

CREATE TABLE accounts (
  id                 BIGSERIAL PRIMARY KEY,
  company_id         BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  code               TEXT NOT NULL,
  name               TEXT NOT NULL,
  type               account_type NOT NULL,
  subtype            TEXT NOT NULL DEFAULT 'general',  -- bank, cash, receivable, payable, tax, current_asset, fixed_asset, ...
  parent_id          BIGINT REFERENCES accounts(id) ON DELETE RESTRICT,
  system_key         TEXT,                              -- AR, AP, VAT_OUTPUT, VAT_INPUT, RETAINED_EARNINGS, ...
  cash_flow_category TEXT NOT NULL DEFAULT 'OPERATING' CHECK (cash_flow_category IN ('OPERATING','INVESTING','FINANCING','CASH')),
  description        TEXT,
  is_active          BOOLEAN NOT NULL DEFAULT TRUE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, code),
  UNIQUE (company_id, system_key),
  CHECK (parent_id IS NULL OR parent_id <> id)
);

CREATE TABLE bank_accounts (
  account_id      BIGINT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  company_id      BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  bank_name       TEXT,
  account_number  TEXT,
  branch_name     TEXT,
  currency        CHAR(3) NOT NULL DEFAULT 'ZMW' REFERENCES currencies(code),
  is_cash         BOOLEAN NOT NULL DEFAULT FALSE,
  low_balance_threshold NUMERIC(18,2)
);

CREATE TABLE fiscal_periods (
  id          BIGSERIAL PRIMARY KEY,
  company_id  BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  start_date  DATE NOT NULL,
  end_date    DATE NOT NULL,
  status      TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','LOCKED','CLOSED')),
  locked_by   BIGINT REFERENCES users(id),
  locked_at   TIMESTAMPTZ,
  CHECK (end_date >= start_date),
  UNIQUE (company_id, start_date)
);

CREATE TABLE customers (
  id                  BIGSERIAL PRIMARY KEY,
  company_id          BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  code                TEXT NOT NULL,
  name                TEXT NOT NULL CHECK (length(trim(name)) > 0),
  contact_person      TEXT,
  email               TEXT,
  phone               TEXT,
  address             TEXT,
  tpin                TEXT,
  credit_limit        NUMERIC(18,2),
  payment_terms_days  INT NOT NULL DEFAULT 30 CHECK (payment_terms_days >= 0),
  branch_id           BIGINT REFERENCES branches(id),
  notes               TEXT,
  is_active           BOOLEAN NOT NULL DEFAULT TRUE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, code)
);
CREATE INDEX customers_name_trgm ON customers USING gin (name gin_trgm_ops);

CREATE TABLE suppliers (
  id                  BIGSERIAL PRIMARY KEY,
  company_id          BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  code                TEXT NOT NULL,
  name                TEXT NOT NULL CHECK (length(trim(name)) > 0),
  contact_person      TEXT,
  email               TEXT,
  phone               TEXT,
  address             TEXT,
  tpin                TEXT,
  payment_terms_days  INT NOT NULL DEFAULT 30 CHECK (payment_terms_days >= 0),
  default_account_id  BIGINT REFERENCES accounts(id),
  bank_details        TEXT,
  notes               TEXT,
  is_active           BOOLEAN NOT NULL DEFAULT TRUE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, code)
);
CREATE INDEX suppliers_name_trgm ON suppliers USING gin (name gin_trgm_ops);

CREATE TABLE tax_rates (
  id                   BIGSERIAL PRIMARY KEY,
  company_id           BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  code                 TEXT NOT NULL,
  name                 TEXT NOT NULL,
  tax_type             TEXT NOT NULL CHECK (tax_type IN ('VAT','WHT','PAYE','TURNOVER','EXCISE','OTHER')),
  rate                 NUMERIC(9,4) NOT NULL CHECK (rate >= 0 AND rate <= 100),
  effective_from       DATE NOT NULL,
  effective_to         DATE,
  sales_account_id     BIGINT REFERENCES accounts(id),   -- output tax / tax payable
  purchase_account_id  BIGINT REFERENCES accounts(id),   -- input tax recoverable
  applies_to           TEXT NOT NULL DEFAULT 'BOTH' CHECK (applies_to IN ('SALES','PURCHASES','BOTH','PAYROLL')),
  description          TEXT,
  is_active            BOOLEAN NOT NULL DEFAULT TRUE,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (effective_to IS NULL OR effective_to >= effective_from),
  UNIQUE (company_id, code, effective_from)
);

CREATE TABLE items (
  id                 BIGSERIAL PRIMARY KEY,
  company_id         BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  code               TEXT NOT NULL,
  name               TEXT NOT NULL,
  description        TEXT,
  unit               TEXT DEFAULT 'each',
  sale_price         NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (sale_price >= 0),
  purchase_price     NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (purchase_price >= 0),
  income_account_id  BIGINT REFERENCES accounts(id),
  expense_account_id BIGINT REFERENCES accounts(id),
  tax_rate_id        BIGINT REFERENCES tax_rates(id),
  is_active          BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE (company_id, code)
);

CREATE TABLE journal_entries (
  id              BIGSERIAL PRIMARY KEY,
  company_id      BIGINT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  number          TEXT,
  entry_date      DATE NOT NULL,
  reference       TEXT,
  description     TEXT NOT NULL,
  source_type     TEXT NOT NULL DEFAULT 'MANUAL',
  source_id       BIGINT,
  status          TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','PENDING_APPROVAL','POSTED','REVERSED','VOID')),
  is_adjusting    BOOLEAN NOT NULL DEFAULT FALSE,
  reversal_of     BIGINT REFERENCES journal_entries(id),
  reversed_by     BIGINT REFERENCES journal_entries(id),
  auto_reverse_on DATE,
  recurring_id    BIGINT,
  branch_id       BIGINT REFERENCES branches(id),
  department_id   BIGINT REFERENCES departments(id),
  total           NUMERIC(18,2) NOT NULL DEFAULT 0,
  ai_generated    BOOLEAN NOT NULL DEFAULT FALSE,
  ai_rationale    TEXT,
  created_by      BIGINT REFERENCES users(id),
  approved_by     BIGINT REFERENCES users(id),
  approved_at     TIMESTAMPTZ,
  posted_by       BIGINT REFERENCES users(id),
  posted_at       TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, number)
);
CREATE INDEX je_company_date_idx ON journal_entries(company_id, entry_date);
CREATE INDEX je_source_idx ON journal_entries(company_id, source_type, source_id);

CREATE TABLE journal_lines (
  id              BIGSERIAL PRIMARY KEY,
  entry_id        BIGINT NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
  company_id      BIGINT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  line_no         INT NOT NULL,
  account_id      BIGINT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  description     TEXT,
  debit           NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (debit >= 0),
  credit          NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (credit >= 0),
  customer_id     BIGINT REFERENCES customers(id),
  supplier_id     BIGINT REFERENCES suppliers(id),
  tax_rate_id     BIGINT REFERENCES tax_rates(id),
  branch_id       BIGINT REFERENCES branches(id),
  department_id   BIGINT REFERENCES departments(id),
  reconciliation_id BIGINT,
  cleared         BOOLEAN NOT NULL DEFAULT FALSE,
  CHECK ((debit = 0) <> (credit = 0)),             -- exactly one side non-zero
  UNIQUE (entry_id, line_no)
);
CREATE INDEX jl_account_idx ON journal_lines(company_id, account_id);
CREATE INDEX jl_customer_idx ON journal_lines(customer_id) WHERE customer_id IS NOT NULL;
CREATE INDEX jl_supplier_idx ON journal_lines(supplier_id) WHERE supplier_id IS NOT NULL;

-- The ledger is only ever read through posted entries.
CREATE VIEW ledger AS
  SELECT l.*, e.entry_date, e.number AS entry_number, e.reference, e.description AS entry_description,
         e.source_type, e.source_id, e.status
    FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
   WHERE e.status IN ('POSTED','REVERSED');

CREATE TABLE recurring_journals (
  id             BIGSERIAL PRIMARY KEY,
  company_id     BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  description    TEXT NOT NULL,
  lines          JSONB NOT NULL,
  frequency      TEXT NOT NULL CHECK (frequency IN ('WEEKLY','MONTHLY','QUARTERLY','YEARLY')),
  next_run_date  DATE NOT NULL,
  end_date       DATE,
  auto_post      BOOLEAN NOT NULL DEFAULT FALSE,
  is_active      BOOLEAN NOT NULL DEFAULT TRUE,
  last_run_at    TIMESTAMPTZ,
  created_by     BIGINT REFERENCES users(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ───────────────────────── Sales ─────────────────────────
CREATE TABLE sales_documents (
  id                  BIGSERIAL PRIMARY KEY,
  company_id          BIGINT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  doc_type            TEXT NOT NULL CHECK (doc_type IN ('QUOTE','ORDER','INVOICE','CREDIT_NOTE')),
  number              TEXT,
  customer_id         BIGINT NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  doc_date            DATE NOT NULL,
  due_date            DATE,
  reference           TEXT,
  notes               TEXT,
  terms               TEXT,
  status              TEXT NOT NULL DEFAULT 'DRAFT',
  currency            CHAR(3) NOT NULL DEFAULT 'ZMW' REFERENCES currencies(code),
  subtotal            NUMERIC(18,2) NOT NULL DEFAULT 0,
  tax_total           NUMERIC(18,2) NOT NULL DEFAULT 0,
  total               NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (total >= 0),
  amount_paid         NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (amount_paid >= 0),  -- maintained from allocations
  amount_credited     NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (amount_credited >= 0),
  related_document_id BIGINT REFERENCES sales_documents(id),
  journal_entry_id    BIGINT REFERENCES journal_entries(id),
  branch_id           BIGINT REFERENCES branches(id),
  department_id       BIGINT REFERENCES departments(id),
  created_by          BIGINT REFERENCES users(id),
  sent_at             TIMESTAMPTZ,
  posted_at           TIMESTAMPTZ,
  cancelled_at        TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, doc_type, number),
  CHECK (amount_paid + amount_credited <= total OR doc_type <> 'INVOICE')
);
CREATE INDEX sd_customer_idx ON sales_documents(company_id, customer_id);
CREATE INDEX sd_type_status_idx ON sales_documents(company_id, doc_type, status);

CREATE TABLE sales_document_lines (
  id            BIGSERIAL PRIMARY KEY,
  document_id   BIGINT NOT NULL REFERENCES sales_documents(id) ON DELETE CASCADE,
  line_no       INT NOT NULL,
  item_id       BIGINT REFERENCES items(id),
  description   TEXT NOT NULL,
  quantity      NUMERIC(18,4) NOT NULL CHECK (quantity > 0),
  unit_price    NUMERIC(18,2) NOT NULL CHECK (unit_price >= 0),
  discount_pct  NUMERIC(9,4) NOT NULL DEFAULT 0 CHECK (discount_pct >= 0 AND discount_pct <= 100),
  account_id    BIGINT NOT NULL REFERENCES accounts(id),
  tax_rate_id   BIGINT REFERENCES tax_rates(id),
  line_subtotal NUMERIC(18,2) NOT NULL,
  line_tax      NUMERIC(18,2) NOT NULL DEFAULT 0,
  line_total    NUMERIC(18,2) NOT NULL,
  UNIQUE (document_id, line_no)
);

-- ───────────────────────── Purchases ─────────────────────────
CREATE TABLE purchase_documents (
  id                  BIGSERIAL PRIMARY KEY,
  company_id          BIGINT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  doc_type            TEXT NOT NULL CHECK (doc_type IN ('PO','BILL','DEBIT_NOTE')),
  number              TEXT,
  supplier_id         BIGINT NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
  supplier_reference  TEXT,                       -- supplier's own invoice number
  doc_date            DATE NOT NULL,
  due_date            DATE,
  notes               TEXT,
  status              TEXT NOT NULL DEFAULT 'DRAFT',
  currency            CHAR(3) NOT NULL DEFAULT 'ZMW' REFERENCES currencies(code),
  subtotal            NUMERIC(18,2) NOT NULL DEFAULT 0,
  tax_total           NUMERIC(18,2) NOT NULL DEFAULT 0,
  total               NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (total >= 0),
  amount_paid         NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (amount_paid >= 0),
  amount_credited     NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (amount_credited >= 0),
  related_document_id BIGINT REFERENCES purchase_documents(id),
  journal_entry_id    BIGINT REFERENCES journal_entries(id),
  document_id         BIGINT REFERENCES documents(id),
  branch_id           BIGINT REFERENCES branches(id),
  department_id       BIGINT REFERENCES departments(id),
  ai_generated        BOOLEAN NOT NULL DEFAULT FALSE,
  created_by          BIGINT REFERENCES users(id),
  approved_by         BIGINT REFERENCES users(id),
  posted_at           TIMESTAMPTZ,
  cancelled_at        TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, doc_type, number),
  CHECK (amount_paid + amount_credited <= total OR doc_type <> 'BILL')
);
CREATE INDEX pd_supplier_idx ON purchase_documents(company_id, supplier_id);

CREATE TABLE purchase_document_lines (
  id            BIGSERIAL PRIMARY KEY,
  document_id   BIGINT NOT NULL REFERENCES purchase_documents(id) ON DELETE CASCADE,
  line_no       INT NOT NULL,
  item_id       BIGINT REFERENCES items(id),
  description   TEXT NOT NULL,
  quantity      NUMERIC(18,4) NOT NULL CHECK (quantity > 0),
  unit_price    NUMERIC(18,2) NOT NULL CHECK (unit_price >= 0),
  discount_pct  NUMERIC(9,4) NOT NULL DEFAULT 0 CHECK (discount_pct >= 0 AND discount_pct <= 100),
  account_id    BIGINT NOT NULL REFERENCES accounts(id),
  tax_rate_id   BIGINT REFERENCES tax_rates(id),
  line_subtotal NUMERIC(18,2) NOT NULL,
  line_tax      NUMERIC(18,2) NOT NULL DEFAULT 0,
  line_total    NUMERIC(18,2) NOT NULL,
  UNIQUE (document_id, line_no)
);

-- ───────────────────────── Payments & receipts ─────────────────────────
CREATE TABLE payments (
  id                BIGSERIAL PRIMARY KEY,
  company_id        BIGINT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  direction         TEXT NOT NULL CHECK (direction IN ('IN','OUT')),     -- IN = receipt
  number            TEXT,
  payment_date      DATE NOT NULL,
  customer_id       BIGINT REFERENCES customers(id),
  supplier_id       BIGINT REFERENCES suppliers(id),
  amount            NUMERIC(18,2) NOT NULL CHECK (amount > 0),
  bank_account_id   BIGINT NOT NULL REFERENCES accounts(id),
  method            TEXT NOT NULL DEFAULT 'BANK_TRANSFER' CHECK (method IN ('CASH','BANK_TRANSFER','MOBILE_MONEY','CHEQUE','CARD','OTHER')),
  wht_rate_id       BIGINT REFERENCES tax_rates(id),
  wht_amount        NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (wht_amount >= 0),
  reference         TEXT,
  notes             TEXT,
  status            TEXT NOT NULL DEFAULT 'POSTED' CHECK (status IN ('POSTED','VOID')),
  journal_entry_id  BIGINT REFERENCES journal_entries(id),
  created_by        BIGINT REFERENCES users(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, direction, number),
  CHECK ((direction = 'IN' AND customer_id IS NOT NULL AND supplier_id IS NULL)
      OR (direction = 'OUT' AND supplier_id IS NOT NULL AND customer_id IS NULL))
);

CREATE TABLE payment_allocations (
  id                    BIGSERIAL PRIMARY KEY,
  payment_id            BIGINT NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  sales_document_id     BIGINT REFERENCES sales_documents(id),
  purchase_document_id  BIGINT REFERENCES purchase_documents(id),
  amount                NUMERIC(18,2) NOT NULL CHECK (amount > 0),
  CHECK ((sales_document_id IS NULL) <> (purchase_document_id IS NULL))
);

-- ───────────────────────── Expenses ─────────────────────────
CREATE TABLE expenses (
  id                 BIGSERIAL PRIMARY KEY,
  company_id         BIGINT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  number             TEXT,
  expense_date       DATE NOT NULL,
  supplier_id        BIGINT REFERENCES suppliers(id),
  payee_name         TEXT,
  account_id         BIGINT NOT NULL REFERENCES accounts(id),           -- expense category
  amount             NUMERIC(18,2) NOT NULL CHECK (amount > 0),          -- net of tax
  tax_rate_id        BIGINT REFERENCES tax_rates(id),
  tax_amount         NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (tax_amount >= 0),
  total              NUMERIC(18,2) NOT NULL CHECK (total > 0),
  payment_account_id BIGINT NOT NULL REFERENCES accounts(id),           -- bank/cash paid from
  payment_method     TEXT NOT NULL DEFAULT 'CASH',
  description        TEXT,
  reference          TEXT,
  branch_id          BIGINT REFERENCES branches(id),
  department_id      BIGINT REFERENCES departments(id),
  document_id        BIGINT REFERENCES documents(id),
  status             TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','PENDING_APPROVAL','POSTED','VOID')),
  journal_entry_id   BIGINT REFERENCES journal_entries(id),
  ai_generated       BOOLEAN NOT NULL DEFAULT FALSE,
  ai_confidence      NUMERIC(5,2),
  created_by         BIGINT REFERENCES users(id),
  approved_by        BIGINT REFERENCES users(id),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, number),
  CHECK (total = amount + tax_amount)
);

-- ───────────────────────── Banking ─────────────────────────
CREATE TABLE reconciliations (
  id                 BIGSERIAL PRIMARY KEY,
  company_id         BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  bank_account_id    BIGINT NOT NULL REFERENCES accounts(id),
  statement_date     DATE NOT NULL,
  statement_balance  NUMERIC(18,2) NOT NULL,
  opening_balance    NUMERIC(18,2) NOT NULL DEFAULT 0,
  book_balance       NUMERIC(18,2),
  cleared_balance    NUMERIC(18,2),
  difference         NUMERIC(18,2),
  status             TEXT NOT NULL DEFAULT 'IN_PROGRESS' CHECK (status IN ('IN_PROGRESS','COMPLETED')),
  created_by         BIGINT REFERENCES users(id),
  completed_by       BIGINT REFERENCES users(id),
  completed_at       TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE journal_lines ADD CONSTRAINT jl_recon_fk FOREIGN KEY (reconciliation_id) REFERENCES reconciliations(id) ON DELETE SET NULL;

CREATE TABLE bank_statement_imports (
  id               BIGSERIAL PRIMARY KEY,
  company_id       BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  bank_account_id  BIGINT NOT NULL REFERENCES accounts(id),
  filename         TEXT,
  line_count       INT NOT NULL DEFAULT 0,
  imported_by      BIGINT REFERENCES users(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE bank_statement_lines (
  id                BIGSERIAL PRIMARY KEY,
  company_id        BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  bank_account_id   BIGINT NOT NULL REFERENCES accounts(id),
  import_id         BIGINT REFERENCES bank_statement_imports(id) ON DELETE CASCADE,
  txn_date          DATE NOT NULL,
  description       TEXT,
  reference         TEXT,
  amount            NUMERIC(18,2) NOT NULL CHECK (amount <> 0),        -- +deposit / -withdrawal
  balance           NUMERIC(18,2),
  status            TEXT NOT NULL DEFAULT 'UNMATCHED' CHECK (status IN ('UNMATCHED','MATCHED','EXCLUDED')),
  matched_line_id   BIGINT REFERENCES journal_lines(id) ON DELETE SET NULL,
  reconciliation_id BIGINT REFERENCES reconciliations(id) ON DELETE SET NULL,
  matched_by        BIGINT REFERENCES users(id),
  matched_at        TIMESTAMPTZ,
  fingerprint       TEXT NOT NULL,
  UNIQUE (company_id, bank_account_id, fingerprint)
);

-- ───────────────────────── AI, review, notifications ─────────────────────────
CREATE TABLE ai_conversations (
  id          BIGSERIAL PRIMARY KEY,
  company_id  BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title       TEXT NOT NULL DEFAULT 'New conversation',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE ai_messages (
  id               BIGSERIAL PRIMARY KEY,
  conversation_id  BIGINT NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
  role             TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content          TEXT NOT NULL,
  data             JSONB,            -- tool results, sources, drafts created
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE review_flags (
  id           BIGSERIAL PRIMARY KEY,
  company_id   BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL,
  severity     TEXT NOT NULL DEFAULT 'MEDIUM' CHECK (severity IN ('LOW','MEDIUM','HIGH')),
  entity_type  TEXT NOT NULL,
  entity_id    BIGINT NOT NULL,
  message      TEXT NOT NULL,
  details      JSONB NOT NULL DEFAULT '{}'::jsonb,
  status       TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','RESOLVED','DISMISSED')),
  resolved_by  BIGINT REFERENCES users(id),
  resolved_at  TIMESTAMPTZ,
  resolution_note TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, kind, entity_type, entity_id)
);

CREATE TABLE notifications (
  id          BIGSERIAL PRIMARY KEY,
  company_id  BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id     BIGINT REFERENCES users(id) ON DELETE CASCADE,   -- NULL = everyone with access to the kind
  kind        TEXT NOT NULL,
  title       TEXT NOT NULL,
  body        TEXT,
  link        TEXT,
  dedupe_key  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, dedupe_key)
);
CREATE TABLE notification_reads (
  notification_id BIGINT NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  user_id         BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  read_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (notification_id, user_id)
);

CREATE TABLE email_log (
  id          BIGSERIAL PRIMARY KEY,
  company_id  BIGINT REFERENCES companies(id) ON DELETE CASCADE,
  to_address  TEXT NOT NULL,
  subject     TEXT NOT NULL,
  status      TEXT NOT NULL,            -- SENT, FAILED, NOT_CONFIGURED
  error       TEXT,
  related_type TEXT,
  related_id  BIGINT,
  sent_by     BIGINT REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE backups (
  id          BIGSERIAL PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('DATABASE','CONFIG')),
  company_id  BIGINT REFERENCES companies(id) ON DELETE SET NULL,
  filename    TEXT NOT NULL,
  size_bytes  BIGINT,
  sha256      TEXT,
  status      TEXT NOT NULL DEFAULT 'COMPLETED',
  notes       TEXT,
  created_by  BIGINT REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ───────────────────────── Audit trail (immutable, hash-chained) ─────────────────────────
CREATE TABLE audit_logs (
  id           BIGSERIAL PRIMARY KEY,
  company_id   BIGINT,
  user_id      BIGINT,
  user_email   TEXT,
  action       TEXT NOT NULL,
  entity_type  TEXT,
  entity_id    TEXT,
  old_value    JSONB,
  new_value    JSONB,
  ip           TEXT,
  user_agent   TEXT,
  via_ai       BOOLEAN NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  prev_hash    TEXT,
  hash         TEXT
);
CREATE INDEX audit_company_idx ON audit_logs(company_id, created_at DESC);
CREATE INDEX audit_entity_idx ON audit_logs(entity_type, entity_id);

CREATE OR REPLACE FUNCTION audit_chain() RETURNS trigger AS $$
DECLARE last_hash TEXT;
BEGIN
  PERFORM pg_advisory_xact_lock(424242);
  SELECT hash INTO last_hash FROM audit_logs ORDER BY id DESC LIMIT 1;
  NEW.prev_hash := COALESCE(last_hash, 'GENESIS');
  NEW.hash := encode(digest(
      NEW.prev_hash || '|' || COALESCE(NEW.company_id::text,'') || '|' || COALESCE(NEW.user_id::text,'') || '|' ||
      NEW.action || '|' || COALESCE(NEW.entity_type,'') || '|' || COALESCE(NEW.entity_id,'') || '|' ||
      COALESCE(NEW.old_value::text,'') || '|' || COALESCE(NEW.new_value::text,'') || '|' || NEW.created_at::text,
      'sha256'), 'hex');
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER audit_chain_trg BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION audit_chain();

CREATE OR REPLACE FUNCTION audit_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Audit log entries are immutable' USING ERRCODE = 'P0001';
END $$ LANGUAGE plpgsql;
CREATE TRIGGER audit_no_update BEFORE UPDATE OR DELETE ON audit_logs FOR EACH ROW EXECUTE FUNCTION audit_immutable();

-- ───────────────────────── Ledger integrity, enforced in the database ─────────────────────────
-- 1. A posted entry must balance (checked at COMMIT, so lines can be inserted one by one).
CREATE OR REPLACE FUNCTION check_entry_balanced() RETURNS trigger AS $$
DECLARE eid BIGINT; st TEXT; d NUMERIC; c NUMERIC; n INT;
BEGIN
  IF TG_TABLE_NAME = 'journal_entries' THEN
    eid := NEW.id;
  ELSIF TG_OP = 'DELETE' THEN
    eid := OLD.entry_id;
  ELSE
    eid := NEW.entry_id;
  END IF;
  SELECT status INTO st FROM journal_entries WHERE id = eid;
  IF st IN ('POSTED','REVERSED') THEN
    SELECT COALESCE(SUM(debit),0), COALESCE(SUM(credit),0), COUNT(*) INTO d, c, n FROM journal_lines WHERE entry_id = eid;
    IF n < 2 THEN RAISE EXCEPTION 'Journal % must have at least two lines', eid USING ERRCODE = 'P0002'; END IF;
    IF d <> c THEN RAISE EXCEPTION 'Journal % is unbalanced: debits % <> credits %', eid, d, c USING ERRCODE = 'P0002'; END IF;
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER jl_balanced AFTER INSERT OR UPDATE OR DELETE ON journal_lines
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_entry_balanced();
CREATE CONSTRAINT TRIGGER je_balanced AFTER INSERT OR UPDATE ON journal_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_entry_balanced();

-- 2. Posted lines cannot be changed (only reconciliation flags may move).
CREATE OR REPLACE FUNCTION protect_posted_lines() RETURNS trigger AS $$
DECLARE st TEXT;
BEGIN
  SELECT status INTO st FROM journal_entries WHERE id = COALESCE(OLD.entry_id, NEW.entry_id);
  IF st IN ('POSTED','REVERSED') THEN
    IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Posted journal lines cannot be deleted; reverse the journal instead' USING ERRCODE = 'P0003'; END IF;
    IF TG_OP = 'UPDATE' AND (NEW.account_id, NEW.debit, NEW.credit, NEW.entry_id) IS DISTINCT FROM (OLD.account_id, OLD.debit, OLD.credit, OLD.entry_id) THEN
      RAISE EXCEPTION 'Posted journal lines cannot be edited; reverse the journal instead' USING ERRCODE = 'P0003';
    END IF;
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$ LANGUAGE plpgsql;
CREATE TRIGGER jl_protect BEFORE UPDATE OR DELETE ON journal_lines FOR EACH ROW EXECUTE FUNCTION protect_posted_lines();

CREATE OR REPLACE FUNCTION protect_posted_entries() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND OLD.status IN ('POSTED','REVERSED') THEN
    RAISE EXCEPTION 'Posted journals cannot be deleted' USING ERRCODE = 'P0003';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status IN ('POSTED','REVERSED') THEN
    IF NEW.status NOT IN ('POSTED','REVERSED') OR (OLD.status = 'REVERSED' AND NEW.status <> 'REVERSED') THEN
      RAISE EXCEPTION 'A posted journal can only be reversed' USING ERRCODE = 'P0003';
    END IF;
    IF (NEW.entry_date, NEW.company_id, NEW.total) IS DISTINCT FROM (OLD.entry_date, OLD.company_id, OLD.total) THEN
      RAISE EXCEPTION 'Posted journal date and amount cannot be changed' USING ERRCODE = 'P0003';
    END IF;
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$ LANGUAGE plpgsql;
CREATE TRIGGER je_protect BEFORE UPDATE OR DELETE ON journal_entries FOR EACH ROW EXECUTE FUNCTION protect_posted_entries();

-- 3. Nothing may be posted into a locked or closed period.
CREATE OR REPLACE FUNCTION check_period_open() RETURNS trigger AS $$
DECLARE ps TEXT;
BEGIN
  IF NEW.status = 'POSTED' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'POSTED') THEN
    SELECT status INTO ps FROM fiscal_periods
     WHERE company_id = NEW.company_id AND NEW.entry_date BETWEEN start_date AND end_date LIMIT 1;
    IF ps IN ('LOCKED','CLOSED') THEN
      RAISE EXCEPTION 'Financial period is locked for %', NEW.entry_date USING ERRCODE = 'P0004';
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER je_period_open BEFORE INSERT OR UPDATE ON journal_entries FOR EACH ROW EXECUTE FUNCTION check_period_open();

-- 4. Lines must belong to the same company as their entry and account.
CREATE OR REPLACE FUNCTION check_line_company() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM journal_entries e JOIN accounts a ON a.id = NEW.account_id
                  WHERE e.id = NEW.entry_id AND e.company_id = NEW.company_id AND a.company_id = NEW.company_id) THEN
    RAISE EXCEPTION 'Journal line company mismatch' USING ERRCODE = 'P0005';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER jl_company BEFORE INSERT OR UPDATE ON journal_lines FOR EACH ROW EXECUTE FUNCTION check_line_company();

INSERT INTO currencies (code, name, symbol, enabled) VALUES
  ('ZMW','Zambian Kwacha','K', TRUE),
  ('USD','US Dollar','$', FALSE),
  ('ZAR','South African Rand','R', FALSE),
  ('EUR','Euro','€', FALSE),
  ('GBP','British Pound','£', FALSE),
  ('BWP','Botswana Pula','P', FALSE),
  ('CNY','Chinese Yuan','¥', FALSE);
