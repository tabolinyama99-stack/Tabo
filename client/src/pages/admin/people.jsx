import { useState } from 'react';
import { api } from '../../lib/api.js';
import { useSession } from '../../lib/session.jsx';
import { fmtDateTime, fmtK } from '../../lib/format.js';
import { Card, Field, Input, Select, Check, MoneyInput, Button, Alert, Modal, useApi, Loadable, useAction, useToast, Badge, TextArea } from '../../components/ui.jsx';
import { DataTable } from '../../components/DataTable.jsx';
import { useLookup } from '../../components/lookups.js';

function UserModal({ initial, roles, onClose, onSaved }) {
  const branches = useLookup('/admin/branches');
  const [f, setF] = useState(initial ? { name: initial.name, phone: initial.phone || '', role_id: initial.role_id, branch_id: initial.branch_id || '' } : { email: '', name: '', phone: '', role_id: roles.find((r) => r.name === 'Accountant')?.id || '', branch_id: '', password: '', must_change_password: true });
  const [run, busy] = useAction(); const [temp, setTemp] = useState(null);
  const save = async () => { const r = await run(() => (initial ? api.put(`/admin/users/${initial.id}`, { ...f, branch_id: f.branch_id || null }) : api.post('/admin/users', { ...f, branch_id: f.branch_id || null, password: f.password || undefined })), initial ? 'User updated.' : 'User created.'); if (r) { if (r.temporary_password) setTemp(r.temporary_password); else onSaved(); } };
  if (temp) return <Modal title="User created" onClose={onSaved} footer={<Button variant="primary" onClick={onSaved}>Done</Button>}><Alert tone="warning" title="Temporary password:"><code style={{ fontSize: 16 }}>{temp}</code></Alert><p>Share it securely with {f.name}. They must change it at first sign-in. It will not be shown again.</p></Modal>;
  return <Modal title={initial ? `Edit ${initial.name}` : 'Add user'} onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" busy={busy} disabled={!f.name || !f.role_id || (!initial && !f.email)} onClick={save}>Save</Button></>}>
    <div className="form-grid">
      {!initial && <Field label="Email" required span={2} hint="If this person already has a TAEL Books login (e.g. in another company), they are added to this company."><Input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>}
      <Field label="Full name" required><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
      <Field label="Phone"><Input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>
      <Field label="Role" required><Select value={f.role_id} onChange={(v) => setF({ ...f, role_id: v })} placeholder="Choose…" options={roles.map((r) => ({ value: r.id, label: r.name }))} /></Field>
      <Field label="Branch"><Select value={f.branch_id} onChange={(v) => setF({ ...f, branch_id: v })} placeholder="All branches" options={branches.map((b) => ({ value: b.id, label: b.name }))} /></Field>
      {!initial && <><Field label="Password" hint="Leave blank to generate a temporary password."><Input type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} autoComplete="new-password" /></Field>
        <Field label=" "><Check label="Must change password at first sign-in" checked={f.must_change_password} onChange={(v) => setF({ ...f, must_change_password: v })} /></Field></>}
    </div>
  </Modal>;
}

export function Users() {
  const { isSuperAdmin, me } = useSession(); const { confirm } = useToast();
  const users = useApi('/admin/users'); const roles = useApi('/admin/roles');
  const [edit, setEdit] = useState(null); const [run] = useAction(); const [temp, setTemp] = useState(null);
  const act = async (u, what) => {
    if (what === 'reset') { if (!(await confirm({ title: `Reset password for ${u.name}?`, message: 'A temporary password is generated and all their sessions are signed out.' }))) return; const r = await run(() => api.post(`/admin/users/${u.id}/reset-password`), 'Password reset.'); if (r?.temporary_password) setTemp({ name: u.name, pw: r.temporary_password }); }
    if (what === 'disable' || what === 'enable') { if (await run(() => api.post(`/admin/users/${u.id}/status`, { is_active: what === 'enable' }), what === 'enable' ? 'User enabled.' : 'User disabled.')) users.reload(); }
    if (what === 'remove') { if (await confirm({ title: `Remove ${u.name} from this company?`, message: 'Their access is deactivated. Their history stays in the audit trail.', danger: true }) && await run(() => api.del(`/admin/users/${u.id}`), 'User removed.')) users.reload(); }
  };
  return <Card title="Users" actions={<Button variant="primary" icon="plus" onClick={() => setEdit({})}>Add user</Button>} pad={false}>
    <Loadable state={users}>{(rows) => <DataTable rows={rows} columns={[{ key: 'name', label: 'Name', render: (v, u) => <span className="row-gap">{v}{u.is_super_admin && <Badge tone="brand">Super Admin</Badge>}</span> }, { key: 'email', label: 'Email' }, { key: 'role_name', label: 'Role' },
      { key: 'status', label: 'Status', render: (_, u) => (u.membership_active === false ? <Badge>Disabled</Badge> : u.locked_until && new Date(u.locked_until) > new Date() ? <Badge tone="warning">Locked</Badge> : <Badge tone="positive">Active</Badge>) },
      { key: 'last_login_at', label: 'Last sign-in', type: 'datetime' },
      { key: 'a', label: '', sortable: false, render: (_, u) => (!u.is_super_admin || isSuperAdmin) && u.id !== me.user.id && <div className="row-gap"><Button size="sm" variant="ghost" onClick={() => setEdit(u)}>Edit</Button><Button size="sm" variant="ghost" onClick={() => act(u, 'reset')}>Reset password</Button>
        {!u.is_super_admin && <Button size="sm" variant="ghost" onClick={() => act(u, u.membership_active === false ? 'enable' : 'disable')}>{u.membership_active === false ? 'Enable' : 'Disable'}</Button>}{!u.is_super_admin && <Button size="sm" variant="ghost" onClick={() => act(u, 'remove')}>Remove</Button>}</div> }]} />}</Loadable>
    {edit && roles.data && <UserModal initial={edit.id ? edit : null} roles={roles.data.filter((r) => isSuperAdmin || r.name !== 'Super Admin')} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); users.reload(); }} />}
    {temp && <Modal title="Temporary password" onClose={() => setTemp(null)} footer={<Button variant="primary" onClick={() => setTemp(null)}>Done</Button>}><p>New temporary password for {temp.name}:</p><Alert tone="warning"><code style={{ fontSize: 16 }}>{temp.pw}</code></Alert></Modal>}
  </Card>;
}

