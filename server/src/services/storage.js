// File storage for uploads (receipts, logos, statements). Local disk by default; the
// interface (put/get/remove) is small so an S3-compatible driver can be added later.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { badRequest, notFound } from '../lib/errors.js';

// Allowed types, verified by file signature (not by the browser-supplied MIME type).
const SIGNATURES = [
  { mime: 'image/png', ext: 'png', test: (b) => b.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { mime: 'image/jpeg', ext: 'jpg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/gif', ext: 'gif', test: (b) => b.slice(0, 4).toString() === 'GIF8' },
  { mime: 'image/webp', ext: 'webp', test: (b) => b.slice(0, 4).toString() === 'RIFF' && b.slice(8, 12).toString() === 'WEBP' },
  { mime: 'application/pdf', ext: 'pdf', test: (b) => b.slice(0, 5).toString() === '%PDF-' },
  { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ext: 'xlsx', test: (b) => b[0] === 0x50 && b[1] === 0x4b },
  { mime: 'image/x-icon', ext: 'ico', test: (b) => b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0 },
];
const SVG = { mime: 'image/svg+xml', ext: 'svg' };
const CSV = { mime: 'text/csv', ext: 'csv' };

export function sniff(buffer, originalName = '') {
  const sig = SIGNATURES.find((s) => s.test(buffer));
  if (sig) return sig;
  const head = buffer.slice(0, 2048).toString('utf8');
  if (/\.svg$/i.test(originalName) && /<svg[\s>]/i.test(head)) {
    // Reject active content in SVG logos
    const full = buffer.toString('utf8');
    if (/<script|on\w+\s*=|javascript:|<foreignObject|<iframe|xlink:href\s*=\s*["'](?!#|data:image)/i.test(full)) throw badRequest('This SVG contains scripts or external references and cannot be uploaded.');
    return SVG;
  }
  if (/\.(csv|txt)$/i.test(originalName) && !/[\x00-\x08\x0e-\x1f]/.test(head)) return CSV;
  return null;
}

export const KINDS = {
  image: ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml', 'image/x-icon'],
  receipt: ['image/png', 'image/jpeg', 'image/webp', 'application/pdf'],
  statement: ['text/csv', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  any: ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf', 'text/csv', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'image/svg+xml', 'image/x-icon'],
};

export async function saveUpload(db, ctx, file, { category = 'general', kind = 'any', linkedType = null, linkedId = null, companyId } = {}) {
  if (!file?.buffer?.length) throw badRequest('No file received.');
  const t = sniff(file.buffer, file.originalname);
  if (!t || !KINDS[kind].includes(t.mime)) throw badRequest(`This file type is not allowed here. Allowed: ${KINDS[kind].map((m) => m.split('/')[1].replace('vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'xlsx')).join(', ')}.`);
  const cid = companyId ?? ctx.companyId;
  const key = `${cid ?? 'platform'}/${new Date().toISOString().slice(0, 7)}/${crypto.randomUUID()}.${t.ext}`;
  const full = path.join(config.uploadDir, key);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, file.buffer, { mode: 0o640 });
  const sha = crypto.createHash('sha256').update(file.buffer).digest('hex');
  const name = String(file.originalname || `upload.${t.ext}`).replace(/[^\w.\- ()]/g, '_').slice(0, 180);
  const { rows: [doc] } = await db.query(
    `INSERT INTO documents (company_id, category, original_name, storage_key, mime_type, size_bytes, sha256, linked_type, linked_id, uploaded_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [cid, category, name, key, t.mime, file.buffer.length, sha, linkedType, linkedId, ctx.user?.id || null]);
  return doc;
}

export async function readDocument(db, companyId, id, { allowPlatform = false } = {}) {
  const { rows: [doc] } = await db.query('SELECT * FROM documents WHERE id=$1', [id]);
  if (!doc || (doc.company_id !== companyId && !(allowPlatform && doc.company_id === null))) throw notFound('Document');
  const full = path.resolve(config.uploadDir, doc.storage_key);
  if (!full.startsWith(config.uploadDir + path.sep)) throw notFound('Document');
  const data = await fs.readFile(full).catch(() => { throw notFound('Document file'); });
  return { doc, data };
}

export async function removeDocumentFile(doc) {
  const full = path.resolve(config.uploadDir, doc.storage_key);
  if (full.startsWith(config.uploadDir + path.sep)) await fs.rm(full, { force: true });
}
