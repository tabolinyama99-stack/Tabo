import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import { fmtK, isNeg, STATUS_TONE, titleCase } from '../lib/format.js';

// ───────────── Icons (1.5px stroke, currentColor) ─────────────
const P = {
  dashboard: 'M3 13h8V3H3zM13 21h8V11h-8zM3 21h8v-6H3zM13 3v6h8V3z', sales: 'M4 19V9M10 19V5M16 19v-7M21 19H3', purchases: 'M6 6h15l-1.5 9h-12zM6 6 5 3H2M9 20a1 1 0 1 0 0-.01M18 20a1 1 0 1 0 0-.01',
  payments: 'M3 7h18v10H3zM3 11h18M7 15h3', expenses: 'M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6', bank: 'M3 10 12 4l9 6M5 10v8M9 10v8M15 10v8M19 10v8M3 20h18',
  ledger: 'M5 3h12a2 2 0 0 1 2 2v16H7a2 2 0 0 1-2-2zM5 17a2 2 0 0 1 2-2h12M9 7h6', reports: 'M4 20V4M4 20h16M8 16v-5M12 16V8M16 16v-3', ai: 'M12 3l1.8 4.7L18.5 9l-4.7 1.8L12 15.5l-1.8-4.7L5.5 9l4.7-1.3zM18 15l.9 2.1 2.1.9-2.1.9L18 21l-.9-2.1L15 18l2.1-.9z',
  admin: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM21 21l-4.3-4.3', bell: 'M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0', menu: 'M3 6h18M3 12h18M3 18h18',
  x: 'M18 6 6 18M6 6l12 12', plus: 'M12 5v14M5 12h14', check: 'M20 6 9 17l-5-5', chevron: 'm9 18 6-6-6-6', down: 'm6 9 6 6 6-6', upload: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12',
  download: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3', printer: 'M6 9V2h12v7M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2M6 14h12v8H6z',
  file: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6', flag: 'M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1zM4 22v-7', approve: 'M9 11l3 3L22 4M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11',
  users: 'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM23 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8', send: 'M22 2 11 13M22 2l-7 20-4-9-9-4z',
  logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9', sun: 'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4',
  moon: 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z', refresh: 'M23 4v6h-6M1 20v-6h6M3.5 9a9 9 0 0 1 14.8-3.4L23 10M1 14l4.6 4.4A9 9 0 0 0 20.5 15', link: 'M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7',
  trash: 'M3 6h18M8 6V4h8v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6', edit: 'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z', eye: 'M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  doc: 'M4 4h16v16H4zM8 8h8M8 12h8M8 16h5', building: 'M3 21h18M5 21V5l7-3 7 3v16M9 9h1M14 9h1M9 13h1M14 13h1M9 17h1M14 17h1', lock: 'M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4', unlock: 'M5 11h14v10H5zM8 11V7a4 4 0 0 1 7.9-1',
};
export function Icon({ name, size = 18, className, style }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className={className} style={style} aria-hidden="true"><path d={P[name] || P.doc} /></svg>;
}

