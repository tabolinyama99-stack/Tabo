import { useRef, useState } from 'react';
import { Routes, Route, useParams, useNavigate, Link } from 'react-router-dom';
import { api, qs } from '../lib/api.js';
import { useSession } from '../lib/session.jsx';
import { fmtK, fmtDate, today, monthStart, addMonths } from '../lib/format.js';
import { PageHeader, Card, useApi, Loadable, Button, Field, Input, Select, DateInput, MoneyInput, Modal, Alert, StatusBadge, Money, useAction, useToast, Tabs, Badge, Kpi, Check } from '../components/ui.jsx';
import { DataTable } from '../components/DataTable.jsx';
import { useLookup, accountOptions, bankOptions, invalidate } from '../components/lookups.js';

function BankAccountModal({ initial, onClose, onSaved }) {
  const [f, setF] = useState(initial || { code: '', name: '', bank_name: '', account_number: '', branch_name: '', is_cash: false, low_balance_threshold: '' });
  const [run, busy] = useAction();
  return <Modal title={initial ? `Edit ${initial.name}` : 'New bank or cash account'} onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" busy={busy} disabled={!f.name || !f.code}
    onClick={async () => { const r = await run(() => (initial ? api.put(`/bank-accounts/${initial.id}`, f) : api.post('/bank-accounts', f)), 'Saved.'); if (r) { invalidate('/bank-accounts'); invalidate('/accounts'); onSaved(); } }}>Save</Button></>}>
    <div className="form-grid">
      <Field label="Ledger code" required hint="e.g. 1120"><Input value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} disabled={!!initial} /></Field>
      <Field label="Account name" required><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Bank – Zanaco Current" /></Field>
      {!f.is_cash && <><Field label="Bank"><Input value={f.bank_name || ''} onChange={(e) => setF({ ...f, bank_name: e.target.value })} /></Field>
        <Field label="Account number"><Input value={f.account_number || ''} onChange={(e) => setF({ ...f, account_number: e.target.value })} /></Field>
        <Field label="Branch"><Input value={f.branch_name || ''} onChange={(e) => setF({ ...f, branch_name: e.target.value })} /></Field></>}
      <Field label="Low balance alert (K)"><MoneyInput value={f.low_balance_threshold || ''} onChange={(v) => setF({ ...f, low_balance_threshold: v })} /></Field>
      {!initial && <Check label="This is a cash / petty cash / mobile money account" checked={f.is_cash} onChange={(v) => setF({ ...f, is_cash: v })} />}
    </div>
  </Modal>;
}

function TransactionModal({ onClose, onSaved, defaultBank }) {
  const banks = useLookup('/bank-accounts'); const accounts = useLookup('/accounts');
  const [f, setF] = useState({ kind: 'DEPOSIT', bank_account_id: defaultBank || '', to_account_id: '', contra_account_id: '', amount: '', date: today(), reference: '', description: '' });
  const [run, busy] = useAction();
  return <Modal title="Record bank transaction" onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" busy={busy} disabled={!f.bank_account_id || !f.amount || (f.kind === 'TRANSFER' ? !f.to_account_id : !f.contra_account_id)}
    onClick={async () => { const r = await run(() => api.post('/bank-transactions', { ...f, to_account_id: f.to_account_id || undefined, contra_account_id: f.contra_account_id || undefined }), (x) => `Posted ${x.number}.`); if (r) onSaved(); }}>Post</Button></>}>
    <div className="form-grid">
      <Field label="Type" span={2}><Select value={f.kind} onChange={(v) => setF({ ...f, kind: v })} options={[{ value: 'DEPOSIT', label: 'Deposit (money in)' }, { value: 'WITHDRAWAL', label: 'Withdrawal (money out)' }, { value: 'TRANSFER', label: 'Transfer between accounts' }]} /></Field>
      <Field label={f.kind === 'TRANSFER' ? 'From account' : 'Bank / cash account'}><Select value={f.bank_account_id} onChange={(v) => setF({ ...f, bank_account_id: v })} placeholder="Choose…" options={bankOptions(banks)} /></Field>
      {f.kind === 'TRANSFER' ? <Field label="To account"><Select value={f.to_account_id} onChange={(v) => setF({ ...f, to_account_id: v })} placeholder="Choose…" options={bankOptions(banks).filter((b) => String(b.value) !== String(f.bank_account_id))} /></Field>
        : <Field label={f.kind === 'DEPOSIT' ? 'Source (credit account)' : 'Purpose (debit account)'} hint={f.kind === 'DEPOSIT' ? 'e.g. Owner\'s Capital, Loans, Other Income' : 'e.g. Bank Charges, Drawings'}><Select value={f.contra_account_id} onChange={(v) => setF({ ...f, contra_account_id: v })} placeholder="Choose…" options={accountOptions(accounts.filter((a) => !a.is_bank))} /></Field>}
      <Field label="Amount (K)"><MoneyInput value={f.amount} onChange={(v) => setF({ ...f, amount: v })} /></Field>
      <Field label="Date"><DateInput value={f.date} onChange={(v) => setF({ ...f, date: v })} /></Field>
      <Field label="Reference"><Input value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} /></Field>
      <Field label="Description"><Input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
    </div>
    <p className="t-small">Customer receipts and supplier payments should be recorded under Receipts / Supplier payments so invoices and bills are updated.</p>
  </Modal>;
}

