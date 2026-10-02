import { useState } from 'react';
import { Link } from 'react-router-dom';
import { qs } from '../lib/api.js';
import { useSession } from '../lib/session.jsx';
import { fmtK, monthStart, today, addMonths, monthEnd } from '../lib/format.js';
import { PageHeader, Card, useApi, Loadable, Tabs, Field, DateInput, Badge, Alert, LinkButton, Select } from '../components/ui.jsx';
import { DataTable } from '../components/DataTable.jsx';
import { Chat } from '../components/AIPanel.jsx';
import { Markdown } from '../components/Markdown.jsx';

const TONE = { positive: 'positive', warning: 'warning', critical: 'negative', info: 'info' };

function Analyst() {
  const lastMonth = addMonths(monthStart(), -1);
  const [r, setR] = useState({ from: lastMonth, to: monthEnd(lastMonth) });
  const state = useApi(`/ai/analysis${qs(r)}`);
  return <div className="stack">
    <div className="toolbar"><Field label="From"><DateInput value={r.from} onChange={(v) => setR({ ...r, from: v })} /></Field><Field label="To"><DateInput value={r.to} onChange={(v) => setR({ ...r, to: v })} /></Field>
      <Field label="Quick"><Select value="" placeholder="Choose…" onChange={(v) => { if (v === 'tm') setR({ from: monthStart(), to: today() }); if (v === 'lm') setR({ from: lastMonth, to: monthEnd(lastMonth) }); if (v === 'q') setR({ from: addMonths(monthStart(), -2), to: today() }); }} options={[{ value: 'tm', label: 'This month' }, { value: 'lm', label: 'Last month' }, { value: 'q', label: 'Last 3 months' }]} /></Field></div>
    <Loadable state={state}>{(a) => <>
      <p className="muted" style={{ margin: 0 }}>Comparing {a.period.from} – {a.period.to} with {a.previous.from} – {a.previous.to}. Every statement below shows the figures it is based on.</p>
      {a.narrative && <Card title="Commentary"><Markdown text={a.narrative} /><p className="t-small">Written by Claude using only the figures shown on this page.</p></Card>}
      <Card title="Findings">{a.insights.map((i, k) => <div key={k} className="insight"><div className="row-gap"><Badge tone={TONE[i.severity]}>{i.title}</Badge></div><p style={{ margin: '6px 0 0' }}>{i.text}</p>
        <div className="figs">{i.figures.map((f, j) => <span key={j} className="fig">{f.label}: <span className="num">{fmtK(f.value)}</span></span>)}</div></div>)}</Card>
      <Card title="Biggest changes in costs" pad={false}><DataTable searchable={false} rows={a.expense_changes.map((x, i) => ({ ...x, id: i }))} columns={[{ key: 'category', label: 'Category' }, { key: 'previous', label: 'Previous', type: 'money' }, { key: 'current', label: 'Current', type: 'money' }, { key: 'change', label: 'Change', type: 'money' }]} /></Card>
    </>}</Loadable>
  </div>;
}

function Bookkeeper() {
  const { can } = useSession();
  const drafts = useApi('/expenses?ai=true&status=DRAFT,PENDING_APPROVAL');
  return <div className="stack">
    <Card title="AI bookkeeping"><p style={{ marginTop: 0 }}>Upload receipts, supplier invoices or fuel slips. The AI reads the date, vendor, invoice number, total and VAT, suggests the account and payment method, and prepares a <strong>draft</strong>. You review and approve it — uncertain items are never posted automatically.</p>
      <div className="row-gap wrap">{can('create_expense') && <LinkButton variant="primary" icon="upload" to="/expenses/scan">Scan a receipt or invoice</LinkButton>}<LinkButton to="/approvals">Go to approvals</LinkButton>{can('manage_banking') && <LinkButton to="/banking">Import a bank statement</LinkButton>}</div></Card>
    <Card title="AI drafts waiting for review" pad={false}><Loadable state={drafts}>{(d) => <DataTable rows={d.items} rowLink={(r) => `/expenses/${r.id}`} searchable={false}
      columns={[{ key: 'number', label: 'Number' }, { key: 'expense_date', label: 'Date', type: 'date' }, { key: 'payee', label: 'Payee' }, { key: 'category', label: 'Suggested category' }, { key: 'status', label: 'Status', type: 'status' }, { key: 'total', label: 'Total', type: 'money' }]} empty={{ title: 'No AI drafts waiting', text: 'Scan a receipt to create one.' }} />}</Loadable></Card>
  </div>;
}

export default function AIPage() {
  const { can, me } = useSession();
  const [tab, setTab] = useState('chat');
  const status = useApi('/ai/status');
  return <div className="stack">
    <PageHeader title={me.settings?.ai?.assistant_name || 'TAEL Assistant'} subtitle="AI that works from your real ledger — it never invents figures and never posts without approval." />
    {status.data?.mode === 'built-in' && <Alert tone="info" title="Built-in mode.">The assistant is answering with the built-in engine. {me.user.is_super_admin || can('manage_ai') ? <>Add an Anthropic API key in <Link to="/admin/ai">Admin Center → AI Settings</Link> for full natural-language conversation and better receipt reading.</> : 'Ask your administrator to add an AI key for full natural-language conversation.'}</Alert>}
    <Tabs tabs={[{ value: 'chat', label: 'Assistant' }, { value: 'bookkeeper', label: 'Bookkeeper' }, ...(can('view_reports') ? [{ value: 'analyst', label: 'Financial analyst' }] : []), ...(can('review_anomalies') ? [{ value: 'anomalies', label: 'Anomalies' }] : [])]} value={tab} onChange={setTab} />
    {tab === 'chat' && <Card pad={false}><Chat /></Card>}
    {tab === 'bookkeeper' && <Bookkeeper />}
    {tab === 'analyst' && <Analyst />}
    {tab === 'anomalies' && <Card><p style={{ marginTop: 0 }}>Anomaly detection checks for duplicate transactions and supplier invoices, unusually large expenses, unusual payment patterns, unexpected month-on-month changes, possible misclassification and missing receipts. Results are listed in the review queue with neutral wording.</p><LinkButton variant="primary" to="/review">Open review queue</LinkButton></Card>}
  </div>;
}
