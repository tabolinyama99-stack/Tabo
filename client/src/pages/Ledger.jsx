import { Fragment, useEffect, useMemo, useState } from 'react';
import { Routes, Route, useParams, useNavigate, useLocation, Link } from 'react-router-dom';
import { api, qs } from '../lib/api.js';
import { useSession } from '../lib/session.jsx';
import { fmtK, fmtDate, today, sumK, titleCase } from '../lib/format.js';
import { PageHeader, Card, useApi, Loadable, Button, Field, Input, Select, DateInput, MoneyInput, Modal, Alert, StatusBadge, Money, useAction, useToast, Badge, Check, LinkButton, TextArea } from '../components/ui.jsx';
import { DataTable } from '../components/DataTable.jsx';
import { useLookup, accountOptions, partyOptions, invalidate } from '../components/lookups.js';
import { Attachments } from '../components/Attachments.jsx';

const SOURCES = ['MANUAL', 'AI', 'INVOICE', 'CREDIT_NOTE', 'BILL', 'DEBIT_NOTE', 'RECEIPT', 'PAYMENT', 'EXPENSE', 'BANK', 'OPENING', 'REVERSAL', 'RECURRING'];

function JournalList() {
  const { can } = useSession();
  const [f, setF] = useState({ status: '', source_type: '', from: '', to: '' });
  const state = useApi(`/journals${qs({ ...f, limit: 500 })}`);
  return <div className="stack">
    <PageHeader title="Journal entries" subtitle="Every posted transaction in the general ledger" actions={can('create_journal') && <LinkButton variant="primary" icon="plus" to="/journals/new">New journal</LinkButton>} />
    <Card pad={false}><Loadable state={state}>{(d) => <DataTable rows={d.items} rowLink={(r) => `/journals/${r.id}`}
      toolbar={<div className="row-gap wrap" style={{ marginLeft: 'auto' }}>
        <Select value={f.status} onChange={(v) => setF({ ...f, status: v })} placeholder="All statuses" options={['DRAFT', 'PENDING_APPROVAL', 'POSTED', 'REVERSED'].map((s) => ({ value: s, label: titleCase(s) }))} aria-label="Status" />
        <Select value={f.source_type} onChange={(v) => setF({ ...f, source_type: v })} placeholder="All sources" options={SOURCES.map((s) => ({ value: s, label: titleCase(s) }))} aria-label="Source" />
        <DateInput value={f.from} onChange={(v) => setF({ ...f, from: v })} aria-label="From" /><DateInput value={f.to} onChange={(v) => setF({ ...f, to: v })} aria-label="To" /></div>}
      columns={[{ key: 'number', label: 'Number' }, { key: 'entry_date', label: 'Date', type: 'date' }, { key: 'description', label: 'Description' }, { key: 'reference', label: 'Reference' },
        { key: 'source_type', label: 'Source', render: (v, r) => <span className="row-gap">{titleCase(v)}{r.ai_generated && <Badge tone="accent">AI</Badge>}{r.is_adjusting && <Badge>Adj.</Badge>}</span> }, { key: 'status', label: 'Status', type: 'status' }, { key: 'total', label: 'Amount', type: 'money' }]} />}</Loadable></Card>
  </div>;
}

