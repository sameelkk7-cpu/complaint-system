const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const fetch = require('node-fetch');
const FormData = require('form-data');
const db = require('../db');
const { requireAuth, requireRole, userFromToken } = require('../middleware/auth');

const router = express.Router();

const UPLOAD_ROOT = process.env.UPLOADS_DIR || (process.env.DATA_DIR ? path.join(process.env.DATA_DIR, 'uploads') : path.join(__dirname, '..', 'uploads'));
for (const sub of ['audio', 'photos']) {
  fs.mkdirSync(path.join(UPLOAD_ROOT, sub), { recursive: true });
}
const MIN_CONF = Number(process.env.AI_MIN_CONFIDENCE || 0.30);

// ---------- File uploads (photo + audio evidence) ----------
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(UPLOAD_ROOT, file.fieldname === 'audio' ? 'audio' : 'photos')),
  // Random server-side name: no user-controlled path/filename, and not guessable.
  filename: (req, file, cb) => {
    const ext = (path.extname(file.originalname || '').toLowerCase().replace(/[^a-z0-9.]/g, '') || '').slice(0, 6);
    cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`);
  }
});
const fileFilter = (req, file, cb) => {
  const ok = (file.fieldname === 'audio' && /^(audio|video)\//.test(file.mimetype)) ||   // browsers label webm recordings video/webm
             (file.fieldname === 'photo' && /^image\//.test(file.mimetype));
  if (!ok) return cb(new Error(`Invalid ${file.fieldname} file type (${file.mimetype})`));
  cb(null, true);
};
const upload = multer({ storage, fileFilter, limits: { fileSize: 15 * 1024 * 1024 } });
const uploadFields = upload.fields([{ name: 'audio', maxCount: 1 }, { name: 'photo', maxCount: 1 }]);

function logAction(complaintId, actorId, action, details) {
  db.prepare(`INSERT INTO audit_log (complaint_id, actor_user_id, action, details) VALUES (?, ?, ?, ?)`)
    .run(complaintId, actorId, action, details || null);
}

// "B-402" -> "B" so complaints against a neighbour route to that block's committee.
function blockOf(unit) {
  if (!unit) return null;
  const m = String(unit).trim().toUpperCase().match(/^(?:BLOCK|WING)?\s*([A-Z0-9]+)/);
  return m ? m[1] : null;
}

function getAiAnalyzeUrl() {
  let url = (process.env.AI_SERVICE_URL || (process.env.NODE_ENV === 'production' ? 'https://complaint-system-ai-kxn8.onrender.com/analyze' : 'http://localhost:5001/analyze')).trim();
  // If set to the legacy/non-suffixed domain, normalize to the active Render AI service
  url = url.replace('https://complaint-system-ai.onrender.com', 'https://complaint-system-ai-kxn8.onrender.com');
  url = url.replace(/\/+$/, '');
  if (!url.endsWith('/analyze')) {
    url = `${url}/analyze`;
  }
  return url;
}

async function analyzeAudio(filePath, { attempt = 1 } = {}) {
  const aiUrl = getAiAnalyzeUrl();
  const stat = fs.statSync(filePath);
  const form = new FormData();
  form.append('audio', fs.createReadStream(filePath), { knownLength: stat.size });
  const headers = form.getHeaders();
  headers['content-length'] = String(form.getLengthSync());
  // Prevent node-fetch stream premature close on gzipped responses from Cloudflare/Render
  headers['accept-encoding'] = 'identity';
  // First request after start-up can be slow while the model warms up on the AI service.
  // Render free-tier cold starts take up to ~50 s; model load adds ~5-10 s more.
  // Use 150 s so we stay under gunicorn's 180 s worker timeout with margin.
  const TIMEOUT_MS = 150000;
  try {
    const resp = await fetch(aiUrl, {
      method: 'POST',
      body: form,
      headers,
      compress: false,
      timeout: TIMEOUT_MS
    });
    if (!resp.ok) {
      const errBody = await resp.json().catch(() => ({}));
      throw new Error(errBody.error || `AI service returned HTTP ${resp.status}`);
    }
    const body = await resp.json().catch(() => null);
    if (!body || !body.top_category || typeof body.confidence !== 'number') {
      throw new Error('AI service returned invalid or missing classification result');
    }
    return body;
  } catch (err) {
    // On a network timeout (cold-start wakeup), retry once before giving up.
    const isTimeout = err.type === 'request-timeout' || err.code === 'ECONNRESET' ||
                      err.code === 'ECONNREFUSED' || err.message.includes('network timeout');
    if (isTimeout && attempt === 1) {
      console.warn(`[AI] Timeout on attempt 1 (cold start?), retrying once — ${err.message}`);
      // Re-create the form stream for the retry (streams can't be reused)
      return analyzeAudio(filePath, { attempt: 2 });
    }
    throw err;
  }
}

// Decide whether the audio supports the complaint.
function verdictFor(claimedType, ai) {
  if (!ai || !ai.top_category || typeof ai.confidence !== 'number') return 'Inconclusive';
  if (ai.top_category === 'Silence') return 'Inconclusive';
  if (ai.confidence < MIN_CONF) return 'Inconclusive';
  if (claimedType && claimedType !== 'Other' && ai.top_category !== claimedType) return 'Mismatch';
  return 'Verified';
}

function parseDetails(c) {
  if (!c) return c;
  let ai_details = null;
  try { ai_details = c.ai_details ? JSON.parse(c.ai_details) : null; } catch (e) {}
  return { ...c, ai_details, has_photo: !!c.photo_path, has_audio: !!c.audio_path };
}

// ---------- Submit a complaint ----------
router.post('/', requireAuth, requireRole('user'), (req, res) => {
  uploadFields(req, res, async (uploadErr) => {
    if (uploadErr) return res.status(400).json({ error: uploadErr.message });

    const { category, description, incident_datetime, against_unit, claimed_noise_type } = req.body;
    const audioFile = req.files?.audio?.[0];
    const photoFile = req.files?.photo?.[0];
    const cleanup = () => [audioFile, photoFile].forEach(f => f && fs.unlink(f.path, () => {}));

    if (!category || !description || !description.trim()) {
      cleanup();
      return res.status(400).json({ error: 'category and description are required' });
    }

    let ai = null, ai_verdict = null, status = 'Pending';

    if (audioFile) {
      try {
        ai = await analyzeAudio(audioFile.path);
        ai_verdict = verdictFor(claimed_noise_type, ai);
        status = ai_verdict === 'Verified' ? 'Pending' : 'Unverified';
      } catch (err) {
        console.error('AI service problem, sending to manual review:', err.message);
        ai_verdict = 'Unavailable';
        status = 'Unverified';
      }
    }

    const unit = against_unit ? against_unit.trim().toUpperCase() : null;
    const info = db.prepare(`
      INSERT INTO complaints (user_id, category, description, incident_datetime, photo_path, audio_path,
                              ai_category, ai_confidence, noise_level, status, assigned_block,
                              against_unit, claimed_noise_type, ai_verdict, ai_details)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      req.user.id, category, description.trim(), incident_datetime || null,
      photoFile ? photoFile.filename : null, audioFile ? audioFile.filename : null,
      ai ? ai.top_category : null, ai ? ai.confidence : null, ai ? ai.noise_level : null,
      status, blockOf(unit), unit, claimed_noise_type || null, ai_verdict,
      ai ? JSON.stringify({
        top_predictions: ai.top_predictions, category_scores: ai.category_scores,
        noise_db_relative: ai.noise_db_relative, active_fraction: ai.active_fraction, mock: !!ai.mock
      }) : null
    );

    logAction(info.lastInsertRowid, req.user.id, 'COMPLAINT_SUBMITTED',
      `category=${category}, status=${status}${ai_verdict ? `, ai_verdict=${ai_verdict}` : ''}${photoFile ? ', photo' : ''}${audioFile ? ', audio' : ''}`);

    res.status(201).json(parseDetails(db.prepare('SELECT * FROM complaints WHERE id = ?').get(info.lastInsertRowid)));
  });
});

