import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, LineChart, Line, ComposedChart, Area, Cell } from 'recharts';
import { useSession } from '../lib/session.jsx';
import { qs } from '../lib/api.js';
import { fmtK, today, monthStart, yearStart, addMonths, monthEnd } from '../lib/format.js';
import { Card, Kpi, PageHeader, Loadable, useApi, Select, Field, DateInput, Alert, Badge } from '../components/ui.jsx';
import { useLookup } from '../components/lookups.js';

export const PERIODS = {
  this_month: { label: 'This month', range: () => ({ from: monthStart(), to: today() }) },
  last_month: { label: 'Last month', range: () => { const s = addMonths(monthStart(), -1); return { from: s, to: monthEnd(s) }; } },
  this_quarter: { label: 'This quarter', range: () => { const m = Number(today().slice(5, 7)); const qm = String(Math.floor((m - 1) / 3) * 3 + 1).padStart(2, '0'); return { from: `${today().slice(0, 4)}-${qm}-01`, to: today() }; } },
  ytd: { label: 'Year to date', range: () => ({ from: yearStart(), to: today() }) },
  last_12: { label: 'Last 12 months', range: () => ({ from: addMonths(monthStart(), -11), to: today() }) },
  custom: { label: 'Custom…', range: null },
};
const axisK = (v) => (Math.abs(v) >= 1e6 ? `K${(v / 1e6).toFixed(1)}m` : Math.abs(v) >= 1e3 ? `K${Math.round(v / 1e3)}k` : `K${v}`);
const tipK = (v) => fmtK(Number(v).toFixed(2));
const monthLabel = (m) => new Date(`${m}-01T00:00:00Z`).toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' });
const C = (n) => `var(--chart-${n})`;

function pctDelta(cur, prev, goodWhenUp = true, label = 'previous period') {
  if (prev === undefined || prev === null || Number(prev) === 0) return {};
  const p = ((Number(cur) - Number(prev)) / Math.abs(Number(prev))) * 100;
  const good = goodWhenUp ? p >= 0 : p <= 0;
  return { delta: `${p >= 0 ? '▲' : '▼'} ${Math.abs(p).toFixed(1)}% vs ${label}`, deltaTone: good ? 'up' : 'down' };
}

function ChartTip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return <div className="card" style={{ padding: '8px 12px', fontSize: 12 }}><strong>{label}</strong>{payload.map((p) => <div key={p.dataKey} style={{ display: 'flex', gap: 12, justifyContent: 'space-between' }}><span><i style={{ display: 'inline-block', width: 8, height: 8, background: p.color, marginRight: 6, borderRadius: 2 }} />{p.name}</span><span className="num">{tipK(p.value)}</span></div>)}</div>;
}
const grid = <CartesianGrid stroke="var(--border)" strokeDasharray="0" vertical={false} />;
const xa = (k = 'label') => <XAxis dataKey={k} tick={{ fill: 'var(--ink-muted)', fontSize: 12 }} axisLine={{ stroke: 'var(--border)' }} tickLine={false} />;
const ya = <YAxis tickFormatter={axisK} tick={{ fill: 'var(--ink-muted)', fontSize: 12 }} axisLine={false} tickLine={false} width={56} />;

export default function Dashboard() {
  const { me, can } = useSession();
  const [period, setPeriod] = useState('ytd');
  const [custom, setCustom] = useState({ from: monthStart(), to: today() });
  const [branch, setBranch] = useState('');
  const branches = useLookup('/admin/branches');
  const range = period === 'custom' ? custom : PERIODS[period].range();
  const state = useApi(`/dashboard${qs({ ...range, branch_id: branch })}`);
  const widgets = new Set(me.settings?.dashboard?.widgets || []);
  const on = (w) => widgets.has(w);
  return <div className="stack">
    <PageHeader title={`Good ${new Date().getHours() < 12 ? 'morning' : new Date().getHours() < 17 ? 'afternoon' : 'evening'}, ${me.user.name.split(' ')[0]}`} subtitle={`${me.company.name} · figures from the posted ledger in Zambian Kwacha`}
      actions={<div className="toolbar" style={{ margin: 0 }}>
        <Field label="Period"><Select value={period} onChange={setPeriod} options={Object.entries(PERIODS).map(([v, p]) => ({ value: v, label: p.label }))} /></Field>
        {period === 'custom' && <><Field label="From"><DateInput value={custom.from} onChange={(v) => setCustom({ ...custom, from: v })} /></Field><Field label="To"><DateInput value={custom.to} onChange={(v) => setCustom({ ...custom, to: v })} /></Field></>}
        {me.settings?.features?.branches && branches.length > 1 && <Field label="Branch"><Select value={branch} onChange={setBranch} placeholder="All branches" options={branches.map((b) => ({ value: b.id, label: b.name }))} /></Field>}
      </div>} />
    {me.company.is_demo && <Alert tone="warning" title="Demo company.">All figures here are sample data for testing. Switch to your own company from the user menu.</Alert>}
    <Loadable state={state}>{(d) => <DashboardBody d={d} on={on} can={can} />}</Loadable>
  </div>;
}

