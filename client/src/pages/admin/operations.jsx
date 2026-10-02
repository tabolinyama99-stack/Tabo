import { useEffect, useRef, useState } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { api, download, qs } from '../../lib/api.js';
import { useSession } from '../../lib/session.jsx';
import { fmtDate, fmtDateTime, today, titleCase } from '../../lib/format.js';
import { Card, Field, Input, Select, Check, Button, Alert, Modal, useApi, Loadable, useAction, useToast, Badge, StatusBadge, TextArea, DateInput } from '../../components/ui.jsx';
import { DataTable } from '../../components/DataTable.jsx';
import { useLookup, accountOptions, invalidate } from '../../components/lookups.js';

export function Companies() {
  const { refresh } = useSession(); const state = useApi('/admin/companies'); const [open, setOpen] = useState(false); const [f, setF] = useState({ name: '', tpin: '', email: '' }); const [run, busy] = useAction();
  return <Card title="All companies" actions={<Button variant="primary" icon="plus" onClick={() => setOpen(true)}>New company</Button>} pad={false}>
    <p className="muted" style={{ padding: '0 var(--space-5)' }}>Each company has its own ledger, users, settings and branding. Data never mixes between companies. Switch companies from your user menu.</p>
    <Loadable state={state}>{(rows) => <DataTable rows={rows} columns={[{ key: 'name', label: 'Company', render: (v, c) => <span className="row-gap">{v}{c.is_demo && <Badge tone="accent">Demo</Badge>}</span> }, { key: 'tpin', label: 'TPIN' }, { key: 'users', label: 'Users', type: 'number' }, { key: 'created_at', label: 'Created', type: 'date' },
      { key: 'is_active', label: 'Status', render: (v, c) => <Button size="sm" variant="ghost" onClick={async () => { if (await run(() => api.post(`/admin/companies/${c.id}/active`, { is_active: !v }), 'Updated.')) state.reload(); }}>{v ? 'Active — deactivate' : 'Inactive — activate'}</Button> }]} />}</Loadable>
    {open && <Modal title="New company" onClose={() => setOpen(false)} footer={<><Button onClick={() => setOpen(false)}>Cancel</Button><Button variant="primary" busy={busy} disabled={!f.name} onClick={async () => { if (await run(() => api.post('/admin/companies', f), 'Company created with a default Zambian chart of accounts, roles and VAT rates.')) { setOpen(false); state.reload(); refresh(); } }}>Create</Button></>}>
      <div className="form-grid"><Field label="Company name" span={2}><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field><Field label="TPIN"><Input value={f.tpin} onChange={(e) => setF({ ...f, tpin: e.target.value })} /></Field><Field label="Email"><Input value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field></div></Modal>}
  </Card>;
}

function UnitTable({ kind, title }) {
  const state = useApi(`/admin/${kind}`); const [edit, setEdit] = useState(null); const [run, busy] = useAction();
  const extra = kind === 'branches' ? 'address' : kind === 'warehouses' ? 'location' : null;
  return <Card title={title} actions={<Button size="sm" icon="plus" onClick={() => setEdit({ code: '', name: '', is_active: true })}>Add</Button>} pad={false}>
    <Loadable state={state}>{(rows) => <DataTable searchable={false} rows={rows} onRowClick={setEdit} columns={[{ key: 'code', label: 'Code' }, { key: 'name', label: 'Name' }, ...(extra ? [{ key: extra, label: titleCase(extra) }] : []), { key: 'is_active', label: 'Status', render: (v) => (v ? 'Active' : 'Inactive') }]} />}</Loadable>
    {edit && <Modal title={edit.id ? `Edit ${edit.name}` : `Add ${title.toLowerCase().slice(0, -1)}`} onClose={() => setEdit(null)} footer={<><Button onClick={() => setEdit(null)}>Cancel</Button><Button variant="primary" busy={busy} disabled={!edit.code || !edit.name}
      onClick={async () => { if (await run(() => (edit.id ? api.put(`/admin/${kind}/${edit.id}`, edit) : api.post(`/admin/${kind}`, edit)), 'Saved.')) { invalidate(`/admin/${kind}`); setEdit(null); state.reload(); } }}>Save</Button></>}>
      <div className="form-grid"><Field label="Code"><Input value={edit.code} onChange={(e) => setEdit({ ...edit, code: e.target.value })} /></Field><Field label="Name"><Input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
        {extra && <Field label={titleCase(extra)} span={2}><Input value={edit[extra] || ''} onChange={(e) => setEdit({ ...edit, [extra]: e.target.value })} /></Field>}<Check label="Active" checked={edit.is_active !== false} onChange={(v) => setEdit({ ...edit, is_active: v })} /></div></Modal>}
  </Card>;
}
export function OrgUnits() { const { me } = useSession(); return <><UnitTable kind="branches" title="Branches" /><UnitTable kind="departments" title="Departments" />{me.settings?.features?.warehouses ? <UnitTable kind="warehouses" title="Warehouses" /> : <Alert tone="info">Warehouses are turned off. Enable them under System preferences → Features.</Alert>}</>; }

