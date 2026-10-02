import { useEffect, useRef, useState } from 'react';
import { NavLink, Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useSession, applyBranding, localStorageGet, localStorageSet } from '../lib/session.jsx';
import { api } from '../lib/api.js';
import { fmtDateTime } from '../lib/format.js';
import { Icon, Button, Badge } from './ui.jsx';
import { AIPanel } from './AIPanel.jsx';

const NAV = [
  { to: '/', label: 'Dashboard', icon: 'dashboard', perm: ['view_dashboard'], end: true },
  { section: 'Sales', icon: 'sales', items: [
    { to: '/sales/invoices', label: 'Invoices', perm: ['view_sales'] }, { to: '/sales/quotes', label: 'Quotations & orders', perm: ['view_sales'] },
    { to: '/sales/credit-notes', label: 'Credit notes', perm: ['view_sales'] }, { to: '/sales/customers', label: 'Customers', perm: ['view_sales'] }] },
  { section: 'Purchases', icon: 'purchases', items: [
    { to: '/purchases/bills', label: 'Bills', perm: ['view_purchases'] }, { to: '/purchases/orders', label: 'Purchase orders', perm: ['view_purchases'] },
    { to: '/purchases/debit-notes', label: 'Debit notes', perm: ['view_purchases'] }, { to: '/purchases/suppliers', label: 'Suppliers', perm: ['view_purchases'] }] },
  { section: 'Money', icon: 'payments', items: [
    { to: '/payments?direction=IN', label: 'Receipts', perm: ['view_payments'] }, { to: '/payments?direction=OUT', label: 'Supplier payments', perm: ['view_payments'] },
    { to: '/expenses', label: 'Expenses', perm: ['view_expenses'] }, { to: '/banking', label: 'Banking', perm: ['view_banking'] }, { to: '/banking/reconcile', label: 'Reconciliation', perm: ['reconcile_bank'] }] },
  { section: 'Accounting', icon: 'ledger', items: [
    { to: '/journals', label: 'Journals', perm: ['view_ledger'] }, { to: '/journals/recurring', label: 'Recurring journals', perm: ['view_ledger'] },
    { to: '/accounts', label: 'Chart of accounts', perm: ['view_ledger'] }, { to: '/approvals', label: 'Approvals', perm: ['approve_transactions', 'approve_expense', 'approve_purchase', 'approve_invoice'] },
    { to: '/review', label: 'Review queue', perm: ['review_anomalies'] }, { to: '/documents', label: 'Documents', perm: ['upload_documents'] }] },
  { section: 'Insights', icon: 'reports', items: [
    { to: '/reports', label: 'Reports', perm: ['view_reports'] }, { to: '/performance', label: 'Customer & supplier performance', perm: ['view_reports'] }, { to: '/ai', label: 'AI assistant & analyst', perm: ['use_ai'] }] },
  { to: '/admin', label: 'Admin Center', icon: 'admin', perm: ['manage_settings', 'manage_users', 'manage_company', 'manage_roles', 'manage_tax', 'manage_ai', 'manage_integrations', 'manage_backups', 'view_audit_logs', 'manage_periods'] },
];

function Logo({ me }) {
  const b = me.settings?.branding || {};
  const dark = document.documentElement.dataset.theme === 'dark';
  // Dark mode prefers the dark-background logo; light mode prefers the light-background logo; both fall back to the main logo.
  const order = dark ? ['logo_dark', 'logo', 'logo_light'] : ['logo_light', 'logo', 'logo_dark'];
  const id = order.find((k) => b[`${k}_document_id`]) || null;
  if (id) return <img src={`/api/public/branding/${me.company.id}/${id}?v=${b[`${id}_document_id`]}`} alt={me.company.name} className="brand-logo" />;
  return <div className="brand-mark"><svg width="28" height="28" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="7" fill="var(--brand)" /><path d="M8 10h16M16 10v13" stroke="var(--on-brand)" strokeWidth="3.2" strokeLinecap="round" /><circle cx="23.5" cy="22.5" r="2.5" fill="var(--accent)" /></svg><span>{me.company.name}</span></div>;
}