function DashboardBody({ d, on, can }) {
  const k = d.kpis;
  const trend = useMemo(() => d.trend.map((t) => ({ ...t, label: monthLabel(t.month), revenue: Number(t.revenue), expenses: Number(t.expenses), profit: Number(t.profit), inflow: Number(t.inflow), outflow: -Number(t.outflow), net_cash: Number(t.net_cash) })), [d]);
  const aging = (a) => [{ label: 'Current', v: Number(a.current) }, { label: '1–30', v: Number(a.d1_30) }, { label: '31–60', v: Number(a.d31_60) }, { label: '61–90', v: Number(a.d61_90) }, { label: '90+', v: Number(a.d90p) }];
  const rv = d.review;
  return <>
    <div className="kpis">
      {on('revenue') && <Kpi label="Total revenue" value={k.revenue} {...pctDelta(k.revenue, k.revenue_prev, true, d.comparison)} to={`/reports/profit-and-loss?from=${d.period.from}&to=${d.period.to}`} />}
      {on('expenses') && <Kpi label="Total expenses" value={k.expenses} {...pctDelta(k.expenses, k.expenses_prev, false, d.comparison)} to={`/reports/expenses?from=${d.period.from}&to=${d.period.to}`} />}
      {on('net_profit') && <Kpi label="Net profit" value={k.net_profit} {...pctDelta(k.net_profit, k.net_profit_prev, true, d.comparison)} to={`/reports/profit-and-loss?from=${d.period.from}&to=${d.period.to}`} />}
      {on('cash_balance') && <Kpi label="Cash balance" value={k.cash_balance} hint="Cash & mobile money" to="/banking" />}
      {on('bank_balance') && <Kpi label="Bank balance" value={k.bank_balance} hint="All bank accounts" to="/banking" />}
      {on('receivables') && <Kpi label="Accounts receivable" value={k.receivables} hint={`${fmtK(k.overdue_receivables)} overdue`} to="/reports/ar-aging" />}
      {on('payables') && <Kpi label="Accounts payable" value={k.payables} hint={`${fmtK(k.overdue_payables)} past due`} to="/reports/ap-aging" />}
      {on('overdue_invoices') && <Kpi label="Overdue invoices" value={String(k.overdue_invoices)} money={false} hint={fmtK(k.overdue_receivables)} to="/sales/invoices?status=OVERDUE" />}
      {on('outstanding_bills') && <Kpi label="Outstanding bills" value={String(k.outstanding_bills)} money={false} hint={fmtK(k.payables)} to="/purchases/bills?status=POSTED,PARTIALLY_PAID,OVERDUE" />}
    </div>
    {on('review_queue') && (rv.flags + rv.expense_drafts + rv.journal_drafts + rv.bill_drafts + rv.unmatched_bank > 0) && <Card title="Needs attention" pad>
      <div className="row-gap wrap">
        {rv.flags > 0 && can('review_anomalies') && <Link className="btn btn-sm" to="/review"><Badge tone="warning">{rv.flags}</Badge> items require review</Link>}
        {rv.expense_drafts + rv.journal_drafts + rv.bill_drafts > 0 && <Link className="btn btn-sm" to="/approvals"><Badge tone="accent">{rv.expense_drafts + rv.journal_drafts + rv.bill_drafts}</Badge> drafts awaiting approval</Link>}
        {rv.unmatched_bank > 0 && <Link className="btn btn-sm" to="/banking"><Badge tone="info">{rv.unmatched_bank}</Badge> unmatched bank lines</Link>}
      </div>
    </Card>}
    <div className="grid grid-2">
      {on('chart_revenue_trend') && <Card title="Revenue vs expenses — last 12 months"><div className="chart-box"><ResponsiveContainer><BarChart data={trend} barGap={2}>{grid}{xa()}{ya}<Tooltip content={<ChartTip />} cursor={{ fill: 'var(--surface-200)' }} />
        <Bar dataKey="revenue" name="Revenue" fill={C(1)} radius={[3, 3, 0, 0]} /><Bar dataKey="expenses" name="Expenses" fill={C(2)} radius={[3, 3, 0, 0]} /></BarChart></ResponsiveContainer></div>
        <div className="legend"><span><i style={{ background: C(1) }} />Revenue</span><span><i style={{ background: C(2) }} />Expenses</span></div></Card>}
      {on('chart_profit_trend') && <Card title="Net profit trend"><div className="chart-box"><ResponsiveContainer><ComposedChart data={trend}>{grid}{xa()}{ya}<Tooltip content={<ChartTip />} />
        <Area dataKey="profit" name="Net profit" stroke={C(1)} fill="var(--brand-tint)" strokeWidth={2} /></ComposedChart></ResponsiveContainer></div></Card>}
      {on('chart_expense_trend') && <Card title="Expense trend"><div className="chart-box"><ResponsiveContainer><LineChart data={trend}>{grid}{xa()}{ya}<Tooltip content={<ChartTip />} />
        <Line dataKey="expenses" name="Expenses" stroke={C(2)} strokeWidth={2} dot={false} /></LineChart></ResponsiveContainer></div></Card>}
      {on('chart_cash_flow') && <Card title="Cash flow — money in and out"><div className="chart-box"><ResponsiveContainer><ComposedChart data={trend} stackOffset="sign">{grid}{xa()}{ya}<Tooltip content={<ChartTip />} />
        <Bar dataKey="inflow" name="Money in" fill={C(1)} stackId="a" /><Bar dataKey="outflow" name="Money out" fill={C(2)} stackId="a" /><Line dataKey="net_cash" name="Net" stroke="var(--ink)" strokeWidth={2} dot={false} /></ComposedChart></ResponsiveContainer></div>
        <div className="legend"><span><i style={{ background: C(1) }} />Money in</span><span><i style={{ background: C(2) }} />Money out</span><span><i style={{ background: 'var(--ink)' }} />Net</span></div></Card>}
      {on('chart_sales_by_customer') && <Card title="Sales by customer (period)">{d.sales_by_customer.length ? <div className="chart-box"><ResponsiveContainer><BarChart data={d.sales_by_customer.map((x) => ({ label: x.name, v: Number(x.amount) }))} layout="vertical" margin={{ left: 8 }}>
        <CartesianGrid stroke="var(--border)" horizontal={false} /><XAxis type="number" tickFormatter={axisK} tick={{ fill: 'var(--ink-muted)', fontSize: 12 }} axisLine={false} tickLine={false} /><YAxis type="category" dataKey="label" width={150} tick={{ fill: 'var(--ink)', fontSize: 12 }} axisLine={false} tickLine={false} />
        <Tooltip content={<ChartTip />} cursor={{ fill: 'var(--surface-200)' }} /><Bar dataKey="v" name="Net sales" fill={C(1)} radius={[0, 3, 3, 0]} /></BarChart></ResponsiveContainer></div> : <p className="muted">No sales in this period.</p>}</Card>}
      {on('chart_expenses_by_category') && <Card title="Expenses by category (period)">{d.expenses_by_category.length ? <div className="chart-box"><ResponsiveContainer><BarChart data={d.expenses_by_category.map((x) => ({ label: x.name, v: Number(x.amount) }))} layout="vertical" margin={{ left: 8 }}>
        <CartesianGrid stroke="var(--border)" horizontal={false} /><XAxis type="number" tickFormatter={axisK} tick={{ fill: 'var(--ink-muted)', fontSize: 12 }} axisLine={false} tickLine={false} /><YAxis type="category" dataKey="label" width={170} tick={{ fill: 'var(--ink)', fontSize: 12 }} axisLine={false} tickLine={false} />
        <Tooltip content={<ChartTip />} cursor={{ fill: 'var(--surface-200)' }} /><Bar dataKey="v" name="Amount" fill={C(2)} radius={[0, 3, 3, 0]} /></BarChart></ResponsiveContainer></div> : <p className="muted">No expenses in this period.</p>}</Card>}
      {on('chart_receivables_aging') && <Card title="Receivables aging" actions={<Link to="/reports/ar-aging" className="t-small">Report →</Link>}><div className="chart-box"><ResponsiveContainer><BarChart data={aging(d.receivables_aging)}>{grid}{xa()}{ya}<Tooltip content={<ChartTip />} cursor={{ fill: 'var(--surface-200)' }} />
        <Bar dataKey="v" name="Outstanding" radius={[3, 3, 0, 0]}>{aging(d.receivables_aging).map((_, i) => <Cell key={i} fill={i === 0 ? C(1) : i < 2 ? C(4) : 'var(--negative)'} />)}</Bar></BarChart></ResponsiveContainer></div></Card>}
      {on('chart_payables_aging') && <Card title="Payables aging" actions={<Link to="/reports/ap-aging" className="t-small">Report →</Link>}><div className="chart-box"><ResponsiveContainer><BarChart data={aging(d.payables_aging)}>{grid}{xa()}{ya}<Tooltip content={<ChartTip />} cursor={{ fill: 'var(--surface-200)' }} />
        <Bar dataKey="v" name="Outstanding" radius={[3, 3, 0, 0]}>{aging(d.payables_aging).map((_, i) => <Cell key={i} fill={i === 0 ? C(3) : i < 2 ? C(4) : 'var(--negative)'} />)}</Bar></BarChart></ResponsiveContainer></div></Card>}
    </div>
  </>;
}
