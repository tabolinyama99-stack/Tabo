import { useState } from 'react';
import { Routes, Route, useParams, Link, useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useSession } from '../lib/session.jsx';
import { fmtK } from '../lib/format.js';
import { PageHeader, Card, useApi, Loadable, Button, Modal, Field, Input, TextArea, MoneyInput, Kpi, Check, Select, useAction, LinkButton } from '../components/ui.jsx';
import { DataTable } from '../components/DataTable.jsx';
import { invalidate, useLookup, accountOptions } from '../components/lookups.js';

function PartyForm({ kind, initial, onClose, onSaved }) {
  const isC = kind === 'customers';
  const accounts = useLookup('/accounts');
  const [f, setF] = useState(initial || { name: '', code: '', contact_person: '', email: '', phone: '', address: '', tpin: '', payment_terms_days: 30, credit_limit: '', bank_details: '', default_account_id: '', notes: '', is_active: true });
  const [run, busy] = useAction();
  const set = (k) => (e) => setF({ ...f, [k]: e?.target ? e.target.value : e });
  const save = async () => {
    const body = { ...f, payment_terms_days: Number(f.payment_terms_days) || 0 };
    if (isC) { delete body.bank_details; delete body.default_account_id; } else delete body.credit_limit;
    const r = await run(() => (initial ? api.put(`/${kind}/${initial.id}`, body) : api.post(`/${kind}`, body)), 'Saved.');
    if (r) { invalidate(`/${kind}`); onSaved(r); }
  };
  return <Modal wide title={initial ? `Edit ${initial.name}` : `New ${isC ? 'customer' : 'supplier'}`} onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" busy={busy} disabled={!f.name?.trim()} onClick={save}>Save</Button></>}>
    <div className="form-grid">
      <Field label="Name" required><Input value={f.name} onChange={set('name')} /></Field>
      <Field label="Code" hint="Leave blank to number automatically."><Input value={f.code || ''} onChange={set('code')} /></Field>
      <Field label="Contact person"><Input value={f.contact_person || ''} onChange={set('contact_person')} /></Field>
      <Field label="Email"><Input type="email" value={f.email || ''} onChange={set('email')} /></Field>
      <Field label="Phone"><Input value={f.phone || ''} onChange={set('phone')} /></Field>
      <Field label="TPIN"><Input value={f.tpin || ''} onChange={set('tpin')} /></Field>
      <Field label="Address" span={2}><TextArea value={f.address || ''} onChange={set('address')} /></Field>
      <Field label="Payment terms (days)"><Input type="number" min="0" value={f.payment_terms_days} onChange={set('payment_terms_days')} /></Field>
      {isC ? <Field label="Credit limit (K)"><MoneyInput value={f.credit_limit || ''} onChange={set('credit_limit')} /></Field>
        : <><Field label="Default expense account"><Select value={f.default_account_id || ''} onChange={set('default_account_id')} placeholder="—" options={accountOptions(accounts, ['EXPENSE', 'COST_OF_SALES', 'ASSET'])} /></Field>
          <Field label="Bank details" span={2}><Input value={f.bank_details || ''} onChange={set('bank_details')} /></Field></>}
      <Field label="Notes" span={2}><TextArea value={f.notes || ''} onChange={set('notes')} /></Field>
      <Check label="Active" checked={f.is_active} onChange={(v) => setF({ ...f, is_active: v })} />
    </div>
  </Modal>;
}

function List({ kind }) {
  const isC = kind === 'customers';
  const { can, term } = useSession();
  const [all, setAll] = useState(false);
  const state = useApi(`/${kind}${all ? '?active=all' : ''}`);
  const [form, setForm] = useState(false);
  const nav = useNavigate();
  const base = isC ? '/sales/customers' : '/purchases/suppliers';
  return <div className="stack">
    <PageHeader title={term(isC ? 'customers' : 'suppliers')} subtitle={`Balances are calculated from the ledger (${isC ? 'Accounts Receivable' : 'Accounts Payable'})`}
      actions={<>{can('view_reports') && <LinkButton to={`/performance?kind=${kind}`}>Performance</LinkButton>}{can(isC ? 'manage_customers' : 'manage_suppliers') && <Button variant="primary" icon="plus" onClick={() => setForm(true)}>New {isC ? 'customer' : 'supplier'}</Button>}</>} />
    <Card pad={false}><Loadable state={state}>{(rows) => <DataTable rows={rows} rowLink={(r) => `${base}/${r.id}`} toolbar={<Check label="Show inactive" checked={all} onChange={setAll} />}
      columns={[{ key: 'code', label: 'Code' }, { key: 'name', label: 'Name' }, { key: 'email', label: 'Email' }, { key: 'phone', label: 'Phone' }, { key: 'payment_terms_days', label: 'Terms', type: 'number', render: (v) => `${v} days` },
        { key: 'is_active', label: 'Status', render: (v) => (v ? 'Active' : 'Inactive') }, { key: 'balance', label: isC ? 'Owes you' : 'You owe', type: 'money' }]} />}</Loadable></Card>
    {form && <PartyForm kind={kind} onClose={() => setForm(false)} onSaved={(r) => { setForm(false); nav(`${base}/${r.id}`); }} />}
  </div>;
}

