// Read view for a sales or purchase document with its actions.
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, download } from '../lib/api.js';
import { useSession } from '../lib/session.jsx';
import { fmtK, fmtDate, DOC_LABEL } from '../lib/format.js';
import { Button, Card, StatusBadge, Money, PageHeader, Alert, Modal, Field, Input, Select, TextArea, useToast, useAction, Badge } from './ui.jsx';
import { DataTable } from './DataTable.jsx';
import { Attachments } from './Attachments.jsx';

export function DocumentView({ side, doc, reload }) {
  const isSales = side === 'sales';
  const { can } = useSession();
  const nav = useNavigate(); const { confirm } = useToast();
  const [run, busy] = useAction();
  const [emailOpen, setEmailOpen] = useState(false);
  const [applyOpen, setApplyOpen] = useState(false);
  const base = isSales ? '/sales/documents' : '/purchases/documents';
  const t = DOC_LABEL[doc.doc_type];
  const party = isSales ? doc.customer_name : doc.supplier_name;
  const status = doc.effective_status || doc.status;
  const isDraft = ['DRAFT', 'PENDING_APPROVAL'].includes(doc.status);
  const posted = !isDraft && doc.status !== 'CANCELLED';

  const post = async () => {
    if (!(await confirm({ title: `Approve & post ${t.toLowerCase()} ${doc.number}?`, message: `${fmtK(doc.total)} will be posted to the ledger. This cannot be edited afterwards.`, confirmLabel: 'Approve & post' }))) return;
    const r = await run(() => api.post(`${base}/${doc.id}/post`), `${t} posted to the ledger.`); if (r) reload();
  };
  const cancel = async () => {
    const reason = await confirm({ title: `Cancel ${doc.number}?`, message: posted ? 'The journal will be reversed and the document marked cancelled. This is recorded in the audit trail.' : 'The draft will be cancelled.', confirmLabel: `Cancel ${t.toLowerCase()}`, danger: true, input: posted, inputLabel: 'Reason' });
    if (!reason) return;
    const r = await run(() => api.post(`${base}/${doc.id}/cancel`, { reason: typeof reason === 'string' ? reason : undefined }), `${t} cancelled.`); if (r) reload();
  };
  const convert = async (to) => { const r = await run(() => api.post(`${base}/${doc.id}/convert`, { to }), (x) => `${DOC_LABEL[to]} ${x.number} created as a draft.`); if (r) nav(`/${side}/documents/${r.id}`); };
  const setStatus = async (s) => { const r = await run(() => api.post(`${base}/${doc.id}/status`, { status: s }), 'Status updated.'); if (r) reload(); };

  const actions = <>
    <Button size="sm" icon="eye" onClick={() => run(() => download(`${base}/${doc.id}/pdf`, { open: true }))}>PDF</Button>
    <Button size="sm" icon="download" onClick={() => run(() => download(`${base}/${doc.id}/pdf?download=1`))}>Download</Button>
    {can('send_documents') && (posted || doc.doc_type === 'QUOTE' || doc.doc_type === 'PO') && <Button size="sm" icon="send" onClick={() => setEmailOpen(true)}>Email</Button>}
    {isDraft && can(isSales ? (doc.doc_type === 'INVOICE' ? 'edit_invoice' : 'create_quote') : 'edit_purchase') && <Link className="btn btn-sm" to={`/${side}/documents/${doc.id}/edit`}>Edit</Link>}
    {isDraft && ['INVOICE', 'CREDIT_NOTE'].includes(doc.doc_type) && can('approve_invoice', 'create_credit_note') && <Button size="sm" variant="primary" busy={busy} onClick={post}>Approve & post</Button>}
    {isDraft && ['BILL', 'DEBIT_NOTE'].includes(doc.doc_type) && can('approve_purchase') && <Button size="sm" variant="primary" busy={busy} onClick={post}>Approve & post</Button>}
    {doc.doc_type === 'INVOICE' && ['SENT', 'PARTIALLY_PAID'].includes(doc.status) && can('create_payment') && <Link className="btn btn-sm btn-primary" to={`/payments/new?direction=IN&party_id=${doc.customer_id}&doc=${doc.id}`}>Record payment</Link>}
    {doc.doc_type === 'BILL' && ['POSTED', 'PARTIALLY_PAID'].includes(doc.status) && can('create_payment') && <Link className="btn btn-sm btn-primary" to={`/payments/new?direction=OUT&party_id=${doc.supplier_id}&doc=${doc.id}`}>Pay bill</Link>}
    {doc.doc_type === 'QUOTE' && !['CONVERTED', 'CANCELLED', 'DECLINED'].includes(doc.status) && can('create_quote') && <><Button size="sm" onClick={() => setStatus('ACCEPTED')}>Mark accepted</Button><Button size="sm" onClick={() => setStatus('DECLINED')}>Declined</Button><Button size="sm" onClick={() => convert('ORDER')}>Convert to order</Button></>}
    {['QUOTE', 'ORDER'].includes(doc.doc_type) && !['CONVERTED', 'INVOICED', 'CANCELLED'].includes(doc.status) && can('create_invoice') && <Button size="sm" variant="primary" onClick={() => convert('INVOICE')}>Convert to invoice</Button>}
    {doc.doc_type === 'PO' && !['BILLED', 'CANCELLED'].includes(doc.status) && can('create_purchase') && <Button size="sm" variant="primary" onClick={() => convert('BILL')}>Convert to bill</Button>}
    {doc.doc_type === 'INVOICE' && posted && can('create_credit_note') && <Button size="sm" onClick={() => convert('CREDIT_NOTE')}>Credit note</Button>}
    {doc.doc_type === 'BILL' && posted && can('create_purchase') && <Button size="sm" onClick={() => convert('DEBIT_NOTE')}>Debit note</Button>}
    {['CREDIT_NOTE', 'DEBIT_NOTE'].includes(doc.doc_type) && doc.status === 'POSTED' && can(isSales ? 'create_credit_note' : 'approve_purchase') && <Button size="sm" variant="primary" onClick={() => setApplyOpen(true)}>Apply to {isSales ? 'invoice' : 'bill'}</Button>}
    {doc.status !== 'CANCELLED' && !['PAID', 'CONVERTED', 'INVOICED', 'BILLED'].includes(doc.status) && <Button size="sm" variant="danger" onClick={cancel}>Cancel</Button>}
  </>;

  return <div className="stack">
    <PageHeader back={isSales ? (doc.doc_type === 'INVOICE' ? '/sales/invoices' : doc.doc_type === 'CREDIT_NOTE' ? '/sales/credit-notes' : '/sales/quotes') : (doc.doc_type === 'BILL' ? '/purchases/bills' : doc.doc_type === 'PO' ? '/purchases/orders' : '/purchases/debit-notes')}
      title={<span className="row-gap">{t} {doc.number} <StatusBadge status={status} />{doc.ai_generated && <Badge tone="accent">AI draft</Badge>}</span>} subtitle={party} actions={actions} />
    {doc.status === 'DRAFT' && ['INVOICE', 'BILL', 'CREDIT_NOTE', 'DEBIT_NOTE'].includes(doc.doc_type) && <Alert tone="info" title="Draft.">Not yet posted to the ledger. Review it and choose Approve & post.</Alert>}
    {doc.status === 'PENDING_APPROVAL' && <Alert tone="warning" title="Pending approval.">An authorised user must approve this before it is posted.</Alert>}
    {doc.ai_generated && isDraft && <Alert tone="warning" title="Prepared by the AI assistant.">Check the supplier, amounts, tax and account before approving.</Alert>}
    <div className="grid grid-3">
      <Card title="Summary"><dl className="dl">
        <dt>{isSales ? 'Customer' : 'Supplier'}</dt><dd><Link to={`/${side}/${isSales ? 'customers' : 'suppliers'}/${isSales ? doc.customer_id : doc.supplier_id}`}>{party}</Link></dd>
        <dt>Date</dt><dd>{fmtDate(doc.doc_date)}</dd>
        {doc.due_date && <><dt>{doc.doc_type === 'QUOTE' ? 'Valid until' : 'Due'}</dt><dd>{fmtDate(doc.due_date)}</dd></>}
        {(doc.reference || doc.supplier_reference) && <><dt>Reference</dt><dd>{doc.reference || doc.supplier_reference}</dd></>}
        {doc.related_number && <><dt>Related</dt><dd><Link to={`/${side}/documents/${doc.related_document_id}`}>{doc.related_number}</Link></dd></>}
        {doc.journal_number && <><dt>Journal</dt><dd><Link to={`/journals/${doc.journal_entry_id}`}>{doc.journal_number}</Link></dd></>}
        <dt>Created by</dt><dd>{doc.created_by_name || '—'}</dd>
      </dl></Card>
      <Card title="Amounts"><div className="totals" style={{ width: '100%' }}>
        <span className="muted">Subtotal</span><Money value={doc.subtotal} /><span className="muted">VAT</span><Money value={doc.tax_total} />
        <span className="grand">Total</span><span className="grand"><Money value={doc.total} /></span>
        {['INVOICE', 'BILL'].includes(doc.doc_type) && <><span className="muted">Paid</span><Money value={doc.amount_paid} /><span className="muted">Credited</span><Money value={doc.amount_credited} /><span><strong>Balance due</strong></span><strong><Money value={doc.balance_due} /></strong></>}
      </div></Card>
      <Card title="Notes"><p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{doc.notes || <span className="muted">No notes.</span>}</p>{doc.terms && <p className="t-small" style={{ whiteSpace: 'pre-wrap' }}>{doc.terms}</p>}</Card>
    </div>
    <Card title="Lines" pad={false}>
      <DataTable searchable={false} rows={doc.lines} columns={[{ key: 'description', label: 'Description' }, { key: 'quantity', label: 'Qty', type: 'number', render: (v) => <span className="num">{Number(v)}</span> }, { key: 'unit_price', label: 'Unit price', type: 'money' },
        { key: 'discount_pct', label: 'Disc %', type: 'number', render: (v) => (Number(v) ? `${Number(v)}%` : '') }, { key: 'account_name', label: 'Account', render: (v, r) => `${r.account_code} ${v}` }, { key: 'tax_code', label: 'Tax' }, { key: 'line_tax', label: 'VAT', type: 'money' }, { key: 'line_subtotal', label: 'Amount', type: 'money' }]} />
    </Card>
    {doc.payments?.length > 0 && <Card title="Payments" pad={false}><DataTable searchable={false} rows={doc.payments} rowLink={(r) => `/payments/${r.id}`} columns={[{ key: 'number', label: 'Number' }, { key: 'payment_date', label: 'Date', type: 'date' }, { key: 'method', label: 'Method' }, { key: 'status', label: 'Status', type: 'status' }, { key: 'amount', label: 'Amount', type: 'money' }]} /></Card>}
    {doc.credit_notes?.length > 0 && <Card title="Credit notes" pad={false}><DataTable searchable={false} rows={doc.credit_notes} rowLink={(r) => `/sales/documents/${r.id}`} columns={[{ key: 'number', label: 'Number' }, { key: 'doc_date', label: 'Date', type: 'date' }, { key: 'status', label: 'Status', type: 'status' }, { key: 'total', label: 'Total', type: 'money' }]} /></Card>}
    <Attachments linkedType={isSales ? 'sales_document' : 'purchase_document'} linkedId={doc.id} initial={doc.documents} />
    {doc.doc_type === 'CREDIT_NOTE' && doc.status === 'POSTED' && <Alert tone="info" title="Unapplied credit.">This credit note reduces the customer's balance but is not applied to an invoice yet. Choose Apply to invoice, or refund the customer.</Alert>}
    {doc.doc_type === 'DEBIT_NOTE' && doc.status === 'POSTED' && <Alert tone="info" title="Unapplied debit note.">This reduces what you owe the supplier but is not applied to a bill yet. Choose Apply to bill.</Alert>}
    {applyOpen && <ApplyNoteModal side={side} doc={doc} onClose={() => setApplyOpen(false)} onDone={() => { setApplyOpen(false); reload(); }} />}
    {emailOpen && <EmailModal side={side} doc={doc} onClose={() => setEmailOpen(false)} onSent={() => { setEmailOpen(false); reload(); }} />}
  </div>;
}

function ApplyNoteModal({ side, doc, onClose, onDone }) {
  const isSales = side === 'sales';
  const [docs, setDocs] = useState(null);
  const [target, setTarget] = useState('');
  const [run, busy] = useAction();
  useEffect(() => { api.get(`/payments/open-documents?direction=${isSales ? 'IN' : 'OUT'}&party_id=${isSales ? doc.customer_id : doc.supplier_id}`).then(setDocs).catch(() => setDocs([])); }, [doc, isSales]);
  const ok = (docs || []).filter((d) => Number(d.balance_due) >= Number(doc.total));
  const apply = async () => { if (await run(() => api.post(`/${isSales ? 'sales' : 'purchases'}/documents/${doc.id}/apply`, isSales ? { invoice_id: target } : { bill_id: target }), `${doc.number} applied.`)) onDone(); };
  return <Modal title={`Apply ${doc.number} (${fmtK(doc.total)})`} onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" busy={busy} disabled={!target} onClick={apply}>Apply</Button></>}>
    {docs === null ? <p className="muted">Loading…</p> : ok.length ? <Field label={isSales ? 'Invoice' : 'Bill'}><Select value={target} onChange={setTarget} placeholder="Choose…"
      options={ok.map((d) => ({ value: d.id, label: `${d.number} · due ${fmtDate(d.due_date)} · balance ${fmtK(d.balance_due)}` }))} /></Field>
      : <p className="muted">No open {isSales ? 'invoice' : 'bill'} has a balance of at least {fmtK(doc.total)}.</p>}
  </Modal>;
}

function EmailModal({ side, doc, onClose, onSent }) {
  const isSales = side === 'sales';
  const [f, setF] = useState({ to: (isSales ? doc.customer_email : doc.supplier_email) || '', subject: '', message: '' });
  const [run, busy] = useAction();
  return <Modal title={`Email ${doc.number}`} onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" busy={busy} disabled={!f.to} onClick={async () => { const r = await run(() => api.post(`/${side === 'sales' ? 'sales' : 'purchases'}/documents/${doc.id}/email`, f), 'Email sent.'); if (r) onSent(); }}>Send</Button></>}>
    <div className="stack-sm">
      <Field label="To"><Input type="email" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></Field>
      <Field label="Subject" hint="Leave blank for the default subject."><Input value={f.subject} onChange={(e) => setF({ ...f, subject: e.target.value })} /></Field>
      <Field label="Message" hint="Leave blank for the default message. The PDF is attached."><TextArea value={f.message} onChange={(e) => setF({ ...f, message: e.target.value })} /></Field>
    </div>
  </Modal>;
}