export function JournalForm({ initial }) {
  const { me, can } = useSession(); const nav = useNavigate();
  const accounts = useLookup('/accounts'); const customers = useLookup('/customers'); const suppliers = useLookup('/suppliers');
  const branches = useLookup('/admin/branches'); const departments = useLookup('/admin/departments');
  const blank = { account_id: '', debit: '', credit: '', description: '', customer_id: '', supplier_id: '' };
  const [f, setF] = useState(initial ? { date: initial.entry_date, reference: initial.reference || '', description: initial.description, is_adjusting: initial.is_adjusting, auto_reverse_on: initial.auto_reverse_on || '', branch_id: initial.branch_id || '', department_id: initial.department_id || '',
    lines: initial.lines.map((l) => ({ account_id: l.account_id, debit: Number(l.debit) ? l.debit : '', credit: Number(l.credit) ? l.credit : '', description: l.description || '', customer_id: l.customer_id || '', supplier_id: l.supplier_id || '' })) }
    : { date: today(), reference: '', description: '', is_adjusting: false, auto_reverse_on: '', branch_id: '', department_id: '', lines: [{ ...blank }, { ...blank }] });
  const [run, busy] = useAction();
  const d = sumK(f.lines.map((l) => l.debit)), c = sumK(f.lines.map((l) => l.credit));
  const diff = sumK([d, `-${c}`.replace('--', '')]);
  const balanced = d === c && Number(d) > 0;
  const accById = new Map(accounts.map((a) => [String(a.id), a]));
  const setLine = (i, p) => setF((x) => ({ ...x, lines: x.lines.map((l, j) => (j === i ? { ...l, ...p } : l)) }));
  const save = async (action) => {
    const body = { ...f, action, auto_reverse_on: f.auto_reverse_on || null, branch_id: f.branch_id || null, department_id: f.department_id || null, lines: f.lines.filter((l) => l.account_id && (Number(l.debit) || Number(l.credit))).map((l) => ({ ...l, debit: l.debit || null, credit: l.credit || null })) };
    const r = await run(() => (initial ? api.put(`/journals/${initial.id}`, body) : api.post('/journals', body)), (x) => (x._pendingApproval || x.status === 'PENDING_APPROVAL' ? `${x.number} submitted for approval.` : x.status === 'POSTED' ? `${x.number} posted.` : `${x.number} saved as draft.`));
    if (r) nav(`/journals/${r.id}`);
  };
  return <div className="stack">
    <Card title="Journal"><div className="form-grid cols-4">
      <Field label="Date" required><DateInput value={f.date} onChange={(v) => setF({ ...f, date: v })} /></Field>
      <Field label="Reference"><Input value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} /></Field>
      <Field label="Description" required span={2}><Input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
      {me.settings?.features?.branches && <Field label="Branch"><Select value={f.branch_id} onChange={(v) => setF({ ...f, branch_id: v })} placeholder="—" options={branches.map((b) => ({ value: b.id, label: b.name }))} /></Field>}
      {me.settings?.features?.departments && <Field label="Department"><Select value={f.department_id} onChange={(v) => setF({ ...f, department_id: v })} placeholder="—" options={departments.map((b) => ({ value: b.id, label: b.name }))} /></Field>}
      <Field label="Auto-reverse on" hint="For accruals: posts the reversal automatically"><DateInput value={f.auto_reverse_on} onChange={(v) => setF({ ...f, auto_reverse_on: v })} /></Field>
      <Field label=" "><Check label="Adjusting entry" checked={f.is_adjusting} onChange={(v) => setF({ ...f, is_adjusting: v })} /></Field>
    </div></Card>
    <Card title="Lines" pad={false}>
      <div className="table-wrap"><table className="table lines-table"><thead><tr><th>Account</th><th>Line description</th><th>Customer / supplier</th><th className="r">Debit</th><th className="r">Credit</th><th /></tr></thead>
        <tbody>{f.lines.map((l, i) => { const a = accById.get(String(l.account_id)); return <tr key={i}>
          <td style={{ minWidth: 240 }}><Select value={l.account_id} onChange={(v) => setLine(i, { account_id: v })} placeholder="Account…" options={accountOptions(accounts)} aria-label="Account" /></td>
          <td className="line-desc"><Input value={l.description} onChange={(e) => setLine(i, { description: e.target.value })} aria-label="Line description" /></td>
          <td style={{ minWidth: 180 }}>{a?.system_key === 'AR' ? <Select value={l.customer_id} onChange={(v) => setLine(i, { customer_id: v })} placeholder="Customer…" options={partyOptions(customers)} aria-label="Customer" />
            : a?.system_key === 'AP' ? <Select value={l.supplier_id} onChange={(v) => setLine(i, { supplier_id: v })} placeholder="Supplier…" options={partyOptions(suppliers)} aria-label="Supplier" /> : <span className="faint t-small">—</span>}</td>
          <td style={{ width: 150 }}><MoneyInput value={l.debit} onChange={(v) => setLine(i, { debit: v, credit: v ? '' : l.credit })} aria-label="Debit" /></td>
          <td style={{ width: 150 }}><MoneyInput value={l.credit} onChange={(v) => setLine(i, { credit: v, debit: v ? '' : l.debit })} aria-label="Credit" /></td>
          <td><Button size="sm" variant="ghost" icon="trash" aria-label="Remove line" disabled={f.lines.length <= 2} onClick={() => setF({ ...f, lines: f.lines.filter((_, j) => j !== i) })} /></td></tr>; })}</tbody>
        <tfoot><tr className="row-total"><td colSpan={3}>Totals {!balanced && Number(d) + Number(c) > 0 && <span className="neg"> — out of balance by {fmtK(diff.replace('-', ''))}</span>}</td><td className="r num">{fmtK(d)}</td><td className="r num">{fmtK(c)}</td><td /></tr></tfoot></table></div>
      <div style={{ padding: 'var(--space-3) var(--space-5)' }}><Button size="sm" icon="plus" onClick={() => setF({ ...f, lines: [...f.lines, { ...blank }] })}>Add line</Button></div>
    </Card>
    {!balanced && <Alert tone="info">Total debits must equal total credits before the journal can be posted. You can save an unbalanced draft.</Alert>}
    <div className="form-actions"><Button onClick={() => nav(-1)}>Cancel</Button><Button busy={busy} disabled={!f.description} onClick={() => save('draft')}>Save draft</Button>
      {can('create_journal') && <Button variant="primary" busy={busy} disabled={!balanced || !f.description} onClick={() => save('post')}>{can('post_journal') ? 'Post journal' : 'Submit for approval'}</Button>}</div>
  </div>;
}

