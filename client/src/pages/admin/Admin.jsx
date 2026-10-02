import { useState } from 'react';
import { NavLink, Routes, Route, Navigate } from 'react-router-dom';
import { useSession } from '../../lib/session.jsx';
import { PageHeader, Card } from '../../components/ui.jsx';
import * as S from './sections.jsx';
import * as U from './people.jsx';
import * as O from './operations.jsx';

const SECTIONS = [
  ['Organisation', [
    ['company', 'Company', 'manage_company', S.Company], ['branding', 'Branding & logo', 'manage_company', S.Branding], ['companies', 'All companies', 'SUPER', O.Companies],
    ['branches', 'Branches, departments & warehouses', 'manage_settings', O.OrgUnits]]],
  ['People & access', [['users', 'Users', 'manage_users', U.Users], ['roles', 'Roles & permissions', 'manage_roles', U.Roles], ['security', 'Security', 'SUPER', S.Security]]],
  ['Accounting', [['accounting', 'Accounting & approvals', 'manage_settings', S.Accounting], ['tax', 'Tax', 'manage_tax', O.Tax], ['periods', 'Financial periods', 'manage_periods', O.Periods], ['numbering', 'Numbering', 'manage_settings', O.Numbering]]],
  ['Documents & output', [['templates', 'Invoice & document templates', 'manage_company', S.Templates], ['reports', 'Report templates', 'manage_company', S.ReportTemplates], ['dashboard', 'Dashboard widgets', 'manage_settings', S.Dashboard]]],
  ['Communication', [['notifications', 'Notifications', 'manage_settings', S.Notifications], ['email', 'Email', 'manage_settings', S.Email]]],
  ['AI & integrations', [['ai', 'AI settings', 'manage_ai', S.AISettings], ['integrations', 'Integrations & API keys', 'manage_integrations', O.Integrations]]],
  ['System', [['preferences', 'System preferences', 'manage_settings', S.Preferences], ['data', 'Import & export', 'manage_settings', O.ImportExport], ['backups', 'Backups', 'manage_backups', O.Backups], ['audit', 'Audit logs', 'view_audit_logs', O.Audit], ['system', 'System information', 'manage_settings', O.SystemInfo]]],
];

export default function Admin() {
  const { can, isSuperAdmin, me } = useSession();
  const allowed = (p) => (p === 'SUPER' ? isSuperAdmin : can(p));
  const items = SECTIONS.flatMap(([, list]) => list).filter(([, , p]) => allowed(p));
  return <div className="stack">
    <PageHeader title="Admin Center" subtitle={`${me.company.name} · ${isSuperAdmin ? 'Super Admin — full configuration access' : me.role}`} />
    <div className="admin-layout">
      <Card className="admin-nav" pad={false}>
        {SECTIONS.map(([group, list]) => { const l = list.filter(([, , p]) => allowed(p)); return l.length > 0 && <div key={group}><div className="menu-label">{group}</div>{l.map(([slug, label]) => <NavLink key={slug} to={`/admin/${slug}`}>{label}</NavLink>)}</div>; })}
      </Card>
      <div className="stack" style={{ minWidth: 0 }}>
        <Routes>
          {items.map(([slug, , , C]) => <Route key={slug} path={slug} element={<C />} />)}
          <Route path="*" element={<Navigate to={`/admin/${items[0]?.[0] || 'company'}`} replace />} />
        </Routes>
      </div>
    </div>
  </div>;
}
export { useState };
