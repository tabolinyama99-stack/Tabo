// Settings-driven Admin Center sections (company, branding, templates, accounting, AI, etc.).
import { useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api.js';
import { useSession } from '../../lib/session.jsx';
import { Card, Field, Input, Select, TextArea, Check, MoneyInput, Button, Alert, useApi, Loadable, useAction, useToast, Badge } from '../../components/ui.jsx';

/** Generic settings form. fields: [{ key, label, type, options, hint, span }] */
export function SettingsForm({ section, title, description, fields, children, after }) {
  const { refresh } = useSession();
  const state = useApi('/admin/settings');
  const [v, setV] = useState(null);
  const [run, busy] = useAction();
  useEffect(() => { if (state.data) setV(state.data[section]); }, [state.data, section]);
  if (!v) return <Loadable state={state}>{() => null}</Loadable>;
  const set = (k) => (val) => setV({ ...v, [k]: val?.target ? val.target.value : val });
  const save = async () => { const r = await run(() => api.put(`/admin/settings/${section}`, v), 'Settings saved.'); if (r) { setV(r); refresh(); } };
  return <Card title={title}>
    {description && <p className="muted" style={{ marginTop: 0 }}>{description}</p>}
    <div className="form-grid">
      {fields.map((f) => <Field key={f.key} label={f.type === 'bool' ? null : f.label} hint={f.hint} span={f.span}>
        {f.type === 'bool' ? <Check label={f.label} checked={v[f.key]} onChange={set(f.key)} />
          : f.type === 'select' ? <Select value={v[f.key] ?? ''} onChange={set(f.key)} options={f.options} />
          : f.type === 'textarea' ? <TextArea value={v[f.key] ?? ''} onChange={set(f.key)} />
          : f.type === 'money' ? <MoneyInput value={v[f.key] ?? ''} onChange={set(f.key)} />
          : f.type === 'number' ? <Input type="number" value={v[f.key] ?? ''} onChange={(e) => set(f.key)(e.target.value === '' ? '' : Number(e.target.value))} />
          : f.type === 'color' ? <div className="row-gap"><input type="color" className="swatch" value={v[f.key] || '#000000'} onChange={(e) => set(f.key)(e.target.value)} aria-label={f.label} /><Input value={v[f.key] || ''} onChange={set(f.key)} style={{ maxWidth: 140 }} /></div>
          : <Input type={f.type === 'password' ? 'password' : 'text'} value={v[f.key] ?? ''} onChange={set(f.key)} />}
      </Field>)}
    </div>
    {children?.(v, setV)}
    <div className="form-actions"><Button variant="primary" busy={busy} onClick={save}>Save changes</Button></div>
    {after}
  </Card>;
}

export function Company() {
  const { refresh, isSuperAdmin } = useSession();
  const state = useApi('/admin/company'); const curr = useApi('/admin/currencies');
  const [c, setC] = useState(null); const [run, busy] = useAction();
  useEffect(() => { if (state.data) setC(state.data); }, [state.data]);
  if (!c) return <Loadable state={state}>{() => null}</Loadable>;
  const set = (k) => (e) => setC({ ...c, [k]: e?.target ? e.target.value : e });
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  return <Card title="Company information">
    <div className="form-grid">
      <Field label="Company name" required><Input value={c.name || ''} onChange={set('name')} /></Field>
      <Field label="Registered (legal) name"><Input value={c.legal_name || ''} onChange={set('legal_name')} /></Field>
      <Field label="TPIN"><Input value={c.tpin || ''} onChange={set('tpin')} /></Field>
      <Field label="VAT registration number"><Input value={c.vat_number || ''} onChange={set('vat_number')} /></Field>
      <Field label="Company registration number (PACRA)"><Input value={c.registration_no || ''} onChange={set('registration_no')} /></Field>
      <Field label="Website"><Input value={c.website || ''} onChange={set('website')} /></Field>
      <Field label="Address" span={2}><TextArea value={c.address || ''} onChange={set('address')} /></Field>
      <Field label="City / town"><Input value={c.city || ''} onChange={set('city')} /></Field>
      <Field label="Email"><Input type="email" value={c.email || ''} onChange={set('email')} /></Field>
      <Field label="Phone"><Input value={c.phone || ''} onChange={set('phone')} /></Field>
      <Field label="Alternative phone"><Input value={c.phone_alt || ''} onChange={set('phone_alt')} /></Field>
      <Field label="Financial year starts in"><Select value={c.fy_start_month} onChange={(v) => setC({ ...c, fy_start_month: Number(v) })} options={months.map((m, i) => ({ value: i + 1, label: m }))} /></Field>
      <Field label="Default (base) currency" hint="Locked once transactions are posted."><Select value={c.base_currency} onChange={set('base_currency')} options={(curr.data || []).filter((x) => x.enabled || x.code === c.base_currency).map((x) => ({ value: x.code, label: `${x.code} — ${x.name}` }))} /></Field>
      <Field label="Time zone"><Select value={c.timezone} onChange={set('timezone')} options={['Africa/Lusaka', 'Africa/Johannesburg', 'Africa/Harare', 'Africa/Nairobi', 'UTC'].map((z) => ({ value: z, label: z }))} /></Field>
    </div>
    {isSuperAdmin && <p className="t-small">Additional currencies can be enabled under System preferences.</p>}
    <div className="form-actions"><Button variant="primary" busy={busy} onClick={async () => { const body = { ...c }; for (const k of ['id', 'is_demo', 'is_active', 'created_at', 'updated_at', 'country']) delete body[k]; if (await run(() => api.put('/admin/company', body), 'Company information saved.')) refresh(); }}>Save</Button></div>
  </Card>;
}

function LogoSlot({ slot, label, hint, docId }) {
  const { me, refresh } = useSession(); const input = useRef(null); const [run, busy] = useAction(); const { confirm } = useToast();
  const [v, setV] = useState(docId);
  const up = async (file) => { const r = await run(() => api.upload(`/admin/branding/${slot}`, file), `${label} uploaded.`); if (r) { setV(r.document_id); refresh(); } };
  return <div className="stack-sm">
    <span className="field-label">{label}</span>
    <div className="row-gap wrap"><div className="logo-preview" style={slot === 'logo_dark' ? { background: '#151c19' } : undefined}>{v ? <img src={`/api/public/branding/${me.company.id}/${slot}?v=${v}`} alt={label} /> : <span className="t-small">None</span>}</div>
      <input ref={input} type="file" hidden accept="image/png,image/jpeg,image/svg+xml,image/webp,image/x-icon" onChange={(e) => e.target.files[0] && up(e.target.files[0])} />
      <Button size="sm" icon="upload" busy={busy} onClick={() => input.current?.click()}>{v ? 'Replace' : 'Upload'}</Button>
      {v && <Button size="sm" variant="danger" onClick={async () => { if (await confirm({ title: `Remove ${label.toLowerCase()}?`, message: 'The default mark will be shown instead.', danger: true }) && await run(() => api.del(`/admin/branding/${slot}`), 'Removed.')) { setV(null); refresh(); } }}>Remove</Button>}</div>
    <span className="field-hint">{hint}</span>
  </div>;
}

export function Branding() {
  const state = useApi('/admin/settings');
  return <>
    <Loadable state={state}>{(s) => <Card title="Logo & favicon"><div className="form-grid">
      <LogoSlot slot="logo" label="Main logo" hint="Used everywhere by default, including invoices, receipts, quotations and PDF reports. PNG/JPG recommended; SVG and WebP are converted automatically for PDFs." docId={s.branding.logo_document_id} />
      <LogoSlot slot="logo_light" label="Light-mode logo" hint="Optional. Shown on light backgrounds (login page and navigation in light mode). Falls back to the main logo." docId={s.branding.logo_light_document_id} />
      <LogoSlot slot="logo_dark" label="Dark-mode logo" hint="Optional. A light-coloured version shown on dark backgrounds when dark mode is on. Falls back to the main logo." docId={s.branding.logo_dark_document_id} />
      <LogoSlot slot="favicon" label="Favicon" hint="Square PNG, ICO or SVG, at least 32×32." docId={s.branding.favicon_document_id} />
    </div></Card>}</Loadable>
    <SettingsForm section="branding" title="Brand colours, theme & login page" description="Colours apply across the app, invoices, receipts and reports. Choose colours dark enough for white text (the app checks contrast automatically for button text)."
      fields={[{ key: 'primary_color', label: 'Primary brand colour', type: 'color' }, { key: 'secondary_color', label: 'Secondary (accent) colour', type: 'color' },
        { key: 'theme', label: 'Default theme', type: 'select', options: [{ value: 'system', label: 'Follow device' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }] },
        { key: 'login_title', label: 'Login page title' }, { key: 'login_tagline', label: 'Login page tagline', span: 2 },
        { key: 'show_logo_on_documents', label: 'Show logo on invoices, receipts & quotations', type: 'bool' }, { key: 'show_logo_on_reports', label: 'Show logo on PDF reports', type: 'bool' }]} />
  </>;
}

const DOCS = [['invoice', 'Invoice'], ['quote', 'Quotation'], ['sales_order', 'Sales order'], ['credit_note', 'Credit note'], ['receipt', 'Receipt'], ['purchase_order', 'Purchase order']];
export function Templates() {
  return <SettingsForm section="documents" title="Invoice, receipt & document templates" description="Titles, layout, footers and terms printed on PDFs and emails. Branding (logo, colours) comes from Branding & logo."
    fields={[{ key: 'bank_details', label: 'Bank / payment details printed on invoices', type: 'textarea', span: 2, hint: 'e.g. Bank, account name, account number, branch, mobile money number.' }]}>
    {(v, setV) => <div className="stack" style={{ marginTop: 16 }}>{DOCS.map(([k, label]) => { const d = v[k] || {}; const set = (f) => (val) => setV({ ...v, [k]: { ...d, [f]: val?.target ? val.target.value : val } }); return <Card key={k} title={label}><div className="form-grid">
      <Field label="Document title"><Input value={d.title || ''} onChange={set('title')} /></Field>
      <Field label="Layout"><Select value={d.layout || 'classic'} onChange={set('layout')} options={[{ value: 'classic', label: 'Classic' }, { value: 'modern', label: 'Modern (colour band)' }]} /></Field>
      <Field label="Footer" span={2}><Input value={d.footer || ''} onChange={set('footer')} /></Field>
      {'terms' in d && <Field label="Default terms" span={2}><TextArea value={d.terms || ''} onChange={set('terms')} /></Field>}
      {k === 'invoice' && <><Check label="Show bank details" checked={d.show_bank_details !== false} onChange={set('show_bank_details')} /><Check label="Show customer TPIN" checked={d.show_tpin !== false} onChange={set('show_tpin')} /></>}
    </div></Card>; })}</div>}
  </SettingsForm>;
}

export function ReportTemplates() {
  return <SettingsForm section="documents" title="Report templates" description="Applied to every PDF and Excel export."
    fields={[]}>{(v, setV) => { const r = v.report || {}; const set = (f) => (val) => setV({ ...v, report: { ...r, [f]: val?.target ? val.target.value : val } }); return <div className="form-grid">
      <Field label="Header note (e.g. 'Management accounts — unaudited')" span={2}><Input value={r.header_note || ''} onChange={set('header_note')} /></Field>
      <Field label="Footer text" span={2}><Input value={r.footer_note || ''} onChange={set('footer_note')} /></Field>
      <Check label="Show logo on reports" checked={r.show_logo !== false} onChange={set('show_logo')} /></div>; }}</SettingsForm>;
}

export function Accounting() {
  return <SettingsForm section="accounting" title="Accounting rules & approval workflow" description="Who can post what, and when a second person must approve. Role transaction limits are set per role under Roles & permissions."
    fields={[{ key: 'default_payment_terms_days', label: 'Default payment terms (days)', type: 'number' },
      { key: 'journal_approval_threshold', label: 'Manual journals above this need approval (K)', type: 'money' },
      { key: 'expense_approval_threshold', label: 'Expenses above this need approval (K)', type: 'money' },
      { key: 'segregation_of_duties', label: 'Segregation of duties — creators cannot approve their own items above the threshold', type: 'bool', span: 2 },
      { key: 'ai_drafts_require_approval', label: 'AI-prepared drafts always require approval', type: 'bool', span: 2 },
      { key: 'allow_negative_cash', label: 'Allow payments that make a bank/cash balance negative', type: 'bool', span: 2 }]} />;
}

export function Dashboard() {
  const W = [['revenue', 'Total revenue'], ['expenses', 'Total expenses'], ['net_profit', 'Net profit'], ['cash_balance', 'Cash balance'], ['bank_balance', 'Bank balance'], ['receivables', 'Accounts receivable'], ['payables', 'Accounts payable'], ['overdue_invoices', 'Overdue invoices'], ['outstanding_bills', 'Outstanding supplier bills'],
    ['chart_revenue_trend', 'Chart: revenue vs expenses'], ['chart_expense_trend', 'Chart: expense trend'], ['chart_profit_trend', 'Chart: profit trend'], ['chart_cash_flow', 'Chart: cash flow'], ['chart_sales_by_customer', 'Chart: sales by customer'], ['chart_expenses_by_category', 'Chart: expenses by category'],
    ['chart_receivables_aging', 'Chart: receivables aging'], ['chart_payables_aging', 'Chart: payables aging'], ['review_queue', 'Needs-attention panel']];
  return <SettingsForm section="dashboard" title="Dashboard widgets" description="Choose what everyone in this company sees on the dashboard." fields={[]}>
    {(v, setV) => <div className="perm-grid">{W.map(([k, l]) => <Check key={k} label={l} checked={v.widgets.includes(k)} onChange={(on) => setV({ ...v, widgets: on ? [...v.widgets, k] : v.widgets.filter((x) => x !== k) })} />)}</div>}
  </SettingsForm>;
}

export function Notifications() {
  return <SettingsForm section="notifications" title="Notifications" description="In-app notifications are created by a background job every hour."
    fields={[{ key: 'invoice_overdue', label: 'Invoice overdue', type: 'bool' }, { key: 'payment_received', label: 'Payment received', type: 'bool' }, { key: 'bill_due', label: 'Supplier bill due', type: 'bool' },
      { key: 'bill_due_days', label: 'Days before a bill is due to notify', type: 'number' }, { key: 'reconciliation_required', label: 'Bank reconciliation required', type: 'bool' }, { key: 'reconciliation_days', label: 'Reconcile at least every (days)', type: 'number' },
      { key: 'unusual_transaction', label: 'Unusual transaction flagged', type: 'bool' }, { key: 'ai_review', label: 'AI drafts need review', type: 'bool' }, { key: 'low_cash', label: 'Low cash balance', type: 'bool' }, { key: 'low_cash_threshold', label: 'Default low-cash threshold (K)', type: 'money' },
      { key: 'period_closing', label: 'Month-end / period closing reminder', type: 'bool' }, { key: 'tax_deadline', label: 'Tax deadline reminder', type: 'bool' }, { key: 'approval_required', label: 'Items awaiting approval', type: 'bool' }]} />;
}

export function Email() {
  const state = useApi('/admin/settings'); const [pw, setPw] = useState(''); const [run, busy] = useAction();
  return <SettingsForm section="email" title="Email (SMTP)" description="Used to email invoices, quotations, statements and purchase orders. Works with any SMTP provider (Gmail/Google Workspace, Microsoft 365, Zoho, your host)."
    fields={[{ key: 'enabled', label: 'Enable sending email', type: 'bool', span: 2 }, { key: 'smtp_host', label: 'SMTP host' }, { key: 'smtp_port', label: 'Port', type: 'number' }, { key: 'smtp_secure', label: 'Use SSL/TLS (port 465)', type: 'bool' },
      { key: 'smtp_user', label: 'Username' }, { key: 'from_name', label: 'From name' }, { key: 'from_email', label: 'From email' }]}
    after={<div className="stack-sm" style={{ marginTop: 16 }}><Field label="SMTP password" hint={state.data?.secrets?.smtp_password?.configured ? `Stored encrypted (${state.data.secrets.smtp_password.preview}). Enter a new one to replace it.` : 'Stored encrypted; never shown again.'}>
      <div className="row-gap"><Input type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" /><Button busy={busy} disabled={!pw} onClick={async () => { if (await run(() => api.put('/admin/secrets/smtp_password', { value: pw }), 'Password saved.')) { setPw(''); state.reload(); } }}>Save password</Button></div></Field></div>} />;
}

export function AISettings() {
  const { isSuperAdmin } = useSession();
  const state = useApi('/admin/settings'); const status = useApi('/ai/status');
  const [key, setKey] = useState(''); const [scope, setScope] = useState('company'); const [run, busy] = useAction();
  const sec = state.data?.secrets;
  return <>
    <Card title="AI provider">
      <p className="muted" style={{ marginTop: 0 }}>TAEL Books uses Anthropic's Claude for natural-language answers, receipt reading and commentary. Without a key, a built-in assistant and on-server OCR are used. Keys are encrypted at rest and never sent to browsers.</p>
      <div className="row-gap wrap" style={{ marginBottom: 12 }}><span>Current mode:</span>{status.data && <Badge tone={status.data.mode === 'claude' ? 'positive' : 'info'}>{status.data.mode === 'claude' ? `Claude · ${status.data.model}` : 'Built-in'}</Badge>}
        {sec && <span className="t-small">Company key: {sec.ai_api_key.configured ? sec.ai_api_key.preview : 'not set'} · Platform key: {sec.platform_ai_key.configured ? 'set' : 'not set'}</span>}</div>
      <div className="form-grid"><Field label="Anthropic API key"><Input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder="sk-ant-…" autoComplete="off" /></Field>
        {isSuperAdmin && <Field label="Apply to"><Select value={scope} onChange={setScope} options={[{ value: 'company', label: 'This company only' }, { value: 'platform', label: 'All companies (platform key)' }]} /></Field>}</div>
      <div className="form-actions"><Button variant="danger" onClick={async () => { if (await run(() => api.put('/admin/secrets/anthropic_api_key', { value: null, scope }), 'Key removed.')) { state.reload(); status.reload(); } }}>Remove key</Button>
        <Button variant="primary" busy={busy} disabled={!key} onClick={async () => { if (await run(() => api.put('/admin/secrets/anthropic_api_key', { value: key, scope }), 'Key saved.')) { setKey(''); state.reload(); status.reload(); } }}>Save key</Button></div>
    </Card>
    <SettingsForm section="ai" title="AI behaviour" fields={[{ key: 'enabled', label: 'Enable the AI assistant', type: 'bool' }, { key: 'assistant_name', label: 'Assistant name' },
      { key: 'model', label: 'Model (leave blank for the default)', hint: 'e.g. claude-sonnet-5-5 (default) or claude-opus-5-5 — any model your key has access to.' },
      { key: 'allow_transaction_drafts', label: 'Allow AI to prepare draft transactions', type: 'bool' }, { key: 'auto_extract_documents', label: 'Allow AI receipt / invoice reading', type: 'bool' },
      { key: 'anomaly_detection', label: 'Run anomaly detection', type: 'bool' }, { key: 'large_expense_multiplier', label: 'Flag expenses larger than × the account average', type: 'number' },
      { key: 'duplicate_window_days', label: 'Duplicate detection window (days)', type: 'number' }, { key: 'missing_document_threshold', label: 'Flag missing receipts above (K)', type: 'money' }]} />
  </>;
}

export function Security() {
  return <SettingsForm section="security" title="Security" description="Applies to users of this company. Sessions use secure HTTP-only cookies with CSRF protection; passwords are hashed with bcrypt; sign-in is rate-limited and accounts lock after repeated failures."
    fields={[{ key: 'session_timeout_hours', label: 'Session timeout (hours)', type: 'number' }, { key: 'password_min_length', label: 'Minimum password length', type: 'number' },
      { key: 'max_failed_logins', label: 'Lock account after failed sign-ins', type: 'number' }, { key: 'lockout_minutes', label: 'Lockout duration (minutes)', type: 'number' }]} />;
}

export function Preferences() {
  const { isSuperAdmin } = useSession();
  const curr = useApi('/admin/currencies'); const [run] = useAction();
  return <>
    <SettingsForm section="appearance" title="Appearance" fields={[{ key: 'default_theme', label: 'Default theme', type: 'select', options: [{ value: 'system', label: 'Follow device' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }] },
      { key: 'density', label: 'Density', type: 'select', options: [{ value: 'comfortable', label: 'Comfortable' }, { value: 'compact', label: 'Compact' }] }, { key: 'date_format', label: 'Date format', type: 'select', options: [{ value: 'DD/MM/YYYY', label: 'DD/MM/YYYY' }] }]} />
    <SettingsForm section="terminology" title="Terminology" description="Rename common terms to match how your business speaks."
      fields={[['customer', 'Customer'], ['customers', 'Customers'], ['supplier', 'Supplier'], ['suppliers', 'Suppliers'], ['invoice', 'Invoice'], ['bill', 'Bill'], ['expense', 'Expense'], ['branch', 'Branch'], ['department', 'Department']].map(([key, label]) => ({ key, label }))} />
    <SettingsForm section="features" title="Features" fields={[{ key: 'branches', label: 'Branches', type: 'bool' }, { key: 'departments', label: 'Departments', type: 'bool' }, { key: 'warehouses', label: 'Warehouses', type: 'bool' }, { key: 'multi_currency', label: 'Multi-currency (architecture ready — base currency ZMW)', type: 'bool' }]} />
    {isSuperAdmin && <Card title="Currencies" pad={false}><Loadable state={curr}>{(rows) => <div className="table-wrap"><table className="table"><thead><tr><th>Code</th><th>Name</th><th>Symbol</th><th>Enabled</th></tr></thead>
      <tbody>{rows.map((c) => <tr key={c.code}><td className="num">{c.code}</td><td>{c.name}</td><td>{c.symbol}</td><td><Check label="" checked={c.enabled} disabled={c.code === 'ZMW'} onChange={async (on) => { if (await run(() => api.put(`/admin/currencies/${c.code}`, { enabled: on }), 'Updated.')) curr.reload(); }} /></td></tr>)}</tbody></table></div>}</Loadable></Card>}
  </>;
}
export { Alert };
