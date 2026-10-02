import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useSession } from '../lib/session.jsx';
import { Button, Card, Field, Input, Alert, PageHeader, useAction } from '../components/ui.jsx';

export default function Profile() {
  const { me, refresh } = useSession();
  const [sp] = useSearchParams(); const nav = useNavigate();
  const [p, setP] = useState({ name: me.user.name, phone: '' });
  const [pw, setPw] = useState({ current_password: '', new_password: '', confirm: '' });
  const [run, busy] = useAction();
  return <div className="stack">
    <PageHeader title="Profile & password" subtitle={`${me.user.email} · ${me.role}`} />
    {(sp.get('force') || me.user.must_change_password) && <Alert tone="warning" title="Change your password.">Your administrator issued a temporary password. Choose a new one to continue.</Alert>}
    <div className="grid grid-2">
      <Card title="Your details"><div className="stack-sm">
        <Field label="Full name"><Input value={p.name} onChange={(e) => setP({ ...p, name: e.target.value })} /></Field>
        <Field label="Phone"><Input value={p.phone} onChange={(e) => setP({ ...p, phone: e.target.value })} placeholder="+260…" /></Field>
        <div><Button variant="primary" busy={busy} onClick={() => run(() => api.put('/auth/profile', p).then(refresh), 'Profile saved')}>Save</Button></div>
      </div></Card>
      <Card title="Change password"><div className="stack-sm">
        <Field label="Current password"><Input type="password" autoComplete="current-password" value={pw.current_password} onChange={(e) => setPw({ ...pw, current_password: e.target.value })} /></Field>
        <Field label="New password" hint="At least 10 characters with letters and numbers."><Input type="password" autoComplete="new-password" value={pw.new_password} onChange={(e) => setPw({ ...pw, new_password: e.target.value })} /></Field>
        <Field label="Confirm new password" error={pw.confirm && pw.confirm !== pw.new_password ? 'Passwords do not match.' : null}><Input type="password" autoComplete="new-password" value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} /></Field>
        <div><Button variant="primary" busy={busy} disabled={!pw.new_password || pw.new_password !== pw.confirm}
          onClick={() => run(async () => { await api.post('/auth/change-password', { current_password: pw.current_password, new_password: pw.new_password }); await refresh(); setPw({ current_password: '', new_password: '', confirm: '' }); nav('/'); }, 'Password changed')}>Change password</Button></div>
      </div></Card>
    </div>
  </div>;
}
