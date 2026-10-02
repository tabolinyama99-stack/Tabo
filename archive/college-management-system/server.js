const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const { entities: baseEntities, ROLES, FIELD_TYPES, defaultSettings } = require('./src/schema');
const { db, hashPassword, verifyPassword, getSettings, DATA_DIR } = require('./src/db');

const PORT = process.env.PORT || 3000;
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');
const SESSION_DAYS = 7;
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '12mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOAD_DIR, {
  setHeaders: res => {
    // Uploaded files (e.g. SVG logos) must never run scripts.
    res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox");
    res.setHeader('X-Content-Type-Options', 'nosniff');
  }
}));

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const wrap = fn => (req, res, next) => {
  try {
    const out = fn(req, res, next);
    if (out !== undefined && !res.headersSent) res.json(out);
  } catch (e) { next(e); }
};

// ---------------------------------------------------------------- entities

function parseJSON(text, fallback) {
  try { return JSON.parse(text); } catch { return fallback; }
}

// Schema + super admin overrides (module labels/visibility/permissions) + custom fields.
function getEntities() {
  const modules = parseJSON(getSettings().modules || '{}', {});
  const custom = db.prepare('SELECT * FROM custom_fields ORDER BY sort, id').all();
  const out = {};
  for (const [key, base] of Object.entries(baseEntities)) {
    const o = modules[key] || {};
    const def = {
      key,
      ...base,
      label: o.label || base.label,
      singular: o.singular || base.singular,
      icon: o.icon || base.icon,
      hidden: !!o.hidden,
      read: Array.isArray(o.read) ? o.read : base.read,
      write: Array.isArray(o.write) ? o.write : base.write,
      fields: base.fields.map(f => ({ ...f, label: (o.fieldLabels && o.fieldLabels[f.name]) || f.label }))
    };
    for (const cf of custom.filter(c => c.entity === key)) {
      def.fields.push({
        name: 'x_' + cf.name, label: cf.label, type: cf.type, custom: true, customId: cf.id,
        options: cf.options ? cf.options.split(',').map(s => s.trim()).filter(Boolean) : undefined,
        required: !!cf.required, list: !!cf.list
      });
    }
    out[key] = def;
  }
  return out;
}

function getEntity(key) {
  const def = getEntities()[key];
  if (!def) throw new HttpError(404, 'Unknown module: ' + key);
  return def;
}

function can(user, def, action) {
  if (!user) return false;
  if (user.role === 'super_admin') return true;
  if (def.hidden) return false;
  return (def[action] || []).includes(user.role);
}

function visibleFields(user, def) {
  return def.fields.filter(f => !(f.hideFrom || []).includes(user.role));
}

function displayLabel(def, row) {
  if (!row) return '';
  if (def.key === 'enrollments' || def.key === 'attendance' || def.key === 'grades' || def.key === 'fees' || def.key === 'timetable') {
    return `#${row.id} ${row.description || row.assessment || row.date || row.day || ''}`.trim();
  }
  const parts = def.display.map(n => row[n]).filter(v => v !== null && v !== undefined && v !== '');
  if (parts.length > 1 && def.display[0].match(/code|no$/)) return `${parts[0]} – ${parts.slice(1).join(' ')}`;
  return parts.join(' ') || `#${row.id}`;
}

// Row-level restrictions (students only see their own records, etc.)
function scopeWhere(user, def) {
  const where = [];
  const params = [];
  if (user.role === 'student' && def.scope && def.scope.student) {
    where.push(`${def.scope.student} = ?`);
    params.push(user.student_id || -1);
  }
  if (def.key === 'notices' && user.role !== 'super_admin' && user.role !== 'admin') {
    const aud = user.role === 'student' ? ['Everyone', 'Students'] : ['Everyone', 'Teachers', 'Staff'];
    where.push(`(audience IS NULL OR audience IN (${aud.map(() => '?').join(',')}))`);
    params.push(...aud);
  }
  if (def.key === 'users' && user.role !== 'super_admin') {
    where.push("role != 'super_admin'");
  }
  return { where, params };
}

