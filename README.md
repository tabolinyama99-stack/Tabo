# TAEL Books

Multi-company, double-entry accounting software for Zambian businesses — with an AI accounting assistant that answers from the real ledger and only ever prepares **drafts** for human approval.

Currency: Zambian Kwacha (ZMW / K) by default · Dates: DD/MM/YYYY · Built for desktop, laptop, tablet and mobile.

---

## What is included

| Area | Highlights |
|---|---|
| **Accounting engine** | Double-entry journals; debits = credits enforced in the app **and** by PostgreSQL constraint triggers; posted journals cannot be edited or deleted (reverse instead); manual, automatic, reversing, auto-reversing, recurring, adjusting and opening-balance journals; period locking enforced by the database; exact money maths (NUMERIC(18,2) + integer ngwee in code, never floating point); every transaction atomic. |
| **Sales** | Customers, quotations → sales orders → invoices → credit notes, receipts with allocation, customer statements, statuses Draft / Sent / Partially paid / Paid / Overdue / Cancelled, branded PDF invoices, email. |
| **Purchases** | Suppliers, purchase orders → bills → debit notes, supplier payments with withholding tax, duplicate supplier-invoice detection, supplier statements. |
| **Expenses** | Date, payee/supplier, category, amount, VAT (inclusive/exclusive), payment method, branch, department, reference, receipt attachment; approval thresholds and role limits. |
| **Banking** | Multiple bank, cash and mobile-money accounts; deposits, withdrawals, transfers; CSV/Excel statement import (auto column detection, duplicate-safe); automatic match suggestions; create-and-match for bank charges; reconciliation with history and report. |
| **Reports (18)** | Trial balance, general ledger, P&L (with comparisons), balance sheet, cash flow, AR/AP aging, sales, purchases, expenses, income, tax (VAT & WHT, reconciled to ledger), customer & supplier statements, cashbook, bank reconciliation, journal, audit. Search, sort, paginate, print, **PDF and Excel export**. |
| **Dashboard** | Revenue, expenses, net profit, cash, bank, receivables, payables, overdue invoices, outstanding bills; 8 charts; widgets configurable by the admin. |
| **AI** | Chat assistant over live data with sources; natural-language → draft transactions (never posted automatically); receipt/invoice reading → draft expense or bill; financial analyst with figures shown; anomaly detection (duplicates, large expenses, unusual payments, misclassification, missing receipts, unexpected changes) with neutral wording; every AI action audited. |
| **Admin Center** | Company, branding & logos (light/dark/favicon), users, roles & granular permissions, transaction limits, security, accounting & approval rules, tax engine with effective-dated rates, financial periods, numbering, document & report templates, dashboard widgets, notifications, email (SMTP), AI settings & keys, integrations & API keys, system preferences (theme, terminology, features, currencies), import/export, backups & restore, audit logs. |
| **Security** | bcrypt passwords, HTTP-only secure session cookies, CSRF tokens, rate limiting, account lockout, server-side permission checks on every endpoint, file-type sniffing for uploads, SVG sanitising, AES-256-GCM encrypted secrets, hash-chained immutable audit log, CSP/HSTS headers, no stack traces to users. |
| **Multi-company** | One Super Admin, unlimited companies, each with its own ledger, users, roles, settings and branding; data isolated per company. |

## Quick start (local, with Docker)

```bash
cp .env.example .env              # set POSTGRES_PASSWORD, APP_ENCRYPTION_KEY, SUPER_ADMIN_* values
docker compose up -d --build
open http://localhost:4000         # sign in with SUPER_ADMIN_EMAIL / SUPER_ADMIN_PASSWORD
```

On first start the app runs database migrations, creates your **Super Admin** and your company (with a Zambian chart of accounts, VAT 16%, roles and numbering). Remove `SUPER_ADMIN_PASSWORD` from `.env` afterwards and change your password under **Profile**.

Want sample data to explore? Set `SEED_DEMO=true` once. It creates **"DEMO – Kafue Hardware & Supplies Ltd"** (clearly labelled) with six months of transactions and demo users for every role (password `DemoPass2026`, e.g. `accountant@demo.tael`, `cashier@demo.tael`, `auditor@demo.tael`). Your real company works without demo data.

## Quick start (without Docker)

Requirements: Node.js 20+, PostgreSQL 14+, optionally `tesseract-ocr` and `poppler-utils` (receipt OCR) and `postgresql-client` (backups).

```bash
npm --prefix server ci && npm --prefix client ci
cp .env.example server/.env        # edit DATABASE_URL etc.
npm run build                      # builds the web client into client/dist
npm start                          # migrates, bootstraps, serves API + client on :4000
```

Development: `npm run dev:server` (API on :4000) and `npm run dev:client` (Vite on :5173 with an API proxy).

## Deploying to production

The app is one Docker image (API + web client) plus PostgreSQL and a persistent volume for uploads/backups.

**Option A — your own server (VPS) with automatic HTTPS**
1. Point your domain's DNS at the server and install Docker.
2. Edit `deploy/Caddyfile` (replace `books.example.com`).
3. `cp .env.example .env` and fill it in (`COOKIE_SECURE=true`, `TRUST_PROXY=1`).
4. `docker compose -f docker-compose.yml -f deploy/docker-compose.https.yml up -d --build`