function Sidebar({ open, onClose }) {
  const { me, can } = useSession();
  const loc = useLocation();
  const full = loc.pathname + loc.search;
  const isActive = (to) => (to.includes('?') ? full === to : loc.pathname === to || (to !== '/' && loc.pathname.startsWith(`${to}/`) && !NAV.some((n) => n.items?.some((i) => i.to !== to && i.to.startsWith(to) && loc.pathname.startsWith(i.to)))));
  return <>
    <div className={`scrim ${open ? 'show' : ''}`} onClick={onClose} />
    <nav className={`sidebar ${open ? 'open' : ''}`} aria-label="Main">
      <div className="sidebar-brand"><Logo me={me} /></div>
      {me.company.is_demo && <div className="demo-flag">DEMO DATA</div>}
      <div className="nav">
        {NAV.map((n) => {
          if (n.to) return can(...n.perm) && <NavLink key={n.to} to={n.to} end={n.end} className="nav-item" onClick={onClose}><Icon name={n.icon} />{n.label}</NavLink>;
          const items = n.items.filter((i) => can(...i.perm));
          if (!items.length) return null;
          return <div key={n.section} className="nav-group"><div className="nav-section"><Icon name={n.icon} size={16} />{n.section}</div>
            {items.map((i) => <Link key={i.to} to={i.to} className={`nav-item sub ${isActive(i.to) ? 'active' : ''}`} onClick={onClose}>{i.label}</Link>)}</div>;
        })}
      </div>
    </nav>
  </>;
}

function GlobalSearch() {
  const [q, setQ] = useState(''); const [res, setRes] = useState([]); const [open, setOpen] = useState(false);
  const nav = useNavigate(); const box = useRef(null);
  useEffect(() => {
    if (q.trim().length < 2) { setRes([]); return undefined; }
    const t = setTimeout(() => api.get(`/search?q=${encodeURIComponent(q)}`).then(setRes).catch(() => setRes([])), 200);
    return () => clearTimeout(t);
  }, [q]);
  useEffect(() => { const h = (e) => { if (!box.current?.contains(e.target)) setOpen(false); }; document.addEventListener('mousedown', h); return () => document.removeEventListener('mousedown', h); }, []);
  useEffect(() => { const h = (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'k') { e.preventDefault(); box.current?.querySelector('input')?.focus(); } }; document.addEventListener('keydown', h); return () => document.removeEventListener('keydown', h); }, []);
  const go = (r) => { setOpen(false); setQ(''); nav(r.link); };
  return <div className="search" ref={box}>
    <Icon name="search" size={16} className="search-icon" />
    <input className="input" placeholder="Search customers, invoices, transactions…" value={q} onChange={(e) => { setQ(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)}
      onKeyDown={(e) => { if (e.key === 'Enter' && res[0]) go(res[0]); }} aria-label="Global search" />
    {open && q.trim().length >= 2 && <div className="menu search-menu">{res.length ? res.slice(0, 14).map((r, i) => <button key={i} className="menu-item" onClick={() => go(r)}>
      <span className="menu-type">{r.type.replace('_', ' ')}</span><span><strong>{r.title}</strong><br /><span className="t-small">{r.subtitle}</span></span></button>) : <div className="menu-empty">No results</div>}</div>}
  </div>;
}

