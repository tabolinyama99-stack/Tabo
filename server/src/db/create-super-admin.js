// Usage: SUPER_ADMIN_EMAIL=you@example.com SUPER_ADMIN_PASSWORD='...' SUPER_ADMIN_NAME='Your Name' COMPANY_NAME='My Company' npm run create-super-admin
import { pool, tx } from './pool.js';
import { migrate } from './migrate.js';
import { hashPassword, checkPasswordPolicy } from '../lib/password.js';
import { setupCompany } from '../services/company-setup.js';

export async function createSuperAdmin({ email, password, name, companyName }) {
  checkPasswordPolicy(password, 10);
  return tx(async (db) => {
    const hash = await hashPassword(password);
    const { rows: [u] } = await db.query(
      `INSERT INTO users (email, name, password_hash, is_super_admin) VALUES (lower($1),$2,$3,true)
       ON CONFLICT ((lower(email))) DO UPDATE SET is_super_admin=true, password_hash=EXCLUDED.password_hash, is_active=true, name=EXCLUDED.name RETURNING *`, [email, name, hash]);
    let company = (await db.query('SELECT * FROM companies WHERE NOT is_demo ORDER BY id LIMIT 1')).rows[0];
    if (!company && companyName) company = await setupCompany(db, { name: companyName }, { createdBy: u.id });
    if (company) {
      const { rows: [role] } = await db.query(`SELECT id FROM roles WHERE company_id=$1 AND name='Super Admin'`, [company.id]);
      await db.query(`INSERT INTO memberships (user_id, company_id, role_id) VALUES ($1,$2,$3) ON CONFLICT (user_id, company_id) DO UPDATE SET role_id=EXCLUDED.role_id, is_active=true`, [u.id, company.id, role.id]);
    }
    await db.query(`INSERT INTO audit_logs (user_id, user_email, action, entity_type, entity_id) VALUES ($1,$2,'user.super_admin_created','user',$3)`, [u.id, u.email, String(u.id)]);
    return { user: u, company };
  });
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (isMain) {
  const email = process.env.SUPER_ADMIN_EMAIL, password = process.env.SUPER_ADMIN_PASSWORD;
  if (!email || !password) { console.error('Set SUPER_ADMIN_EMAIL and SUPER_ADMIN_PASSWORD'); process.exit(1); }
  migrate().then(() => createSuperAdmin({ email, password, name: process.env.SUPER_ADMIN_NAME || 'Super Admin', companyName: process.env.COMPANY_NAME || 'My Company' }))
    .then(({ user, company }) => { console.log(`Super Admin ready: ${user.email}${company ? ` · company "${company.name}" (#${company.id})` : ''}`); return pool.end(); })
    .catch((e) => { console.error(e.message); process.exit(1); });
}
