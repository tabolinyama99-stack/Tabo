// Fetch wrapper: JSON, CSRF header, friendly errors.
let csrf = null;
export const setCsrf = (t) => { csrf = t; };

export class ApiError extends Error {
  constructor(status, body) { super(body?.error?.message || `Request failed (${status})`); this.status = status; this.code = body?.error?.code; this.details = body?.error?.details; }
}

async function request(method, url, body, { form = false } = {}) {
  const headers = {};
  if (csrf && method !== 'GET') headers['X-CSRF-Token'] = csrf;
  let payload;
  if (form) payload = body; else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  let res;
  try { res = await fetch(`/api${url}`, { method, headers, body: payload, credentials: 'same-origin' }); }
  catch { throw new ApiError(0, { error: { message: 'Cannot reach the server. Check your connection and try again.' } }); }
  const isJson = (res.headers.get('content-type') || '').includes('application/json');
  const data = isJson ? await res.json() : null;
  if (!res.ok) {
    const err = new ApiError(res.status, data);
    if (res.status === 401 && !url.startsWith('/auth/')) window.dispatchEvent(new CustomEvent('tael:unauthorized'));
    throw err;
  }
  return data;
}

export const api = {
  get: (u) => request('GET', u),
  post: (u, b) => request('POST', u, b ?? {}),
  put: (u, b) => request('PUT', u, b ?? {}),
  del: (u) => request('DELETE', u),
  upload: (u, file, fields = {}) => { const f = new FormData(); if (file) f.append('file', file); for (const [k, v] of Object.entries(fields)) if (v !== undefined && v !== null) f.append(k, v); return request('POST', u, f, { form: true }); },
};

/** Download or open a binary endpoint (PDF/XLSX/CSV) using the session cookie. */
export async function download(url, { open = false } = {}) {
  const res = await fetch(`/api${url}`, { credentials: 'same-origin' });
  if (!res.ok) { let b = null; try { b = await res.json(); } catch { /* binary */ } throw new ApiError(res.status, b); }
  const blob = await res.blob();
  const href = URL.createObjectURL(blob);
  if (open) { window.open(href, '_blank', 'noopener'); setTimeout(() => URL.revokeObjectURL(href), 60000); return; }
  const cd = res.headers.get('content-disposition') || '';
  const name = cd.match(/filename="?([^"]+)"?/)?.[1] || 'download';
  const a = document.createElement('a'); a.href = href; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 10000);
}

export const qs = (o) => { const p = new URLSearchParams(); for (const [k, v] of Object.entries(o || {})) if (v !== undefined && v !== null && v !== '') p.set(k, v); const s = p.toString(); return s ? `?${s}` : ''; };
