// Shared editor for sales and purchase documents (lines with item, qty, price, discount, account, tax).
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useSession } from '../lib/session.jsx';
import { fmtK, today, DOC_LABEL } from '../lib/format.js';
import { Button, Card, Field, Input, Select, DateInput, MoneyInput, TextArea, Alert, Modal, useToast, Icon } from './ui.jsx';
import { useLookup, accountOptions, partyOptions, taxOptions, invalidate } from './lookups.js';

/** Client-side preview of totals using integer ngwee maths (the server recalculates authoritatively). */
function previewLine(l, rates) {
  const toC = (v) => { const s = String(v || '0').replace(/,/g, ''); if (!/^\d*(\.\d*)?$/.test(s)) return 0; const [i, f = ''] = s.split('.'); return Number(i || 0) * 100 + Number((f + '00').slice(0, 2)) + (Number(f[2] || 0) >= 5 ? 1 : 0); };
  const qty = Number(String(l.quantity || 0).replace(/,/g, '')) || 0;
  const gross = Math.round(toC(l.unit_price) * qty);
  const sub = gross - Math.round(gross * (Number(l.discount_pct) || 0) / 100);
  const rate = rates.find((t) => String(t.id) === String(l.tax_rate_id));
  const tax = rate ? Math.round(sub * Number(rate.rate) / 100) : 0;
  return { sub, tax };
}
const c2s = (c) => `${(c < 0 ? '-' : '')}${Math.floor(Math.abs(c) / 100)}.${String(Math.abs(c) % 100).padStart(2, '0')}`;

export function QuickParty({ kind, onCreated, onClose }) {
  const [f, setF] = useState({ name: '', email: '', phone: '', tpin: '', payment_terms_days: 30 });
  const [busy, setBusy] = useState(false); const { toast } = useToast();
  const save = async () => { setBusy(true); try { const p = await api.post(`/${kind}`, f); invalidate(`/${kind}`); onCreated(p); } catch (e) { toast(e.message, 'error'); } finally { setBusy(false); } };
  return <Modal title={`New ${kind === 'customers' ? 'customer' : 'supplier'}`} onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" busy={busy} disabled={!f.name.trim()} onClick={save}>Create</Button></>}>
    <div className="form-grid">
      <Field label="Name" required span={2}><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
      <Field label="Email"><Input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
      <Field label="Phone"><Input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>
      <Field label="TPIN"><Input value={f.tpin} onChange={(e) => setF({ ...f, tpin: e.target.value })} /></Field>
      <Field label="Payment terms (days)"><Input type="number" min="0" value={f.payment_terms_days} onChange={(e) => setF({ ...f, payment_terms_days: e.target.value })} /></Field>
    </div>
  </Modal>;
}

