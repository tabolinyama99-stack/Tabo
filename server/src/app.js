import express from 'express';
import helmet from 'helmet';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { pool } from './db/pool.js';
import { authenticate, requireCompany } from './middleware/auth.js';
import { errorHandler } from './middleware/errors.js';
import authRoutes from './routes/auth.js';
import adminRoutes from './routes/admin.js';
import ledgerRoutes from './routes/ledger.js';
import businessRoutes from './routes/business.js';
import opsRoutes from './routes/ops.js';
import aiRoutes from './routes/ai.js';
import { readDocument } from './services/storage.js';

export function createApp() {
  const app = express();
  app.set('trust proxy', config.trustProxy === 'loopback' ? 'loopback' : Number(config.trustProxy) || config.trustProxy);
  app.disable('x-powered-by');
  app.use(helmet({
    contentSecurityPolicy: { useDefaults: true, directives: {
      'default-src': ["'self'"], 'script-src': ["'self'"], 'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      'font-src': ["'self'", 'https://fonts.gstatic.com', 'data:'], 'img-src': ["'self'", 'data:', 'blob:'], 'connect-src': ["'self'"], 'frame-src': ["'self'", 'blob:'], 'object-src': ["'self'", 'blob:'],
      'frame-ancestors': ["'self'"], 'upgrade-insecure-requests': config.isProd ? [] : null } },
    crossOriginEmbedderPolicy: false,
    strictTransportSecurity: config.isProd ? { maxAge: 31536000, includeSubDomains: true } : false,
  }));
  app.use(compression());
  if (!config.isTest) app.use(morgan(config.isProd ? 'combined' : 'dev', { skip: (req) => req.path.startsWith('/assets') }));
  app.use(express.json({ limit: '2mb' }));
  app.use(cookieParser());

  app.get('/healthz', async (req, res) => {
    try { await pool.query('SELECT 1'); res.json({ status: 'ok', time: new Date().toISOString() }); } catch { res.status(503).json({ status: 'db_unavailable' }); }
  });

  const api = express.Router();
  api.use(rateLimit({ windowMs: 60 * 1000, limit: config.isTest ? 100000 : 600, standardHeaders: true, legacyHeaders: false, message: { error: { code: 'RATE_LIMITED', message: 'Too many requests. Please slow down.' } } }));
  api.use('/auth', authRoutes);
  // Public branding assets for the login page (logo/favicon only)
  api.get('/public/branding/:companyId/:slot', async (req, res, next) => {
    try {
      const key = { logo: 'logo_document_id', logo_light: 'logo_light_document_id', logo_dark: 'logo_dark_document_id', favicon: 'favicon_document_id' }[req.params.slot];
      const { rows: [c] } = await pool.query('SELECT settings FROM companies WHERE id=$1 AND is_active', [Number(req.params.companyId) || 0]);
      const id = c?.settings?.branding?.[key];
      if (!id) return res.status(404).end();
      const { doc, data } = await readDocument(pool, Number(req.params.companyId), id);
      res.setHeader('Content-Type', doc.mime_type);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      if (doc.mime_type === 'image/svg+xml') res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
      res.setHeader('Cache-Control', 'public, max-age=300');
      res.send(data);
    } catch (e) { next(e); }
  });
  api.use(authenticate, requireCompany);
  api.use('/admin', adminRoutes);
  api.use(ledgerRoutes);
  api.use(businessRoutes);
  api.use(opsRoutes);
  api.use(aiRoutes);
  api.use((req, res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: 'API endpoint not found.' } }));
  app.use('/api', api);

  // Serve the built frontend (single-page app)
  const dist = process.env.CLIENT_DIST || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../client/dist');
  if (fs.existsSync(dist)) {
    app.use(express.static(dist, { index: false, maxAge: '1h', setHeaders: (res, p) => { if (p.includes(`${path.sep}assets${path.sep}`)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable'); } }));
    app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(path.join(dist, 'index.html')));
  }
  app.use(errorHandler);
  return app;
}
