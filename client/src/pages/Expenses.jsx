import { Fragment, useEffect, useRef, useState } from 'react';
import { Routes, Route, useParams, useNavigate, Link } from 'react-router-dom';
import { api, qs } from '../lib/api.js';
import { useSession } from '../lib/session.jsx';
import { fmtK, fmtDate, today } from '../lib/format.js';
import { PageHeader, Card, useApi, Loadable, Button, Field, Input, Select, DateInput, MoneyInput, TextArea, Alert, StatusBadge, Money, useAction, useToast, LinkButton, Check, Badge, Icon } from '../components/ui.jsx';
import { DataTable } from '../components/DataTable.jsx';
import { useLookup, accountOptions, partyOptions, taxOptions, bankOptions } from '../components/lookups.js';
import { Attachments } from '../components/Attachments.jsx';

const METHODS = [['CASH', 'Cash'], ['BANK_TRANSFER', 'Bank transfer'], ['MOBILE_MONEY', 'Mobile money'], ['CARD', 'Card'], ['CHEQUE', 'Cheque'], ['OTHER', 'Other']].map(([value, label]) => ({ value, label }));

function List() {
  const { can } = useSession();
  const [status, setStatus] = useState('');
  const state = useApi(`/expenses${qs({ status, limit: 500 })}`);
  return <div className="stack">
    <PageHeader title="Expenses" subtitle="Costs paid directly from cash, bank or mobile money" actions={<>{can('use_ai') && can('create_expense') && <LinkButton to="/expenses/scan" icon="ai">Scan receipt</LinkButton>}{can('create_expense') && <LinkButton variant="primary" icon="plus" to="/expenses/new">New expense</LinkButton>}</>} />
    <Card pad={false}><Loadable state={state}>{(d) => <DataTable rows={d.items} rowLink={(r) => `/expenses/${r.id}`}
      toolbar={<div className="row-gap" style={{ marginLeft: 'auto' }}><Select value={status} onChange={setStatus} placeholder="All statuses" options={['DRAFT', 'PENDING_APPROVAL', 'POSTED', 'VOID'].map((s) => ({ value: s, label: s.replace('_', ' ').toLowerCase() }))} aria-label="Status" /><span className="t-small">Posted total {fmtK(d.sum_total)}</span></div>}
      columns={[{ key: 'number', label: 'Number' }, { key: 'expense_date', label: 'Date', type: 'date' }, { key: 'payee', label: 'Payee' }, { key: 'category', label: 'Category' }, { key: 'description', label: 'Description' },
        { key: 'has_receipt', label: 'Receipt', render: (v) => (v ? <Icon name="file" size={15} /> : '') }, { key: 'status', label: 'Status', render: (v, r) => <span className="row-gap"><StatusBadge status={v} />{r.ai_generated && <Badge tone="accent">AI</Badge>}</span> }, { key: 'total', label: 'Total', type: 'money' }]} />}</Loadable></Card>
  </div>;
}