// ───────────── Basics ─────────────
export function Button({ variant, size, icon, children, busy, className = '', ...rest }) {
  const cls = ['btn', variant && `btn-${variant}`, size === 'sm' && 'btn-sm', !children && icon && 'btn-icon', className].filter(Boolean).join(' ');
  return <button type="button" className={cls} disabled={busy || rest.disabled} {...rest}>{icon && <Icon name={icon} size={size === 'sm' ? 15 : 17} />}{busy ? 'Working…' : children}</button>;
}
export function LinkButton({ to, variant, size, icon, children }) {
  return <Link to={to} className={['btn', variant && `btn-${variant}`, size === 'sm' && 'btn-sm'].filter(Boolean).join(' ')}>{icon && <Icon name={icon} size={16} />}{children}</Link>;
}
export function Badge({ tone = '', children }) { return <span className={`badge${tone ? ` badge-${tone}` : ''}`}>{children}</span>; }
export function StatusBadge({ status }) { if (!status) return null; return <Badge tone={STATUS_TONE[status] ?? ''}>{titleCase(status)}</Badge>; }
export function Money({ value, className = '', blankZero }) { return <span className={`num ${isNeg(value) ? 'neg' : ''} ${className}`}>{fmtK(value, { blankZero })}</span>; }
export function Card({ title, actions, children, className = '', pad = true, ...rest }) {
  return <section className={`card ${className}`} {...rest}>{(title || actions) && <div className="card-head"><h2>{title}</h2><div className="row-gap">{actions}</div></div>}<div className={pad ? 'card-body' : ''}>{children}</div></section>;
}
export function PageHeader({ title, subtitle, actions, back }) {
  const nav = useNavigate();
  return <div className="page-head"><div className="page-head-text">{back && (back === -1 ? <button className="linkish t-small back-link" onClick={() => nav(-1)}>← Back</button> : <Link to={back} className="t-small back-link">← Back</Link>)}<h1 className="t-h1">{title}</h1>{subtitle && <p className="muted page-sub">{subtitle}</p>}</div>{actions && <div className="row-gap wrap">{actions}</div>}</div>;
}
export function Alert({ tone = 'info', title, children }) { return <div className={`alert alert-${tone}`} role={tone === 'error' ? 'alert' : 'status'}><div>{title && <strong>{title} </strong>}{children}</div></div>; }
export function Spinner({ label = 'Loading…' }) { return <div className="spinner-wrap" role="status"><span className="spinner" aria-hidden="true" />{label}</div>; }
export function Empty({ title = 'Nothing here yet', children, action }) { return <div className="empty"><p className="t-h2">{title}</p>{children && <p className="muted">{children}</p>}{action}</div>; }
export function Kpi({ label, value, delta, deltaTone, hint, to, money = true }) {
  const inner = <><span className="kpi-label">{label}</span><span className={`kpi-value ${money && isNeg(value) ? 'neg' : ''}`}>{money ? fmtK(value ?? '0') : value}</span>{(delta || hint) && <span className={`kpi-delta ${deltaTone || ''}`}>{delta || hint}</span>}</>;
  return to ? <Link to={to} className="card kpi kpi-link">{inner}</Link> : <div className="card kpi">{inner}</div>;
}
export function Tabs({ tabs, value, onChange }) {
  return <div className="tabs" role="tablist">{tabs.map((t) => <button key={t.value} role="tab" aria-selected={value === t.value} className="tab" onClick={() => onChange(t.value)}>{t.label}{t.count != null && <span className="tab-count">{t.count}</span>}</button>)}</div>;
}

// ───────────── Form controls ─────────────
export function Field({ label, hint, error, children, span, required }) {
  return <div className={`field ${span ? `span-${span}` : ''}`}>{label && <label>{label}{required && <span className="neg" aria-hidden="true"> *</span>}</label>}{children}{error ? <span className="field-error">{error}</span> : hint ? <span className="field-hint">{hint}</span> : null}</div>;
}
export const Input = ({ className = '', ...p }) => <input className={`input ${className}`} {...p} />;
export const TextArea = (p) => <textarea className="textarea" {...p} />;
export function Select({ options, placeholder, value, onChange, ...rest }) {
  return <select className="select" value={value ?? ''} onChange={(e) => onChange?.(e.target.value)} {...rest}>
    {placeholder !== undefined && <option value="">{placeholder}</option>}
    {options.map((o) => (o.group ? <optgroup key={o.group} label={o.group}>{o.options.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}</optgroup> : <option key={o.value} value={o.value} disabled={o.disabled}>{o.label}</option>))}
  </select>;
}
export function MoneyInput({ value, onChange, ...rest }) {
  return <input className="input num" inputMode="decimal" value={value ?? ''} placeholder="0.00" onChange={(e) => onChange(e.target.value.replace(/[^\d.,-]/g, ''))}
    onBlur={(e) => { const v = e.target.value.replace(/,/g, ''); if (v && /^-?\d*(\.\d*)?$/.test(v)) onChange(Number(v).toFixed(2)); }} {...rest} />;
}
export const DateInput = ({ value, onChange, ...rest }) => <input type="date" className="input" value={value || ''} onChange={(e) => onChange(e.target.value)} {...rest} />;
export const Check = ({ label, checked, onChange, ...rest }) => <label className="checkbox"><input type="checkbox" checked={!!checked} onChange={(e) => onChange(e.target.checked)} {...rest} />{label}</label>;