function serialize(user, def, row) {
  if (!row) return row;
  const extra = parseJSON(row.extra || '{}', {});
  const out = { id: row.id, created_at: row.created_at, updated_at: row.updated_at };
  for (const f of visibleFields(user, def)) {
    if (f.type === 'password') continue;
    out[f.name] = f.custom ? (extra[f.name.slice(2)] ?? null) : row[f.name];
  }
  return out;
}

function refLabels(user, def, rows) {
  const labels = {};
  const all = getEntities();
  for (const f of def.fields.filter(f => f.type === 'ref')) {
    const ids = [...new Set(rows.map(r => r[f.name]).filter(v => v !== null && v !== undefined))];
    labels[f.name] = {};
    if (!ids.length) continue;
    const refDef = all[f.ref];
    const refRows = db.prepare(`SELECT * FROM ${f.ref} WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids);
    for (const r of refRows) labels[f.name][r.id] = displayLabel(refDef, r);
  }
  return labels;
}

function coerce(field, value) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return field.type === 'boolean' ? 0 : null;
  switch (field.type) {
    case 'number': {
      const n = Number(value);
      if (Number.isNaN(n)) throw new HttpError(400, `${field.label} must be a number`);
      return n;
    }
    case 'boolean': return value === true || value === 1 || value === '1' || value === 'true' || value === 'on' ? 1 : 0;
    case 'ref': {
      const n = parseInt(value, 10);
      if (Number.isNaN(n)) throw new HttpError(400, `${field.label} is invalid`);
      return n;
    }
    default: return String(value).trim();
  }
}

function gradeFromScale(pct) {
  const scale = (getSettings().grading_scale || defaultSettings.grading_scale)
    .split(',').map(s => s.split(':').map(x => x.trim())).filter(p => p.length === 2)
    .map(([g, min]) => [g, Number(min)]).sort((a, b) => b[1] - a[1]);
  for (const [g, min] of scale) if (pct >= min) return g;
  return scale.length ? scale[scale.length - 1][0] : '';
}

// Validate a body and split it into column values and custom-field values.
function prepareValues(user, def, body, existing) {
  const cols = {};
  const extra = existing ? parseJSON(existing.extra || '{}', {}) : {};
  const fields = visibleFields(user, def).filter(f => !f.readonly);
  for (const f of fields) {
    let v = coerce(f, body[f.name]);
    if (v === undefined) {
      if (existing) continue;
      v = f.default !== undefined ? f.default : (f.type === 'boolean' ? 0 : null);
    }
    if (f.type === 'password') {
      if (v) cols.password = hashPassword(v);
      continue;
    }
    if (f.required && (v === null || v === '')) throw new HttpError(400, `${f.label} is required`);
    if (f.type === 'email' && v && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) throw new HttpError(400, `${f.label} is not a valid email`);
    if (f.type === 'ref' && v !== null) {
      if (!db.prepare(`SELECT 1 FROM ${f.ref} WHERE id = ?`).get(v)) throw new HttpError(400, `${f.label}: selected record does not exist`);
    }
    if (f.unique && v !== null && v !== '') {
      const dup = db.prepare(`SELECT id FROM ${def.key} WHERE ${f.name} = ? COLLATE NOCASE AND id != ?`).get(v, existing ? existing.id : -1);
      if (dup) throw new HttpError(409, `${f.label} "${v}" already exists`);
    }
    if (f.custom) extra[f.name.slice(2)] = v;
    else cols[f.name] = v;
  }
  cols.extra = JSON.stringify(extra);

  // Module specific rules.
  const merged = { ...(existing || {}), ...cols };
  if (def.key === 'fees') {
    const amount = Number(merged.amount) || 0;
    const paid = Number(merged.paid) || 0;
    cols.status = paid >= amount && amount > 0 ? 'Paid' : paid > 0 ? 'Partial' : 'Unpaid';
  }
  if (def.key === 'grades') {
    if (!merged.grade && merged.score !== null && merged.score !== undefined) {
      const max = Number(merged.max_score) || 100;
      cols.grade = gradeFromScale((Number(merged.score) / max) * 100);
    }
  }
  if (def.key === 'users') {
    if (!existing && !cols.password) throw new HttpError(400, 'Password is required for new users');
    if (cols.role && !ROLES.includes(cols.role)) throw new HttpError(400, 'Invalid role');
    if (user.role !== 'super_admin') {
      if (cols.role === 'super_admin' || (existing && existing.role === 'super_admin')) {
        throw new HttpError(403, 'Only the super admin can manage super admin accounts');
      }
    }
    if (existing && existing.role === 'super_admin' && (cols.role && cols.role !== 'super_admin' || cols.active === 0)) {
      const supers = db.prepare("SELECT COUNT(*) n FROM users WHERE role='super_admin' AND active=1").get().n;
      if (supers <= 1) throw new HttpError(400, 'You cannot demote or deactivate the last super admin');
    }
  }
  return cols;
}

function audit(user, action, entity, recordId, details) {
  db.prepare('INSERT INTO audit_log (user_id, user_name, action, entity, record_id, details) VALUES (?,?,?,?,?,?)')
    .run(user ? user.id : null, user ? user.name : 'system', action, entity, recordId || null,
      typeof details === 'string' ? details : JSON.stringify(details || {}));
}

function deleteRecord(user, def, id) {
  const row = db.prepare(`SELECT * FROM ${def.key} WHERE id = ?`).get(id);
  if (!row) throw new HttpError(404, 'Record not found');
  if (def.key === 'users') {
    if (row.id === user.id) throw new HttpError(400, 'You cannot delete your own account');
    if (row.role === 'super_admin') {
      if (user.role !== 'super_admin') throw new HttpError(403, 'Only the super admin can delete super admins');
      const supers = db.prepare("SELECT COUNT(*) n FROM users WHERE role='super_admin'").get().n;
      if (supers <= 1) throw new HttpError(400, 'You cannot delete the last super admin');
    }
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
  }
  // Cascade to records that point at this one.
  let cascaded = 0;
  for (const [key, other] of Object.entries(baseEntities)) {
    for (const f of other.fields.filter(f => f.type === 'ref' && f.ref === def.key)) {
      if (f.onDelete === 'cascade') {
        const dependents = db.prepare(`SELECT id FROM ${key} WHERE ${f.name} = ?`).all(id);
        for (const d of dependents) cascaded += 1 + deleteRecord(user, getEntity(key), d.id).cascaded;
      } else {
        db.prepare(`UPDATE ${key} SET ${f.name} = NULL WHERE ${f.name} = ?`).run(id);
      }
    }
  }
  db.prepare(`DELETE FROM ${def.key} WHERE id = ?`).run(id);
  return { row, cascaded };
}

// ---------------------------------------------------------------- auth

const loginAttempts = new Map();

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

app.use((req, res, next) => {
  const token = parseCookies(req).cms_session;
  if (token) {
    const s = db.prepare('SELECT * FROM sessions WHERE token = ? AND expires_at > ?').get(token, Date.now());
    if (s) {
      const u = db.prepare('SELECT * FROM users WHERE id = ? AND active = 1').get(s.user_id);
      if (u) { req.user = u; req.token = token; }
    }
  }
  next();
});

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Please sign in' });
  next();
}
function requireSuper(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Please sign in' });
  if (req.user.role !== 'super_admin') return res.status(403).json({ error: 'Super admin only' });
  next();
}

function publicUser(u) {
  let linked = null;
  if (u.student_id) linked = db.prepare('SELECT id, reg_no, first_name, last_name FROM students WHERE id = ?').get(u.student_id);
  if (u.teacher_id) linked = db.prepare('SELECT id, staff_no, first_name, last_name FROM teachers WHERE id = ?').get(u.teacher_id);
  return { id: u.id, name: u.name, email: u.email, role: u.role, avatar: u.avatar, student_id: u.student_id, teacher_id: u.teacher_id, linked };
}

app.post('/api/login', wrap((req, res) => {
  const ip = req.ip;
  const a = loginAttempts.get(ip) || { n: 0, until: 0 };
  if (a.until > Date.now()) throw new HttpError(429, 'Too many attempts. Try again in a few minutes.');
  const { email, password } = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE').get(String(email || '').trim());
  if (!u || !verifyPassword(password || '', u.password) || !u.active) {
    a.n += 1;
    if (a.n >= 8) { a.until = Date.now() + 5 * 60 * 1000; a.n = 0; }
    loginAttempts.set(ip, a);
    throw new HttpError(401, u && !u.active ? 'This account is disabled' : 'Wrong email or password');
  }
  loginAttempts.delete(ip);
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?,?,?)').run(token, u.id, Date.now() + SESSION_DAYS * 864e5);
  res.setHeader('Set-Cookie', `cms_session=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`);
  audit(u, 'login', 'users', u.id, '');
  return { user: publicUser(u) };
}));

app.post('/api/logout', wrap((req, res) => {
  if (req.token) db.prepare('DELETE FROM sessions WHERE token = ?').run(req.token);
  res.setHeader('Set-Cookie', 'cms_session=; HttpOnly; Path=/; Max-Age=0');
  return { ok: true };
}));

app.get('/api/me', requireAuth, wrap(req => ({ user: publicUser(req.user) })));

app.put('/api/me', requireAuth, wrap(req => {
  const { name, avatar } = req.body || {};
  if (!name || !String(name).trim()) throw new HttpError(400, 'Name is required');
  db.prepare("UPDATE users SET name = ?, avatar = ?, updated_at = datetime('now') WHERE id = ?").run(String(name).trim(), avatar || null, req.user.id);
  return { user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id)) };
}));

app.post('/api/me/password', requireAuth, wrap(req => {
  const { current, next } = req.body || {};
  if (!verifyPassword(current || '', req.user.password)) throw new HttpError(400, 'Current password is wrong');
  if (!next || String(next).length < 6) throw new HttpError(400, 'New password must be at least 6 characters');
  db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hashPassword(next), req.user.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?').run(req.user.id, req.token);
  audit(req.user, 'change_password', 'users', req.user.id, '');
  return { ok: true };
}));

// ---------------------------------------------------------------- settings & branding

app.get('/api/settings', wrap(() => {
  const s = getSettings();
  return s;
}));

app.put('/api/settings', requireSuper, wrap(req => {
  const body = req.body || {};
  const upsert = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  const tx = db.transaction(() => {
    for (const [k, v] of Object.entries(body)) {
      if (!/^[a-z_]{1,40}$/.test(k)) continue;
      upsert.run(k, typeof v === 'string' ? v : JSON.stringify(v));
    }
  });
  tx();
  audit(req.user, 'update', 'settings', null, Object.keys(body).join(', '));
  return getSettings();
}));

app.post('/api/settings/reset', requireSuper, wrap(req => {
  const upsert = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  for (const [k, v] of Object.entries(defaultSettings)) upsert.run(k, v);
  audit(req.user, 'reset', 'settings', null, 'Branding and settings reset to defaults');
  return getSettings();
}));

const MIME = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp',
  'image/svg+xml': 'svg', 'image/x-icon': 'ico', 'image/vnd.microsoft.icon': 'ico'
};
app.post('/api/upload', requireAuth, wrap(req => {
  const m = /^data:([\w/+.-]+);base64,(.+)$/s.exec((req.body && req.body.dataUrl) || '');
  if (!m || !MIME[m[1]]) throw new HttpError(400, 'Please upload an image (PNG, JPG, GIF, WEBP, SVG or ICO)');
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 8 * 1024 * 1024) throw new HttpError(400, 'Image is too large (max 8 MB)');
  const name = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}.${MIME[m[1]]}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, name), buf);
  return { url: '/uploads/' + name };
}));

// ---------------------------------------------------------------- meta

app.get('/api/meta', requireAuth, wrap(req => {
  const all = getEntities();
  const out = {};
  for (const [key, def] of Object.entries(all)) {
    const readable = can(req.user, def, 'read');
    if (!readable && req.user.role !== 'super_admin') continue;
    out[key] = {
      key, label: def.label, singular: def.singular, icon: def.icon, hidden: def.hidden,
      read: def.read, write: def.write,
      canWrite: can(req.user, def, 'write'),
      canDelete: can(req.user, def, 'write'),
      fields: visibleFields(req.user, def).map(f => ({
        name: f.name, label: f.label, type: f.type, options: f.options, ref: f.ref, required: !!f.required,
        list: !!f.list, readonly: !!f.readonly, custom: !!f.custom, customId: f.customId, default: f.default
      }))
    };
  }
  return { entities: out, roles: ROLES, fieldTypes: FIELD_TYPES, baseEntities: Object.fromEntries(Object.entries(baseEntities).map(([k, d]) => [k, { label: d.label, singular: d.singular, icon: d.icon, read: d.read, write: d.write, fields: d.fields.map(f => ({ name: f.name, label: f.label })) }])) };
}));

// ---------------------------------------------------------------- generic CRUD

function listRows(req, def, { all = false } = {}) {
  const user = req.user;
  const { where, params } = scopeWhere(user, def);
  const fields = visibleFields(user, def);
  const q = String(req.query.q || '').trim();
  if (q) {
    const like = `%${q}%`;
    const ors = [];
    for (const f of fields.filter(f => !f.custom && ['text', 'textarea', 'email', 'select', 'date', 'number'].includes(f.type))) {
      ors.push(`CAST(${f.name} AS TEXT) LIKE ?`); params.push(like);
    }
    ors.push('extra LIKE ?'); params.push(like);
    ors.push('CAST(id AS TEXT) = ?'); params.push(q);
    const allDefs = getEntities();
    for (const f of fields.filter(f => f.type === 'ref')) {
      const refDef = allDefs[f.ref];
      const cols = baseEntities[f.ref].display.filter(n => n !== 'id');
      if (!cols.length) continue;
      const refIds = db.prepare(`SELECT id FROM ${f.ref} WHERE ${cols.map(c => `CAST(${c} AS TEXT) LIKE ?`).join(' OR ')} OR (${cols.map(c => `COALESCE(${c},'')`).join(" || ' ' || ")}) LIKE ? LIMIT 500`)
        .all(...cols.map(() => like), like).map(r => r.id);
      if (refIds.length && refDef) { ors.push(`${f.name} IN (${refIds.join(',')})`); }
    }
    where.push(`(${ors.join(' OR ')})`);
  }
  for (const f of fields.filter(f => !f.custom)) {
    const v = req.query['f_' + f.name];
    if (v !== undefined && v !== '') { where.push(`${f.name} = ?`); params.push(v); }
  }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const sortable = new Set(['id', 'created_at', 'updated_at', ...fields.filter(f => !f.custom && f.type !== 'password').map(f => f.name)]);
  let sort = sortable.has(req.query.sort) ? req.query.sort : (def.key === 'notices' ? 'pinned DESC, publish_date' : 'id');
  const dir = req.query.dir === 'asc' ? 'ASC' : 'DESC';
  const total = db.prepare(`SELECT COUNT(*) n FROM ${def.key} ${whereSql}`).get(...params).n;
  const limit = all ? -1 : Math.min(Math.max(parseInt(req.query.limit, 10) || 25, 1), 500);
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const rows = db.prepare(`SELECT * FROM ${def.key} ${whereSql} ORDER BY ${sort} ${dir} LIMIT ? OFFSET ?`)
    .all(...params, limit, all ? 0 : (page - 1) * limit);
  return { rows: rows.map(r => serialize(user, def, r)), total, page, limit, labels: refLabels(user, def, rows) };
}

function entityFor(req, action) {
  const def = getEntity(req.params.entity);
  if (!can(req.user, def, action)) throw new HttpError(403, `You don't have permission to ${action === 'read' ? 'view' : 'change'} ${def.label}`);
  return def;
}

app.get('/api/data/:entity', requireAuth, wrap(req => listRows(req, entityFor(req, 'read'), { all: req.query.all === '1' })));

app.get('/api/options/:entity', requireAuth, wrap(req => {
  const def = entityFor(req, 'read');
  const { where, params } = scopeWhere(req.user, def);
  const rows = db.prepare(`SELECT * FROM ${def.key} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id`).all(...params);
  return rows.map(r => ({ id: r.id, label: displayLabel(def, r) }));
}));

app.get('/api/data/:entity/:id', requireAuth, wrap(req => {
  const def = entityFor(req, 'read');
  const { where, params } = scopeWhere(req.user, def);
  where.push('id = ?'); params.push(req.params.id);
  const row = db.prepare(`SELECT * FROM ${def.key} WHERE ${where.join(' AND ')}`).get(...params);
  if (!row) throw new HttpError(404, 'Record not found');
  return { row: serialize(req.user, def, row), labels: refLabels(req.user, def, [row]) };
}));

function createRecord(user, def, body) {
  const cols = prepareValues(user, def, body || {}, null);
  const names = Object.keys(cols);
  const info = db.prepare(`INSERT INTO ${def.key} (${names.join(',')}) VALUES (${names.map(() => '?').join(',')})`).run(...names.map(n => cols[n]));
  audit(user, 'create', def.key, info.lastInsertRowid, displayLabel(def, { id: info.lastInsertRowid, ...cols }));
  return db.prepare(`SELECT * FROM ${def.key} WHERE id = ?`).get(info.lastInsertRowid);
}

app.post('/api/data/:entity', requireAuth, wrap(req => {
  const def = entityFor(req, 'write');
  return { row: serialize(req.user, def, createRecord(req.user, def, req.body)) };
}));

app.post('/api/data/:entity/import', requireAuth, wrap(req => {
  const def = entityFor(req, 'write');
  const rows = Array.isArray(req.body && req.body.rows) ? req.body.rows : [];
  let created = 0;
  const errors = [];
  rows.forEach((r, i) => {
    try { createRecord(req.user, def, r); created++; } catch (e) { errors.push(`Row ${i + 2}: ${e.message}`); }
  });
  return { created, errors };
}));

app.put('/api/data/:entity/:id', requireAuth, wrap(req => {
  const def = entityFor(req, 'write');
  const existing = db.prepare(`SELECT * FROM ${def.key} WHERE id = ?`).get(req.params.id);
  if (!existing) throw new HttpError(404, 'Record not found');
  if (def.key === 'users' && req.user.role !== 'super_admin' && existing.role === 'super_admin') {
    throw new HttpError(403, 'Only the super admin can edit super admin accounts');
  }
  const cols = prepareValues(req.user, def, req.body || {}, existing);
  const names = Object.keys(cols);
  db.prepare(`UPDATE ${def.key} SET ${names.map(n => `${n} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`)
    .run(...names.map(n => cols[n]), existing.id);
  if (def.key === 'users' && cols.password && existing.id !== req.user.id) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(existing.id);
  const row = db.prepare(`SELECT * FROM ${def.key} WHERE id = ?`).get(existing.id);
  audit(req.user, 'update', def.key, existing.id, displayLabel(def, row));
  return { row: serialize(req.user, def, row) };
}));

app.delete('/api/data/:entity/:id', requireAuth, wrap(req => {
  const def = entityFor(req, 'write');
  const result = db.transaction(() => deleteRecord(req.user, def, Number(req.params.id)))();
  audit(req.user, 'delete', def.key, result.row.id, displayLabel(def, result.row) + (result.cascaded ? ` (+${result.cascaded} related)` : ''));
  return { ok: true, cascaded: result.cascaded };
}));

app.post('/api/data/:entity/bulk-delete', requireAuth, wrap(req => {
  const def = entityFor(req, 'write');
  const ids = (req.body && req.body.ids || []).map(Number).filter(Boolean);
  let deleted = 0, cascaded = 0;
  const errors = [];
  for (const id of ids) {
    try {
      const r = db.transaction(() => deleteRecord(req.user, def, id))();
      deleted++; cascaded += r.cascaded;
    } catch (e) { errors.push(`#${id}: ${e.message}`); }
  }
  audit(req.user, 'bulk_delete', def.key, null, `${deleted} deleted, ${cascaded} related`);
  return { deleted, cascaded, errors };
}));

// Super admin: wipe every record in a module.
app.post('/api/data/:entity/wipe', requireSuper, wrap(req => {
  const def = getEntity(req.params.entity);
  let deleted = 0;
  db.transaction(() => {
    const rows = def.key === 'users'
      ? db.prepare("SELECT id FROM users WHERE role != 'super_admin'").all()
      : db.prepare(`SELECT id FROM ${def.key}`).all();
    for (const r of rows) { deleteRecord(req.user, def, r.id); deleted++; }
  })();
  audit(req.user, 'wipe', def.key, null, `${deleted} records`);
  return { deleted };
}));

// ---------------------------------------------------------------- custom fields

app.get('/api/custom-fields', requireAuth, wrap(() => db.prepare('SELECT * FROM custom_fields ORDER BY entity, sort, id').all()));

function cleanCustomField(body) {
  const entity = String(body.entity || '');
  if (!baseEntities[entity]) throw new HttpError(400, 'Choose a module');
  const label = String(body.label || '').trim();
  if (!label) throw new HttpError(400, 'Label is required');
  const name = (String(body.name || '').trim() || label).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40);
  if (!name) throw new HttpError(400, 'Invalid field name');
  const type = FIELD_TYPES.includes(body.type) ? body.type : 'text';
  return {
    entity, name, label, type, options: String(body.options || ''),
    required: body.required ? 1 : 0, list: body.list ? 1 : 0, sort: parseInt(body.sort, 10) || 0
  };
}

app.post('/api/custom-fields', requireSuper, wrap(req => {
  const c = cleanCustomField(req.body || {});
  try {
    const info = db.prepare('INSERT INTO custom_fields (entity,name,label,type,options,required,list,sort) VALUES (@entity,@name,@label,@type,@options,@required,@list,@sort)').run(c);
    audit(req.user, 'create', 'custom_fields', info.lastInsertRowid, `${c.entity}.${c.name}`);
    return db.prepare('SELECT * FROM custom_fields WHERE id = ?').get(info.lastInsertRowid);
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) throw new HttpError(409, 'That field already exists on this module');
    throw e;
  }
}));

