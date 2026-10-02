import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { api, download } from '../lib/api.js';
import { useSession } from '../lib/session.jsx';
import { fmtK, fmtDate, fmtDateTime, titleCase } from '../lib/format.js';
import { PageHeader, Card, useApi, Loadable, Button, Badge, StatusBadge, useAction, useToast, Tabs, Empty, Select } from '../components/ui.jsx';
import { DataTable } from '../components/DataTable.jsx';

function Approvals() {
  const { can } = useSession(); const { confirm } = useToast();
  const state = useApi('/approvals'); const [run, busy] = useAction();
  const approve = async (kind, row) => {
    const urls = { journal: `/journals/${row.id}/approve`, expense: `/expenses/${row.id}/approve`, bill: `/purchases/documents/${row.id}/post`, invoice: `/sales/documents/${row.id}/post` };
    if (!(await confirm({ title: `Approve ${row.number}?`, message: `${fmtK(row.total)} will be posted to the ledger.`, confirmLabel: 'Approve & post' }))) return;
    if (await run(() => api.post(urls[kind]), `${row.number} approved and posted.`)) state.reload();
  };
  const reject = async (kind, row) => {
    const reason = await confirm({ title: `Reject ${row.number}?`, message: kind === 'journal' ? 'It returns to draft for the creator.' : 'The draft is discarded (kept in the audit trail).', input: true, inputLabel: 'Reason', danger: true, confirmLabel: 'Reject' });
    if (!reason) return;
    const urls = { journal: [`/journals/${row.id}/reject`, { reason }], expense: [`/expenses/${row.id}/void`, { reason }], bill: [`/purchases/documents/${row.id}/cancel`, { reason }], invoice: [`/sales/documents/${row.id}/cancel`, { reason }] };
    if (await run(() => api.post(...urls[kind]), 'Rejected.')) state.reload();
  };
  const section = (kind, title, rows, link, perm) => rows.length > 0 && <Card key={kind} title={`${title} (${rows.length})`} pad={false}><DataTable searchable={false} rows={rows} rowLink={link}
    columns={[{ key: 'number', label: 'Number', render: (v, r) => <span className="row-gap">{v}{r.ai_generated && <Badge tone="accent">AI draft</Badge>}</span> }, { key: 'date', label: 'Date', type: 'date' }, { key: 'description', label: 'Description' }, { key: 'created_by', label: 'Created by' }, { key: 'status', label: 'Status', type: 'status' }, { key: 'total', label: 'Amount', type: 'money' },
      { key: 'actions', label: '', sortable: false, render: (_, r) => can(perm) && <div className="row-gap" onClick={(e) => e.stopPropagation()}><Button size="sm" variant="primary" busy={busy} onClick={() => approve(kind, r)}>Approve</Button><Button size="sm" onClick={() => reject(kind, r)}>Reject</Button></div> }]} /></Card>;
  return <div className="stack"><PageHeader title="Approvals" subtitle="Transactions waiting for an authorised user, including drafts prepared by the AI assistant. Open an item to review its full detail first." />
    <Loadable state={state}>{(d) => { const n = d.journals.length + d.expenses.length + d.bills.length + d.invoices.length; return n === 0 ? <Card><Empty title="Nothing waiting for approval">New drafts and items above approval thresholds will appear here.</Empty></Card> : <>
      {section('expense', 'Expenses', d.expenses, (r) => `/expenses/${r.id}`, 'approve_expense')}
      {section('journal', 'Journals', d.journals, (r) => `/journals/${r.id}`, 'approve_transactions')}
      {section('bill', 'Supplier bills', d.bills, (r) => `/purchases/documents/${r.id}`, 'approve_purchase')}
      {section('invoice', 'Draft invoices', d.invoices, (r) => `/sales/documents/${r.id}`, 'approve_invoice')}</>; }}</Loadable></div>;
}