function JournalView() {
  const { id } = useParams(); const { can } = useSession(); const { confirm } = useToast(); const nav = useNavigate();
  const state = useApi(`/journals/${id}`); const [run, busy] = useAction();
  return <Loadable state={state}>{(j) => { const draft = ['DRAFT', 'PENDING_APPROVAL'].includes(j.status); const d = sumK(j.lines.map((l) => l.debit)), c = sumK(j.lines.map((l) => l.credit)); return <div className="stack">
    <PageHeader back="/journals" title={<span className="row-gap">Journal {j.number} <StatusBadge status={j.status} />{j.ai_generated && <Badge tone="accent">AI draft</Badge>}</span>} subtitle={j.description}
      actions={<>
        {draft && ['MANUAL', 'AI', 'RECURRING'].includes(j.source_type) && can('create_journal') && <LinkButton to={`/journals/${j.id}/edit`}>Edit</LinkButton>}
        {j.status === 'DRAFT' && can('create_journal') && <Button variant={can('approve_transactions') ? '' : 'primary'} busy={busy} disabled={d !== c} onClick={async () => { if (await run(() => api.post(`/journals/${j.id}/post`), (x) => (x.status === 'POSTED' ? 'Posted.' : 'Submitted for approval.'))) state.reload(); }}>{can('post_journal') ? 'Post' : 'Submit for approval'}</Button>}
        {draft && can('approve_transactions') && <Button variant="primary" busy={busy} disabled={d !== c} onClick={async () => { if (await confirm({ title: `Approve ${j.number}?`, message: `${fmtK(d)} will be posted to the ledger.`, confirmLabel: 'Approve & post' }) && await run(() => api.post(`/journals/${j.id}/approve`), 'Approved and posted.')) state.reload(); }}>Approve & post</Button>}
        {j.status === 'PENDING_APPROVAL' && can('approve_transactions') && <Button onClick={async () => { const reason = await confirm({ title: 'Return to draft?', message: 'The journal goes back to its creator as a draft.', input: true, inputLabel: 'Reason' }); if (reason && await run(() => api.post(`/journals/${j.id}/reject`, { reason }), 'Returned to draft.')) state.reload(); }}>Reject</Button>}
        {draft && can('create_journal') && <Button variant="danger" onClick={async () => { if (await confirm({ title: `Delete draft ${j.number}?`, message: 'The draft is voided (it remains in the audit trail).', danger: true }) && await run(() => api.del(`/journals/${j.id}`), 'Draft deleted.')) nav('/journals'); }}>Delete</Button>}
        {j.status === 'POSTED' && can('reverse_journal') && ['MANUAL', 'AI', 'RECURRING', 'BANK', 'OPENING'].includes(j.source_type) && <Button variant="danger" onClick={async () => { const reason = await confirm({ title: `Reverse ${j.number}?`, message: 'A mirror-image journal is posted and this one is marked Reversed.', input: true, inputLabel: 'Reason', danger: true, confirmLabel: 'Reverse' }); if (reason) { const r = await run(() => api.post(`/journals/${j.id}/reverse`, { reason }), (x) => `Reversed by ${x.number}.`); if (r) state.reload(); } }}>Reverse</Button>}
      </>} />
    {j.ai_generated && draft && <Alert tone="warning" title="Prepared by the AI assistant.">{j.ai_rationale} Check the accounts and amounts before approving.</Alert>}
    {j.status === 'PENDING_APPROVAL' && <Alert tone="warning" title="Pending approval.">This journal is above the approval threshold or the creator's limit.</Alert>}
    <div className="grid grid-3">
      <Card title="Details"><dl className="dl"><dt>Date</dt><dd>{fmtDate(j.entry_date)}</dd><dt>Reference</dt><dd>{j.reference || '—'}</dd><dt>Source</dt><dd>{titleCase(j.source_type)}{j.source_id && ['INVOICE', 'CREDIT_NOTE'].includes(j.source_type) ? <> · <Link to={`/sales/documents/${j.source_id}`}>open</Link></> : j.source_id && ['BILL', 'DEBIT_NOTE'].includes(j.source_type) ? <> · <Link to={`/purchases/documents/${j.source_id}`}>open</Link></> : j.source_type === 'EXPENSE' ? <> · <Link to={`/expenses/${j.source_id}`}>open</Link></> : ['RECEIPT', 'PAYMENT'].includes(j.source_type) ? <> · <Link to={`/payments/${j.source_id}`}>open</Link></> : null}</dd>
        {j.reversal_of && <><dt>Reverses</dt><dd><Link to={`/journals/${j.reversal_of}`}>#{j.reversal_of}</Link></dd></>}{j.reversed_by && <><dt>Reversed by</dt><dd><Link to={`/journals/${j.reversed_by}`}>#{j.reversed_by}</Link></dd></>}
        {j.auto_reverse_on && <><dt>Auto-reverse</dt><dd>{fmtDate(j.auto_reverse_on)}</dd></>}</dl></Card>
      <Card title="Audit"><dl className="dl"><dt>Created by</dt><dd>{j.created_by_name || 'System'}</dd>{j.approved_by_name && <><dt>Approved by</dt><dd>{j.approved_by_name}</dd></>}{j.posted_by_name && <><dt>Posted by</dt><dd>{j.posted_by_name}</dd></>}{j.posted_at && <><dt>Posted at</dt><dd>{new Date(j.posted_at).toLocaleString('en-GB')}</dd></>}</dl>
        <Link className="t-small" to={`/admin/audit?entity_type=journal_entry&entity_id=${j.id}`}>View audit trail →</Link></Card>
      <Card title="Totals"><div className="totals" style={{ width: '100%' }}><span className="muted">Debits</span><Money value={d} /><span className="muted">Credits</span><Money value={c} /><span>Balanced</span><span>{d === c ? <Badge tone="positive">Yes</Badge> : <Badge tone="negative">No</Badge>}</span></div></Card>
    </div>
    <Card title="Lines" pad={false}><div className="table-wrap"><table className="table"><thead><tr><th>Account</th><th>Description</th><th>Party</th><th className="r">Debit</th><th className="r">Credit</th></tr></thead>
      <tbody>{j.lines.map((l) => <tr key={l.id}><td>{l.account_code} {l.account_name}</td><td>{l.description}</td><td>{l.customer_name || l.supplier_name}</td><td className="r num">{Number(l.debit) ? fmtK(l.debit) : ''}</td><td className="r num">{Number(l.credit) ? fmtK(l.credit) : ''}</td></tr>)}</tbody>
      <tfoot><tr className="row-total"><td colSpan={3}>Total</td><td className="r num">{fmtK(d)}</td><td className="r num">{fmtK(c)}</td></tr></tfoot></table></div></Card>
    <Attachments linkedType="journal_entry" linkedId={j.id} initial={j.documents} />
  </div>; }}</Loadable>;
}

function EditJournal() { const { id } = useParams(); const s = useApi(`/journals/${id}`); return <Loadable state={s}>{(j) => <div className="stack"><PageHeader back={`/journals/${id}`} title={`Edit ${j.number}`} /><JournalForm initial={j} /></div>}</Loadable>; }

function Recurring() {
  const { can } = useSession();
  const state = useApi('/recurring-journals'); const accounts = useLookup('/accounts');
  const [edit, setEdit] = useState(null); const [run, busy] = useAction();
  return <div className="stack">
    <PageHeader back="/journals" title="Recurring journals" subtitle="Templates that create journals on a schedule (e.g. monthly rent accrual, depreciation)."
      actions={can('create_journal') && <><Button busy={busy} onClick={async () => { await run(() => api.post('/recurring-journals/run'), (x) => `${x.created} journal(s) created.`); state.reload(); }}>Run due now</Button><Button variant="primary" icon="plus" onClick={() => setEdit({})}>New template</Button></>} />
    <Card pad={false}><Loadable state={state}>{(rows) => <DataTable rows={rows} onRowClick={can('create_journal') ? (r) => setEdit(r) : undefined}
      columns={[{ key: 'name', label: 'Name' }, { key: 'frequency', label: 'Frequency', render: titleCase }, { key: 'next_run_date', label: 'Next run', type: 'date' }, { key: 'end_date', label: 'Ends', type: 'date' },
        { key: 'auto_post', label: 'Mode', render: (v) => (v ? 'Auto-post' : 'Create draft') }, { key: 'is_active', label: 'Status', render: (v) => (v ? <Badge tone="positive">Active</Badge> : <Badge>Paused</Badge>) }]} empty={{ title: 'No recurring journals', text: 'Create one for regular accruals, depreciation or allocations.' }} />}</Loadable></Card>
    {edit && <RecurringModal initial={edit.id ? edit : null} accounts={accounts} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); state.reload(); }} />}
  </div>;
}
function RecurringModal({ initial, accounts, onClose, onSaved }) {
  const [f, setF] = useState(initial ? { ...initial, end_date: initial.end_date || '', lines: initial.lines.map((l) => ({ account_id: l.account_id, debit: Number(l.debit) ? l.debit : '', credit: Number(l.credit) ? l.credit : '' })) }
    : { name: '', description: '', frequency: 'MONTHLY', next_run_date: today(), end_date: '', auto_post: false, is_active: true, lines: [{ account_id: '', debit: '', credit: '' }, { account_id: '', debit: '', credit: '' }] });
  const [run, busy] = useAction();
  const d = sumK(f.lines.map((l) => l.debit)), c = sumK(f.lines.map((l) => l.credit));
  const setLine = (i, p) => setF({ ...f, lines: f.lines.map((l, j) => (j === i ? { ...l, ...p } : l)) });
  return <Modal wide title={initial ? `Edit ${initial.name}` : 'New recurring journal'} onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" busy={busy} disabled={d !== c || !Number(d) || !f.name || !f.description}
    onClick={async () => { const body = { ...f, end_date: f.end_date || null, lines: f.lines.filter((l) => l.account_id).map((l) => ({ account_id: l.account_id, debit: l.debit || null, credit: l.credit || null })) }; if (await run(() => (initial ? api.put(`/recurring-journals/${initial.id}`, body) : api.post('/recurring-journals', body)), 'Saved.')) onSaved(); }}>Save</Button></>}>
    <div className="form-grid cols-3">
      <Field label="Name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
      <Field label="Journal description" span={2}><Input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
      <Field label="Frequency"><Select value={f.frequency} onChange={(v) => setF({ ...f, frequency: v })} options={['WEEKLY', 'MONTHLY', 'QUARTERLY', 'YEARLY'].map((x) => ({ value: x, label: titleCase(x) }))} /></Field>
      <Field label="Next run date"><DateInput value={f.next_run_date} onChange={(v) => setF({ ...f, next_run_date: v })} /></Field>
      <Field label="End date (optional)"><DateInput value={f.end_date} onChange={(v) => setF({ ...f, end_date: v })} /></Field>
      <Check label="Post automatically (otherwise create drafts for review)" checked={f.auto_post} onChange={(v) => setF({ ...f, auto_post: v })} />
      <Check label="Active" checked={f.is_active} onChange={(v) => setF({ ...f, is_active: v })} />
    </div>
    <div className="table-wrap" style={{ marginTop: 16 }}><table className="table"><thead><tr><th>Account</th><th className="r">Debit</th><th className="r">Credit</th></tr></thead>
      <tbody>{f.lines.map((l, i) => <tr key={i}><td><Select value={l.account_id} onChange={(v) => setLine(i, { account_id: v })} placeholder="Account…" options={accountOptions(accounts)} /></td><td><MoneyInput value={l.debit} onChange={(v) => setLine(i, { debit: v })} /></td><td><MoneyInput value={l.credit} onChange={(v) => setLine(i, { credit: v })} /></td></tr>)}</tbody>
      <tfoot><tr className="row-total"><td><Button size="sm" onClick={() => setF({ ...f, lines: [...f.lines, { account_id: '', debit: '', credit: '' }] })}>Add line</Button></td><td className="r num">{fmtK(d)}</td><td className="r num">{fmtK(c)}</td></tr></tfoot></table></div>
  </Modal>;
}

