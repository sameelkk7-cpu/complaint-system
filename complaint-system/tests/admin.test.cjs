const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Database = require('../backend/node_modules/better-sqlite3');

function fixture() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`CREATE TABLE complaints (id INTEGER PRIMARY KEY, category TEXT, photo_path TEXT, audio_path TEXT);
    CREATE TABLE audit_log (id INTEGER PRIMARY KEY, complaint_id INTEGER REFERENCES complaints(id), actor_user_id INTEGER, action TEXT, details TEXT);
    INSERT INTO complaints VALUES (1, 'Parking', 'photo.jpg', NULL), (2, 'Noise Disturbance', NULL, 'clip.wav');
    INSERT INTO audit_log VALUES (1, 1, 4, 'CREATED', ''), (2, 2, 4, 'CREATED', '');`);
  const routes = {}, guards = [], removed = [];
  const router = { use: (...values) => guards.push(...values) };
  for (const method of ['get', 'post', 'patch', 'delete']) router[method] = (url, fn) => { routes[method + url] = fn; };
  const requireAuth = () => {};
  const adminOnly = () => {};
  const source = fs.readFileSync(path.join(__dirname, '../backend/routes/admin.js'), 'utf8');
  vm.runInNewContext(source, { module: { exports: {} }, console, require(name) {
    if (name === 'express') return { Router: () => router };
    if (name === 'path') return path;
    if (name === 'fs') return { unlink: (file, cb) => { removed.push(file); cb(null); } };
    if (name === '../db') return db;
    if (name === '../mailer') return {};
    if (name === '../middleware/auth') return { requireAuth, requireRole: role => { assert.equal(role, 'admin'); return adminOnly; } };
    if (name === './complaints') return { UPLOAD_ROOT: '/evidence', logAction: (...args) => db.prepare('INSERT INTO audit_log (complaint_id,actor_user_id,action,details) VALUES (?,?,?,?)').run(...args) };
    throw Error(name);
  } });
  function remove(id) {
    const result = {};
    routes['delete/complaints/:id']({ params: { id }, user: { id: 9 } }, {
      status(code) { result.status = code; return this; }, json(body) { result.body = body; }
    });
    return result;
  }
  return { db, remove, removed, guards, requireAuth, adminOnly };
}
test('deletion is admin-protected and removes only the selected complaint and evidence', () => {
  const f = fixture();
  try {
    assert.deepEqual(f.guards, [f.requireAuth, f.adminOnly]);
    f.remove('1');
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM complaints').get().n, 1);
    assert.equal(f.db.prepare('SELECT id FROM complaints').get().id, 2);
    assert.equal(f.db.prepare('SELECT complaint_id FROM audit_log WHERE id=1').get().complaint_id, null);
    assert.equal(f.db.prepare("SELECT details FROM audit_log WHERE action='COMPLAINT_DELETED'").get().details, 'complaint_id=1, category=Parking');
    assert.deepEqual(f.removed, [path.join('/evidence', 'photos', 'photo.jpg')]);
    assert.equal(f.remove('1').status, 404);
    assert.equal(f.remove('invalid').status, 400);
  } finally { f.db.close(); }
});
test('failed audit write rolls back deletion and preserves evidence', () => {
  const f = fixture();
  try {
    f.db.exec("CREATE TRIGGER prevent_audit BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT, 'test failure'); END;");
    assert.throws(() => f.remove('1'), /test failure/);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM complaints').get().n, 2);
    assert.equal(f.db.prepare('SELECT complaint_id FROM audit_log WHERE id=1').get().complaint_id, 1);
    assert.equal(f.removed.length, 0);
  } finally { f.db.close(); }
});
test('admin feedback displays escaped comments and numeric ratings', async () => {
  const html = fs.readFileSync(path.join(__dirname, '../frontend/admin-dashboard.html'), 'utf8');
  const source = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)][0][1];
  new vm.Script(source);
  const fragment = source.slice(source.indexOf('  async function loadFeedback()'), source.indexOf('  // ---- Assign dialog'));
  const list = {};
  const ctx = vm.createContext({ document: { getElementById: () => list }, apiFetch: async () => [{ id: 1, rating: 4, feedback: '<script>bad</script>', resident_name: 'Resident', category: 'Parking' }], esc: value => String(value).replaceAll('<', '&lt;').replaceAll('>', '&gt;') });
  vm.runInContext(fragment, ctx);
  await ctx.loadFeedback();
  assert.match(list.innerHTML, /4 \/ 5 stars/);
  assert.match(list.innerHTML, /&lt;script&gt;/);
  assert.doesNotMatch(list.innerHTML, /<script>/);
});