export function Tax() {
  const state = useApi('/tax-rates'); const accounts = useLookup('/accounts'); const [edit, setEdit] = useState(null); const [run, busy] = useAction(); const { me } = useSession();
  const blank = { code: '', name: '', tax_type: 'VAT', rate: '', effective_from: today(), effective_to: '', sales_account_id: '', purchase_account_id: '', applies_to: 'BOTH', description: '', is_active: true };
  return <>
    <Alert tone="info" title="Configurable tax engine.">{me.settings?.tax?.note || 'Tax calculations use the rates configured here.'} To change a rate that has been used, add a <strong>new version</strong> of the same code with a new effective date — past transactions keep the rate in force at the time.</Alert>
    <Card title="Tax rates" actions={<><Button onClick={() => setEdit({ ...blank, _version: true })}>New version of a rate</Button><Button variant="primary" icon="plus" onClick={() => setEdit(blank)}>New tax rate</Button></>} pad={false}>
      <Loadable state={state}>{(rows) => <DataTable rows={rows} onRowClick={(r) => setEdit({ ...r, rate: String(Number(r.rate)), effective_to: r.effective_to || '', sales_account_id: r.sales_account_id || '', purchase_account_id: r.purchase_account_id || '' })}
        columns={[{ key: 'code', label: 'Code' }, { key: 'name', label: 'Name' }, { key: 'tax_type', label: 'Type' }, { key: 'rate', label: 'Rate', render: (v) => `${Number(v)}%` }, { key: 'effective_from', label: 'From', type: 'date' }, { key: 'effective_to', label: 'To', type: 'date' },
          { key: 'sales_account_name', label: 'Output / sales account' }, { key: 'purchase_account_name', label: 'Input / purchase account' }, { key: 'is_active', label: 'Status', render: (v) => (v ? 'Active' : 'Inactive') }]} />}</Loadable>
    </Card>
    <SettingsTax />
    {edit && <Modal wide title={edit.id ? `Edit ${edit.code}` : edit._version ? 'New version of an existing rate' : 'New tax rate'} onClose={() => setEdit(null)} footer={<><Button onClick={() => setEdit(null)}>Cancel</Button><Button variant="primary" busy={busy} disabled={!edit.code || !edit.name || edit.rate === ''}
      onClick={async () => { const b = { ...edit, effective_to: edit.effective_to || null }; delete b._version; if (await run(() => (edit.id ? api.put(`/tax-rates/${edit.id}`, b) : api.post('/tax-rates', b)), 'Tax rate saved.')) { invalidate('/tax-rates'); setEdit(null); state.reload(); } }}>Save</Button></>}>
      {edit._version && <Alert tone="info">Use the same code as the existing rate. The previous version is closed the day before the new effective date.</Alert>}
      <div className="form-grid cols-3" style={{ marginTop: 8 }}>
        <Field label="Code"><Input value={edit.code} disabled={!!edit.id} onChange={(e) => setEdit({ ...edit, code: e.target.value.toUpperCase() })} /></Field>
        <Field label="Name"><Input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
        <Field label="Type"><Select value={edit.tax_type} disabled={!!edit.id} onChange={(v) => setEdit({ ...edit, tax_type: v })} options={['VAT', 'WHT', 'PAYE', 'TURNOVER', 'EXCISE', 'OTHER'].map((t) => ({ value: t, label: t }))} /></Field>
        <Field label="Rate (%)"><Input className="num" value={edit.rate} onChange={(e) => setEdit({ ...edit, rate: e.target.value })} /></Field>
        <Field label="Effective from"><DateInput value={edit.effective_from} disabled={!!edit.id} onChange={(v) => setEdit({ ...edit, effective_from: v })} /></Field>
        <Field label="Effective to (optional)"><DateInput value={edit.effective_to} onChange={(v) => setEdit({ ...edit, effective_to: v })} /></Field>
        <Field label="Applies to"><Select value={edit.applies_to} onChange={(v) => setEdit({ ...edit, applies_to: v })} options={['BOTH', 'SALES', 'PURCHASES', 'PAYROLL'].map((t) => ({ value: t, label: titleCase(t) }))} /></Field>
        <Field label={edit.tax_type === 'WHT' ? 'Receivable account (WHT deducted by customers)' : 'Output tax account (sales)'}><Select value={edit.sales_account_id} onChange={(v) => setEdit({ ...edit, sales_account_id: v })} placeholder="None" options={accountOptions(accounts, ['ASSET', 'LIABILITY'])} /></Field>
        <Field label={edit.tax_type === 'WHT' ? 'Payable account (WHT you deduct from suppliers)' : 'Input tax account (purchases)'}><Select value={edit.purchase_account_id} onChange={(v) => setEdit({ ...edit, purchase_account_id: v })} placeholder="None" options={accountOptions(accounts, ['ASSET', 'LIABILITY'])} /></Field>
        <Field label="Description" span={3}><TextArea value={edit.description || ''} onChange={(e) => setEdit({ ...edit, description: e.target.value })} /></Field>
        <Check label="Active" checked={edit.is_active} onChange={(v) => setEdit({ ...edit, is_active: v })} />
      </div></Modal>}
  </>;
}
function SettingsTax() {
  const state = useApi('/admin/settings'); const [v, setV] = useState(null); const [run, busy] = useAction();
  useEffect(() => { if (state.data) setV(state.data.tax); }, [state.data]);
  if (!v) return null;
  return <Card title="Tax settings"><div className="form-grid">
    <Check label="VAT registered" checked={v.vat_registered} onChange={(x) => setV({ ...v, vat_registered: x })} />
    <Field label="VAT return due day of following month"><Input type="number" min="1" max="31" value={v.vat_return_due_day} onChange={(e) => setV({ ...v, vat_return_due_day: Number(e.target.value) })} /></Field>
    <Field label="Remind this many days before"><Input type="number" min="0" value={v.tax_reminder_days_before} onChange={(e) => setV({ ...v, tax_reminder_days_before: Number(e.target.value) })} /></Field>
    <Field label="Note shown with tax figures" span={2}><TextArea value={v.note} onChange={(e) => setV({ ...v, note: e.target.value })} /></Field>
  </div><div className="form-actions"><Button variant="primary" busy={busy} onClick={() => run(() => api.put('/admin/settings/tax', v), 'Saved.')}>Save</Button></div></Card>;
}