const TYPES = [['ASSET', 'Assets'], ['LIABILITY', 'Liabilities'], ['EQUITY', 'Equity'], ['REVENUE', 'Revenue'], ['COST_OF_SALES', 'Cost of sales'], ['EXPENSE', 'Expenses']];
function Accounts() {
  const { can } = useSession(); const loc = useLocation(); const { confirm } = useToast();
  const highlight = new URLSearchParams(loc.search).get('highlight');
  const state = useApi('/accounts');
  const [edit, setEdit] = useState(null); const [ob, setOb] = useState(false); const [showInactive, setShowInactive] = useState(false);
  const [run] = useAction();
  return <div className="stack">
    <PageHeader title="Chart of accounts" subtitle="Balances are derived from posted journals. Accounts with transactions can be archived but never deleted."
      actions={can('edit_chart_of_accounts') && <><Button onClick={() => setOb(true)}>Opening balances</Button><Button variant="primary" icon="plus" onClick={() => setEdit({})}>New account</Button></>} />
    <Check label="Show archived accounts" checked={showInactive} onChange={setShowInactive} />
    <Loadable state={state}>{(rows) => <div className="stack">{TYPES.map(([t, label]) => { const list = rows.filter((a) => a.type === t && (showInactive || a.is_active)); return <Card key={t} title={label} pad={false}>
      <div className="table-wrap"><table className="table"><thead><tr><th>Code</th><th>Name</th><th>Subtype</th><th>System</th><th className="r">Transactions</th><th className="r">Balance</th><th /></tr></thead>
        <tbody>{list.map((a) => { const bal = ['ASSET', 'EXPENSE', 'COST_OF_SALES'].includes(t) ? a.balance : String(-Number(a.balance)).replace(/^-0$/, '0'); return <tr key={a.id} className={String(a.id) === highlight ? 'row-header' : ''}>
          <td className="num">{a.code}</td><td style={{ paddingLeft: a.parent_id ? 28 : undefined }}>{a.name}{!a.is_active && <> <Badge>Archived</Badge></>}</td><td className="t-small">{a.subtype.replace(/_/g, ' ')}</td><td className="t-small">{a.system_key || ''}</td>
          <td className="r num">{a.transactions}</td><td className="r"><Link to={`/reports/general-ledger?account_id=${a.id}&from=${today().slice(0, 4)}-01-01`}><Money value={Number(bal).toFixed(2)} /></Link></td>
          <td className="r">{can('edit_chart_of_accounts') && <div className="row-gap" style={{ justifyContent: 'flex-end' }}><Button size="sm" variant="ghost" onClick={() => setEdit(a)}>Edit</Button>
            {!a.system_key && <Button size="sm" variant="ghost" onClick={async () => { if (a.transactions === 0 && a.is_active) { if (await confirm({ title: `Delete ${a.code} ${a.name}?`, message: 'This account has no transactions and will be removed.', danger: true }) && await run(() => api.del(`/accounts/${a.id}`), 'Deleted.')) { invalidate('/accounts'); state.reload(); } } else if (await run(() => api.post(`/accounts/${a.id}/active`, { is_active: !a.is_active }), a.is_active ? 'Archived.' : 'Restored.')) { invalidate('/accounts'); state.reload(); } }}>{a.transactions === 0 && a.is_active ? 'Delete' : a.is_active ? 'Archive' : 'Restore'}</Button>}</div>}</td></tr>; })}</tbody></table></div></Card>; })}</div>}</Loadable>
    {edit && <AccountModal initial={edit.id ? edit : null} accounts={state.data || []} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); invalidate('/accounts'); state.reload(); }} />}
    {ob && <OpeningBalances accounts={state.data || []} onClose={() => setOb(false)} onSaved={() => { setOb(false); state.reload(); }} />}
  </div>;
}
function AccountModal({ initial, accounts, onClose, onSaved }) {
  const [f, setF] = useState(initial ? { code: initial.code, name: initial.name, type: initial.type, subtype: initial.subtype, parent_id: initial.parent_id || '', description: initial.description || '', cash_flow_category: initial.cash_flow_category } : { code: '', name: '', type: 'EXPENSE', subtype: 'operating_expense', parent_id: '', description: '', cash_flow_category: 'OPERATING' });
  const [run, busy] = useAction();
  const SUB = { ASSET: ['current_asset', 'receivable', 'fixed_asset', 'tax', 'general'], LIABILITY: ['current_liability', 'payable', 'tax', 'long_term_liability'], EQUITY: ['equity'], REVENUE: ['operating_revenue', 'other_income'], COST_OF_SALES: ['cost_of_sales'], EXPENSE: ['operating_expense', 'payroll', 'finance_cost', 'non_cash'] };
  return <Modal title={initial ? `Edit ${initial.code} ${initial.name}` : 'New account'} onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" busy={busy} disabled={!f.code || !f.name}
    onClick={async () => { if (await run(() => (initial ? api.put(`/accounts/${initial.id}`, { ...f, parent_id: f.parent_id || '' }) : api.post('/accounts', { ...f, parent_id: f.parent_id || null })), 'Account saved.')) onSaved(); }}>Save</Button></>}>
    <div className="form-grid">
      <Field label="Code"><Input value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} /></Field>
      <Field label="Name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
      <Field label="Type" hint={initial?.transactions ? 'Locked: account has transactions' : null}><Select value={f.type} disabled={!!initial?.transactions || !!initial?.system_key} onChange={(v) => setF({ ...f, type: v, subtype: SUB[v][0], parent_id: '' })} options={TYPES.map(([v, l]) => ({ value: v, label: l }))} /></Field>
      <Field label="Subtype"><Select value={f.subtype} onChange={(v) => setF({ ...f, subtype: v })} options={(SUB[f.type] || []).concat(initial && !SUB[f.type]?.includes(f.subtype) ? [f.subtype] : []).map((s) => ({ value: s, label: s.replace(/_/g, ' ') }))} /></Field>
      <Field label="Parent account (sub-account of)"><Select value={f.parent_id} onChange={(v) => setF({ ...f, parent_id: v })} placeholder="None" options={accounts.filter((a) => a.type === f.type && a.id !== initial?.id && !a.parent_id).map((a) => ({ value: a.id, label: `${a.code} ${a.name}` }))} /></Field>
      <Field label="Cash flow category"><Select value={f.cash_flow_category} onChange={(v) => setF({ ...f, cash_flow_category: v })} options={['OPERATING', 'INVESTING', 'FINANCING'].map((x) => ({ value: x, label: titleCase(x) }))} /></Field>
      <Field label="Description" span={2}><TextArea value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
    </div>
  </Modal>;
}
function OpeningBalances({ accounts, onClose, onSaved }) {
  const eligible = accounts.filter((a) => a.is_active && !['AR', 'AP', 'OPENING_BALANCE'].includes(a.system_key) && ['ASSET', 'LIABILITY', 'EQUITY'].includes(a.type));
  const [date, setDate] = useState(`${today().slice(0, 4)}-01-01`);
  const [vals, setVals] = useState({});
  const [run, busy] = useAction();
  const lines = Object.entries(vals).filter(([, v]) => v.amount && Number(v.amount)).map(([id, v]) => { const a = eligible.find((x) => String(x.id) === id); const debitSide = a.type === 'ASSET'; return { account_id: id, [debitSide ? 'debit' : 'credit']: v.amount }; });
  return <Modal wide title="Opening balances" onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" busy={busy} disabled={!lines.length}
    onClick={async () => { if (await run(() => api.post('/accounts/opening-balances', { date, lines }), (x) => `Opening balances posted (${x.number}).`)) onSaved(); }}>Post opening balances</Button></>}>
    <Alert tone="info">Enter balances as at the day before you start using TAEL Books. Any difference goes to <strong>Opening Balance Equity</strong>. For money customers owe you or you owe suppliers, create opening invoices/bills dated before your start date using the Opening Balance Equity account, so aging reports stay accurate.</Alert>
    <div className="toolbar" style={{ marginTop: 16 }}><Field label="Balance date"><DateInput value={date} onChange={setDate} /></Field></div>
    <div className="table-wrap"><table className="table"><thead><tr><th>Account</th><th>Type</th><th className="r">Balance (K)</th></tr></thead>
      <tbody>{eligible.map((a) => <tr key={a.id}><td>{a.code} {a.name}</td><td className="t-small">{titleCase(a.type)}</td><td style={{ width: 180 }}><MoneyInput value={vals[a.id]?.amount || ''} onChange={(v) => setVals({ ...vals, [a.id]: { amount: v } })} /></td></tr>)}</tbody></table></div>
  </Modal>;
}

export default function Ledger() {
  const loc = useLocation();
  if (loc.pathname.startsWith('/accounts')) return <Accounts />;
  return <Routes><Route index element={<JournalList />} /><Route path="new" element={<div className="stack"><PageHeader back="/journals" title="New journal entry" /><JournalForm /></div>} />
    <Route path="recurring" element={<Recurring />} /><Route path=":id/edit" element={<EditJournal />} /><Route path=":id" element={<JournalView />} /></Routes>;
}
export { Fragment, useEffect, useMemo };