function Overview() {
  const { can } = useSession();
  const state = useApi('/bank-accounts');
  const [modal, setModal] = useState(null);
  return <div className="stack">
    <PageHeader title="Banking" subtitle="Bank, cash and mobile money accounts — balances from the ledger"
      actions={<>{can('manage_banking') && <Button icon="plus" onClick={() => setModal('txn')}>Record transaction</Button>}{can('manage_banking') && <Button variant="primary" icon="plus" onClick={() => setModal('acct')}>New account</Button>}</>} />
    <Loadable state={state}>{(accts) => <div className="grid grid-3">{accts.map((a) => <Link key={a.id} to={`/banking/${a.id}`} className="card kpi kpi-link">
      <span className="kpi-label">{a.is_cash ? 'Cash' : a.bank_name || 'Bank'}{a.account_number ? ` · ${a.account_number}` : ''}</span>
      <strong>{a.code} {a.name}</strong>
      <span className={`kpi-value ${Number(a.balance) < 0 ? 'neg' : ''}`}>{fmtK(a.balance)}</span>
      <span className="kpi-delta">{a.is_cash ? 'Cash account' : <>Cleared {fmtK(a.cleared_balance)} · {a.last_reconciled ? `reconciled to ${fmtDate(a.last_reconciled)}` : 'never reconciled'}</>}</span>
      {a.unmatched_lines > 0 && <span><Badge tone="warning">{a.unmatched_lines} unmatched statement lines</Badge></span>}
      {a.low_balance_threshold && Number(a.balance) < Number(a.low_balance_threshold) && <span><Badge tone="negative">Below {fmtK(a.low_balance_threshold)}</Badge></span>}
    </Link>)}</div>}</Loadable>
    {modal === 'acct' && <BankAccountModal onClose={() => setModal(null)} onSaved={() => { setModal(null); state.reload(); }} />}
    {modal === 'txn' && <TransactionModal onClose={() => setModal(null)} onSaved={() => { setModal(null); state.reload(); }} />}
  </div>;
}