// ───────────── Modal & confirm ─────────────
export function Modal({ title, onClose, children, footer, wide }) {
  const ref = useRef(null);
  useEffect(() => {
    const prev = document.activeElement;
    ref.current?.querySelector('input, select, textarea, button:not(.modal-x)')?.focus();
    const k = (e) => { if (e.key === 'Escape') onClose?.(); };
    document.addEventListener('keydown', k);
    return () => { document.removeEventListener('keydown', k); prev?.focus?.(); };
  }, [onClose]);
  return <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.(); }}>
    <div className={`modal card ${wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true" aria-label={title} ref={ref}>
      <div className="card-head"><h2>{title}</h2><Button variant="ghost" size="sm" icon="x" className="modal-x" aria-label="Close" onClick={onClose} /></div>
      <div className="card-body modal-body">{children}</div>
      {footer && <div className="modal-foot">{footer}</div>}
    </div>
  </div>;
}

const ToastCtx = createContext(null);
export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const [confirmState, setConfirm] = useState(null);
  const push = useCallback((msg, tone = 'success') => {
    const id = Math.random();
    setToasts((t) => [...t, { id, msg, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === 'error' ? 7000 : 3500);
  }, []);
  const confirm = useCallback((opts) => new Promise((resolve) => setConfirm({ ...opts, resolve })), []);
  return <ToastCtx.Provider value={{ toast: push, confirm }}>
    {children}
    <div className="toasts" aria-live="polite">{toasts.map((t) => <div key={t.id} className={`toast alert alert-${t.tone}`}>{t.msg}</div>)}</div>
    {confirmState && <ConfirmDialog {...confirmState} onDone={(v) => { confirmState.resolve(v); setConfirm(null); }} />}
  </ToastCtx.Provider>;
}
function ConfirmDialog({ title, message, confirmLabel = 'Confirm', danger, input, inputLabel, requireText, onDone }) {
  const [text, setText] = useState('');
  const ok = !requireText || text === requireText;
  return <Modal title={title} onClose={() => onDone(false)} footer={<><Button onClick={() => onDone(false)}>Cancel</Button><Button variant={danger ? 'danger' : 'primary'} disabled={!ok || (input && !text.trim())} onClick={() => onDone(input ? text : true)}>{confirmLabel}</Button></>}>
    <p style={{ marginTop: 0 }}>{message}</p>
    {(input || requireText) && <Field label={inputLabel || (requireText ? `Type ${requireText} to confirm` : 'Reason')}><Input value={text} onChange={(e) => setText(e.target.value)} autoFocus /></Field>}
  </Modal>;
}
export const useToast = () => useContext(ToastCtx);

// ───────────── Data hooks ─────────────
export function useApi(url, deps = []) {
  const [state, setState] = useState({ data: null, loading: !!url, error: null });
  const load = useCallback(async () => {
    if (!url) return;
    setState((s) => ({ ...s, loading: true, error: null }));
    try { const data = await api.get(url); setState({ data, loading: false, error: null }); return data; } catch (e) { setState({ data: null, loading: false, error: e }); }
  }, [url]);
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [load, ...deps]);
  return { ...state, reload: load, setData: (d) => setState((s) => ({ ...s, data: typeof d === 'function' ? d(s.data) : d })) };
}

/** Wrap an async action with busy state, success toast and friendly error toast. */
export function useAction() {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const run = useCallback(async (fn, success, opts) => {
    setBusy(true);
    try { const r = await fn(); if (success) toast(typeof success === 'function' ? success(r) : success); return r; }
    catch (e) { if (opts?.onError?.(e) !== true) toast(e.message || 'Something went wrong.', 'error'); return undefined; }
    finally { setBusy(false); }
  }, [toast]);
  return [run, busy];
}

export function Loadable({ state, children }) {
  if (state.loading && !state.data) return <Spinner />;
  if (state.error) return <Alert tone="error" title="Could not load.">{state.error.message}</Alert>;
  if (!state.data) return null;
  return children(state.data);
}
