const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || (process.env.DATA_DIR ? path.join(process.env.DATA_DIR, 'complaint_system.db') : path.join(__dirname, 'complaint_system.db'));
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('admin','user','residency')),
  flat_number TEXT,
  block TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','deactivated')),
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS complaints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  category TEXT NOT NULL,
  description TEXT NOT NULL,
  incident_datetime TEXT,
  photo_path TEXT,
  audio_path TEXT,
  ai_category TEXT,
  ai_confidence REAL,
  noise_level TEXT,
  status TEXT NOT NULL DEFAULT 'Pending' CHECK(status IN ('Pending','Unverified','In Progress','Resolved','Closed','Rejected')),
  assigned_block TEXT,
  assigned_residency_id INTEGER REFERENCES users(id),
  residency_response TEXT,
  meeting_proposed_at TEXT,
  rating INTEGER,
  feedback TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  complaint_id INTEGER REFERENCES complaints(id),
  actor_user_id INTEGER REFERENCES users(id),
  action TEXT NOT NULL,
  details TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS announcements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT DEFAULT (datetime('now'))
);
`);

// ---- Lightweight migrations (safe to run on an existing database) ----
function addColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}
// The neighbour's flat/block the complaint is AGAINST (used for repeat-offender tracking).
addColumn('complaints', 'against_unit', 'TEXT');
// What kind of noise the resident says it is (compared with the AI's finding).
addColumn('complaints', 'claimed_noise_type', 'TEXT');
// AI verification outcome: Verified | Mismatch | Inconclusive | Unavailable
addColumn('complaints', 'ai_verdict', 'TEXT');
// Full AI evidence report (JSON: top sounds, category scores, relative dB ...)
addColumn('complaints', 'ai_details', 'TEXT');
addColumn('announcements', 'emailed_count', 'INTEGER DEFAULT 0');
addColumn('announcements', 'email_failed_count', 'INTEGER DEFAULT 0');

// Seed a default admin account if none exists yet
const adminExists = db.prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1").get();
if (!adminExists) {
  const hash = bcrypt.hashSync('admin123', 10);
  db.prepare(`INSERT INTO users (name, email, password_hash, role, status)
              VALUES (?, ?, ?, 'admin', 'approved')`)
    .run('System Admin', 'admin@society.local', hash);
  console.log('Seeded default admin -> email: admin@society.local  password: admin123');
}

// Seed a default guest account for permission-free submissions
const guestExists = db.prepare("SELECT id FROM users WHERE email = 'guest@society.local' LIMIT 1").get();
if (!guestExists) {
  const hash = bcrypt.hashSync('guest1234', 10);
  db.prepare(`INSERT INTO users (name, email, password_hash, role, status)
              VALUES (?, ?, ?, 'user', 'approved')`)
    .run('Guest Resident', 'guest@society.local', hash);
  console.log('Seeded default guest account -> email: guest@society.local');
}

// Ensure all existing users are approved so no one is blocked from submitting or signing in
try {
  db.prepare("UPDATE users SET status = 'approved' WHERE status = 'pending'").run();
} catch (e) {}

module.exports = db;