app.put('/api/custom-fields/:id', requireSuper, wrap(req => {
  const old = db.prepare('SELECT * FROM custom_fields WHERE id = ?').get(req.params.id);
  if (!old) throw new HttpError(404, 'Field not found');
  const c = cleanCustomField({ ...req.body, entity: old.entity, name: old.name });
  db.prepare('UPDATE custom_fields SET label=@label, type=@type, options=@options, required=@required, list=@list, sort=@sort WHERE id=@id').run({ ...c, id: old.id });
  audit(req.user, 'update', 'custom_fields', old.id, `${old.entity}.${old.name}`);
  return db.prepare('SELECT * FROM custom_fields WHERE id = ?').get(old.id);
}));

app.delete('/api/custom-fields/:id', requireSuper, wrap(req => {
  const old = db.prepare('SELECT * FROM custom_fields WHERE id = ?').get(req.params.id);
  if (!old) throw new HttpError(404, 'Field not found');
  db.prepare('DELETE FROM custom_fields WHERE id = ?').run(old.id);
  audit(req.user, 'delete', 'custom_fields', old.id, `${old.entity}.${old.name}`);
  return { ok: true };
}));

// ---------------------------------------------------------------- dashboard

app.get('/api/dashboard', requireAuth, wrap(req => {
  const u = req.user;
  const all = getEntities();
  const counts = {};
  for (const [key, def] of Object.entries(all)) {
    if (!can(u, def, 'read') || def.hidden) continue;
    const { where, params } = scopeWhere(u, def);
    counts[key] = db.prepare(`SELECT COUNT(*) n FROM ${key} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`).get(...params).n;
  }
  const scoped = (table) => {
    const { where, params } = scopeWhere(u, all[table]);
    return { sql: where.length ? 'WHERE ' + where.join(' AND ') : '', params };
  };
  const out = { counts };
  if (can(u, all.fees, 'read')) {
    const s = scoped('fees');
    out.fees = db.prepare(`SELECT COALESCE(SUM(amount),0) due, COALESCE(SUM(paid),0) paid FROM fees ${s.sql}`).get(...s.params);
  }
  if (can(u, all.attendance, 'read')) {
    const s = scoped('attendance');
    out.attendance = db.prepare(`SELECT status, COUNT(*) n FROM attendance ${s.sql} GROUP BY status`).all(...s.params);
  }
  if (can(u, all.students, 'read') && u.role !== 'student') {
    out.studentsByStatus = db.prepare("SELECT COALESCE(status, 'Unknown') status, COUNT(*) n FROM students GROUP BY status").all();
    out.studentsByDept = db.prepare("SELECT COALESCE(d.name, 'Unassigned') name, COUNT(*) n FROM students s LEFT JOIN departments d ON d.id = s.department_id GROUP BY d.id ORDER BY n DESC LIMIT 8").all();
  }
  if (can(u, all.notices, 'read')) {
    const s = scoped('notices');
    out.notices = db.prepare(`SELECT id, title, body, audience, publish_date, pinned FROM notices ${s.sql} ORDER BY pinned DESC, COALESCE(publish_date, created_at) DESC LIMIT 5`).all(...s.params);
  }
  if (u.role === 'student' && u.student_id) {
    out.grades = db.prepare(`SELECT g.assessment, g.score, g.max_score, g.grade, c.code, c.title FROM grades g LEFT JOIN courses c ON c.id = g.course_id WHERE g.student_id = ? ORDER BY g.id DESC LIMIT 8`).all(u.student_id);
    out.myCourses = db.prepare(`SELECT c.code, c.title FROM enrollments e JOIN courses c ON c.id = e.course_id WHERE e.student_id = ? AND e.status = 'Enrolled'`).all(u.student_id);
  }
  if (u.role === 'super_admin') {
    out.recent = db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 8').all();
  }
  return out;
}));

