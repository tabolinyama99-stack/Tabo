import { ZodError } from 'zod';
import { fromDbError } from '../lib/errors.js';
import { config } from '../config.js';

export function errorHandler(err, req, res, _next) {
  if (err instanceof ZodError) {
    const first = err.issues[0];
    return res.status(400).json({ error: { code: 'VALIDATION', message: `${first.path.join('.') || 'Input'}: ${first.message}`, details: err.issues } });
  }
  if (err?.type === 'entity.too.large' || err?.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: { code: 'TOO_LARGE', message: `The file or request is too large (max ${config.maxUploadMb} MB).` } });
  if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: { code: 'BAD_JSON', message: 'The request body is not valid JSON.' } });
  const mapped = err?.expose ? err : fromDbError(err);
  if (mapped) return res.status(mapped.status).json({ error: { code: mapped.code, message: mapped.message, details: mapped.details } });
  const ref = Math.random().toString(36).slice(2, 10).toUpperCase();
  console.error(`[error ${ref}] ${req.method} ${req.originalUrl}:`, err);
  res.status(500).json({ error: { code: 'INTERNAL', message: `Something went wrong on our side. Please try again; if it persists, quote reference ${ref}.` } });
}

export const asyncH = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