function Account() {
  const { id } = useParams(); const { can } = useSession();
  const [tab, setTab] = useState('register');
  const [range, setRange] = useState({ from: addMonths(monthStart(), -2), to: today() });
  const accts = useApi('/bank-accounts');
  const reg = useApi(`/bank-accounts/${id}/register${qs(range)}`);
  const [modal, setModal] = useState(null);
  const acct = accts.data?.find((a) => String(a.id) === id);
  return <div className="stack">
    <PageHeader back="/banking" title={acct ? `${acct.code} ${acct.name}` : 'Account'} subtitle={acct && `${acct.bank_name || ''} ${acct.account_number || ''}`}
      actions={<>{can('manage_banking') && acct && <Button onClick={() => setModal('edit')}>Edit</Button>}{can('manage_banking') && <Button icon="plus" onClick={() => setModal('txn')}>Record transaction</Button>}{can('reconcile_bank') && !acct?.is_cash && <Link className="btn btn-primary" to={`/banking/reconcile?account=${id}`}>Reconcile</Link>}</>} />
    {acct && <div className="kpis"><Kpi label="Book balance" value={acct.balance} /><Kpi label="Cleared balance" value={acct.cleared_balance} /><Kpi label="Unmatched statement lines" value={String(acct.unmatched_lines)} money={false} /></div>}
    <Tabs tabs={[{ value: 'register', label: 'Transactions' }, ...(acct?.is_cash ? [] : [{ value: 'statement', label: 'Bank statement & matching' }])]} value={tab} onChange={setTab} />
    {tab === 'register' && <Card pad={false}><div className="toolbar" style={{ padding: 'var(--space-3)', margin: 0 }}><Field label="From"><DateInput value={range.from} onChange={(v) => setRange({ ...range, from: v })} /></Field><Field label="To"><DateInput value={range.to} onChange={(v) => setRange({ ...range, to: v })} /></Field></div>
      <Loadable state={reg}>{(r) => <DataTable rows={[{ id: 'open', entry_date: range.from, description: 'Opening balance', balance: r.opening_balance, _o: true }, ...r.rows]} rowClass={(x) => (x._o ? 'row-subtle' : '')} rowLink={(x) => (x._o ? undefined : `/journals/${x.entry_id}`)}
        columns={[{ key: 'entry_date', label: 'Date', type: 'date' }, { key: 'entry_number', label: 'Journal' }, { key: 'reference', label: 'Reference' }, { key: 'description', label: 'Description' }, { key: 'source_type', label: 'Source', render: (v) => v && v.toLowerCase().replace('_', ' ') },
          { key: 'debit', label: 'Money in', type: 'money', render: (v) => (Number(v) ? <Money value={v} /> : '') }, { key: 'credit', label: 'Money out', type: 'money', render: (v) => (Number(v) ? <Money value={v} /> : '') },
          { key: 'cleared', label: 'Cleared', render: (v, x) => (x._o ? '' : v ? '✓' : '') }, { key: 'balance', label: 'Balance', type: 'money' }]} />}</Loadable></Card>}
    {tab === 'statement' && <Statement id={id} onChange={() => { accts.reload(); reg.reload(); }} />}
    {modal === 'txn' && <TransactionModal defaultBank={id} onClose={() => setModal(null)} onSaved={() => { setModal(null); reg.reload(); accts.reload(); }} />}
    {modal === 'edit' && <BankAccountModal initial={acct} onClose={() => setModal(null)} onSaved={() => { setModal(null); accts.reload(); }} />}
  </div>;
}

function Statement({ id, onChange }) {
  const { can } = useSession();
  const [status, setStatus] = useState('UNMATCHED');
  const lines = useApi(`/bank-accounts/${id}/statement-lines${qs({ status })}`);
  const sugg = useApi(status === 'UNMATCHED' ? `/bank-accounts/${id}/suggestions` : null);
  const accounts = useLookup('/accounts');
  const [run, busy] = useAction(); const input = useRef(null);
  const [create, setCreate] = useState(null);
  const refresh = () => { lines.reload(); sugg.reload(); onChange(); };
  const upload = async (file) => { const r = await run(() => api.upload(`/bank-accounts/${id}/import`, file), (x) => `Imported ${x.imported} line(s); ${x.auto_matched} matched automatically.`); if (r) { if (r.errors?.length) console.warn(r.errors); refresh(); } };
  const byLine = new Map((sugg.data || []).map((s) => [s.statement_line.id, s.candidates]));
  return <div className="stack">
    <Card title="Import a statement" actions={can('manage_banking') && <><input ref={input} type="file" hidden accept=".csv,.txt,.xlsx" onChange={(e) => e.target.files[0] && upload(e.target.files[0])} /><Button icon="upload" busy={busy} onClick={() => input.current?.click()}>Upload CSV / Excel</Button>
      <Button busy={busy} onClick={async () => { const r = await run(() => api.post(`/bank-accounts/${id}/auto-match`), (x) => `${x.applied} line(s) matched.`); if (r) refresh(); }}>Auto-match</Button></>}>
      <p className="muted" style={{ margin: 0 }}>Upload the statement exported from your bank. A header row with <strong>Date</strong>, <strong>Description</strong> and either <strong>Amount</strong> or <strong>Debit/Credit</strong> columns is detected automatically (dates as DD/MM/YYYY). Re-importing the same lines is safe — duplicates are skipped.</p>
    </Card>
    <Card title="Statement lines" pad={false} actions={<Select value={status} onChange={setStatus} options={[{ value: 'UNMATCHED', label: 'Unmatched' }, { value: 'MATCHED', label: 'Matched' }, { value: 'EXCLUDED', label: 'Excluded' }]} aria-label="Status" />}>
      <Loadable state={lines}>{(rows) => !rows.length ? <p className="muted" style={{ padding: 'var(--space-5)' }}>No {status.toLowerCase()} lines.</p> : <div style={{ padding: '0 var(--space-5)' }}>{rows.map((s) => <div key={s.id} className="match-row">
        <div><div className="row-gap"><strong className="num">{fmtK(s.amount)}</strong><StatusBadge status={s.status} /></div><div>{fmtDate(s.txn_date)} · {s.description}</div>{s.reference && <div className="t-small">Ref {s.reference}</div>}</div>
        <div>{s.status === 'MATCHED' ? <div className="row-gap wrap">Matched to <Link to={`/journals/${s.entry_id}`}>{s.entry_number}</Link> {s.entry_description}{!s.reconciliation_id && <Button size="sm" onClick={async () => { if (await run(() => api.post(`/statement-lines/${s.id}/unmatch`), 'Unmatched.')) refresh(); }}>Unmatch</Button>}</div>
          : s.status === 'EXCLUDED' ? <Button size="sm" onClick={async () => { if (await run(() => api.post(`/statement-lines/${s.id}/exclude`, { exclude: false }), 'Restored.')) refresh(); }}>Include again</Button>
          : <>{(byLine.get(s.id) || []).map((c) => <div key={c.id} className="cand"><span><strong>{c.entry_number}</strong> {fmtDate(c.entry_date)} · {c.description} <span className="t-small">({c.score}% match)</span></span>
            <Button size="sm" variant="primary" onClick={async () => { if (await run(() => api.post(`/statement-lines/${s.id}/match`, { journal_line_id: c.id }), 'Matched.')) refresh(); }}>Match</Button></div>)}
            {!(byLine.get(s.id) || []).length && <p className="t-small" style={{ marginTop: 0 }}>No ledger transaction with this amount. Record it (e.g. bank charges) or exclude the line.</p>}
            <div className="row-gap wrap">{can('manage_banking') && <Button size="sm" onClick={() => setCreate(s)}>Create entry</Button>}<Button size="sm" variant="ghost" onClick={async () => { if (await run(() => api.post(`/statement-lines/${s.id}/exclude`), 'Excluded.')) refresh(); }}>Exclude</Button></div></>}</div>
      </div>)}</div>}</Loadable>
    </Card>
    {create && <CreateEntry line={create} accounts={accounts} onClose={() => setCreate(null)} onDone={() => { setCreate(null); refresh(); }} />}
  </div>;
}