// ---------------------------------------------------------------- super admin tools

app.get('/api/audit', requireSuper, wrap(req => {
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const q = String(req.query.q || '').trim();
  const where = q ? "WHERE user_name LIKE ? OR action LIKE ? OR entity LIKE ? OR details LIKE ?" : '';
  const params = q ? Array(4).fill(`%${q}%`) : [];
  const total = db.prepare(`SELECT COUNT(*) n FROM audit_log ${where}`).get(...params).n;
  const rows = db.prepare(`SELECT * FROM audit_log ${where} ORDER BY id DESC LIMIT 50 OFFSET ?`).all(...params, (page - 1) * 50);
  return { rows, total, page, limit: 50 };
}));

app.delete('/api/audit', requireSuper, wrap(req => {
  db.prepare('DELETE FROM audit_log').run();
  audit(req.user, 'clear', 'audit_log', null, 'Audit log cleared');
  return { ok: true };
}));

const BACKUP_TABLES = () => [...Object.keys(baseEntities), 'settings', 'custom_fields'];

app.get('/api/backup', requireSuper, wrap((req, res) => {
  const data = { app: 'college-management-system', version: 1, exported_at: new Date().toISOString(), tables: {} };
  for (const t of BACKUP_TABLES()) data.tables[t] = db.prepare(`SELECT * FROM ${t}`).all();
  res.setHeader('Content-Disposition', `attachment; filename="college-backup-${new Date().toISOString().slice(0, 10)}.json"`);
  res.json(data);
}));

