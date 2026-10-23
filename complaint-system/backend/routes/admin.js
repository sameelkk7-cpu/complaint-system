const express = require('express');
const path = require('path');
const fs = require('fs');
const db = require('../db');
const mailer = require('../mailer');
const { requireAuth, requireRole } = require('../middleware/auth');
const { parseDetails, logAction, analyzeAudio, verdictFor, UPLOAD_ROOT } = require('./complaints');

const router = express.Router();
router.use(requireAuth, requireRole('admin'));

const COMPLAINT_SELECT = `
  SELECT c.*, u.name AS resident_name, u.flat_number AS resident_flat, u.email AS resident_email,
         r.name AS assigned_to_name
  FROM complaints c
  JOIN users u ON u.id = c.user_id
  LEFT JOIN users r ON r.id = c.assigned_residency_id`;

function emailResident(complaint, subject, text) {
  const u = db.prepare('SELECT email, name FROM users WHERE id = ?').get(complaint.user_id);
  if (u) mailer.notify(u.email, subject, `Hello ${u.name},\n\n${text}\n\n— Residents' Complaint Desk`);
}

// ---- Resident verification ----
router.get('/users', (req, res) => {
  const { status } = req.query;
  const base = 'SELECT id, name, email, role, flat_number, block, status, created_at FROM users';
  res.json(status ? db.prepare(`${base} WHERE status = ? ORDER BY id DESC`).all(status)
                  : db.prepare(`${base} ORDER BY id DESC`).all());
});

router.patch('/users/:id/status', (req, res) => {
  const { status } = req.body;
  if (!['approved', 'rejected', 'deactivated'].includes(status)) {
    return res.status(400).json({ error: 'status must be approved, rejected, or deactivated' });
  }
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target.role === 'admin') return res.status(400).json({ error: 'Admin accounts cannot be changed here' });

  db.prepare('UPDATE users SET status = ? WHERE id = ?').run(status, req.params.id);
  if (status === 'approved') {
    mailer.notify(target.email, 'Your account has been approved',
      `Hello ${target.name},\n\nYour account has been approved. You can now sign in and use the complaint desk.\n\n— Residents' Complaint Desk`);
  }
  res.json({ message: `User ${req.params.id} set to ${status}` });
});

// Committee members (for the "assign" dialog)
router.get('/committee', (req, res) => {
  res.json(db.prepare(`SELECT id, name, block, flat_number FROM users WHERE role = 'residency' AND status = 'approved' ORDER BY name`).all());
});

// ---- Complaints ----
router.get('/complaints', (req, res) => {
  const { status } = req.query;
  const rows = status
    ? db.prepare(`${COMPLAINT_SELECT} WHERE c.status = ? ORDER BY c.created_at DESC`).all(status)
    : db.prepare(`${COMPLAINT_SELECT} ORDER BY c.created_at DESC`).all();
  res.json(rows.map(parseDetails));
});

router.get('/complaints/:id', (req, res) => {
  const c = db.prepare(`${COMPLAINT_SELECT} WHERE c.id = ?`).get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Not found' });
  res.json(parseDetails(c));
});

// Admin-only removal; keep the audit history without a dangling foreign key.
router.delete('/complaints/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid complaint ID' });
  const c = db.prepare('SELECT * FROM complaints WHERE id = ?').get(id);
  if (!c) return res.status(404).json({ error: 'Complaint not found' });
  db.transaction(() => {
    db.prepare('UPDATE audit_log SET complaint_id = NULL WHERE complaint_id = ?').run(id);
    db.prepare('DELETE FROM complaints WHERE id = ?').run(id);
    logAction(null, req.user.id, 'COMPLAINT_DELETED', `complaint_id=${id}, category=${c.category}`);
  })();
  for (const [folder, filename] of [['audio', c.audio_path], ['photos', c.photo_path]]) {
    if (!filename) continue;
    fs.unlink(path.join(UPLOAD_ROOT, folder, path.basename(filename)), err => {
      if (err && err.code !== 'ENOENT') console.error('Could not remove deleted complaint evidence:', err.message);
    });
  }
  res.json({ message: `Complaint #${id} deleted` });
});

