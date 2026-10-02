import { useMemo, useState } from 'react';
import { Routes, Route, useParams, useSearchParams, Link, useLocation, useNavigate } from 'react-router-dom';
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid } from 'recharts';
import { download, qs } from '../lib/api.js';
import { useSession } from '../lib/session.jsx';
import { fmtK, fmtDate, today, monthStart, yearStart, isNeg, titleCase } from '../lib/format.js';
import { PageHeader, Card, useApi, Loadable, Button, Field, Select, DateInput, Input, Alert, Tabs, useAction, Kpi } from '../components/ui.jsx';
import { DataTable, cell } from '../components/DataTable.jsx';
import { useLookup, partyOptions } from '../components/lookups.js';

const GROUPS = [
  ['Financial statements', ['profit-and-loss', 'balance-sheet', 'cash-flow', 'trial-balance', 'general-ledger', 'journal']],
  ['Receivables & payables', ['ar-aging', 'ap-aging', 'customer-statement', 'supplier-statement']],
  ['Sales, purchases & expenses', ['sales', 'purchases', 'expenses', 'income']],
  ['Tax', ['tax']],
  ['Cash & bank', ['cashbook', 'bank-reconciliation']],
  ['Control', ['audit']],
];
const DESCRIPTIONS = {
  'profit-and-loss': 'Revenue, cost of sales, expenses and net profit, with period comparison.', 'balance-sheet': 'Statement of financial position: assets, liabilities and equity.', 'cash-flow': 'Cash in and out by operating, investing and financing activities.',
  'trial-balance': 'Debit and credit balance of every account — always balances.', 'general-ledger': 'Every posted line by account with running balances.', journal: 'All journals with their debit and credit lines.',
  'ar-aging': 'What customers owe, by days overdue.', 'ap-aging': 'What you owe suppliers, by days overdue.', 'customer-statement': 'Statement of account to send to a customer.', 'supplier-statement': 'Supplier account history and balance.',
  sales: 'Net sales by customer, month, item or account.', purchases: 'Purchases by supplier, month or account.', expenses: 'Expenses by category, month, department or branch.', income: 'Income by account or month.',
  tax: 'VAT output vs input and withholding tax for the period.', cashbook: 'Receipts and payments per bank/cash account.', 'bank-reconciliation': 'Reconciliation history and statements.', audit: 'Who did what and when — immutable log.',
};

function Index() {
  const state = useApi('/reports');
  return <div className="stack"><PageHeader title="Reports" subtitle="All reports are calculated live from posted transactions and can be exported to PDF or Excel." />
    <Loadable state={state}>{(list) => { const avail = new Set(list.map((r) => r.slug)); const label = Object.fromEntries(list.map((r) => [r.slug, r.label]));
      return <div className="grid grid-3">{GROUPS.map(([g, slugs]) => slugs.some((s) => avail.has(s)) && <Card key={g} title={g}><div className="stack-sm">{slugs.filter((s) => avail.has(s)).map((s) => <div key={s}><Link to={`/reports/${s}`}><strong>{label[s]}</strong></Link><div className="t-small">{DESCRIPTIONS[s]}</div></div>)}</div></Card>)}</div>; }}</Loadable>
  </div>;
}

const STRUCT = new Set(['header', 'subheader', 'subtotal', 'total', 'grand', 'subtle']);
function rowHref(r, slug, report) {
  if (r.entry_id) return `/journals/${r.entry_id}`;
  if (r.account_id) return `/reports/general-ledger?account_id=${r.account_id}&from=${report.from || yearStart()}&to=${report.to || report.as_of || today()}`;
  if (r.party_id && slug === 'ar-aging') return `/reports/customer-statement?customer_id=${r.party_id}`;
  if (r.party_id && slug === 'ap-aging') return `/reports/supplier-statement?supplier_id=${r.party_id}`;
  if (r._link?.reconciliation_id) return `/reports/bank-reconciliation?reconciliation_id=${r._link.reconciliation_id}`;
  return null;
}