function Notifications() {
  const [data, setData] = useState({ items: [], unread: 0 }); const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const load = () => api.get('/notifications').then(setData).catch(() => {});
  useEffect(() => { load(); const t = setInterval(load, 120000); return () => clearInterval(t); }, []);
  useEffect(() => { const h = (e) => { if (!ref.current?.contains(e.target)) setOpen(false); }; document.addEventListener('mousedown', h); return () => document.removeEventListener('mousedown', h); }, []);
  const readAll = async () => { await api.post('/notifications/read', { ids: data.items.filter((i) => !i.is_read).map((i) => i.id) }); load(); };
  return <div className="pop" ref={ref}>
    <Button variant="ghost" icon="bell" aria-label={`Notifications (${data.unread} unread)`} onClick={() => setOpen(!open)} />
    {data.unread > 0 && <span className="dot-count">{data.unread > 9 ? '9+' : data.unread}</span>}
    {open && <div className="menu notif-menu"><div className="menu-head"><strong>Notifications</strong>{data.unread > 0 && <button className="linkish" onClick={readAll}>Mark all read</button>}</div>
      {data.items.length ? data.items.map((n) => <Link key={n.id} to={n.link || '/'} className={`menu-item ${n.is_read ? '' : 'unread'}`} onClick={() => { setOpen(false); api.post('/notifications/read', { ids: [n.id] }).then(load); }}>
        <span><strong>{n.title}</strong>{n.body && <><br /><span className="t-small">{n.body}</span></>}<br /><span className="t-small">{fmtDateTime(n.created_at)}</span></span></Link>) : <div className="menu-empty">You're all caught up.</div>}</div>}
  </div>;
}

function UserMenu() {
  const { me, logout, refresh } = useSession();
  const [open, setOpen] = useState(false); const ref = useRef(null); const nav = useNavigate();
  useEffect(() => { const h = (e) => { if (!ref.current?.contains(e.target)) setOpen(false); }; document.addEventListener('mousedown', h); return () => document.removeEventListener('mousedown', h); }, []);
  const theme = localStorageGet('tael-theme') || me.settings?.branding?.theme || 'system';
  const setTheme = (t) => { localStorageSet('tael-theme', t); applyBranding(me.settings?.branding, me.company.id, me.company.name); setOpen(false); refresh(); };
  const switchCo = async (id) => { await api.post('/auth/switch-company', { company_id: id }); setOpen(false); await refresh(); nav('/'); };
  return <div className="pop" ref={ref}>
    <button className="user-btn" onClick={() => setOpen(!open)} aria-haspopup="menu" aria-expanded={open}><span className="avatar">{me.user.name.split(' ').map((x) => x[0]).slice(0, 2).join('')}</span><span className="user-meta"><strong>{me.user.name}</strong><span className="t-small">{me.role}</span></span><Icon name="down" size={14} /></button>
    {open && <div className="menu user-menu" role="menu">
      <div className="menu-head"><span className="t-small">{me.user.email}</span></div>
      {me.companies?.length > 1 && <><div className="menu-label">Switch company</div>{me.companies.map((c) => <button key={c.id} className={`menu-item ${c.id === me.company.id ? 'unread' : ''}`} onClick={() => switchCo(c.id)}>{c.name}{c.is_demo && <Badge tone="accent">Demo</Badge>}</button>)}</>}
      <div className="menu-label">Theme</div>
      <div className="seg">{['light', 'dark', 'system'].map((t) => <button key={t} className={theme === t ? 'on' : ''} onClick={() => setTheme(t)}>{t[0].toUpperCase() + t.slice(1)}</button>)}</div>
      <Link className="menu-item" to="/profile" onClick={() => setOpen(false)}>Profile & password</Link>
      <button className="menu-item" onClick={logout}><Icon name="logout" size={16} />Sign out</button>
    </div>}
  </div>;
}

export function Layout() {
  const { me, can } = useSession();
  const [nav, setNav] = useState(false);
  const [ai, setAi] = useState(false);
  const loc = useLocation();
  useEffect(() => { setNav(false); }, [loc.pathname]);
  return <div className="shell">
    <Sidebar open={nav} onClose={() => setNav(false)} />
    <div className="main">
      <header className="topbar">
        <Button variant="ghost" icon="menu" className="hamburger" aria-label="Open menu" onClick={() => setNav(true)} />
        {can('search', 'view_dashboard') && <GlobalSearch />}
        <div className="topbar-right">
          {can('use_ai') && me.settings?.ai?.enabled !== false && <Button variant="ghost" icon="ai" onClick={() => setAi(true)} className="ai-btn">{me.settings?.ai?.assistant_name || 'Assistant'}</Button>}
          <Notifications />
          <UserMenu />
        </div>
      </header>
      <main className="content" id="main"><Outlet /></main>
    </div>
    {ai && <AIPanel onClose={() => setAi(false)} />}
  </div>;
}