export function ExpenseForm({ initial }) {
  const { me } = useSession();
  const nav = useNavigate();
  const accounts = useLookup('/accounts'); const suppliers = useLookup('/suppliers'); const rates = useLookup('/tax-rates'); const banks = useLookup('/bank-accounts');
  const branches = useLookup('/admin/branches'); const departments = useLookup('/admin/departments');
  const [f, setF] = useState(initial ? { ...initial, amount: initial.total, amount_includes_tax: !!initial.tax_rate_id, tax_rate_id: initial.tax_rate_id || '' }
    : { expense_date: today(), supplier_id: '', payee_name: '', account_id: '', amount: '', amount_includes_tax: true, tax_rate_id: '', payment_account_id: '', payment_method: 'CASH', description: '', reference: '', branch_id: '', department_id: '' });
  const [file, setFile] = useState(null);
  const [run, busy] = useAction();
  useEffect(() => { if (!f.payment_account_id && banks.length) setF((x) => ({ ...x, payment_account_id: banks.find((b) => b.is_cash)?.id || banks[0].id })); }, [banks, f.payment_account_id]);
  const set = (k) => (v) => setF((x) => ({ ...x, [k]: v?.target ? v.target.value : v }));
  const thr = me.settings?.accounting?.expense_approval_threshold;
  const save = async (action) => {
    const body = { ...f, action, supplier_id: f.supplier_id || null, tax_rate_id: f.tax_rate_id || null, branch_id: f.branch_id || null, department_id: f.department_id || null };
    for (const k of ['id', 'number', 'status', 'total', 'tax_amount', 'documents', 'company_id', 'journal_entry_id', 'created_at', 'updated_at', 'account_name', 'account_code', 'payment_account_name', 'supplier_name', 'tax_code', 'branch_name', 'department_name', 'created_by_name', 'approved_by_name', 'journal_number', 'ai_generated', 'ai_confidence', 'created_by', 'approved_by', 'document_id']) delete body[k];
    const r = await run(async () => {
      if (file && !initial) { const d = await api.upload('/documents', file, { category: 'receipt' }); body.document_id = d.id; }
      return initial ? api.put(`/expenses/${initial.id}`, body) : api.post('/expenses', body);
    }, (x) => (x.status === 'POSTED' ? `Expense ${x.number} posted.` : x.status === 'PENDING_APPROVAL' ? `Expense ${x.number} sent for approval.` : `Draft ${x.number} saved.`));
    if (r) nav(`/expenses/${r.id}`);
  };
  return <div className="stack">
    <Card title="Expense"><div className="form-grid cols-3">
      <Field label="Date" required><DateInput value={f.expense_date} onChange={set('expense_date')} /></Field>
      <Field label="Supplier"><Select value={f.supplier_id || ''} onChange={set('supplier_id')} placeholder="— or type a payee →" options={partyOptions(suppliers)} /></Field>
      <Field label="Payee (if not a supplier)"><Input value={f.payee_name || ''} onChange={set('payee_name')} disabled={!!f.supplier_id} /></Field>
      <Field label="Expense category" required><Select value={f.account_id} onChange={set('account_id')} placeholder="Choose category…" options={accountOptions(accounts, ['EXPENSE', 'COST_OF_SALES', 'ASSET'])} /></Field>
      <Field label="Amount (K)" required hint={f.tax_rate_id ? (f.amount_includes_tax ? 'Total including VAT' : 'Amount before VAT') : null}><MoneyInput value={f.amount} onChange={set('amount')} /></Field>
      <Field label="Tax"><div className="stack-sm"><Select value={f.tax_rate_id || ''} onChange={set('tax_rate_id')} placeholder="No tax" options={taxOptions(rates, 'PURCHASES')} />{f.tax_rate_id && <Check label="Amount includes VAT" checked={f.amount_includes_tax} onChange={set('amount_includes_tax')} />}</div></Field>
      <Field label="Paid from" required><Select value={f.payment_account_id} onChange={set('payment_account_id')} options={bankOptions(banks)} /></Field>
      <Field label="Payment method"><Select value={f.payment_method} onChange={set('payment_method')} options={METHODS} /></Field>
      <Field label="Reference"><Input value={f.reference || ''} onChange={set('reference')} placeholder="Receipt number" /></Field>
      {me.settings?.features?.branches && <Field label="Branch"><Select value={f.branch_id || ''} onChange={set('branch_id')} placeholder="—" options={branches.map((b) => ({ value: b.id, label: b.name }))} /></Field>}
      {me.settings?.features?.departments && <Field label="Department"><Select value={f.department_id || ''} onChange={set('department_id')} placeholder="—" options={departments.map((b) => ({ value: b.id, label: b.name }))} /></Field>}
      <Field label="Description" span={3}><TextArea value={f.description || ''} onChange={set('description')} /></Field>
      {!initial && <Field label="Receipt" hint="PDF, JPG or PNG"><input type="file" accept="image/png,image/jpeg,image/webp,application/pdf" onChange={(e) => setFile(e.target.files[0] || null)} /></Field>}
    </div></Card>
    {thr && <p className="t-small">Expenses above {fmtK(thr)}, above your role's limit, or recorded by users without approval rights are sent for approval before posting.</p>}
    <div className="form-actions"><Button onClick={() => nav(-1)}>Cancel</Button><Button busy={busy} onClick={() => save('draft')}>Save draft</Button><Button variant="primary" busy={busy} disabled={!f.account_id || !f.amount || !f.payment_account_id} onClick={() => save('submit')}>Save & post</Button></div>
  </div>;
}

function Scan() {
  const nav = useNavigate(); const [run, busy] = useAction();
  const [drag, setDrag] = useState(false); const [res, setRes] = useState(null);
  const input = useRef(null);
  const go = async (file) => { const r = await run(() => api.upload('/ai/extract', file), (x) => (x.draft ? `Draft ${x.draft.number} created for approval.` : 'Document read.')); if (r) setRes(r); };
  return <div className="stack">
    <PageHeader back="/expenses" title="Scan a receipt or invoice" subtitle="The AI bookkeeper reads the document and prepares a DRAFT for you to check and approve. Nothing is posted automatically." />
    <Card><div className={`dropzone ${drag ? 'drag' : ''}`} onClick={() => input.current?.click()} onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
      onDrop={(e) => { e.preventDefault(); setDrag(false); if (e.dataTransfer.files[0]) go(e.dataTransfer.files[0]); }} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && input.current?.click()}>
      <Icon name="upload" size={28} /><p><strong>{busy ? 'Reading document…' : 'Drop a photo or PDF here, or click to choose'}</strong></p><p className="t-small">Receipts, supplier invoices, fuel slips — JPG, PNG or PDF up to 15 MB</p>
      <input ref={input} type="file" hidden accept="image/png,image/jpeg,image/webp,application/pdf" onChange={(e) => e.target.files[0] && go(e.target.files[0])} /></div></Card>
    {res && <Card title="What I found">
      {res.message && <Alert tone="warning">{res.message}</Alert>}
      <dl className="dl">{[['Vendor', res.extraction.vendor], ['Matched supplier', res.extraction.matched_supplier], ['Date', fmtDate(res.extraction.date)], ['Invoice / receipt no.', res.extraction.invoice_number], ['Total', res.extraction.total && fmtK(res.extraction.total)],
        ['Tax', res.extraction.tax && fmtK(res.extraction.tax)], ['Suggested account', res.extraction.suggested_account], ['Payment method', res.extraction.payment_method], ['Confidence', res.extraction.confidence != null ? `${res.extraction.confidence}%` : null], ['Read by', res.extraction.engine === 'claude' ? 'Claude AI' : 'On-server OCR']]
        .filter(([, v]) => v).map(([k, v]) => <Fragment key={k}><dt>{k}</dt><dd>{v}</dd></Fragment>)}</dl>
      {res.draft && <div className="alert alert-warning" style={{ marginTop: 16 }}><div><strong>{res.draft.status}.</strong> {res.draft.type === 'expense' ? 'Expense' : 'Bill'} {res.draft.number} for {fmtK(res.draft.total)} is waiting for review. <Link to={res.draft.link}>Review & approve →</Link></div></div>}
      <div className="form-actions"><Button onClick={() => setRes(null)}>Scan another</Button>{res.draft && <Button variant="primary" onClick={() => nav(res.draft.link)}>Open draft</Button>}</div>
    </Card>}
  </div>;
}