export function ReportTable({ report, slug }) {
  const [q, setQ] = useState('');
  const nav = useNavigate();
  const structured = report.rows.some((r) => r._style && r._style !== 'total');
  if (!structured) {
    const totalRow = report.rows.find((r) => r._style === 'total');
    const rows = report.rows.filter((r) => r._style !== 'total');
    return <DataTable rows={rows.map((r, i) => ({ ...r, _k: i }))} rowKey="_k" columns={report.columns} pageSize={50} rowLink={(r) => rowHref(r, slug, report)}
      footer={totalRow && <tr className="row-total">{report.columns.map((c) => <td key={c.key} className={['money', 'number', 'percent'].includes(c.type) ? 'r' : ''}>{cell(c, totalRow)}</td>)}</tr>} />;
  }
  const rows = q ? report.rows.filter((r) => r._style || report.columns.some((c) => String(r[c.key] ?? '').toLowerCase().includes(q.toLowerCase()))) : report.rows;
  return <div><div className="dt-toolbar no-print"><Input type="search" placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} className="dt-search" aria-label="Search report" /></div>
    <div className="table-wrap"><table className="table"><thead><tr>{report.columns.map((c) => <th key={c.key} className={['money', 'number', 'percent'].includes(c.type) ? 'r' : ''}>{c.label}</th>)}</tr></thead>
      <tbody>{rows.map((r, i) => { const href = rowHref(r, slug, report); return <tr key={i} className={`${r._style ? `row-${r._style}` : ''} ${href ? 'clickable' : ''}`} onClick={href ? () => nav(href) : undefined}>
        {report.columns.map((c, j) => <td key={c.key} className={['money', 'number', 'percent'].includes(c.type) ? 'r num' : ''} style={j === 0 && r._indent ? { paddingLeft: 12 + r._indent * 16 } : undefined}>{cell(c, r)}</td>)}</tr>; })}</tbody></table></div></div>;
}

function Params({ slug, params, value, onChange }) {
  const customers = useLookup(params.includes('customer_id') ? '/customers' : null);
  const suppliers = useLookup(params.includes('supplier_id') ? '/suppliers' : null);
  const accounts = useLookup(params.includes('account_id') ? '/accounts' : null);
  const branches = useLookup(params.includes('branch_id') ? '/admin/branches' : null);
  const departments = useLookup(params.includes('department_id') ? '/admin/departments' : null);
  const recs = useLookup(params.includes('reconciliation_id') ? '/reconciliations' : null);
  const set = (k) => (v) => onChange({ ...value, [k]: v });
  const presets = [['This month', monthStart(), today()], ['Year to date', yearStart(), today()], ['Last year', `${Number(today().slice(0, 4)) - 1}-01-01`, `${Number(today().slice(0, 4)) - 1}-12-31`]];
  const asOf = !params.includes('from') && params.includes('to');
  return <div className="toolbar no-print">
    {params.includes('from') && <Field label="From"><DateInput value={value.from || ''} onChange={set('from')} /></Field>}
    {params.includes('to') && <Field label={asOf ? 'As at' : 'To'}><DateInput value={value.to || ''} onChange={set('to')} /></Field>}
    {params.includes('from') && <Field label="Quick range"><Select value="" onChange={(i) => i !== '' && onChange({ ...value, from: presets[i][1], to: presets[i][2] })} placeholder="Choose…" options={presets.map((p, i) => ({ value: i, label: p[0] }))} /></Field>}
    {params.includes('compare') && <Field label="Compare with"><Select value={value.compare || 'none'} onChange={set('compare')} options={[{ value: 'none', label: 'No comparison' }, { value: 'previous_period', label: 'Previous period' }, { value: 'previous_year', label: 'Same period last year' }]} /></Field>}
    {params.includes('group_by') && <Field label="Group by"><Select value={value.group_by || ''} onChange={set('group_by')} placeholder="Default" options={(slug === 'sales' ? ['customer', 'month', 'item', 'account'] : slug === 'purchases' ? ['supplier', 'month', 'account'] : ['account', 'month', 'department', 'branch', 'supplier', 'customer']).map((g) => ({ value: g, label: titleCase(g) }))} /></Field>}
    {params.includes('customer_id') && <Field label="Customer"><Select value={value.customer_id || ''} onChange={set('customer_id')} placeholder={slug.includes('statement') ? 'Choose…' : 'All'} options={partyOptions(customers)} /></Field>}
    {params.includes('supplier_id') && <Field label="Supplier"><Select value={value.supplier_id || ''} onChange={set('supplier_id')} placeholder={slug.includes('statement') ? 'Choose…' : 'All'} options={partyOptions(suppliers)} /></Field>}
    {params.includes('account_id') && <Field label="Account"><Select value={value.account_id || ''} onChange={set('account_id')} placeholder="All" options={accounts.filter((a) => slug !== 'cashbook' || a.is_bank).map((a) => ({ value: a.id, label: `${a.code} ${a.name}` }))} /></Field>}
    {params.includes('branch_id') && branches.length > 1 && <Field label="Branch"><Select value={value.branch_id || ''} onChange={set('branch_id')} placeholder="All" options={branches.map((b) => ({ value: b.id, label: b.name }))} /></Field>}
    {params.includes('department_id') && <Field label="Department"><Select value={value.department_id || ''} onChange={set('department_id')} placeholder="All" options={departments.map((b) => ({ value: b.id, label: b.name }))} /></Field>}
    {params.includes('reconciliation_id') && <Field label="Reconciliation"><Select value={value.reconciliation_id || ''} onChange={set('reconciliation_id')} placeholder="History (all)" options={recs.map((r) => ({ value: r.id, label: `${r.bank_account_name} · ${fmtDate(r.statement_date)}` }))} /></Field>}
    {params.includes('source_type') && <Field label="Source"><Select value={value.source_type || ''} onChange={set('source_type')} placeholder="All" options={['MANUAL', 'AI', 'INVOICE', 'CREDIT_NOTE', 'BILL', 'DEBIT_NOTE', 'RECEIPT', 'PAYMENT', 'EXPENSE', 'BANK', 'OPENING', 'REVERSAL', 'RECURRING'].map((s) => ({ value: s, label: titleCase(s) }))} /></Field>}
    {params.includes('action') && <Field label="Action contains"><Input value={value.action || ''} onChange={(e) => set('action')(e.target.value)} /></Field>}
  </div>;
}