// Flagged ("Unverified") complaints: accept -> Pending, reject -> Rejected
router.patch('/complaints/:id/review', (req, res) => {
  const { decision } = req.body;
  if (!['accept', 'reject'].includes(decision)) return res.status(400).json({ error: "decision must be 'accept' or 'reject'" });
  const c = db.prepare('SELECT * FROM complaints WHERE id = ?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Not found' });
  if (c.status !== 'Unverified') return res.status(400).json({ error: 'Only Unverified complaints can be reviewed here' });

  const newStatus = decision === 'accept' ? 'Pending' : 'Rejected';
  db.prepare(`UPDATE complaints SET status = ?, updated_at = datetime('now') WHERE id = ?`).run(newStatus, c.id);
  logAction(c.id, req.user.id, 'FLAGGED_REVIEW', `decision=${decision}`);
  emailResident(c, `Complaint #${c.id} ${decision === 'accept' ? 'accepted' : 'not accepted'}`,
    decision === 'accept'
      ? `Your complaint #${c.id} (${c.category}) was reviewed and accepted. It is now being handled.`
      : `Your complaint #${c.id} (${c.category}) was reviewed but could not be accepted. Please contact the admin if you have more evidence.`);
  res.json({ message: `Complaint marked ${newStatus}` });
});

// Re-run AI analysis on a complaint with audio
router.post('/complaints/:id/reanalyze', async (req, res) => {
  const c = db.prepare('SELECT * FROM complaints WHERE id = ?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Complaint not found' });
  if (!c.audio_path) return res.status(400).json({ error: 'No audio evidence attached to this complaint' });

  const audioFilePath = path.join(UPLOAD_ROOT, 'audio', path.basename(c.audio_path));
  if (!fs.existsSync(audioFilePath)) {
    return res.status(404).json({ error: 'Audio file missing on server' });
  }

  try {
    const ai = await analyzeAudio(audioFilePath);
    const ai_verdict = verdictFor(c.claimed_noise_type, ai);
    db.prepare(`
      UPDATE complaints
      SET ai_category = ?, ai_confidence = ?, noise_level = ?, ai_verdict = ?, ai_details = ?,
          status = CASE WHEN ? = 'Verified' AND status = 'Unverified' THEN 'Pending' ELSE status END,
          updated_at = datetime('now')
      WHERE id = ?
    `).run(
      ai.top_category, ai.confidence, ai.noise_level, ai_verdict,
      JSON.stringify({
        top_predictions: ai.top_predictions, category_scores: ai.category_scores,
        noise_db_relative: ai.noise_db_relative, active_fraction: ai.active_fraction, mock: !!ai.mock
      }),
      ai_verdict, c.id
    );
    logAction(c.id, req.user.id, 'AI_REANALYZED',
      `ai_category=${ai.top_category}, confidence=${ai.confidence}, verdict=${ai_verdict}`);
    res.json(parseDetails(db.prepare(`${COMPLAINT_SELECT} WHERE c.id = ?`).get(c.id)));
  } catch (err) {
    console.error('Re-analysis error for complaint #' + c.id + ':', err.message);
    db.prepare(`UPDATE complaints SET ai_verdict = 'Verification Failed', updated_at = datetime('now') WHERE id = ?`).run(c.id);
    logAction(c.id, req.user.id, 'AI_REANALYSIS_FAILED', err.message);
    res.status(502).json({ error: `AI analysis failed: ${err.message}` });
  }
});

// Assign to a committee member and/or a block
router.patch('/complaints/:id/assign', (req, res) => {
  const { residency_user_id, assigned_block } = req.body;
  const c = db.prepare('SELECT * FROM complaints WHERE id = ?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Not found' });

  let block = (assigned_block || '').trim().toUpperCase() || null;
  let memberId = residency_user_id ? Number(residency_user_id) : null;
  if (memberId) {
    const m = db.prepare(`SELECT id, block FROM users WHERE id = ? AND role = 'residency' AND status = 'approved'`).get(memberId);
    if (!m) return res.status(400).json({ error: 'Selected committee member not found' });
    if (!block) block = m.block ? m.block.toUpperCase() : null;
  }
  db.prepare(`UPDATE complaints SET assigned_residency_id = ?, assigned_block = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(memberId, block, c.id);
  logAction(c.id, req.user.id, 'ASSIGNED', `committee_member=${memberId || '-'}, block=${block || '-'}`);
  res.json({ message: 'Complaint assigned' });
});

// Status management
router.patch('/complaints/:id/status', (req, res) => {
  const { status } = req.body;
  const valid = ['Pending', 'In Progress', 'Resolved', 'Closed', 'Rejected'];
  if (!valid.includes(status)) return res.status(400).json({ error: `status must be one of ${valid.join(', ')}` });
  const c = db.prepare('SELECT * FROM complaints WHERE id = ?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Not found' });
  db.prepare(`UPDATE complaints SET status = ?, updated_at = datetime('now') WHERE id = ?`).run(status, c.id);
  logAction(c.id, req.user.id, 'STATUS_CHANGED', `${c.status} -> ${status}`);
  emailResident(c, `Complaint #${c.id} is now "${status}"`,
    `The status of your complaint #${c.id} (${c.category}) changed from "${c.status}" to "${status}".`);
  res.json({ message: `Complaint status updated to ${status}` });
});

