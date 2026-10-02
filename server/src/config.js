import 'dotenv/config';
import path from 'node:path';

const env = process.env.NODE_ENV || 'development';
const isProd = env === 'production';
const isTest = env === 'test';

function required(name, fallback) {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === '') throw new Error(`Missing required environment variable ${name}`);
  return v;
}

const devKey = 'dev-only-key-change-me-dev-only-key-change-me!!';

export const config = {
  env, isProd, isTest,
  port: Number(process.env.PORT || 4000),
  databaseUrl: isTest
    ? required('TEST_DATABASE_URL', 'postgres://tael:tael@localhost:5432/tael_books_test')
    : required('DATABASE_URL', isProd ? undefined : 'postgres://tael:tael@localhost:5432/tael_books'),
  databaseSsl: process.env.DATABASE_SSL === 'true',
  // 32+ char secret used to encrypt stored secrets (AI keys, SMTP passwords). Required in production.
  encryptionKey: isProd ? required('APP_ENCRYPTION_KEY') : (process.env.APP_ENCRYPTION_KEY || devKey),
  sessionTtlHours: Number(process.env.SESSION_TTL_HOURS || 12),
  cookieSecure: process.env.COOKIE_SECURE ? process.env.COOKIE_SECURE === 'true' : isProd,
  trustProxy: process.env.TRUST_PROXY || (isProd ? '1' : 'loopback'),
  uploadDir: path.resolve(process.env.UPLOAD_DIR || './storage/uploads'),
  backupDir: path.resolve(process.env.BACKUP_DIR || './storage/backups'),
  maxUploadMb: Number(process.env.MAX_UPLOAD_MB || 15),
  appUrl: process.env.APP_URL || 'http://localhost:4000',
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
  aiModel: process.env.AI_MODEL || 'claude-opus-5-5',
  jobsEnabled: process.env.JOBS_ENABLED ? process.env.JOBS_ENABLED === 'true' : !isTest,
  logLevel: process.env.LOG_LEVEL || (isProd ? 'info' : 'debug'),
  corsOrigin: process.env.CORS_ORIGIN || '',
};

if (isProd && config.encryptionKey.length < 32) throw new Error('APP_ENCRYPTION_KEY must be at least 32 characters');