**Option B — Render.com**: create a Blueprint from this repository (`render.yaml` provisions PostgreSQL, the web service, a disk and a generated encryption key). Set `SUPER_ADMIN_EMAIL`, `SUPER_ADMIN_PASSWORD`, `SUPER_ADMIN_NAME`, `COMPANY_NAME` and optionally `ANTHROPIC_API_KEY` when prompted.

**Option C — Railway / Fly.io / Azure / AWS**: deploy the `Dockerfile`, attach PostgreSQL, set the environment variables below, mount a volume at `/data`, health check `GET /healthz`.

### Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | yes | PostgreSQL connection string |
| `APP_ENCRYPTION_KEY` | yes (prod) | 32+ random chars; encrypts stored AI keys & SMTP passwords |
| `SUPER_ADMIN_EMAIL`, `SUPER_ADMIN_PASSWORD`, `SUPER_ADMIN_NAME`, `COMPANY_NAME` | first run | Creates the Super Admin and first company if none exists |
| `PORT` | no | Default 4000 |
| `COOKIE_SECURE`, `TRUST_PROXY` | behind HTTPS | `true` / `1` behind Caddy, Nginx, Render, etc. |
| `DATABASE_SSL` | managed DBs | `true` if your provider requires SSL |
| `UPLOAD_DIR`, `BACKUP_DIR` | no | Default `/data/uploads`, `/data/backups` in Docker |
| `ANTHROPIC_API_KEY`, `AI_MODEL` | no | Platform AI key (or set per company in Admin Center); default model `claude-opus-5-5` |
| `JOBS_ENABLED` | no | Hourly jobs: notifications, recurring & auto-reversing journals, anomaly scans |
| `SEED_DEMO` | no | `true` to create the demo company |
| `AUTO_MIGRATE` | no | `false` to run migrations manually with `npm run migrate` |

### Commands

| Command | What it does |
|---|---|
| `npm run build` | Build the web client |
| `npm start` | Start the server (runs migrations first) |
| `npm run migrate` | Apply database migrations |
| `npm run create-super-admin` | Create/repair the Super Admin (uses `SUPER_ADMIN_*` env vars) |
| `npm run seed:demo` | Create the demo company (`RESET_DEMO=true` rebuilds it) |
| `npm test` | Run the automated test suite (needs `TEST_DATABASE_URL`) |

### Operations

- **Health**: `GET /healthz` (checks the database). Logs go to stdout in Apache combined format — ship them with your platform's log drain.
- **Backups**: enable your database host's daily backups. In-app, the Super Admin can take/restore full database backups (pg_dump format, checksummed, safety backup taken before every restore); company admins can back up and restore configuration.
- **Scaling**: the app is stateless apart from `/data` (uploads/backups). Run one instance with `JOBS_ENABLED=true`; extra instances can set it to `false` (jobs also use a database lock).
- **Upgrades**: deploy the new image; migrations apply automatically and are tracked in `schema_migrations`.

## Using the AI

Without a key, a built-in assistant answers the common questions from the database and on-server OCR reads receipts. With an Anthropic API key (Admin Center → AI settings, or `ANTHROPIC_API_KEY`), Claude handles free-form questions via tools that query the ledger. In both modes:

- every figure comes from a tool/database result and answers list their sources;
- "Record a K5,000 cash sale" creates a **DRAFT** journal showing the proposed debit and credit; an authorised user approves it in **Approvals**, the engine validates it, posts it and the audit log records both the AI draft and the approval;
- the AI sees only what the signed-in user is allowed to see.

## Tax

Rates live in the database with effective dates (Admin Center → Tax): VAT 16% standard, zero-rated, exempt, withholding tax and turnover tax are pre-configured as editable defaults. **Confirm current rates and filing rules with the Zambia Revenue Authority (ZRA)** — TAEL Books calculates using whatever you configure. PAYE/NAPSA accounts and a PAYROLL tax type are in place for a future payroll module.

## Project layout

```
server/            Node.js + Express API
  migrations/      SQL schema (constraints, triggers, immutable audit log)
  src/services/    accounting engine, sales, purchases, payments, expenses, banking, reports, jobs…
  src/ai/          assistant, tools, receipt extraction, analyst
  src/routes/      REST API (permission-checked)
  test/            automated tests (node:test + supertest)
client/            React + Vite web app
deploy/            Caddy HTTPS config and compose overlay
Dockerfile, docker-compose.yml, render.yaml, .github/workflows/ci.yml
```

## API

Everything the UI does goes through the REST API under `/api` (session cookie + `X-CSRF-Token`, or `Authorization: Bearer tael_…` API keys created in Admin Center → Integrations). Main resources: `/auth`, `/dashboard`, `/accounts`, `/journals`, `/recurring-journals`, `/customers`, `/suppliers`, `/sales/documents`, `/purchases/documents`, `/payments`, `/expenses`, `/bank-accounts`, `/reconciliations`, `/reports/:slug?format=json|pdf|xlsx`, `/tax-rates`, `/items`, `/documents`, `/review-flags`, `/approvals`, `/search`, `/notifications`, `/ai/*`, `/admin/*`.

## Known limits / next modules

- Multi-currency is architected (currency tables, per-document currency) but the base-currency ledger is ZMW; foreign-currency revaluation is a future module.
- Payroll (PAYE, NAPSA, NHIMA) is prepared in the chart of accounts and tax engine but not yet a module.
- Inventory quantities/valuation and warehouse stock movements are not tracked yet (items and warehouses exist for invoicing and future stock).
- Email delivery requires your SMTP details.

---
© TAEL Finance & Business Solutions
