import { Routes, Route, useParams, useSearchParams, Link } from 'react-router-dom';
import { useState } from 'react';
import { useSession } from '../lib/session.jsx';
import { qs } from '../lib/api.js';
import { DOC_LABEL, fmtK } from '../lib/format.js';
import { PageHeader, Card, useApi, Loadable, Select, Field, DateInput, LinkButton, Tabs } from '../components/ui.jsx';
import { DataTable } from '../components/DataTable.jsx';
import { DocumentForm } from '../components/DocumentForm.jsx';
import { DocumentView } from '../components/DocumentView.jsx';
import Parties from './Parties.jsx';

export function DocList({ side, types, title, subtitle, newType, newLabel, statuses }) {
  const isSales = side === 'sales';
  const { can } = useSession();
  const [sp] = useSearchParams();
  const [tab, setTab] = useState(types[0]);
  const [status, setStatus] = useState(sp.get('status') || '');
  const [range, setRange] = useState({ from: '', to: '' });
  const typeFilter = types.length > 1 ? tab : types[0];
  const state = useApi(`/${isSales ? 'sales' : 'purchases'}/documents${qs({ type: typeFilter, status, ...range, limit: 500 })}`);
  const createPerm = isSales ? { INVOICE: 'create_invoice', QUOTE: 'create_quote', ORDER: 'create_quote', CREDIT_NOTE: 'create_credit_note' } : { BILL: 'create_purchase', PO: 'create_purchase', DEBIT_NOTE: 'create_purchase' };
  const nt = types.length > 1 ? tab : newType;
  return <div className="stack">
    <PageHeader title={title} subtitle={subtitle} actions={nt && can(createPerm[nt]) && <LinkButton to={`/${side}/documents/new?type=${nt}`} variant="primary" icon="plus">{newLabel || `New ${DOC_LABEL[nt].toLowerCase()}`}</LinkButton>} />
    {types.length > 1 && <Tabs tabs={types.map((t) => ({ value: t, label: `${DOC_LABEL[t]}s` }))} value={tab} onChange={setTab} />}
    <Card pad={false}>
      <Loadable state={state}>{(d) => <DataTable rows={d.items} rowLink={(r) => `/${side}/documents/${r.id}`} initialSort={{ key: 'doc_date', dir: 'desc' }}
        toolbar={<div className="row-gap wrap" style={{ marginLeft: 'auto' }}>
          <Select value={status} onChange={setStatus} placeholder="All statuses" options={statuses.map((s) => ({ value: s, label: s.replace('_', ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase()) }))} aria-label="Status filter" />
          <DateInput value={range.from} onChange={(v) => setRange({ ...range, from: v })} aria-label="From date" /><DateInput value={range.to} onChange={(v) => setRange({ ...range, to: v })} aria-label="To date" />
          <span className="t-small">Total {fmtK(d.sum_total)} · Outstanding {fmtK(d.sum_balance)}</span></div>}
        columns={[{ key: 'number', label: 'Number' }, { key: isSales ? 'customer_name' : 'supplier_name', label: isSales ? 'Customer' : 'Supplier' }, ...(isSales ? [] : [{ key: 'supplier_reference', label: 'Supplier ref' }]),
          { key: 'doc_date', label: 'Date', type: 'date' }, { key: 'due_date', label: 'Due', type: 'date' }, { key: 'status', label: 'Status', type: 'status' },
          { key: 'total', label: 'Total', type: 'money' }, { key: 'balance_due', label: 'Balance', type: 'money' }]}
        empty={{ title: 'No documents yet', text: 'Create your first one with the button above.' }} />}</Loadable>
    </Card>
  </div>;
}

function NewDoc({ side }) {
  const [sp] = useSearchParams();
  const type = sp.get('type') || (side === 'sales' ? 'INVOICE' : 'BILL');
  return <div className="stack"><PageHeader title={`New ${DOC_LABEL[type].toLowerCase()}`} back={-1} /><DocumentForm side={side} docType={type} /></div>;
}
function EditDoc({ side }) {
  const { id } = useParams();
  const s = useApi(`/${side === 'sales' ? 'sales' : 'purchases'}/documents/${id}`);
  return <Loadable state={s}>{(d) => <div className="stack"><PageHeader title={`Edit ${DOC_LABEL[d.doc_type].toLowerCase()} ${d.number}`} back={`/${side}/documents/${d.id}`} /><DocumentForm side={side} docType={d.doc_type} initial={d} /></div>}</Loadable>;
}
function ViewDoc({ side }) {
  const { id } = useParams();
  const s = useApi(`/${side === 'sales' ? 'sales' : 'purchases'}/documents/${id}`);
  return <Loadable state={s}>{(d) => <DocumentView side={side} doc={d} reload={s.reload} />}</Loadable>;
}
export { NewDoc, EditDoc, ViewDoc };

export default function Sales() {
  const { term } = useSession();
  return <Routes>
    <Route path="invoices" element={<DocList side="sales" types={['INVOICE']} newType="INVOICE" title={`${term('invoice')}s`} subtitle="Customer invoices, payments and balances" statuses={['DRAFT', 'SENT', 'PARTIALLY_PAID', 'OVERDUE', 'PAID', 'CANCELLED']} />} />
    <Route path="quotes" element={<DocList side="sales" types={['QUOTE', 'ORDER']} title="Quotations & sales orders" statuses={['DRAFT', 'SENT', 'ACCEPTED', 'DECLINED', 'CONVERTED', 'OPEN', 'INVOICED', 'CANCELLED']} />} />
    <Route path="credit-notes" element={<DocList side="sales" types={['CREDIT_NOTE']} newType="CREDIT_NOTE" title="Credit notes" subtitle="Tip: open a posted invoice and choose Credit note to credit it directly." statuses={['DRAFT', 'POSTED', 'APPLIED', 'CANCELLED']} />} />
    <Route path="customers/*" element={<Parties kind="customers" />} />
    <Route path="documents/new" element={<NewDoc side="sales" />} />
    <Route path="documents/:id/edit" element={<EditDoc side="sales" />} />
    <Route path="documents/:id" element={<ViewDoc side="sales" />} />
    <Route path="*" element={<DocList side="sales" types={['INVOICE']} newType="INVOICE" title="Invoices" statuses={['DRAFT', 'SENT', 'PARTIALLY_PAID', 'OVERDUE', 'PAID', 'CANCELLED']} />} />
  </Routes>;
}
export { Link };