export function Periods() {
  const { can, isSuperAdmin } = useSession(); const { confirm } = useToast(); const state = useApi('/admin/periods'); const [run] = useAction(); const [d, setD] = useState(today());
  const act = async (p, action) => {
    let body = {};
    if (action === 'reopen') { const reason = await confirm({ title: `Reopen ${p.name}?`, message: 'Transactions can be posted into this period again. This is recorded in the audit trail.', input: true, inputLabel: 'Reason for reopening', danger: true }); if (!reason) return; body = { reason }; }
    else if (!(await confirm({ title: `${titleCase(action)} ${p.name}?`, message: action === 'close' ? 'A closed period can only be reopened by the Super Admin.' : 'No transactions can be posted, edited or reversed into a locked period.', danger: action === 'close' }))) return;
    if (p.open_drafts && action !== 'reopen') body.force = !!(await confirm({ title: 'Drafts in this period', message: `${p.open_drafts} draft journal(s) are dated in ${p.name}. Lock anyway? They will not be postable until reopened.`, confirmLabel: 'Lock anyway' }));
    if (action !== 'reopen' && p.open_drafts && !body.force) return;
    if (await run(() => api.post(`/admin/periods/${p.id}/${action}`, body), `Period ${action === 'reopen' ? 'reopened' : action === 'lock' ? 'locked' : 'closed'}.`)) state.reload();
  };
  return <Card title="Financial periods" pad={false} actions={<div className="row-gap"><DateInput value={d} onChange={setD} aria-label="Year to generate" /><Button size="sm" onClick={async () => { if (await run(() => api.post('/admin/periods/generate', { date: d }), 'Periods created.')) state.reload(); }}>Create year</Button></div>}>
    <p className="muted" style={{ padding: '0 var(--space-5)' }}>Lock a month once it is reviewed and reconciled. Locking is enforced by the database itself.</p>
    <Loadable state={state}>{(rows) => <DataTable rows={rows} pageSize={24} columns={[{ key: 'name', label: 'Period' }, { key: 'start_date', label: 'From', type: 'date' }, { key: 'end_date', label: 'To', type: 'date' }, { key: 'status', label: 'Status', type: 'status' },
      { key: 'open_drafts', label: 'Open drafts', type: 'number' }, { key: 'locked_by_name', label: 'Changed by', render: (v, p) => (v ? `${v} · ${fmtDate(p.locked_at)}` : '') },
      { key: 'a', label: '', sortable: false, render: (_, p) => <div className="row-gap">{p.status === 'OPEN' && can('manage_periods') && <><Button size="sm" onClick={() => act(p, 'lock')}>Lock</Button><Button size="sm" variant="ghost" onClick={() => act(p, 'close')}>Close</Button></>}
        {p.status !== 'OPEN' && (p.status === 'LOCKED' ? can('reopen_periods') : isSuperAdmin) && <Button size="sm" variant="danger" onClick={() => act(p, 'reopen')}>Reopen</Button>}</div> }]} />}</Loadable>
  </Card>;
}

