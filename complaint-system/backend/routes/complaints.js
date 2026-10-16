const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const fetch = require('node-fetch');
const FormData = require('form-data');
const db = require('../db');
const { requireAuth, optionalAuth, requireRole, userFromToken } = require('../middleware/auth');

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
const validAudioExts = ['.wav', '.mp3', '.ogg', '.webm', '.m4a', '.aac', '.flac', '.mp4'];

const fileFilter = (req, file, cb) => {
  if (file.fieldname === 'audio') {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const isAudioMime = /^(audio\/|video\/webm)/.test(file.mimetype);
    const isValidExt = validAudioExts.includes(ext);
    if (!isAudioMime && !isValidExt) {
      return cb(new Error(`Invalid audio file format (${file.mimetype}). Supported formats: WAV, MP3, WEBM, OGG, M4A, AAC`));
    }
    return cb(null, true);
  }
  if (file.fieldname === 'photo') {
    if (!/^image\//.test(file.mimetype)) {
      return cb(new Error(`Invalid photo file format (${file.mimetype})`));
    }
    return cb(null, true);
  }
  cb(new Error(`Invalid field: ${file.fieldname}`));
};
const upload = multer({ storage, fileFilter, limits: { fileSize: 25 * 1024 * 1024 } });
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
  let url = (process.env.AI_SERVICE_URL || (process.env.NODE_ENV === 'production' ? 'https://complaint-system-ai-kxn8.onrender.com/analyze' : 'http://127.0.0.1:5001/analyze')).trim();
  url = url.replace('https://complaint-system-ai.onrender.com', 'https://complaint-system-ai-kxn8.onrender.com');
  url = url.replace(/\/+$/, '');
  if (!url.endsWith('/analyze')) {
    url = `${url}/analyze`;
  }
  return url;
}

function validateAudioFile(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size < 100) {
      return 'Audio evidence is empty or corrupted (minimum size required).';
    }
    if (stat.size > 25 * 1024 * 1024) {
      return 'Audio file exceeds maximum size limit (25MB).';
    }

    // Parse WAV header if available to validate recording duration
    const fd = fs.openSync(filePath, 'r');
    const header = Buffer.alloc(44);
    fs.readSync(fd, header, 0, 44, 0);
    fs.closeSync(fd);

    if (header.slice(0, 4).toString() === 'RIFF' && header.slice(8, 12).toString() === 'WAVE') {
      const byteRate = header.readUInt32LE(28);
      if (byteRate > 0) {
        const durationSec = (stat.size - 44) / byteRate;
        if (durationSec < 1.0) {
          return `Audio recording is too short (${durationSec.toFixed(1)}s). Minimum recording duration is 1 second.`;
        }
        if (durationSec > 120.0) {
          return `Audio recording exceeds maximum duration (${durationSec.toFixed(1)}s > 120s).`;
        }
      }
    }
    return null;
  } catch (err) {
    return null;
  }
}

async function sendToAiUrl(url, filePath, timeoutMs = 15000) {
  const stat = fs.statSync(filePath);
  const form = new FormData();
  form.append('audio', fs.createReadStream(filePath), { knownLength: stat.size });
  const headers = form.getHeaders();
  headers['content-length'] = String(form.getLengthSync());
  headers['accept-encoding'] = 'identity';

  const resp = await fetch(url, {
    method: 'POST',
    body: form,
    headers,
    compress: false,
    timeout: timeoutMs
  });
  if (!resp.ok) {
    const errBody = await resp.json().catch(() => ({}));
    const error = new Error(errBody.error || `AI service returned HTTP ${resp.status}`);
    error.status = resp.status;
    throw error;
  }
  const body = await resp.json().catch(() => null);
  if (!body || !body.top_category || typeof body.confidence !== 'number') {
    throw new Error('AI service returned invalid or missing classification result');
  }
  return body;
}

// Calls real YAMNet AI service; never invents dummy results or claims verified if service is down
async function analyzeAudio(filePath) {
  const localUrl = (process.env.AI_SERVICE_URL && !process.env.AI_SERVICE_URL.includes('onrender.com'))
    ? process.env.AI_SERVICE_URL
    : 'http://127.0.0.1:5001/analyze';
  const remoteUrl = 'https://complaint-system-ai-kxn8.onrender.com/analyze';

  // 1. Try local AI service (quick timeout)
  try {
    return await sendToAiUrl(localUrl, filePath, 8000);
  } catch (errLocal) {
    // 2. Try remote Render AI service
    try {
      return await sendToAiUrl(remoteUrl, filePath, 25000);
    } catch (errRemote) {
      console.warn(`[AI] Verification service unreachable (local: ${errLocal.message}, remote: ${errRemote.message})`);
      throw new Error(`AI verification service unavailable (${errLocal.message || errRemote.message})`);
    }
  }
}

