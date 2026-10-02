import { useEffect, useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { api, setCsrf } from '../lib/api.js';
import { useSession, applyBranding } from '../lib/session.jsx';
import { Button, Field, Input, Alert } from '../components/ui.jsx';

export default function Login() {
  const { me, refresh } = useSession();
  const [brand, setBrand] = useState(null);
  const [email, setEmail] = useState(''); const [password, setPassword] = useState('');
  const [err, setErr] = useState(null); const [busy, setBusy] = useState(false);
  const nav = useNavigate(); const loc = useLocation();
  useEffect(() => { api.get('/auth/public-branding').then((b) => { setBrand(b); applyBranding({ ...b.branding, favicon_document_id: b.favicon_version }, b.company_id, b.name); }).catch(() => {}); }, []);
  if (me) return <Navigate to={loc.state?.from || '/'} replace />;
  const submit = async (e) => {
    e.preventDefault(); setErr(null); setBusy(true);
    try { const r = await api.post('/auth/login', { email, password }); setCsrf(r.csrf_token); await refresh(); nav(loc.state?.from || '/', { replace: true }); }
    catch (x) { setErr(x.message); } finally { setBusy(false); }
  };
  return <div className="login">
    <div className="login-art">
      <div>{brand?.has_logo ? <img src={`/api/public/branding/${brand.company_id}/${brand.logo_slot || 'logo'}?v=${brand.logo_version || ''}`} alt={brand.name} style={{ maxHeight: 56, background: '#fff', padding: 8, borderRadius: 8 }} /> : <strong style={{ fontSize: 18 }}>{brand?.name || 'TAEL Books'}</strong>}</div>
      <div><h1>{brand?.branding?.login_title || 'Welcome back'}</h1><p>{brand?.branding?.login_tagline || 'Accounting for Zambian businesses'}</p></div>
      <div className="login-rules" aria-hidden="true"><div /><div /><div /><div className="double" /></div>
      <p className="t-small" style={{ color: 'inherit', opacity: 0.8 }}>TAEL Books · double-entry accounting in Zambian Kwacha</p>
    </div>
    <div className="login-form">
      <form className="card card-pad login-card stack-sm" onSubmit={submit} noValidate>
        <h2 className="t-h1">Sign in</h2>
        <p className="muted" style={{ margin: 0 }}>Use the email and password your administrator gave you.</p>
        {err && <Alert tone="error">{err}</Alert>}
        <Field label="Email"><Input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus /></Field>
        <Field label="Password"><Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></Field>
        <Button type="submit" variant="primary" busy={busy} disabled={!email || !password}>Sign in</Button>
      </form>
    </div>
  </div>;
}