export function Numbering() {
  const state = useApi('/admin/numbering'); const [edit, setEdit] = useState(null); const [run, busy] = useAction();
  const preview = (s) => `${s.prefix}${String(s.next_value).padStart(s.padding, '0')}${s.suffix || ''}`;
  return <Card title="Document numbering" pad={false}><p className="muted" style={{ padding: '0 var(--space-5)' }}>Numbers are allocated atomically, so two users can never get the same number.</p>
    <Loadable state={state}>{(rows) => <DataTable searchable={false} rows={rows} rowKey="key" onRowClick={setEdit} columns={[{ key: 'key', label: 'Document', render: titleCase }, { key: 'prefix', label: 'Prefix' }, { key: 'padding', label: 'Digits', type: 'number' }, { key: 'suffix', label: 'Suffix' }, { key: 'next_value', label: 'Next number', type: 'number' }, { key: 'p', label: 'Next will be', render: (_, s) => <code>{preview(s)}</code> }]} />}</Loadable>
    {edit && <Modal title={`Numbering: ${titleCase(edit.key)}`} onClose={() => setEdit(null)} footer={<><Button onClick={() => setEdit(null)}>Cancel</Button><Button variant="primary" busy={busy} onClick={async () => { if (await run(() => api.put(`/admin/numbering/${edit.key}`, edit), 'Saved.')) { setEdit(null); state.reload(); } }}>Save</Button></>}>
      <div className="form-grid"><Field label="Prefix"><Input value={edit.prefix} onChange={(e) => setEdit({ ...edit, prefix: e.target.value })} /></Field><Field label="Suffix"><Input value={edit.suffix || ''} onChange={(e) => setEdit({ ...edit, suffix: e.target.value })} /></Field>
        <Field label="Digits"><Input type="number" min="1" max="12" value={edit.padding} onChange={(e) => setEdit({ ...edit, padding: Number(e.target.value) })} /></Field><Field label="Next number"><Input type="number" min="1" value={edit.next_value} onChange={(e) => setEdit({ ...edit, next_value: Number(e.target.value) })} /></Field></div>
      <p>Preview: <code>{preview(edit)}</code></p></Modal>}
  </Card>;
}