/**
 * Maps AI classification into one of the 4 verification states:
 * - Pending: awaiting processing
 * - Verified: audio confirmed and matches complaint
 * - Rejected: audio is silent, insufficient confidence, or mismatched sound
 * - Verification Failed: AI service error, timeout, or unreachable
 */
function verdictFor(claimedType, ai) {
  if (!ai || !ai.top_category || typeof ai.confidence !== 'number') {
    return 'Verification Failed';
  }
  if (ai.top_category === 'Silence') {
    return 'Rejected';
  }
  if (ai.confidence < MIN_CONF) {
    return 'Rejected';
  }
  if (claimedType && claimedType !== 'Other') {
    if (ai.top_category !== claimedType && ai.top_category !== 'Noise Disturbance') {
      return 'Rejected';
    }
  }
  return 'Verified';
}

function parseDetails(c) {
  if (!c) return c;
  let ai_details = null;
  try { ai_details = c.ai_details ? JSON.parse(c.ai_details) : null; } catch (e) {}
  return { ...c, ai_details, has_photo: !!c.photo_path, has_audio: !!c.audio_path };
}

// ---------- Submit a complaint (Mandatory Audio Evidence) ----------
router.post('/', optionalAuth, (req, res) => {
  uploadFields(req, res, async (uploadErr) => {
    if (uploadErr) return res.status(400).json({ error: uploadErr.message });

    const { category, description, incident_datetime, against_unit, claimed_noise_type } = req.body;
    const audioFile = req.files?.audio?.[0];
    const photoFile = req.files?.photo?.[0];
    const cleanup = () => [audioFile, photoFile].forEach(f => f && fs.unlink(f.path, () => {}));

    // Server-side mandatory audio evidence validation
    if (!audioFile) {
      cleanup();
      return res.status(400).json({
        error: 'Audio evidence is mandatory to submit a complaint. Please record or upload an audio file.'
      });
    }

    // Server-side audio format, size, and duration validation
    const audioValidationErr = validateAudioFile(audioFile.path);
    if (audioValidationErr) {
      cleanup();
      return res.status(400).json({ error: audioValidationErr });
    }

    if (!category || !description || !description.trim()) {
      cleanup();
      return res.status(400).json({ error: 'category and description are required' });
    }

    let ai = null;
    let ai_verdict = 'Pending';
    let status = 'Pending';

    // Every complaint passes through the audio verification workflow
    try {
      ai = await analyzeAudio(audioFile.path);
      ai_verdict = verdictFor(claimed_noise_type, ai);
    } catch (err) {
      console.warn('[AI] Verification failed or AI service unavailable:', err.message);
      // Safely handle failures without inventing fake results
      ai_verdict = 'Verification Failed';
      ai = null;
    }

    // If verification is not successful, do not mark as verified.
    // Complaints that are not Verified are held as 'Unverified' for admin review and retry.
    if (ai_verdict === 'Verified') {
      status = 'Pending';
    } else {
      status = 'Unverified';
    }

    // Determine acting user ID (logged-in user of ANY role, or guest resident)
    let actorUserId = req.user ? req.user.id : null;
    if (!actorUserId) {
      let guestUser = db.prepare("SELECT id FROM users WHERE email = 'guest@society.local'").get();
      if (!guestUser) {
        const hash = crypto.randomBytes(16).toString('hex');
        const info = db.prepare(`INSERT INTO users (name, email, password_hash, role, status) VALUES (?, ?, ?, 'user', 'approved')`)
          .run('Guest Resident', 'guest@society.local', hash);
        actorUserId = info.lastInsertRowid;
      } else {
        actorUserId = guestUser.id;
      }
    }

    const unit = against_unit ? against_unit.trim().toUpperCase() : null;
    const info = db.prepare(`
      INSERT INTO complaints (user_id, category, description, incident_datetime, photo_path, audio_path,
                              ai_category, ai_confidence, noise_level, status, assigned_block,
                              against_unit, claimed_noise_type, ai_verdict, ai_details)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      actorUserId, category, description.trim(), incident_datetime || null,
      photoFile ? photoFile.filename : null, audioFile.filename,
      ai ? ai.top_category : null, ai ? ai.confidence : null, ai ? ai.noise_level : null,
      status, blockOf(unit), unit, claimed_noise_type || null, ai_verdict,
      ai ? JSON.stringify({
        top_predictions: ai.top_predictions, category_scores: ai.category_scores,
        noise_db_relative: ai.noise_db_relative, active_fraction: ai.active_fraction, mock: !!ai.mock
      }) : null
    );

    logAction(info.lastInsertRowid, actorUserId, 'COMPLAINT_SUBMITTED',
      `category=${category}, status=${status}, ai_verdict=${ai_verdict}${photoFile ? ', photo' : ''}, audio=mandatory`);

    res.status(201).json(parseDetails(db.prepare('SELECT * FROM complaints WHERE id = ?').get(info.lastInsertRowid)));
  });
});

// Re-run AI audio verification (Retry Verification option for temporary errors or manual retry)
router.post('/:id/reanalyze', optionalAuth, async (req, res) => {
  const c = db.prepare('SELECT * FROM complaints WHERE id = ?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Complaint not found' });
  if (!c.audio_path) return res.status(400).json({ error: 'No audio evidence attached to this complaint' });

  // Authorization: owner of complaint or admin
  if (req.user && req.user.role !== 'admin' && req.user.id !== c.user_id) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const audioFilePath = path.join(UPLOAD_ROOT, 'audio', path.basename(c.audio_path));
  if (!fs.existsSync(audioFilePath)) {
    return res.status(404).json({ error: 'Audio file missing on server' });
  }

  let ai = null;
  let ai_verdict = 'Verification Failed';
  try {
    ai = await analyzeAudio(audioFilePath);
    ai_verdict = verdictFor(c.claimed_noise_type, ai);
  } catch (err) {
    console.warn(`[AI reanalyze] Verification failed: ${err.message}`);
    ai_verdict = 'Verification Failed';
  }

  db.prepare(`
    UPDATE complaints
    SET ai_category = ?, ai_confidence = ?, noise_level = ?, ai_verdict = ?, ai_details = ?,
        status = CASE WHEN ? = 'Verified' AND status = 'Unverified' THEN 'Pending' ELSE status END,
        updated_at = datetime('now')
    WHERE id = ?
  `).run(
    ai ? ai.top_category : null,
    ai ? ai.confidence : null,
    ai ? ai.noise_level : null,
    ai_verdict,
    ai ? JSON.stringify({
      top_predictions: ai.top_predictions,
      category_scores: ai.category_scores,
      noise_db_relative: ai.noise_db_relative,
      active_fraction: ai.active_fraction,
      mock: !!ai.mock
    }) : null,
    ai_verdict,
    c.id
  );

  logAction(c.id, req.user ? req.user.id : c.user_id, 'AI_REANALYZED',
    `ai_verdict=${ai_verdict}${ai ? `, top_category=${ai.top_category}` : ''}`);

  if (ai_verdict === 'Verification Failed') {
    return res.status(502).json({
      error: 'AI verification service is currently unavailable. Please try again in a few moments.',
      complaint: parseDetails(db.prepare('SELECT * FROM complaints WHERE id = ?').get(c.id))
    });
  }

  res.json(parseDetails(db.prepare('SELECT * FROM complaints WHERE id = ?').get(c.id)));
});

// ---------- Own complaints (Any authenticated user can view their complaints) ----------
router.get('/mine', optionalAuth, (req, res) => {
  const userId = req.user ? req.user.id : null;
  if (!userId) {
    return res.json([]);
  }
  const rows = db.prepare('SELECT * FROM complaints WHERE user_id = ? ORDER BY created_at DESC').all(userId);
  res.json(rows.map(parseDetails));
});

// Who may look at a complaint (and its evidence)?
function canView(user, c) {
  return true; // Transparent access across portal
}

// ---------- Evidence files (photo / audio) ----------
router.get('/:id/evidence/:kind', (req, res) => {
  try {
    const c = db.prepare('SELECT * FROM complaints WHERE id = ?').get(req.params.id);
    if (!c) return res.status(404).json({ error: 'Not found' });

    const kind = req.params.kind;
    if (!['photo', 'audio'].includes(kind)) return res.status(400).json({ error: 'kind must be photo or audio' });
    const filename = kind === 'photo' ? c.photo_path : c.audio_path;
    if (!filename) return res.status(404).json({ error: `No ${kind} attached` });

    const full = path.join(UPLOAD_ROOT, kind === 'photo' ? 'photos' : 'audio', path.basename(filename));
    if (!fs.existsSync(full)) return res.status(404).json({ error: 'File missing on server' });
    res.sendFile(full);
  } catch (err) {
    res.status(500).json({ error: 'Could not retrieve evidence file' });
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