function View() {
  const { id } = useParams(); const { can, me } = useSession(); const { confirm } = useToast();
  const state = useApi(`/expenses/${id}`); const [run, busy] = useAction(); const [edit, setEdit] = useState(false);
  return <Loadable state={state}>{(e) => edit ? <div className="stack"><PageHeader title={`Edit ${e.number}`} /><ExpenseForm initial={e} /></div> : <div className="stack">
    <PageHeader back="/expenses" title={<span className="row-gap">Expense {e.number} <StatusBadge status={e.status} />{e.ai_generated && <Badge tone="accent">AI draft</Badge>}</span>} subtitle={e.supplier_name || e.payee_name}
      actions={<>
        {['DRAFT', 'PENDING_APPROVAL'].includes(e.status) && can('create_expense') && <Button size="sm" onClick={() => setEdit(true)}>Edit</Button>}
        {e.status === 'DRAFT' && can('create_expense') && <Button size="sm" busy={busy} onClick={async () => { if (await run(() => api.post(`/expenses/${e.id}/submit`), (x) => (x.status === 'POSTED' ? 'Posted.' : 'Sent for approval.'))) state.reload(); }}>Submit</Button>}
        {['DRAFT', 'PENDING_APPROVAL'].includes(e.status) && can('approve_expense') && <Button size="sm" variant="primary" busy={busy} onClick={async () => { if (await confirm({ title: `Approve ${e.number}?`, message: `${fmtK(e.total)} will be posted: Dr ${e.account_name}, Cr ${e.payment_account_name}.`, confirmLabel: 'Approve & post' }) && await run(() => api.post(`/expenses/${e.id}/approve`), 'Expense approved and posted.')) state.reload(); }}>Approve & post</Button>}
        {e.status !== 'VOID' && (can('approve_expense') || e.status !== 'POSTED') && <Button size="sm" variant="danger" onClick={async () => { const reason = await confirm({ title: `${e.status === 'POSTED' ? 'Void' : 'Reject'} ${e.number}?`, message: e.status === 'POSTED' ? 'The journal is reversed.' : 'The draft is discarded (kept in the audit trail).', danger: true, input: true, inputLabel: 'Reason', confirmLabel: e.status === 'POSTED' ? 'Void' : 'Reject' }); if (reason && await run(() => api.post(`/expenses/${e.id}/void`, { reason }), 'Done.')) state.reload(); }}>{e.status === 'POSTED' ? 'Void' : 'Reject'}</Button>}
      </>} />
    {e.ai_generated && e.status !== 'POSTED' && <Alert tone="warning" title="Prepared by the AI assistant.">Check the category, amount and tax against the attached receipt before approving{e.ai_confidence ? ` (confidence ${Number(e.ai_confidence)}%)` : ''}.</Alert>}
    {e.status === 'PENDING_APPROVAL' && <Alert tone="warning" title="Pending approval.">{Number(e.total) > Number(me.settings?.accounting?.expense_approval_threshold || 0) ? `Above the ${fmtK(me.settings.accounting.expense_approval_threshold)} approval threshold.` : 'Requires an approver.'}</Alert>}
    <div className="grid grid-2">
      <Card title="Details"><dl className="dl"><dt>Date</dt><dd>{fmtDate(e.expense_date)}</dd><dt>Category</dt><dd>{e.account_code} {e.account_name}</dd><dt>Paid from</dt><dd>{e.payment_account_name} · {e.payment_method.replace('_', ' ').toLowerCase()}</dd>
        <dt>Net</dt><dd><Money value={e.amount} /></dd><dt>Tax</dt><dd><Money value={e.tax_amount} /> {e.tax_code}</dd><dt>Total</dt><dd><strong><Money value={e.total} /></strong></dd>
        <dt>Reference</dt><dd>{e.reference || '—'}</dd><dt>Description</dt><dd>{e.description || '—'}</dd>{e.branch_name && <><dt>Branch</dt><dd>{e.branch_name}</dd></>}{e.department_name && <><dt>Department</dt><dd>{e.department_name}</dd></>}
        <dt>Recorded by</dt><dd>{e.created_by_name}</dd>{e.approved_by_name && <><dt>Approved by</dt><dd>{e.approved_by_name}</dd></>}{e.journal_number && <><dt>Journal</dt><dd><Link to={`/journals/${e.journal_entry_id}`}>{e.journal_number}</Link></dd></>}</dl></Card>
      <Card title="Proposed entry"><div className="entry"><div className="entry-row head"><span>Account</span><span className="num">Debit</span><span className="num">Credit</span></div>
        <div className="entry-row"><span>{e.account_code} {e.account_name}</span><span className="num">{fmtK(e.amount)}</span><span /></div>
        {Number(e.tax_amount) > 0 && <div className="entry-row"><span>VAT Input (Recoverable)</span><span className="num">{fmtK(e.tax_amount)}</span><span /></div>}
        <div className="entry-row"><span>{e.payment_account_name}</span><span /><span className="num">{fmtK(e.total)}</span></div></div>
        <p className="t-small">{e.status === 'POSTED' ? 'Posted to the ledger.' : 'Not posted yet.'}</p></Card>
    </div>
    <Attachments linkedType="expense" linkedId={e.id} initial={e.documents} />
  </div>}</Loadable>;
}

export default function Expenses() {
  return <Routes><Route index element={<List />} /><Route path="new" element={<div className="stack"><PageHeader back="/expenses" title="New expense" /><ExpenseForm /></div>} /><Route path="scan" element={<Scan />} /><Route path=":id" element={<View />} /></Routes>;
}