const GROUPS = [['General', ['view_dashboard', 'search', 'use_ai', 'view_audit_logs', 'upload_documents', 'review_anomalies']], ['Sales', ['view_sales', 'manage_customers', 'create_quote', 'create_invoice', 'edit_invoice', 'delete_invoice', 'approve_invoice', 'create_credit_note', 'send_documents']],
  ['Purchases', ['view_purchases', 'manage_suppliers', 'create_purchase', 'edit_purchase', 'approve_purchase']], ['Payments & expenses', ['view_payments', 'create_payment', 'edit_payment', 'delete_payment', 'view_expenses', 'create_expense', 'approve_expense']],
  ['Banking', ['view_banking', 'manage_banking', 'reconcile_bank']], ['Ledger', ['view_ledger', 'create_journal', 'post_journal', 'approve_transactions', 'reverse_journal', 'edit_chart_of_accounts', 'manage_periods', 'reopen_periods']],
  ['Reports', ['view_reports', 'export_reports']], ['Administration', ['manage_users', 'manage_roles', 'manage_settings', 'manage_company', 'manage_tax', 'manage_ai', 'manage_integrations', 'manage_backups']]];

function RoleModal({ initial, perms, onClose, onSaved }) {
  const [f, setF] = useState(initial ? { name: initial.name, description: initial.description || '', permissions: initial.permissions, transaction_limit: initial.transaction_limit || '' } : { name: '', description: '', permissions: ['view_dashboard', 'search'], transaction_limit: '' });
  const [run, busy] = useAction(); const label = Object.fromEntries(perms.map((p) => [p.key, p.label]));
  const toggle = (p, on) => setF({ ...f, permissions: on ? [...new Set([...f.permissions, p])] : f.permissions.filter((x) => x !== p) });
  return <Modal wide title={initial ? `Role: ${initial.name}` : 'New role'} onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" busy={busy} disabled={!f.name}
    onClick={async () => { if (await run(() => (initial ? api.put(`/admin/roles/${initial.id}`, f) : api.post('/admin/roles', f)), 'Role saved.')) onSaved(); }}>Save</Button></>}>
    <div className="form-grid"><Field label="Name"><Input value={f.name} disabled={initial?.is_system} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
      <Field label="Transaction limit (K)" hint="Largest single amount this role may post or approve. Blank = no limit."><MoneyInput value={f.transaction_limit} onChange={(v) => setF({ ...f, transaction_limit: v })} /></Field>
      <Field label="Description" span={2}><TextArea value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field></div>
    {GROUPS.map(([g, list]) => <div key={g} style={{ marginTop: 16 }}><div className="row-gap"><strong>{g}</strong><button className="linkish" onClick={() => setF({ ...f, permissions: [...new Set([...f.permissions, ...list])] })}>all</button><button className="linkish" onClick={() => setF({ ...f, permissions: f.permissions.filter((p) => !list.includes(p)) })}>none</button></div>
      <div className="perm-grid" style={{ marginTop: 6 }}>{list.map((p) => <Check key={p} label={<span>{label[p] || p} <span className="t-small">({p})</span></span>} checked={f.permissions.includes(p)} onChange={(on) => toggle(p, on)} />)}</div></div>)}
  </Modal>;
}

export function Roles() {
  const roles = useApi('/admin/roles'); const perms = useApi('/admin/permissions'); const { confirm } = useToast(); const [edit, setEdit] = useState(null); const [run] = useAction();
  return <Card title="Roles & permissions" actions={<Button variant="primary" icon="plus" onClick={() => setEdit({})}>New role</Button>} pad={false}>
    <p className="muted" style={{ padding: '0 var(--space-5)' }}>Permissions are enforced by the server on every request, not only by hiding buttons. The Super Admin always has every permission.</p>
    <Loadable state={roles}>{(rows) => <DataTable rows={rows} onRowClick={(r) => r.name !== 'Super Admin' && setEdit(r)} columns={[{ key: 'name', label: 'Role', render: (v, r) => <span className="row-gap">{v}{r.is_system && <Badge>Built-in</Badge>}</span> }, { key: 'description', label: 'Description' },
      { key: 'permissions', label: 'Permissions', render: (v) => `${v.length}` }, { key: 'transaction_limit', label: 'Limit', render: (v) => (v ? fmtK(v) : 'No limit') }, { key: 'users', label: 'Users', type: 'number' },
      { key: 'a', label: '', sortable: false, render: (_, r) => !r.is_system && <Button size="sm" variant="ghost" onClick={async (e) => { e.stopPropagation(); if (await confirm({ title: `Delete role ${r.name}?`, message: 'Only roles with no users can be deleted.', danger: true }) && await run(() => api.del(`/admin/roles/${r.id}`), 'Role deleted.')) roles.reload(); }}>Delete</Button> }]} />}</Loadable>
    {edit && perms.data && <RoleModal initial={edit.id ? edit : null} perms={perms.data} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); roles.reload(); }} />}
  </Card>;
}
export { fmtDateTime };
