import { Router } from 'express';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import { pool } from '../db/pool.js';
import { asyncH } from '../middleware/errors.js';
import { need } from '../middleware/auth.js';
import { chat } from '../ai/assistant.js';
import { extractAndDraft } from '../ai/extract.js';
import { analyse } from '../ai/analyst.js';
import { aiClient } from '../ai/provider.js';
import { saveUpload } from '../services/storage.js';
import { audit } from '../lib/audit.js';
import { badRequest, forbidden } from '../lib/errors.js';
import { can } from '../services/ledger.js';
import { config } from '../config.js';
import { z, pid } from './_util.js';

const r = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: 1 } });
const aiLimiter = rateLimit({ windowMs: 60 * 1000, limit: config.isTest ? 1000 : 30, keyGenerator: (req) => `u${req.ctx?.user?.id}`,
  message: { error: { code: 'RATE_LIMITED', message: 'Too many AI requests. Please wait a minute.' } } });

r.get('/ai/status', need('use_ai'), asyncH(async (req, res) => {
  const ai = await aiClient(req.ctx);
  res.json({ enabled: req.ctx.settings.ai.enabled !== false, mode: ai ? 'claude' : 'built-in', model: ai?.model || null, assistant_name: req.ctx.settings.ai.assistant_name,
    can_draft: req.ctx.settings.ai.allow_transaction_drafts !== false && (can(req.ctx, 'create_journal') || can(req.ctx, 'create_expense')) });
}));
r.get('/ai/conversations', need('use_ai'), asyncH(async (req, res) => {
  res.json((await pool.query('SELECT id, title, updated_at FROM ai_conversations WHERE company_id=$1 AND user_id=$2 ORDER BY updated_at DESC LIMIT 50', [req.ctx.companyId, req.ctx.user.id])).rows);
}));
r.get('/ai/conversations/:id', need('use_ai'), asyncH(async (req, res) => {
  const { rows: [c] } = await pool.query('SELECT * FROM ai_conversations WHERE id=$1 AND user_id=$2 AND company_id=$3', [pid(req), req.ctx.user.id, req.ctx.companyId]);
  if (!c) throw badRequest('Conversation not found.');
  const { rows } = await pool.query('SELECT id, role, content, data, created_at FROM ai_messages WHERE conversation_id=$1 ORDER BY id', [c.id]);
  res.json({ ...c, messages: rows });
}));
r.delete('/ai/conversations/:id', need('use_ai'), asyncH(async (req, res) => {
  await pool.query('DELETE FROM ai_conversations WHERE id=$1 AND user_id=$2 AND company_id=$3', [pid(req), req.ctx.user.id, req.ctx.companyId]); res.json({ ok: true });
}));
r.post('/ai/chat', need('use_ai'), aiLimiter, asyncH(async (req, res) => {
  const b = z.object({ message: z.string().min(1).max(2000), conversation_id: z.coerce.number().int().positive().optional().nullable() }).parse(req.body);
  res.json(await chat(req.ctx, { conversationId: b.conversation_id, message: b.message }));
}));
r.post('/ai/extract', need('use_ai'), aiLimiter, upload.single('file'), asyncH(async (req, res) => {
  if (!can(req.ctx, 'create_expense') && !can(req.ctx, 'create_purchase')) throw forbidden('You need permission to record expenses or purchases.');
  if (req.ctx.settings.ai.auto_extract_documents === false) throw forbidden('Document extraction is disabled in AI settings.');
  let documentId = req.body?.document_id ? Number(req.body.document_id) : null;
  if (!documentId) {
    if (!req.file) throw badRequest('Upload a receipt or invoice.');
    const doc = await saveUpload(pool, req.ctx, req.file, { category: 'receipt', kind: 'receipt' });
    await audit(req.ctx, 'document.uploaded', { entityType: 'document', entityId: doc.id, newValue: { name: doc.original_name, for: 'ai_extraction' } });
    documentId = doc.id;
  }
  res.status(201).json({ document_id: documentId, ...(await extractAndDraft(req.ctx, documentId, { create: req.body?.create !== 'false' })) });
}));
r.get('/ai/analysis', need('view_reports'), asyncH(async (req, res) => res.json(await analyse(req.ctx, req.query))));

export default r;
