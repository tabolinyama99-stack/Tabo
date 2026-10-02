import { createApp } from './app.js';
import { config } from './config.js';
import { migrate } from './db/migrate.js';
import { pool } from './db/pool.js';
import { startJobs } from './services/jobs.js';

async function bootstrap() {
  // First-run: create the Super Admin from environment variables if none exists yet.
  const { rows: [sa] } = await pool.query('SELECT id FROM users WHERE is_super_admin LIMIT 1');
  if (!sa && process.env.SUPER_ADMIN_EMAIL && process.env.SUPER_ADMIN_PASSWORD) {
    const { createSuperAdmin } = await import('./db/create-super-admin.js');
    const { user, company } = await createSuperAdmin({ email: process.env.SUPER_ADMIN_EMAIL, password: process.env.SUPER_ADMIN_PASSWORD,
      name: process.env.SUPER_ADMIN_NAME || 'Super Admin', companyName: process.env.COMPANY_NAME || 'My Company' });
    console.log(`[tael-books] Super Admin created: ${user.email}${company ? ` (company "${company.name}")` : ''}. Remove SUPER_ADMIN_PASSWORD from the environment now.`);
  } else if (!sa) console.warn('[tael-books] No Super Admin exists yet. Set SUPER_ADMIN_EMAIL and SUPER_ADMIN_PASSWORD and restart, or run: npm run create-super-admin');
  if (process.env.SEED_DEMO === 'true') {
    const { seedDemo } = await import('./db/seed-demo.js');
    const { rows: [u] } = await pool.query('SELECT id FROM users WHERE is_super_admin ORDER BY id LIMIT 1');
    await seedDemo({ adminUserId: u?.id || null });
  }
}

async function main() {
  if (process.env.AUTO_MIGRATE !== 'false') await migrate();
  await bootstrap();
  const app = createApp();
  const server = app.listen(config.port, () => console.log(`[tael-books] listening on :${config.port} (${config.env})`));
  const timer = config.jobsEnabled ? startJobs() : null;
  const shutdown = (sig) => {
    console.log(`[tael-books] ${sig} received, shutting down`);
    if (timer) clearInterval(timer);
    server.close(() => pool.end().then(() => process.exit(0)));
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
main().catch((e) => { console.error('[tael-books] failed to start:', e); process.exit(1); });
