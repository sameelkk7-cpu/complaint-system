const express = require('express');
const db = require('../db');
const mailer = require('../mailer');
const { requireAuth, requireRole } = require('../middleware/auth');
const { parseDetails, logAction } = require('./complaints');

const router = express.Router();
router.use(requireAuth, requireRole('residency'));

// Complaints this committee member may handle: assigned to them, or to their block.
// Flagged (Unverified) and Rejected complaints stay with the admin.
const MINE = `
  (c.assigned_residency_id = @id OR (@block IS NOT NULL AND UPPER(c.assigned_block) = UPPER(@block)))
  AND c.status NOT IN ('Unverified','Rejected')`;
const SELECT = `SELECT c.*, u.name AS resident_name, u.flat_number AS resident_flat
                FROM complaints c JOIN users u ON u.id = c.user_id`;

function getOwned(req, res) {
  const c = db.prepare(`${SELECT} WHERE c.id = @cid AND ${MINE}`).get({ cid: req.params.id, id: req.user.id, block: req.user.block || null });
  if (!c) res.status(404).json({ error: 'Complaint not found or not assigned to you' });
  return c;
}
function emailResident(c, subject, text) {
  const u = db.prepare('SELECT email, name FROM users WHERE id = ?').get(c.user_id);
  if (u) mailer.notify(u.email, subject, `Hello ${u.name},\n\n${text}\n\n— Residents' Complaint Desk`);
}

router.get('/complaints', (req, res) => {
  const rows = db.prepare(`${SELECT} WHERE ${MINE} AND c.status NOT IN ('Resolved','Closed') ORDER BY c.created_at DESC`)
    .all({ id: req.user.id, block: req.user.block || null });
  res.json(rows.map(parseDetails));
});

router.patch('/complaints/:id/respond', (req, res) => {
  const response = (req.body.response || '').trim();
  if (!response) return res.status(400).json({ error: 'response is required' });
  const c = getOwned(req, res); if (!c) return;
  db.prepare(`UPDATE complaints SET residency_response = ?, updated_at = datetime('now') WHERE id = ?`).run(response, c.id);
  logAction(c.id, req.user.id, 'RESIDENCY_RESPONSE', response.slice(0, 200));
  emailResident(c, `Update on complaint #${c.id}`, `The committee responded to your complaint #${c.id}:\n\n"${response}"`);
  res.json({ message: 'Response recorded' });
});

router.patch('/complaints/:id/schedule-meeting', (req, res) => {
  const { meeting_datetime } = req.body;
  if (!meeting_datetime) return res.status(400).json({ error: 'meeting_datetime is required' });
  const c = getOwned(req, res); if (!c) return;
  db.prepare(`UPDATE complaints SET meeting_proposed_at = ?, status = 'In Progress', updated_at = datetime('now') WHERE id = ?`).run(meeting_datetime, c.id);
  logAction(c.id, req.user.id, 'MEETING_SCHEDULED', meeting_datetime);
  emailResident(c, `Resolution meeting proposed for complaint #${c.id}`,
    `The committee proposed a resolution meeting on ${meeting_datetime.replace('T', ' at ')} for your complaint #${c.id}.`);
  res.json({ message: 'Meeting scheduled' });
});

// Mark resolved (committee can close its own cases)
router.patch('/complaints/:id/resolve', (req, res) => {
  const c = getOwned(req, res); if (!c) return;
  db.prepare(`UPDATE complaints SET status = 'Resolved', updated_at = datetime('now') WHERE id = ?`).run(c.id);
  logAction(c.id, req.user.id, 'MARKED_RESOLVED', null);
  emailResident(c, `Complaint #${c.id} resolved`, `Your complaint #${c.id} (${c.category}) was marked resolved. Please rate the outcome in your portal.`);
  res.json({ message: 'Marked resolved' });
});

// Escalate: unassign from committee and send back to the admin's queue
router.patch('/complaints/:id/escalate', (req, res) => {
  const c = getOwned(req, res); if (!c) return;
  db.prepare(`UPDATE complaints SET status = 'Pending', assigned_residency_id = NULL, assigned_block = NULL, updated_at = datetime('now') WHERE id = ?`).run(c.id);
  logAction(c.id, req.user.id, 'ESCALATED_TO_ADMIN', req.body.reason || null);
  res.json({ message: 'Complaint escalated to admin' });
});

router.get('/history', (req, res) => {
  const rows = db.prepare(`${SELECT} WHERE ${MINE} AND c.status IN ('Resolved','Closed') ORDER BY c.updated_at DESC`)
    .all({ id: req.user.id, block: req.user.block || null });
  res.json(rows.map(parseDetails));
});

module.exports = router;