app.post('/api/restore', requireSuper, wrap(req => {
  const data = req.body;
  if (!data || data.app !== 'college-management-system' || !data.tables) throw new HttpError(400, 'This is not a valid backup file');
  if (!(data.tables.users || []).some(u => u.role === 'super_admin')) throw new HttpError(400, 'Backup has no super admin account; refusing to restore');
  db.transaction(() => {
    for (const t of BACKUP_TABLES()) {
      if (!Array.isArray(data.tables[t])) continue;
      const cols = new Set(db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name));
      db.prepare(`DELETE FROM ${t}`).run();
      for (const row of data.tables[t]) {
        const names = Object.keys(row).filter(n => cols.has(n));
        if (!names.length) continue;
        db.prepare(`INSERT INTO ${t} (${names.join(',')}) VALUES (${names.map(() => '?').join(',')})`).run(...names.map(n => row[n]));
      }
    }
    db.prepare('DELETE FROM sessions WHERE user_id != ?').run(req.user.id);
  })();
  audit(req.user, 'restore', 'backup', null, `Restored backup from ${data.exported_at || 'unknown date'}`);
  return { ok: true };
}));

// ---------------------------------------------------------------- errors & SPA

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.get(/^\/(?!api\/|uploads\/).*/, (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Upload is too large' });
  if (err.status && err.status < 500) return res.status(err.status).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong: ' + err.message });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`College Management System running at http://localhost:${PORT}`);
    console.log(`Data folder: ${DATA_DIR}`);
  });
}

module.exports = app;
