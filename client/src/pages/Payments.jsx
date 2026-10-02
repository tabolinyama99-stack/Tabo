import { useEffect, useMemo, useState } from 'react';
import { Routes, Route, useParams, useSearchParams, useNavigate, Link } from 'react-router-dom';
import { api, download, qs } from '../lib/api.js';
import { useSession } from '../lib/session.jsx';
import { fmtK, fmtDate, today, sumK } from '../lib/format.js';
import { PageHeader, Card, useApi, Loadable, Button, Field, Input, Select, DateInput, MoneyInput, TextArea, Alert, StatusBadge, Money, useAction, useToast, LinkButton, Tabs } from '../components/ui.jsx';
import { DataTable } from '../components/DataTable.jsx';
import { useLookup, partyOptions, bankOptions } from '../components/lookups.js';

const METHODS = [['BANK_TRANSFER', 'Bank transfer'], ['CASH', 'Cash'], ['MOBILE_MONEY', 'Mobile money'], ['CHEQUE', 'Cheque'], ['CARD', 'Card'], ['OTHER', 'Other']].map(([value, label]) => ({ value, label }));

function List() {
  const [sp, setSp] = useSearchParams();
  const dir = sp.get('direction') || 'IN';
  const { can } = useSession();
  const state = useApi(`/payments${qs({ direction: dir, limit: 500 })}`);
  return <div className="stack">
    <PageHeader title={dir === 'IN' ? 'Receipts' : 'Supplier payments'} subtitle={dir === 'IN' ? 'Money received from customers' : 'Money paid to suppliers'}
      actions={can('create_payment') && <LinkButton variant="primary" icon="plus" to={`/payments/new?direction=${dir}`}>{dir === 'IN' ? 'Record receipt' : 'Record payment'}</LinkButton>} />
    <Tabs tabs={[{ value: 'IN', label: 'Receipts' }, { value: 'OUT', label: 'Supplier payments' }]} value={dir} onChange={(v) => setSp({ direction: v })} />
    <Card pad={false}><Loadable state={state}>{(d) => <DataTable rows={d.items} rowLink={(r) => `/payments/${r.id}`} toolbar={<span className="t-small" style={{ marginLeft: 'auto' }}>Total posted {fmtK(d.sum_total)}</span>}
      columns={[{ key: 'number', label: 'Number' }, { key: 'payment_date', label: 'Date', type: 'date' }, { key: 'party_name', label: dir === 'IN' ? 'Customer' : 'Supplier' }, { key: 'method', label: 'Method', render: (v) => METHODS.find((m) => m.value === v)?.label },
        { key: 'bank_account_name', label: 'Account' }, { key: 'reference', label: 'Reference' }, { key: 'status', label: 'Status', type: 'status' }, { key: 'amount', label: 'Amount', type: 'money' }]} />}</Loadable></Card>
  </div>;
}

