const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const { entities, defaultSettings } = require('./schema');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'college.db'));
db.pragma('journal_mode = WAL');

function sqlType(field) {
  if (field.type === 'number') return 'REAL';
  if (field.type === 'boolean' || field.type === 'ref') return 'INTEGER';
  return 'TEXT';
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const test = crypto.scryptSync(String(password), salt, 64);
  const known = Buffer.from(hash, 'hex');
  return known.length === test.length && crypto.timingSafeEqual(known, test);
}

function migrate() {
  for (const [table, def] of Object.entries(entities)) {
    db.exec(`CREATE TABLE IF NOT EXISTS ${table} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      extra TEXT DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )`);
    const existing = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name));
    for (const f of def.fields) {
      if (!existing.has(f.name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${f.name} ${sqlType(f)}`);
    }
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS custom_fields (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity TEXT NOT NULL, name TEXT NOT NULL, label TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'text', options TEXT DEFAULT '',
      required INTEGER DEFAULT 0, list INTEGER DEFAULT 0, sort INTEGER DEFAULT 0,
      UNIQUE(entity, name)
    );
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER, user_name TEXT, action TEXT, entity TEXT, record_id INTEGER,
      details TEXT, created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_attendance_student ON attendance(student_id);
    CREATE INDEX IF NOT EXISTS idx_grades_student ON grades(student_id);
    CREATE INDEX IF NOT EXISTS idx_fees_student ON fees(student_id);
    CREATE INDEX IF NOT EXISTS idx_enrollments_student ON enrollments(student_id);
  `);

  const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(defaultSettings)) insertSetting.run(k, v);

  const hasSuper = db.prepare("SELECT COUNT(*) n FROM users WHERE role = 'super_admin'").get().n;
  if (!hasSuper) {
    const email = process.env.SUPERADMIN_EMAIL || 'superadmin@college.edu';
    const password = process.env.SUPERADMIN_PASSWORD || 'admin123';
    db.prepare(`INSERT INTO users (name, email, role, password, active) VALUES (?, ?, 'super_admin', ?, 1)`)
      .run('Super Admin', email, hashPassword(password));
    console.log(`\n  Super admin created -> email: ${email}  password: ${password}`);
    console.log('  Change this password after your first login!\n');
  }
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
}

function getSettings() {
  const out = {};
  for (const row of db.prepare('SELECT key, value FROM settings').all()) out[row.key] = row.value;
  return out;
}

migrate();

module.exports = { db, migrate, hashPassword, verifyPassword, getSettings, DATA_DIR };