// ---------- Own complaints ----------
router.get('/mine', requireAuth, requireRole('user'), (req, res) => {
  const rows = db.prepare('SELECT * FROM complaints WHERE user_id = ? ORDER BY created_at DESC').all(req.user.id);
  res.json(rows.map(parseDetails));
});

// Who may look at a complaint (and its evidence)?
function canView(user, c) {
  if (user.role === 'admin') return true;
  if (user.role === 'user') return c.user_id === user.id;
  if (user.role === 'residency') {
    if (['Unverified', 'Rejected'].includes(c.status)) return false;
    return c.assigned_residency_id === user.id ||
      (!!user.block && !!c.assigned_block && c.assigned_block.toUpperCase() === user.block.toUpperCase());
  }
  return false;
}

// ---------- Evidence files (photo / audio) ----------
// <img>/<audio> tags can't send an Authorization header, so this endpoint also accepts ?token=
router.get('/:id/evidence/:kind', (req, res) => {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : req.query.token;
    if (!token) return res.status(401).json({ error: 'Missing auth token' });
    const user = userFromToken(token);

    const c = db.prepare('SELECT * FROM complaints WHERE id = ?').get(req.params.id);
    if (!c) return res.status(404).json({ error: 'Not found' });
    if (!canView(user, c)) return res.status(403).json({ error: 'Forbidden' });

    const kind = req.params.kind;
    if (!['photo', 'audio'].includes(kind)) return res.status(400).json({ error: 'kind must be photo or audio' });
    const filename = kind === 'photo' ? c.photo_path : c.audio_path;
    if (!filename) return res.status(404).json({ error: `No ${kind} attached` });

    const full = path.join(UPLOAD_ROOT, kind === 'photo' ? 'photos' : 'audio', path.basename(filename));
    if (!fs.existsSync(full)) return res.status(404).json({ error: 'File missing on server' });
    res.sendFile(full);
  } catch (err) {
    res.status(401).json({ error: 'Invalid or expired session' });
  }
});