export function Integrations() {
  const keys = useApi('/admin/api-keys'); const perms = useApi('/admin/permissions'); const [open, setOpen] = useState(false); const [f, setF] = useState({ name: '', permissions: ['view_reports'] }); const [created, setCreated] = useState(null); const [run, busy] = useAction(); const { confirm } = useToast();
  return <>
    <Card title="API keys" actions={<Button variant="primary" icon="plus" onClick={() => setOpen(true)}>Create key</Button>} pad={false}>
      <p className="muted" style={{ padding: '0 var(--space-5)' }}>Connect other systems (POS, payroll, BI tools) with <code>Authorization: Bearer tael_…</code>. Keys only have the permissions you grant, can never manage settings, and are stored hashed.</p>
      <Loadable state={keys}>{(rows) => <DataTable searchable={false} rows={rows} columns={[{ key: 'name', label: 'Name' }, { key: 'prefix', label: 'Key', render: (v) => <code>{v}…</code> }, { key: 'permissions', label: 'Permissions', render: (v) => v.join(', ') }, { key: 'created_by', label: 'Created by' }, { key: 'last_used_at', label: 'Last used', type: 'datetime' },
        { key: 'revoked_at', label: 'Status', render: (v, k) => (v ? <Badge>Revoked</Badge> : <Button size="sm" variant="danger" onClick={async () => { if (await confirm({ title: `Revoke ${k.name}?`, message: 'Systems using this key stop working immediately.', danger: true }) && await run(() => api.del(`/admin/api-keys/${k.id}`), 'Key revoked.')) keys.reload(); }}>Revoke</Button>) }]} />}</Loadable>
    </Card>
    <Card title="Integration endpoints"><p className="muted" style={{ marginTop: 0 }}>Every screen in TAEL Books uses the same REST API at <code>/api</code>. Useful endpoints: <code>GET /api/reports/trial-balance</code>, <code>GET /api/reports/profit-and-loss?from=&amp;to=</code>, <code>POST /api/sales/documents</code>, <code>POST /api/payments</code>, <code>GET /api/admin/export/journal_lines?format=xlsx</code>. See the deployment guide for the full list.</p></Card>
    {open && perms.data && <Modal wide title="Create API key" onClose={() => setOpen(false)} footer={<><Button onClick={() => setOpen(false)}>Cancel</Button><Button variant="primary" busy={busy} disabled={!f.name || !f.permissions.length} onClick={async () => { const r = await run(() => api.post('/admin/api-keys', f)); if (r) { setCreated(r.key); setOpen(false); keys.reload(); } }}>Create</Button></>}>
      <Field label="Name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="e.g. Power BI" /></Field>
      <div className="perm-grid" style={{ marginTop: 12 }}>{perms.data.filter((p) => !p.key.startsWith('manage_')).map((p) => <Check key={p.key} label={p.label} checked={f.permissions.includes(p.key)} onChange={(on) => setF({ ...f, permissions: on ? [...f.permissions, p.key] : f.permissions.filter((x) => x !== p.key) })} />)}</div></Modal>}
    {created && <Modal title="Your new API key" onClose={() => setCreated(null)} footer={<Button variant="primary" onClick={() => setCreated(null)}>I've copied it</Button>}><Alert tone="warning" title="Copy it now —">it will not be shown again.</Alert><p><code style={{ wordBreak: 'break-all' }}>{created}</code></p></Modal>}
  </>;
}

export function ImportExport() {
  const [run, busy] = useAction(); const input = useRef(null); const [entity, setEntity] = useState('customers'); const [res, setRes] = useState(null);
  const EX = [['customers', 'Customers'], ['suppliers', 'Suppliers'], ['accounts', 'Chart of accounts'], ['items', 'Items'], ['invoices', 'Sales documents'], ['bills', 'Purchase documents'], ['expenses', 'Expenses'], ['journal_lines', 'General ledger (all posted lines)']];
  const HEAD = { customers: 'code,name,contact_person,email,phone,address,tpin,payment_terms_days', suppliers: 'code,name,contact_person,email,phone,address,tpin,payment_terms_days', accounts: 'code,name,type,subtype', items: 'code,name,description,unit,sale_price,purchase_price' };
  return <>
    <Card title="Export data"><div className="stack-sm">{EX.map(([k, l]) => <div key={k} className="kv"><span>{l}</span><span className="row-gap"><Button size="sm" busy={busy} onClick={() => run(() => download(`/admin/export/${k}`))}>CSV</Button><Button size="sm" busy={busy} onClick={() => run(() => download(`/admin/export/${k}?format=xlsx`))}>Excel</Button></span></div>)}</div></Card>
    <Card title="Import data">
      <div className="form-grid"><Field label="What to import"><Select value={entity} onChange={setEntity} options={[['customers', 'Customers'], ['suppliers', 'Suppliers'], ['accounts', 'Chart of accounts'], ['items', 'Items']].map(([value, label]) => ({ value, label }))} /></Field>
        <Field label="CSV file" hint={`Header row: ${HEAD[entity]}. Existing codes are updated.`}><div className="row-gap"><input ref={input} type="file" accept=".csv,text/csv" hidden onChange={async (e) => { const fl = e.target.files[0]; if (fl) { const r = await run(() => api.upload(`/admin/import/${entity}`, fl), (x) => `${x.created} created, ${x.updated} updated.`); if (r) setRes(r); } e.target.value = ''; }} /><Button icon="upload" busy={busy} onClick={() => input.current?.click()}>Choose CSV</Button></div></Field></div>
      {res?.errors?.length > 0 && <Alert tone="warning" title={`${res.errors.length} row(s) skipped:`}>{res.errors.slice(0, 10).join('; ')}</Alert>}
    </Card>
  </>;
}

export function Backups() {
  const { isSuperAdmin } = useSession(); const { confirm } = useToast(); const state = useApi('/admin/backups'); const [run, busy] = useAction(); const input = useRef(null);
  return <>
    <Card title="Backups" actions={<>{isSuperAdmin && <Button busy={busy} onClick={async () => { if (await run(() => api.post('/admin/backups/database', {}), 'Database backup created.')) state.reload(); }}>Back up database</Button>}<Button variant="primary" busy={busy} onClick={async () => { if (await run(() => api.post('/admin/backups/config', {}), 'Configuration backup created.')) state.reload(); }}>Back up configuration</Button></>} pad={false}>
      <p className="muted" style={{ padding: '0 var(--space-5)' }}><strong>Database backups</strong> contain everything (all companies) and are Super Admin only. <strong>Configuration backups</strong> contain this company's settings, branding, roles, numbering and tax rates — never transactions. In production, also enable your database host's automatic daily backups.</p>
      <Loadable state={state}>{(rows) => <DataTable rows={rows} columns={[{ key: 'created_at', label: 'Created', type: 'datetime' }, { key: 'kind', label: 'Type', render: titleCase }, { key: 'filename', label: 'File' }, { key: 'size_bytes', label: 'Size', type: 'number', render: (v) => `${(v / 1024).toFixed(0)} KB` }, { key: 'created_by_name', label: 'By' }, { key: 'notes', label: 'Notes' },
        { key: 'a', label: '', sortable: false, render: (_, b) => <div className="row-gap">{(b.kind === 'CONFIG' || isSuperAdmin) && <Button size="sm" onClick={() => run(() => download(`/admin/backups/${b.id}/download`))}>Download</Button>}
          {isSuperAdmin && <Button size="sm" variant="danger" onClick={async () => { const ok = await confirm({ title: b.kind === 'DATABASE' ? 'Restore the entire database?' : 'Restore this configuration?', message: b.kind === 'DATABASE' ? 'This replaces ALL data in ALL companies with this backup. A safety backup is taken first. Everyone will need to sign in again.' : 'Settings, roles, numbering and tax rates for this company are replaced. Transactions are not affected.', requireText: 'RESTORE', danger: true, confirmLabel: 'Restore' }); if (ok && await run(() => api.post(`/admin/backups/${b.id}/restore`, { confirm: 'RESTORE' }), 'Restore complete.')) state.reload(); }}>Restore</Button>}</div> }]} />}</Loadable>
    </Card>
    <Card title="Restore configuration from a file"><div className="row-gap"><input ref={input} type="file" accept=".json,application/json" hidden onChange={async (e) => { const fl = e.target.files[0]; if (fl && await confirm({ title: 'Restore configuration?', message: `Apply settings from ${fl.name} to this company?`, requireText: 'RESTORE' })) await run(() => api.upload('/admin/backups/config/upload', fl), 'Configuration restored.'); e.target.value = ''; }} /><Button icon="upload" onClick={() => input.current?.click()}>Upload configuration backup (.json)</Button></div></Card>
  </>;
}

export function Audit() {
  const [sp] = useSearchParams();
  const [f, setF] = useState({ action: '', entity_type: sp.get('entity_type') || '', entity_id: sp.get('entity_id') || '', from: '', to: '', ai: '' });
  const state = useApi(`/admin/audit-logs${qs({ ...f, limit: 1000 })}`); const verify = useApi('/admin/audit-logs/verify');
  const [detail, setDetail] = useState(null);
  return <>
    <Card title="Audit trail integrity">{verify.data ? (verify.data.intact ? <Alert tone="success" title="Intact.">{verify.data.entries} entries, hash chain verified. Entries cannot be edited or deleted (enforced by the database).</Alert> : <Alert tone="error" title="Integrity problem.">The chain breaks at entry #{verify.data.first_broken_id}.</Alert>) : 'Checking…'}</Card>
    <Card title="Audit log" pad={false}>
      <div className="toolbar" style={{ padding: 'var(--space-3)', margin: 0 }}><Field label="Action contains"><Input value={f.action} onChange={(e) => setF({ ...f, action: e.target.value })} placeholder="e.g. posted, login, settings" /></Field>
        <Field label="Record type"><Select value={f.entity_type} onChange={(v) => setF({ ...f, entity_type: v })} placeholder="All" options={['journal_entry', 'sales_document', 'purchase_document', 'payment', 'expense', 'user', 'role', 'settings', 'company', 'branding', 'account', 'tax_rate', 'fiscal_period', 'backup', 'ai_conversation', 'ai_tool'].map((x) => ({ value: x, label: titleCase(x) }))} /></Field>
        <Field label="From"><DateInput value={f.from} onChange={(v) => setF({ ...f, from: v })} /></Field><Field label="To"><DateInput value={f.to} onChange={(v) => setF({ ...f, to: v })} /></Field>
        <Field label=" "><Check label="AI-assisted only" checked={f.ai === 'true'} onChange={(v) => setF({ ...f, ai: v ? 'true' : '' })} /></Field>
        <Field label=" "><Button size="sm" onClick={() => download(`/reports/audit${qs({ from: f.from, to: f.to, action: f.action, format: 'xlsx' })}`)}>Export</Button></Field></div>
      <Loadable state={state}>{(d) => <DataTable rows={d.items} onRowClick={setDetail} pageSize={50} columns={[{ key: 'created_at', label: 'When', type: 'datetime' }, { key: 'user_name', label: 'User' }, { key: 'action', label: 'Action', render: (v, l) => <span className="row-gap"><code>{v}</code>{l.via_ai && <Badge tone="accent">AI</Badge>}</span> },
        { key: 'entity_type', label: 'Record', render: (v, l) => (v ? `${titleCase(v)} #${l.entity_id}` : '') }, { key: 'ip', label: 'IP address' }]} />}</Loadable>
    </Card>
    {detail && <Modal wide title={`Audit entry #${detail.id}`} onClose={() => setDetail(null)}>
      <dl className="dl"><dt>When</dt><dd>{fmtDateTime(detail.created_at)}</dd><dt>User</dt><dd>{detail.user_name}</dd><dt>Action</dt><dd><code>{detail.action}</code></dd><dt>Record</dt><dd>{detail.entity_type} #{detail.entity_id}</dd><dt>IP / device</dt><dd>{detail.ip} · <span className="t-small">{detail.user_agent}</span></dd><dt>Hash</dt><dd><code className="t-small" style={{ wordBreak: 'break-all' }}>{detail.hash}</code></dd></dl>
      <div className="grid grid-2" style={{ marginTop: 16 }}><div><strong>Old value</strong><pre className="t-small" style={{ whiteSpace: 'pre-wrap', background: 'var(--surface-200)', padding: 12, borderRadius: 6 }}>{JSON.stringify(detail.old_value, null, 2) || '—'}</pre></div>
        <div><strong>New value</strong><pre className="t-small" style={{ whiteSpace: 'pre-wrap', background: 'var(--surface-200)', padding: 12, borderRadius: 6 }}>{JSON.stringify(detail.new_value, null, 2) || '—'}</pre></div></div></Modal>}
  </>;
}

export function SystemInfo() {
  const state = useApi('/admin/system');
  return <Loadable state={state}>{(s) => <Card title="System information"><dl className="dl"><dt>Application</dt><dd>{s.app} {s.version}</dd><dt>Environment</dt><dd>{s.env}</dd><dt>Node.js</dt><dd>{s.node}</dd><dt>Database</dt><dd>{s.database.version.split(',')[0]} · {s.database.size}</dd>
    <dt>Companies</dt><dd>{s.counts.companies}</dd><dt>Users</dt><dd>{s.counts.users}</dd><dt>Journals (this company)</dt><dd>{s.counts.journals}</dd><dt>Documents</dt><dd>{s.counts.documents}</dd><dt>Migrations</dt><dd>{s.migrations.map((m) => m.name).join(', ')}</dd>
    <dt>Platform AI key</dt><dd>{s.ai_platform_key ? 'Configured via environment' : 'Not set in environment'}</dd><dt>Health check</dt><dd><a href="/healthz" target="_blank" rel="noreferrer">/healthz</a></dd></dl></Card>}</Loadable>;
}
export { Link, StatusBadge };