function CreateEntry({ line, accounts, onClose, onDone }) {
  const bc = accounts.find((a) => a.system_key === 'BANK_CHARGES');
  const [f, setF] = useState({ contra_account_id: Number(line.amount) < 0 ? bc?.id || '' : '', description: line.description || '' });
  const [run, busy] = useAction();
  return <Modal title={`Record ${fmtK(line.amount)} from the statement`} onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" busy={busy} disabled={!f.contra_account_id}
    onClick={async () => { if (await run(() => api.post(`/statement-lines/${line.id}/create-entry`, f), 'Entry posted and matched.')) onDone(); }}>Post & match</Button></>}>
    <div className="stack-sm"><Field label={Number(line.amount) < 0 ? 'Expense / debit account' : 'Income / credit account'}><Select value={f.contra_account_id} onChange={(v) => setF({ ...f, contra_account_id: v })} placeholder="Choose…" options={accountOptions(accounts.filter((a) => !a.is_bank))} /></Field>
      <Field label="Description"><Input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field></div>
  </Modal>;
}

function Reconcile() {
  const { can } = useSession(); const nav = useNavigate();
  const params = new URLSearchParams(window.location.search);
  const banks = useLookup('/bank-accounts');
  const list = useApi('/reconciliations');
  const [f, setF] = useState({ bank_account_id: params.get('account') || '', statement_date: today(), statement_balance: '' });
  const [run, busy] = useAction();
  return <div className="stack">
    <PageHeader title="Bank reconciliation" subtitle="Compare the bank statement with your books and clear matching transactions." />
    {can('reconcile_bank') && <Card title="Start a reconciliation"><div className="form-grid cols-4">
      <Field label="Bank account"><Select value={f.bank_account_id} onChange={(v) => setF({ ...f, bank_account_id: v })} placeholder="Choose…" options={bankOptions(banks.filter((b) => !b.is_cash))} /></Field>
      <Field label="Statement date"><DateInput value={f.statement_date} onChange={(v) => setF({ ...f, statement_date: v })} /></Field>
      <Field label="Closing balance per statement (K)"><MoneyInput value={f.statement_balance} onChange={(v) => setF({ ...f, statement_balance: v })} /></Field>
      <Field label=" "><Button variant="primary" busy={busy} disabled={!f.bank_account_id || f.statement_balance === ''} onClick={async () => { const r = await run(() => api.post('/reconciliations', f)); if (r) nav(`/banking/reconcile/${r.id}`); }}>Start</Button></Field>
    </div></Card>}
    <Card title="History" pad={false}><Loadable state={list}>{(rows) => <DataTable rows={rows} rowLink={(r) => `/banking/reconcile/${r.id}`}
      columns={[{ key: 'statement_date', label: 'Statement date', type: 'date' }, { key: 'bank_account_name', label: 'Account' }, { key: 'statement_balance', label: 'Statement balance', type: 'money' }, { key: 'book_balance', label: 'Book balance', type: 'money' }, { key: 'status', label: 'Status', type: 'status' }, { key: 'completed_by_name', label: 'Completed by' }]} />}</Loadable></Card>
  </div>;
}