function Detail({ kind }) {
  const isC = kind === 'customers';
  const { id } = useParams();
  const { can } = useSession();
  const state = useApi(`/${kind}/${id}`);
  const [edit, setEdit] = useState(false);
  const base = isC ? '/sales' : '/purchases';
  return <Loadable state={state}>{(p) => <div className="stack">
    <PageHeader back={isC ? '/sales/customers' : '/purchases/suppliers'} title={p.name} subtitle={[p.code, p.email, p.phone, p.tpin && `TPIN ${p.tpin}`].filter(Boolean).join(' · ')}
      actions={<>
        {can('view_reports') && <LinkButton to={`/reports/${isC ? 'customer' : 'supplier'}-statement?${isC ? 'customer' : 'supplier'}_id=${p.id}`} icon="doc">Statement</LinkButton>}
        {can(isC ? 'create_invoice' : 'create_purchase') && <LinkButton to={`${base}/documents/new?type=${isC ? 'INVOICE' : 'BILL'}`} icon="plus">New {isC ? 'invoice' : 'bill'}</LinkButton>}
        {can('create_payment') && <LinkButton variant="primary" to={`/payments/new?direction=${isC ? 'IN' : 'OUT'}&party_id=${p.id}`}>{isC ? 'Receive payment' : 'Make payment'}</LinkButton>}
        {can(isC ? 'manage_customers' : 'manage_suppliers') && <Button onClick={() => setEdit(true)}>Edit</Button>}</>} />
    <div className="kpis">
      <Kpi label={isC ? 'Balance owed to you' : 'Balance you owe'} value={p.balance} hint="From the ledger" />
      <Kpi label={isC ? 'Total invoiced' : 'Total billed'} value={p.stats.total_billed} />
      <Kpi label="Total paid" value={p.stats.total_paid} />
      <Kpi label="Overdue" value={p.stats.overdue} />
      <Kpi label="Avg. days to pay" value={p.stats.avg_days_to_pay != null ? `${p.stats.avg_days_to_pay} days` : '—'} money={false} />
      {isC && p.credit_limit && <Kpi label="Credit limit" value={p.credit_limit} hint={Number(p.balance) > Number(p.credit_limit) ? 'Over limit' : `${fmtK((Number(p.credit_limit) - Number(p.balance)).toFixed(2))} available`} />}
    </div>
    <div className="grid grid-2">
      <Card title="Documents" pad={false}><DataTable rows={p.documents} rowLink={(r) => `${base}/documents/${r.id}`} pageSize={10}
        columns={[{ key: 'number', label: 'Number' }, { key: 'doc_type', label: 'Type', render: (v) => v.replace('_', ' ').toLowerCase() }, { key: 'doc_date', label: 'Date', type: 'date' }, { key: 'status', label: 'Status', type: 'status' }, { key: 'total', label: 'Total', type: 'money' }, { key: 'balance_due', label: 'Balance', type: 'money' }]} /></Card>
      <Card title="Payments" pad={false}><DataTable rows={p.payments} rowLink={(r) => `/payments/${r.id}`} pageSize={10}
        columns={[{ key: 'number', label: 'Number' }, { key: 'payment_date', label: 'Date', type: 'date' }, { key: 'method', label: 'Method' }, { key: 'status', label: 'Status', type: 'status' }, { key: 'amount', label: 'Amount', type: 'money' }]} /></Card>
    </div>
    {p.address && <Card title="Address & notes"><p style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{p.address}</p>{p.notes && <p className="muted">{p.notes}</p>}{p.bank_details && <p className="t-small">Bank: {p.bank_details}</p>}</Card>}
    {edit && <PartyForm kind={kind} initial={p} onClose={() => setEdit(false)} onSaved={() => { setEdit(false); state.reload(); }} />}
  </div>}</Loadable>;
}

export default function Parties({ kind }) {
  return <Routes><Route index element={<List kind={kind} />} /><Route path=":id" element={<Detail kind={kind} />} /></Routes>;
}
export { Link };