// ---------- Single complaint (with resident name for staff) ----------
router.get('/:id', requireAuth, (req, res) => {
  const c = db.prepare(`
    SELECT c.*, u.name AS resident_name, u.flat_number AS resident_flat, u.block AS resident_block
    FROM complaints c JOIN users u ON u.id = c.user_id WHERE c.id = ?`).get(req.params.id);
  if (!c || !canView(req.user, c)) return res.status(404).json({ error: 'Not found' });
  res.json(parseDetails(c));
});

// ---------- Status timeline ----------
router.get('/:id/timeline', requireAuth, (req, res) => {
  const c = db.prepare('SELECT * FROM complaints WHERE id = ?').get(req.params.id);
  if (!c || !canView(req.user, c)) return res.status(404).json({ error: 'Not found' });
  const rows = db.prepare(`
    SELECT a.action, a.details, a.created_at, u.name AS actor, u.role AS actor_role
    FROM audit_log a LEFT JOIN users u ON u.id = a.actor_user_id
    WHERE a.complaint_id = ? ORDER BY a.created_at ASC, a.id ASC`).all(req.params.id);
  res.json(rows);
});

// ---------- Feedback once resolved ----------
router.post('/:id/feedback', requireAuth, requireRole('user'), (req, res) => {
  const rating = Number(req.body.rating);
  const { feedback } = req.body;
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) return res.status(400).json({ error: 'rating must be 1-5' });
  const c = db.prepare('SELECT * FROM complaints WHERE id = ?').get(req.params.id);
  if (!c || c.user_id !== req.user.id) return res.status(404).json({ error: 'Not found' });
  if (!['Closed', 'Resolved'].includes(c.status)) return res.status(400).json({ error: 'Feedback can only be left on resolved/closed complaints' });
  db.prepare(`UPDATE complaints SET rating = ?, feedback = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(rating, feedback || null, req.params.id);
  logAction(req.params.id, req.user.id, 'FEEDBACK_SUBMITTED', `rating=${rating}`);
  res.json({ message: 'Feedback recorded' });
});

module.exports = router;
module.exports.parseDetails = parseDetails;
module.exports.logAction = logAction;
module.exports.analyzeAudio = analyzeAudio;
module.exports.verdictFor = verdictFor;
module.exports.UPLOAD_ROOT = UPLOAD_ROOT;
module.exports.getAiAnalyzeUrl = getAiAnalyzeUrl;