function ReconcileOne() {
  const { id } = useParams(); const nav = useNavigate(); const { confirm } = useToast();
  const state = useApi(`/reconciliations/${id}`); const [run, busy] = useAction();
  const toggle = async (ids, cleared) => { const r = await run(() => api.post(`/reconciliations/${id}/clear`, { line_ids: ids, cleared })); if (r) state.setData(r); };
  return <Loadable state={state}>{(r) => { const open = r.status === 'IN_PROGRESS'; const diff = Number(r.difference); return <div className="stack">
    <PageHeader back="/banking/reconcile" title={<span className="row-gap">Reconcile {r.bank_account_name} <StatusBadge status={r.status} /></span>} subtitle={`Statement date ${fmtDate(r.statement_date)}`}
      actions={<>{open && <Button variant="danger" onClick={async () => { if (await confirm({ title: 'Delete this reconciliation?', message: 'Cleared marks on unreconciled lines are kept.', danger: true }) && await run(() => api.del(`/reconciliations/${id}`), 'Deleted.')) nav('/banking/reconcile'); }}>Delete</Button>}
        {open && <Button variant="primary" busy={busy} disabled={diff !== 0} onClick={async () => { const x = await run(() => api.post(`/reconciliations/${id}/complete`), 'Reconciliation completed.'); if (x) state.setData(x); }}>Complete reconciliation</Button>}
        <Link className="btn" to={`/reports/bank-reconciliation?reconciliation_id=${id}`}>Report</Link></>} />
    <div className="kpis"><Kpi label="Statement balance" value={r.statement_balance} /><Kpi label="Cleared balance" value={r.cleared_balance} /><Kpi label="Difference" value={r.difference} hint={diff === 0 ? 'Balanced — ready to complete' : 'Clear transactions until this is zero'} deltaTone={diff === 0 ? 'up' : 'down'} /><Kpi label="Book balance" value={r.book_balance} /></div>
    {open && diff !== 0 && <Alert tone="info">Tick each transaction that appears on the bank statement. Statement lines matched on the Banking page are already ticked.</Alert>}
    <Card pad={false} title="Transactions up to the statement date" actions={open && <><Button size="sm" onClick={() => toggle(r.lines.filter((l) => !l.cleared).map((l) => l.id), true)}>Tick all</Button><Button size="sm" onClick={() => toggle(r.lines.filter((l) => l.cleared && !l.reconciliation_id).map((l) => l.id), false)}>Untick all</Button></>}>
      <DataTable rows={r.lines} pageSize={100} columns={[{ key: 'cleared', label: 'Cleared', sortable: false, render: (v, l) => <input type="checkbox" checked={v} disabled={!open || (l.reconciliation_id && String(l.reconciliation_id) !== String(id))} onChange={(e) => toggle([l.id], e.target.checked)} aria-label="Cleared" /> },
        { key: 'entry_date', label: 'Date', type: 'date' }, { key: 'entry_number', label: 'Journal' }, { key: 'reference', label: 'Ref' }, { key: 'description', label: 'Description' },
        { key: 'debit', label: 'Money in', type: 'money', render: (v) => (Number(v) ? <Money value={v} /> : '') }, { key: 'credit', label: 'Money out', type: 'money', render: (v) => (Number(v) ? <Money value={v} /> : '') }]} />
    </Card>
  </div>; }}</Loadable>;
}

export default function Banking() {
  return <Routes><Route index element={<Overview />} /><Route path="reconcile" element={<Reconcile />} /><Route path="reconcile/:id" element={<ReconcileOne />} /><Route path=":id" element={<Account />} /></Routes>;
}
