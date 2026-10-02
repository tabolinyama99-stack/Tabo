import nodemailer from 'nodemailer';
import { pool } from '../db/pool.js';
import { getSecret } from './secrets.js';
import { badRequest } from '../lib/errors.js';

export async function sendEmail(ctx, { to, subject, text, attachments = [], relatedType, relatedId }) {
  const { rows: [c] } = await pool.query('SELECT name, settings FROM companies WHERE id=$1', [ctx.companyId]);
  const e = c.settings?.email || {};
  if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) throw badRequest('A valid recipient email address is required.');
  const log = (status, error) => pool.query(`INSERT INTO email_log (company_id, to_address, subject, status, error, related_type, related_id, sent_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [ctx.companyId, to, subject, status, error || null, relatedType || null, relatedId || null, ctx.user?.id || null]);
  if (!e.enabled || !e.smtp_host) {
    await log('NOT_CONFIGURED', 'Email (SMTP) is not configured');
    throw badRequest('Email is not configured. A Super Admin can set up SMTP in Admin Center → Email. You can download the PDF and send it manually.');
  }
  const pass = await getSecret(ctx.companyId, 'smtp_password');
  const transport = nodemailer.createTransport({ host: e.smtp_host, port: Number(e.smtp_port || 587), secure: !!e.smtp_secure, auth: e.smtp_user ? { user: e.smtp_user, pass } : undefined });
  try {
    await transport.sendMail({ from: `"${e.from_name || c.name}" <${e.from_email || e.smtp_user}>`, to, subject, text, attachments });
    await log('SENT');
  } catch (err) {
    await log('FAILED', err.message);
    throw badRequest(`The email could not be sent: ${err.message}`);
  }
}