export function DocumentForm({ side, docType, initial, onSaved }) {
  const isSales = side === 'sales';
  const { me, can } = useSession();
  const nav = useNavigate(); const { toast, confirm } = useToast();
  const partyKind = isSales ? 'customers' : 'suppliers';
  const parties = useLookup(`/${partyKind}`);
  const accounts = useLookup('/accounts');
  const rates = useLookup('/tax-rates');
  const items = useLookup('/items');
  const branches = useLookup('/admin/branches');
  const departments = useLookup('/admin/departments');
  const vatCode = me.settings?.tax?.vat_registered === false ? null : 'VAT16';
  const defaultTax = rates.find((t) => t.code === vatCode && t.is_active && !t.effective_to)?.id || '';
  const defaultAccount = accounts.find((a) => a.system_key === (isSales ? 'SALES' : 'PURCHASES'))?.id || '';
  const blank = () => ({ item_id: '', description: '', quantity: '1', unit_price: '', discount_pct: '0', account_id: defaultAccount, tax_rate_id: defaultTax });
  const [doc, setDoc] = useState(() => initial ? { ...initial, lines: initial.lines.map((l) => ({ ...l, quantity: String(Number(l.quantity)), discount_pct: String(Number(l.discount_pct)), tax_rate_id: l.tax_rate_id || '' })) }
    : { doc_type: docType, [isSales ? 'customer_id' : 'supplier_id']: '', doc_date: today(), due_date: '', reference: '', supplier_reference: '', notes: '', terms: '', branch_id: '', department_id: '', lines: [] });
  const [quick, setQuick] = useState(false);
  const [extraParties, setExtraParties] = useState([]);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState(null);
  useEffect(() => { if (!initial && doc.lines.length === 0 && accounts.length && rates.length) setDoc((d) => ({ ...d, lines: [blank()] })); /* eslint-disable-next-line */ }, [accounts.length, rates.length]);
  const set = (k, v) => setDoc((d) => ({ ...d, [k]: v }));
  const setLine = (i, patch) => setDoc((d) => ({ ...d, lines: d.lines.map((l, j) => (j === i ? { ...l, ...patch } : l)) }));
  const pickItem = (i, id) => {
    const it = items.find((x) => String(x.id) === String(id));
    if (!it) return setLine(i, { item_id: '' });
    setLine(i, { item_id: it.id, description: it.name, unit_price: isSales ? it.sale_price : it.purchase_price, account_id: (isSales ? it.income_account_id : it.expense_account_id) || defaultAccount, tax_rate_id: it.tax_rate_id || '' });
  };
  const totals = useMemo(() => doc.lines.reduce((s, l) => { const p = previewLine(l, rates); return { sub: s.sub + p.sub, tax: s.tax + p.tax }; }, { sub: 0, tax: 0 }), [doc.lines, rates]);
  const accTypes = isSales ? ['REVENUE', 'LIABILITY', 'EQUITY'] : ['EXPENSE', 'COST_OF_SALES', 'ASSET', 'LIABILITY'];
  const partyField = isSales ? 'customer_id' : 'supplier_id';
  const t = DOC_LABEL[doc.doc_type];
  const canPost = isSales ? (doc.doc_type === 'INVOICE' ? can('approve_invoice') : doc.doc_type === 'CREDIT_NOTE' && can('create_credit_note')) : ['BILL', 'DEBIT_NOTE'].includes(doc.doc_type) && can('approve_purchase', 'create_purchase');
  const postable = ['INVOICE', 'CREDIT_NOTE', 'BILL', 'DEBIT_NOTE', 'PO'].includes(doc.doc_type);

  const save = async (action, allowDuplicate = false) => {
    setErrors(null);
    if (!doc[partyField]) return setErrors(`${t} cannot be saved because the ${isSales ? 'customer' : 'supplier'} is missing.`);
    if (!doc.lines.length || doc.lines.some((l) => !l.description || !l.unit_price || !l.account_id)) return setErrors('Every line needs a description, a price and an account.');
    if (action === 'post' && doc.doc_type !== 'PO') {
      const ok = await confirm({ title: `Approve & post ${t.toLowerCase()}?`, message: `This posts ${fmtK(c2s(totals.sub + totals.tax))} to the ledger. Posted documents cannot be edited — corrections are made with a ${isSales ? 'credit' : 'debit'} note or cancellation.`, confirmLabel: 'Approve & post' });
      if (!ok) return;
    }
    setBusy(true);
    const body = { ...doc, action, allow_duplicate: allowDuplicate || undefined, lines: doc.lines.map(({ item_id, description, quantity, unit_price, discount_pct, account_id, tax_rate_id }) => ({ item_id: item_id || null, description, quantity, unit_price, discount_pct: discount_pct || '0', account_id, tax_rate_id: tax_rate_id || null })) };
    for (const k of ['due_date', 'branch_id', 'department_id', 'related_document_id']) if (!body[k]) body[k] = null;
    try {
      const url = isSales ? '/sales/documents' : '/purchases/documents';
      const r = initial ? await api.put(`${url}/${initial.id}`, body) : await api.post(url, body);
      toast(r._pendingApproval ? `${t} ${r.number} saved and sent for approval.` : `${t} ${r.number} ${action === 'post' ? 'posted' : 'saved'}.`);
      onSaved ? onSaved(r) : nav(`/${side}/documents/${r.id}`);
    } catch (e) {
      if (e.code === 'POSSIBLE_DUPLICATE') {
        const ok = await confirm({ title: 'Possible duplicate bill', message: e.message, confirmLabel: 'Save anyway' });
        setBusy(false);
        if (ok) return save(action, true);
        return;
      }
      setErrors(e.message);
    } finally { setBusy(false); }
  };

  return <div className="stack">
    {errors && <Alert tone="error" title="Cannot save.">{errors}</Alert>}
    <Card title={`${t} details`}>
      <div className="form-grid cols-4">
        <Field label={isSales ? 'Customer' : 'Supplier'} required span={2}>
          <div className="row-gap"><Select value={doc[partyField]} onChange={(v) => set(partyField, v)} placeholder={`Choose ${isSales ? 'customer' : 'supplier'}…`} options={partyOptions([...parties, ...extraParties])} />
            {can(isSales ? 'manage_customers' : 'manage_suppliers') && <Button icon="plus" aria-label="New" onClick={() => setQuick(true)} />}</div>
        </Field>
        <Field label="Date" required><DateInput value={doc.doc_date} onChange={(v) => set('doc_date', v)} /></Field>
        <Field label={doc.doc_type === 'QUOTE' ? 'Valid until' : doc.doc_type === 'PO' ? 'Delivery date' : 'Due date'} hint={['INVOICE', 'BILL'].includes(doc.doc_type) ? 'Blank = payment terms' : null}><DateInput value={doc.due_date || ''} onChange={(v) => set('due_date', v)} /></Field>
        {isSales ? <Field label="Reference / PO number"><Input value={doc.reference || ''} onChange={(e) => set('reference', e.target.value)} /></Field>
          : <Field label="Supplier invoice no."><Input value={doc.supplier_reference || ''} onChange={(e) => set('supplier_reference', e.target.value)} /></Field>}
        {me.settings?.features?.branches && <Field label="Branch"><Select value={doc.branch_id || ''} onChange={(v) => set('branch_id', v)} placeholder="—" options={branches.map((b) => ({ value: b.id, label: b.name }))} /></Field>}
        {me.settings?.features?.departments && <Field label="Department"><Select value={doc.department_id || ''} onChange={(v) => set('department_id', v)} placeholder="—" options={departments.map((b) => ({ value: b.id, label: b.name }))} /></Field>}
      </div>
    </Card>
    <Card title="Lines" pad={false}>
      <div className="table-wrap"><table className="table lines-table">
        <thead><tr><th>Item</th><th>Description</th><th className="r">Qty</th><th className="r">Unit price</th><th className="r">Disc %</th><th>Account</th><th>Tax</th><th className="r">Amount</th><th /></tr></thead>
        <tbody>{doc.lines.map((l, i) => { const p = previewLine(l, rates); return <tr key={i}>
          <td><Select value={l.item_id || ''} onChange={(v) => pickItem(i, v)} placeholder="—" options={items.filter((x) => x.is_active).map((x) => ({ value: x.id, label: x.code }))} aria-label="Item" /></td>
          <td className="line-desc"><Input value={l.description} onChange={(e) => setLine(i, { description: e.target.value })} aria-label="Description" /></td>
          <td style={{ width: 80 }}><Input className="num" value={l.quantity} onChange={(e) => setLine(i, { quantity: e.target.value })} aria-label="Quantity" /></td>
          <td style={{ width: 130 }}><MoneyInput value={l.unit_price} onChange={(v) => setLine(i, { unit_price: v })} aria-label="Unit price" /></td>
          <td style={{ width: 80 }}><Input className="num" value={l.discount_pct} onChange={(e) => setLine(i, { discount_pct: e.target.value })} aria-label="Discount percent" /></td>
          <td style={{ minWidth: 200 }}><Select value={l.account_id} onChange={(v) => setLine(i, { account_id: v })} placeholder="Account…" options={accountOptions(accounts, accTypes)} aria-label="Account" /></td>
          <td style={{ minWidth: 120 }}><Select value={l.tax_rate_id || ''} onChange={(v) => setLine(i, { tax_rate_id: v })} placeholder="No tax" options={taxOptions(rates, isSales ? 'SALES' : 'PURCHASES')} aria-label="Tax" /></td>
          <td className="r num">{fmtK(c2s(p.sub))}</td>
          <td><Button variant="ghost" size="sm" icon="trash" aria-label="Remove line" disabled={doc.lines.length <= 1} onClick={() => setDoc((d) => ({ ...d, lines: d.lines.filter((_, j) => j !== i) }))} /></td>
        </tr>; })}</tbody>
      </table></div>
      <div style={{ padding: 'var(--space-3) var(--space-5)', display: 'flex', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <Button size="sm" icon="plus" onClick={() => setDoc((d) => ({ ...d, lines: [...d.lines, blank()] }))}>Add line</Button>
        <div className="totals"><span className="muted">Subtotal</span><span className="num r">{fmtK(c2s(totals.sub))}</span><span className="muted">VAT</span><span className="num r">{fmtK(c2s(totals.tax))}</span>
          <span className="grand">Total</span><span className="grand num r">{fmtK(c2s(totals.sub + totals.tax))}</span></div>
      </div>
    </Card>
    <Card title="Notes"><div className="form-grid">
      <Field label="Notes (shown on document)"><TextArea value={doc.notes || ''} onChange={(e) => set('notes', e.target.value)} /></Field>
      {isSales && <Field label="Terms" hint="Leave blank to use the default terms from Admin Center → Invoice templates."><TextArea value={doc.terms || ''} onChange={(e) => set('terms', e.target.value)} /></Field>}
    </div></Card>
    <div className="form-actions">
      <Button onClick={() => nav(-1)}>Cancel</Button>
      <Button busy={busy} onClick={() => save('draft')}>Save draft</Button>
      {postable && doc.doc_type !== 'PO' && canPost && <Button variant="primary" busy={busy} onClick={() => save('post')}><Icon name="check" size={16} />{can(isSales ? 'approve_invoice' : 'approve_purchase') ? 'Approve & post' : 'Submit for approval'}</Button>}
      {doc.doc_type === 'PO' && <Button variant="primary" busy={busy} onClick={() => save('post')}>Save & mark open</Button>}
    </div>
    {quick && <QuickParty kind={partyKind} onClose={() => setQuick(false)} onCreated={(p) => { setQuick(false); setExtraParties((x) => [...x, p]); set(partyField, p.id); }} />}
  </div>;
}