function NewPayment() {
  const [sp] = useSearchParams();
  const dir = sp.get('direction') === 'OUT' ? 'OUT' : 'IN';
  const nav = useNavigate(); const { confirm } = useToast();
  const parties = useLookup(dir === 'IN' ? '/customers' : '/suppliers');
  const banks = useLookup('/bank-accounts');
  const rates = useLookup('/tax-rates');
  const [f, setF] = useState({ party_id: sp.get('party_id') || '', payment_date: sp.get('date') || today(), amount: sp.get('amount') || '', bank_account_id: sp.get('bank_account_id') || '', method: 'BANK_TRANSFER', reference: sp.get('reference') || '', notes: '', wht_rate_id: '' });
  const [open, setOpen] = useState([]);
  const [alloc, setAlloc] = useState({});
  const [run, busy] = useAction();
  useEffect(() => { if (!f.bank_account_id && banks.length) setF((x) => ({ ...x, bank_account_id: banks.find((b) => !b.is_cash)?.id || banks[0].id })); }, [banks, f.bank_account_id]);
  useEffect(() => {
    if (!f.party_id) { setOpen([]); return; }
    api.get(`/payments/open-documents${qs({ direction: dir, party_id: f.party_id })}`).then((docs) => {
      setOpen(docs);
      const pre = sp.get('doc');
      if (pre) { const d = docs.find((x) => String(x.id) === pre); if (d) { setAlloc({ [d.id]: d.balance_due }); setF((x) => ({ ...x, amount: x.amount || d.balance_due })); } }
    }).catch(() => setOpen([]));
  }, [f.party_id, dir, sp]);
  const allocated = sumK(Object.values(alloc));
  const autoAllocate = () => {
    let rem = Math.round(Number(String(f.amount).replace(/,/g, '')) * 100) || 0; const a = {};
    for (const d of open) { if (rem <= 0) break; const due = Math.round(Number(d.balance_due) * 100); const x = Math.min(due, rem); a[d.id] = (x / 100).toFixed(2); rem -= x; }
    setAlloc(a);
  };
  const whtRates = rates.filter((t) => t.tax_type === 'WHT' && t.is_active);
  const wht = f.wht_rate_id ? (Number(f.amount || 0) * Number(whtRates.find((t) => String(t.id) === String(f.wht_rate_id))?.rate || 0) / 100) : 0;
  const unallocated = (Number(String(f.amount || 0).replace(/,/g, '')) - Number(allocated)).toFixed(2);
  const save = async () => {
    if (Number(unallocated) > 0 && open.length && !(await confirm({ title: 'Unallocated amount', message: `${fmtK(unallocated)} is not allocated to any ${dir === 'IN' ? 'invoice' : 'bill'} and will remain as a credit on the account. Continue?` }))) return;
    const body = { direction: dir, payment_date: f.payment_date, amount: f.amount, bank_account_id: f.bank_account_id, method: f.method, reference: f.reference, notes: f.notes, wht_rate_id: f.wht_rate_id || null,
      [dir === 'IN' ? 'customer_id' : 'supplier_id']: f.party_id, allocations: Object.entries(alloc).filter(([, v]) => Number(v) > 0).map(([document_id, amount]) => ({ document_id, amount })) };
    const r = await run(() => api.post('/payments', body), (x) => `${x.number} recorded.`);
    if (r) nav(`/payments/${r.id}`);
  };
  return <div className="stack">
    <PageHeader back={-1} title={dir === 'IN' ? 'Record customer receipt' : 'Record supplier payment'} subtitle="Posts immediately: Dr bank / Cr receivable (receipt) or Dr payable / Cr bank (payment)." />
    <Card title="Payment"><div className="form-grid cols-3">
      <Field label={dir === 'IN' ? 'Customer' : 'Supplier'} required><Select value={f.party_id} onChange={(v) => { setF({ ...f, party_id: v }); setAlloc({}); }} placeholder="Choose…" options={partyOptions(parties)} /></Field>
      <Field label="Date" required><DateInput value={f.payment_date} onChange={(v) => setF({ ...f, payment_date: v })} /></Field>
      <Field label="Amount (K)" required><MoneyInput value={f.amount} onChange={(v) => setF({ ...f, amount: v })} /></Field>
      <Field label={dir === 'IN' ? 'Deposited to' : 'Paid from'} required><Select value={f.bank_account_id} onChange={(v) => setF({ ...f, bank_account_id: v })} options={bankOptions(banks)} /></Field>
      <Field label="Method"><Select value={f.method} onChange={(v) => setF({ ...f, method: v })} options={METHODS} /></Field>
      <Field label="Reference"><Input value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} placeholder="Transfer ref, cheque no…" /></Field>
      {dir === 'OUT' && whtRates.length > 0 && <Field label="Withholding tax" hint={wht ? `${fmtK(wht.toFixed(2))} withheld; supplier receives ${fmtK((Number(f.amount) - wht).toFixed(2))}` : 'If applicable'}><Select value={f.wht_rate_id} onChange={(v) => setF({ ...f, wht_rate_id: v })} placeholder="None" options={whtRates.map((t) => ({ value: t.id, label: `${t.name} (${Number(t.rate)}%)` }))} /></Field>}
      <Field label="Notes" span={2}><TextArea value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
    </div></Card>
    <Card title={`Allocate to open ${dir === 'IN' ? 'invoices' : 'bills'}`} actions={open.length > 0 && <Button size="sm" onClick={autoAllocate}>Auto-allocate oldest first</Button>} pad={false}>
      {f.party_id ? open.length ? <div className="table-wrap"><table className="table"><thead><tr><th>Number</th><th>Date</th><th>Due</th><th className="r">Total</th><th className="r">Balance</th><th className="r">Allocate</th></tr></thead>
        <tbody>{open.map((d) => <tr key={d.id}><td>{d.number}{d.supplier_reference ? ` (${d.supplier_reference})` : ''}</td><td>{fmtDate(d.doc_date)}</td><td>{fmtDate(d.due_date)}</td><td className="r num">{fmtK(d.total)}</td><td className="r num">{fmtK(d.balance_due)}</td>
          <td className="r" style={{ width: 160 }}><MoneyInput value={alloc[d.id] || ''} onChange={(v) => setAlloc({ ...alloc, [d.id]: v })} aria-label={`Allocate to ${d.number}`} /></td></tr>)}</tbody></table></div>
        : <p className="muted" style={{ padding: 'var(--space-5)' }}>No open {dir === 'IN' ? 'invoices' : 'bills'}. The payment will be recorded as a credit on the account.</p> : <p className="muted" style={{ padding: 'var(--space-5)' }}>Choose a {dir === 'IN' ? 'customer' : 'supplier'} first.</p>}
      <div style={{ padding: 'var(--space-3) var(--space-5)' }} className="totals"><span className="muted">Allocated</span><span className="num r">{fmtK(allocated)}</span><span className="muted">Unallocated</span><span className={`num r ${Number(unallocated) < 0 ? 'neg' : ''}`}>{fmtK(unallocated)}</span></div>
    </Card>
    {Number(unallocated) < 0 && <Alert tone="error">Allocations exceed the payment amount.</Alert>}
    <div className="form-actions"><Button onClick={() => nav(-1)}>Cancel</Button><Button variant="primary" busy={busy} disabled={!f.party_id || !f.amount || !f.bank_account_id || Number(unallocated) < 0} onClick={save}>Record {dir === 'IN' ? 'receipt' : 'payment'}</Button></div>
  </div>;
}

