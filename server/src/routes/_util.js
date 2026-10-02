import { z } from 'zod';
export { z };
export const money = z.union([z.string(), z.number()]).transform((v) => String(v).trim()).refine((v) => /^-?[\d,]*(\.\d+)?$/.test(v.replace(/^K\s?/i, '')) && v !== '', 'must be an amount');
export const id = z.coerce.number().int().positive();
export const optId = z.union([z.coerce.number().int().positive(), z.literal(''), z.null()]).optional().transform((v) => (v === '' ? null : v));
export const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a date (YYYY-MM-DD)');
export const optDate = z.union([date, z.literal(''), z.null()]).optional().transform((v) => v || null);
export const str = (max = 500) => z.string().trim().max(max);
export const optStr = (max = 500) => z.union([z.string().trim().max(max), z.null()]).optional();
export const pid = (req) => { const n = Number(req.params.id); if (!Number.isSafeInteger(n) || n <= 0) { const e = new Error('Invalid id'); e.status = 400; e.expose = true; e.code = 'BAD_REQUEST'; throw e; } return n; };
export function paging(q) {
  const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 500);
  const page = Math.max(Number(q.page) || 1, 1);
  return { limit, offset: (page - 1) * limit, page };
}