// Repeat offenders = the same flat/unit being complained about 2+ times (rejected ones ignored)
router.get('/repeat-offenders', (req, res) => {
  res.json(db.prepare(`
    SELECT against_unit AS unit, COUNT(*) AS complaint_count,
           SUM(CASE WHEN status IN ('Resolved','Closed') THEN 1 ELSE 0 END) AS resolved_count,
           MAX(created_at) AS last_complaint
    FROM complaints
    WHERE status NOT IN ('Rejected') AND against_unit IS NOT NULL AND against_unit != ''
    GROUP BY against_unit HAVING COUNT(*) >= 2
    ORDER BY complaint_count DESC`).all());
});

// ---- Reports ----
router.get('/reports/summary', (req, res) => {
  const byStatus = db.prepare(`SELECT status, COUNT(*) AS count FROM complaints GROUP BY status`).all();
  const byCategory = db.prepare(`SELECT category, COUNT(*) AS count FROM complaints GROUP BY category ORDER BY count DESC`).all();
  const byAiCategory = db.prepare(`SELECT ai_category AS category, COUNT(*) AS count FROM complaints WHERE ai_category IS NOT NULL GROUP BY ai_category ORDER BY count DESC`).all();
  const byVerdict = db.prepare(`SELECT ai_verdict AS verdict, COUNT(*) AS count FROM complaints WHERE ai_verdict IS NOT NULL GROUP BY ai_verdict`).all();
  const avg = db.prepare(`SELECT AVG((julianday(updated_at) - julianday(created_at)) * 24) AS avg_hours FROM complaints WHERE status IN ('Resolved','Closed')`).get();
  const rating = db.prepare(`SELECT AVG(rating) AS avg_rating, COUNT(rating) AS rated FROM complaints WHERE rating IS NOT NULL`).get();
  const total = db.prepare('SELECT COUNT(*) AS n FROM complaints').get().n;
  res.json({ total, byStatus, byCategory, byAiCategory, byVerdict, avgResolutionHours: avg.avg_hours, avgRating: rating.avg_rating, ratedCount: rating.rated });
});

router.get('/reports/export.csv', (req, res) => {
  const rows = db.prepare(`${COMPLAINT_SELECT} ORDER BY c.id`).all();
  const cols = ['id', 'created_at', 'resident_name', 'resident_flat', 'category', 'against_unit', 'status', 'ai_category', 'ai_confidence', 'noise_level', 'ai_verdict', 'assigned_block', 'assigned_to_name', 'rating', 'description'];
  const esc = v => `"${String(v ?? '').replace(/"/g, '""').replace(/\r?\n/g, ' ')}"`;
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="complaints.csv"');
  res.send([cols.join(','), ...rows.map(r => cols.map(c => esc(r[c])).join(','))].join('\n'));
});

// ---- Announcements (shown in every user's page + optionally e-mailed) ----
router.post('/announcements', async (req, res) => {
  const title = (req.body.title || '').trim();
  const body = (req.body.body || '').trim();
  const sendEmail = req.body.send_email !== false;   // default: also email everyone
  if (!title || !body) return res.status(400).json({ error: 'title and body are required' });

  const info = db.prepare('INSERT INTO announcements (title, body, created_by) VALUES (?, ?, ?)').run(title, body, req.user.id);

  let result = { sent: 0, failed: 0 };
  const recipients = db.prepare(`SELECT email FROM users WHERE status = 'approved' AND role IN ('user','residency')`).all().map(r => r.email);
  if (sendEmail && recipients.length) {
    result = await mailer.sendMany(
      recipients, `[Society Notice] ${title}`,
      `${title}\n\n${body}\n\n— Posted by ${req.user.name} via the Residents' Complaint Desk`
    );
    db.prepare('UPDATE announcements SET emailed_count = ?, email_failed_count = ? WHERE id = ?').run(result.sent, result.failed, info.lastInsertRowid);
  }
  res.status(201).json({ id: info.lastInsertRowid, recipients: recipients.length, emailed: result.sent, failed: result.failed, email_mode: mailer.mode(), email_requested: sendEmail });
});

router.get('/announcements', (req, res) => {
  res.json(db.prepare('SELECT * FROM announcements ORDER BY id DESC LIMIT 100').all());
});

router.delete('/announcements/:id', (req, res) => {
  db.prepare('DELETE FROM announcements WHERE id = ?').run(req.params.id);
  res.json({ message: 'Deleted' });
});

router.get('/email-mode', (req, res) => res.json({ mode: mailer.mode() }));

module.exports = router;