function View() {
  const { id } = useParams();
  const { can } = useSession(); const { confirm } = useToast();
  const state = useApi(`/payments/${id}`);
  const [run, busy] = useAction();
  return <Loadable state={state}>{(p) => <div className="stack">
    <PageHeader back={`/payments?direction=${p.direction}`} title={<span className="row-gap">{p.direction === 'IN' ? 'Receipt' : 'Payment'} {p.number} <StatusBadge status={p.status} /></span>} subtitle={p.customer_name || p.supplier_name}
      actions={<><Button size="sm" icon="eye" onClick={() => run(() => download(`/payments/${p.id}/pdf`, { open: true }))}>{p.direction === 'IN' ? 'Receipt PDF' : 'Voucher PDF'}</Button>
        {p.status === 'POSTED' && can('delete_payment') && <Button size="sm" variant="danger" busy={busy} onClick={async () => { const reason = await confirm({ title: `Void ${p.number}?`, message: 'The journal is reversed and allocations are released back to the invoices/bills.', confirmLabel: 'Void payment', danger: true, input: true, inputLabel: 'Reason' }); if (reason && (await run(() => api.post(`/payments/${p.id}/void`, { reason }), 'Payment voided.'))) state.reload(); }}>Void</Button>}</>} />
    <div className="grid grid-2">
      <Card title="Details"><dl className="dl">
        <dt>Date</dt><dd>{fmtDate(p.payment_date)}</dd><dt>Amount</dt><dd><Money value={p.amount} /></dd>
        {Number(p.wht_amount) > 0 && <><dt>Withholding tax</dt><dd><Money value={p.wht_amount} /></dd><dt>Net paid</dt><dd><Money value={(Number(p.amount) - Number(p.wht_amount)).toFixed(2)} /></dd></>}
        {Number(p.unallocated) > 0 && p.status === 'POSTED' && <><dt>Unallocated (on account)</dt><dd><Money value={p.unallocated} /></dd></>}
        <dt>Account</dt><dd>{p.bank_account_code} {p.bank_account_name}</dd><dt>Method</dt><dd>{METHODS.find((m) => m.value === p.method)?.label}</dd>
        <dt>Reference</dt><dd>{p.reference || '—'}</dd><dt>Journal</dt><dd>{p.journal_number && <Link to={`/journals/${p.journal_entry_id}`}>{p.journal_number}</Link>}</dd><dt>Recorded by</dt><dd>{p.created_by_name}</dd>
        {p.notes && <><dt>Notes</dt><dd>{p.notes}</dd></>}
      </dl></Card>
      {p.status === 'POSTED' && Number(p.unallocated) > 0 && can('create_payment') && <ApplyCredit p={p} onDone={state.reload} />}
      <Card title="Allocations" pad={false}><DataTable searchable={false} rows={p.allocations} rowLink={(r) => (r.sales_document_id ? `/sales/documents/${r.sales_document_id}` : `/purchases/documents/${r.purchase_document_id}`)}
        columns={[{ key: 'document_number', label: 'Document' }, { key: 'document_total', label: 'Document total', type: 'money' }, { key: 'amount', label: 'Allocated', type: 'money' }]} empty={{ title: 'Not allocated', text: 'Held as a credit on the account.' }} /></Card>
    </div>
  </div>}</Loadable>;
}