function ReportView() {
  const { slug } = useParams();
  const [sp, setSp] = useSearchParams();
  const { can } = useSession();
  const list = useApi('/reports');
  const def = list.data?.find((r) => r.slug === slug);
  const params = Object.fromEntries(sp.entries());
  const needsParty = (slug === 'customer-statement' && !params.customer_id) || (slug === 'supplier-statement' && !params.supplier_id);
  const state = useApi(def && !needsParty ? `/reports/${slug}${qs(params)}` : null);
  const [run, busy] = useAction();
  const exp = (format) => run(() => download(`/reports/${slug}${qs({ ...params, format })}`), `${format.toUpperCase()} downloaded.`);
  return <div className="stack">
    <PageHeader back="/reports" title={def?.label || 'Report'} subtitle={state.data?.subtitle}
      actions={can('export_reports') && state.data && <><Button size="sm" icon="printer" onClick={() => window.print()}>Print</Button><Button size="sm" icon="download" busy={busy} onClick={() => exp('pdf')}>PDF</Button><Button size="sm" icon="download" busy={busy} onClick={() => exp('xlsx')}>Excel</Button></>} />
    {def && <Params slug={slug} params={def.params} value={params} onChange={(v) => setSp(Object.fromEntries(Object.entries(v).filter(([, x]) => x !== '' && x != null)))} />}
    {needsParty && <Alert tone="info">Choose a {slug.startsWith('customer') ? 'customer' : 'supplier'} to view the statement.</Alert>}
    <Loadable state={state}>{(r) => <>
      {r.balanced === false && <Alert tone="error" title="Out of balance.">The report does not balance — contact your administrator.</Alert>}
      {r.balanced === true && <Alert tone="success">Balanced — total debits equal total credits{slug === 'balance-sheet' ? ' (assets = liabilities + equity)' : ''}.</Alert>}
      {r.note && <Alert tone="info">{r.note}</Alert>}
      {slug.endsWith('statement') && r.party && <div className="kpis"><Kpi label="Balance due" value={r.balance} />{r.aging && ['current', 'd1_30', 'd31_60', 'd61_90', 'd90p'].map((k) => <Kpi key={k} label={{ current: 'Not yet due', d1_30: '1–30 days', d31_60: '31–60 days', d61_90: '61–90 days', d90p: '90+ days' }[k]} value={r.aging[k]} />)}</div>}
      <Card pad={false}><ReportTable report={r} slug={slug} /></Card>
      {r.detail?.length > 0 && <Card title="Outstanding documents" pad={false}><DataTable rows={r.detail} rowKey="number" rowLink={(x) => `/${slug === 'ar-aging' ? 'sales' : 'purchases'}/documents/${x.document_id}`}
        columns={[{ key: 'number', label: 'Document' }, { key: 'party', label: slug === 'ar-aging' ? 'Customer' : 'Supplier' }, { key: 'doc_date', label: 'Date', type: 'date' }, { key: 'due_date', label: 'Due', type: 'date' }, { key: 'days_overdue', label: 'Days overdue', type: 'number' }, { key: 'bucket', label: 'Bucket' }, { key: 'outstanding', label: 'Outstanding', type: 'money' }]} /></Card>}
    </>}</Loadable>
  </div>;
}