const LINK = { expense: (id) => `/expenses/${id}`, sales_document: (id) => `/sales/documents/${id}`, purchase_document: (id) => `/purchases/documents/${id}`, journal_entry: (id) => `/journals/${id}`, payment: (id) => `/payments/${id}`, account: (id) => `/reports/general-ledger?account_id=${id}` };
function Review() {
  const [status, setStatus] = useState('OPEN');
  const state = useApi(`/review-flags?status=${status}`); const { confirm } = useToast(); const [run, busy] = useAction();
  const act = async (f, action) => { const note = await confirm({ title: action === 'resolve' ? 'Mark as reviewed' : 'Dismiss flag', message: f.message, input: true, inputLabel: 'Outcome of your review', confirmLabel: action === 'resolve' ? 'Mark reviewed' : 'Dismiss' }); if (note && await run(() => api.post(`/review-flags/${f.id}/${action}`, { note }), 'Updated.')) state.reload(); };
  return <div className="stack"><PageHeader title="Review queue" subtitle="Items flagged by AI-assisted anomaly detection. A flag means 'please check', not that anything is wrong."
    actions={<Button busy={busy} icon="refresh" onClick={async () => { if (await run(() => api.post('/review-flags/scan'), (x) => `${x.created} new item(s) flagged.`)) state.reload(); }}>Run scan now</Button>} />
    <Tabs tabs={[{ value: 'OPEN', label: 'Open' }, { value: 'RESOLVED', label: 'Reviewed' }, { value: 'DISMISSED', label: 'Dismissed' }]} value={status} onChange={setStatus} />
    <Card pad={false}><Loadable state={state}>{(rows) => <DataTable rows={rows} rowLink={(f) => LINK[f.entity_type]?.(f.entity_id)}
      columns={[{ key: 'severity', label: 'Priority', type: 'status' }, { key: 'kind', label: 'Type', render: (v) => titleCase(v.replace(/_\d{4}-\d{2}$/, '')) }, { key: 'message', label: 'What to check' }, { key: 'created_at', label: 'Flagged', type: 'datetime' },
        ...(status === 'OPEN' ? [{ key: 'a', label: '', sortable: false, render: (_, f) => <div className="row-gap" onClick={(e) => e.stopPropagation()}><Button size="sm" onClick={() => act(f, 'resolve')}>Reviewed</Button><Button size="sm" variant="ghost" onClick={() => act(f, 'dismiss')}>Dismiss</Button></div> }]
          : [{ key: 'resolved_by_name', label: 'By' }, { key: 'resolution_note', label: 'Note' }])]} empty={{ title: 'Nothing to review', text: 'Run a scan, or check back later.' }} />}</Loadable></Card></div>;
}

function Documents() {
  const [cat, setCat] = useState('');
  const state = useApi(`/documents${cat ? `?category=${cat}` : ''}`); const [run] = useAction();
  const link = (d) => (d.linked_type ? LINK[d.linked_type]?.(d.linked_id) : null);
  return <div className="stack"><PageHeader title="Documents" subtitle="Receipts, invoices and statements attached to transactions" />
    <Card pad={false}><Loadable state={state}>{(rows) => <DataTable rows={rows} toolbar={<Select value={cat} onChange={setCat} placeholder="All categories" options={['receipt', 'general', 'bank_statement'].map((c) => ({ value: c, label: titleCase(c) }))} aria-label="Category" />}
      columns={[{ key: 'original_name', label: 'File', render: (v, d) => <button className="linkish" onClick={() => run(() => download(`/documents/${d.id}/file`, { open: true }))}>{v}</button> }, { key: 'category', label: 'Category', render: titleCase },
        { key: 'linked_type', label: 'Attached to', render: (v, d) => (v ? <Link to={link(d) || '#'}>{titleCase(v)} #{d.linked_id}</Link> : <span className="faint">Not attached</span>) }, { key: 'has_extraction', label: 'AI read', render: (v) => (v ? <Badge tone="accent">Yes</Badge> : '') },
        { key: 'uploaded_by', label: 'Uploaded by' }, { key: 'created_at', label: 'Uploaded', type: 'datetime' }, { key: 'size_bytes', label: 'Size', type: 'number', render: (v) => `${Math.round(v / 1024)} KB` }]} />}</Loadable></Card></div>;
}

export default function Work() {
  const loc = useLocation();
  if (loc.pathname === '/review') return <Review />;
  if (loc.pathname === '/documents') return <Documents />;
  return <Approvals />;
}
export { fmtDate, fmtDateTime, StatusBadge };