/** Apply the on-account (unallocated) part of a posted receipt/payment to open invoices or bills. */
function ApplyCredit({ p, onDone }) {
  const [open, setOpen] = useState(null);
  const [alloc, setAlloc] = useState({});
  const [run, busy] = useAction();
  useEffect(() => { api.get(`/payments/open-documents${qs({ direction: p.direction, party_id: p.customer_id || p.supplier_id })}`).then(setOpen).catch(() => setOpen([])); }, [p]);
  const total = sumK(Object.values(alloc));
  const docWord = p.direction === 'IN' ? 'invoice' : 'bill';
  const apply = async () => {
    const allocations = Object.entries(alloc).filter(([, v]) => Number(v) > 0).map(([document_id, amount]) => ({ document_id, amount }));
    if (await run(() => api.post(`/payments/${p.id}/allocate`, { allocations }), 'Credit applied.')) { setAlloc({}); onDone(); }
  };
  return <Card title={`Apply ${fmtK(p.unallocated)} on account`} pad={false}>
    {open === null ? <p className="muted" style={{ padding: 'var(--space-5)' }}>Loading…</p> : !open.length ? <p className="muted" style={{ padding: 'var(--space-5)' }}>No open {docWord}s for this {p.direction === 'IN' ? 'customer' : 'supplier'}. The amount stays as a credit on the account.</p>
      : <div className="table-wrap"><table className="table"><thead><tr><th>Number</th><th>Due</th><th className="r">Balance</th><th className="r">Apply</th></tr></thead>
        <tbody>{open.map((d) => <tr key={d.id}><td>{d.number}</td><td>{fmtDate(d.due_date)}</td><td className="r num">{fmtK(d.balance_due)}</td>
          <td className="r" style={{ width: 160 }}><MoneyInput value={alloc[d.id] || ''} onChange={(v) => setAlloc({ ...alloc, [d.id]: v })} aria-label={`Apply to ${d.number}`} /></td></tr>)}</tbody></table></div>}
    {open?.length > 0 && <div className="form-actions" style={{ padding: 'var(--space-3) var(--space-5)' }}>
      {Number(total) > Number(p.unallocated) && <span className="neg t-small">More than the unallocated amount.</span>}
      <Button variant="primary" busy={busy} disabled={!(Number(total) > 0) || Number(total) > Number(p.unallocated)} onClick={apply}>Apply {fmtK(total)}</Button></div>}
  </Card>;
}

export default function Payments() {
  return <Routes><Route index element={<List />} /><Route path="new" element={<NewPayment />} /><Route path=":id" element={<View />} /></Routes>;
}
export { useMemo };