function Performance() {
  const [sp, setSp] = useSearchParams();
  const kind = sp.get('kind') || 'customers';
  const [f, setF] = useState({ from: yearStart(), to: today(), branch_id: '', department_id: '', party: '' });
  const branches = useLookup('/admin/branches'); const departments = useLookup('/admin/departments');
  const parties = useLookup(`/${kind}`);
  const state = useApi(`/performance/${kind}${qs({ from: f.from, to: f.to, branch_id: f.branch_id, department_id: f.department_id, [`${kind.slice(0, -1)}_id`]: f.party })}`);
  const isC = kind === 'customers';
  return <div className="stack">
    <PageHeader title="Customer & supplier performance" subtitle="Sales, purchases, collections and balances from posted documents and the ledger" />
    <Tabs tabs={[{ value: 'customers', label: 'Customers' }, { value: 'suppliers', label: 'Suppliers' }]} value={kind} onChange={(v) => { setSp({ kind: v }); setF({ ...f, party: '' }); }} />
    <div className="toolbar"><Field label="From"><DateInput value={f.from} onChange={(v) => setF({ ...f, from: v })} /></Field><Field label="To"><DateInput value={f.to} onChange={(v) => setF({ ...f, to: v })} /></Field>
      <Field label={isC ? 'Customer' : 'Supplier'}><Select value={f.party} onChange={(v) => setF({ ...f, party: v })} placeholder="All" options={partyOptions(parties)} /></Field>
      <Field label="Branch"><Select value={f.branch_id} onChange={(v) => setF({ ...f, branch_id: v })} placeholder="All" options={branches.map((b) => ({ value: b.id, label: b.name }))} /></Field>
      <Field label="Department"><Select value={f.department_id} onChange={(v) => setF({ ...f, department_id: v })} placeholder="All" options={departments.map((b) => ({ value: b.id, label: b.name }))} /></Field></div>
    <Loadable state={state}>{(d) => { const tot = (k) => d.rows.reduce((s, r) => s + Number(r[k] || 0), 0).toFixed(2); const monthly = d.monthly.map((m) => ({ label: m.month, v: Number(m.amount), p: Number(d.payments.find((x) => x.month === m.month)?.amount || 0) })); return <>
      <div className="kpis"><Kpi label={isC ? 'Total sales (net)' : 'Total purchases (net)'} value={tot('net_amount')} /><Kpi label={isC ? 'Amount received' : 'Amount paid'} value={tot('amount_paid')} /><Kpi label="Outstanding" value={tot('outstanding')} /><Kpi label="Overdue" value={tot('overdue')} />{isC && <Kpi label="Gross profit (direct costs tagged)" value={tot('gross_profit')} />}</div>
      <Card title={`${isC ? 'Sales' : 'Purchases'} and ${isC ? 'collections' : 'payments'} by month`}><div className="chart-box"><ResponsiveContainer><BarChart data={monthly}><CartesianGrid stroke="var(--border)" vertical={false} /><XAxis dataKey="label" tick={{ fill: 'var(--ink-muted)', fontSize: 12 }} axisLine={false} tickLine={false} />
        <YAxis tickFormatter={(v) => `K${Math.round(v / 1000)}k`} tick={{ fill: 'var(--ink-muted)', fontSize: 12 }} axisLine={false} tickLine={false} width={56} /><Tooltip formatter={(v) => fmtK(Number(v).toFixed(2))} contentStyle={{ background: 'var(--surface-100)', border: '1px solid var(--border)' }} />
        <Bar dataKey="v" name={isC ? 'Sales' : 'Purchases'} fill="var(--chart-1)" radius={[3, 3, 0, 0]} /><Bar dataKey="p" name={isC ? 'Received' : 'Paid'} fill="var(--chart-2)" radius={[3, 3, 0, 0]} /></BarChart></ResponsiveContainer></div>
        <div className="legend"><span><i style={{ background: 'var(--chart-1)' }} />{isC ? 'Sales' : 'Purchases'}</span><span><i style={{ background: 'var(--chart-2)' }} />{isC ? 'Received' : 'Paid'}</span></div></Card>
      <Card pad={false}><DataTable rows={d.rows} rowLink={(r) => `/${isC ? 'sales/customers' : 'purchases/suppliers'}/${r.id}`} initialSort={{ key: 'net_amount', dir: 'desc' }}
        columns={[{ key: 'name', label: isC ? 'Customer' : 'Supplier' }, { key: 'documents', label: isC ? 'Invoices' : 'Bills', type: 'number' }, { key: 'net_amount', label: 'Net amount', type: 'money' }, { key: 'amount_paid', label: isC ? 'Received' : 'Paid', type: 'money' },
          { key: 'outstanding', label: 'Outstanding', type: 'money' }, { key: 'overdue', label: 'Overdue', type: 'money' }, { key: 'avg_days_to_pay', label: 'Avg days to pay', type: 'number' }, ...(isC ? [{ key: 'gross_profit', label: 'Gross profit', type: 'money' }] : []), { key: 'ledger_balance', label: 'Ledger balance', type: 'money' }]} /></Card>
    </>; }}</Loadable>
  </div>;
}

export default function Reports() {
  const loc = useLocation();
  if (loc.pathname === '/performance') return <Performance />;
  return <Routes><Route index element={<Index />} /><Route path=":slug" element={<ReportView />} /></Routes>;
}
export { useMemo, isNeg };
