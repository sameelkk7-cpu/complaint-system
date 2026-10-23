// Shared helper for talking to the backend API and managing the logged-in session.
// In local development, defaults to '/api'. In production, uses the deployed Render backend URL (or CMS_API_URL override).
const DEFAULT_BACKEND_URL = 'https://complaint-system-backend-gtrc.onrender.com';
const isLocalHost = typeof window !== 'undefined' && (
  window.location.hostname === 'localhost' ||
  window.location.hostname === '127.0.0.1' ||
  window.location.port === '4000' ||
  window.location.port === '3000' ||
  /^192\.168\./.test(window.location.hostname) ||
  /^10\./.test(window.location.hostname) ||
  /^172\./.test(window.location.hostname)
);
const API_BASE = (typeof window !== 'undefined' && (window.CMS_API_URL || window.__CMS_API_URL__))
  ? (window.CMS_API_URL || window.__CMS_API_URL__)
  : (isLocalHost ? '/api' : `${DEFAULT_BACKEND_URL}/api`);

function saveSession(token, user) {
  localStorage.setItem('cms_token', token);
  localStorage.setItem('cms_user', JSON.stringify(user));
}
function getToken() { return localStorage.getItem('cms_token'); }
function getUser() {
  const raw = localStorage.getItem('cms_user');
  return raw ? JSON.parse(raw) : null;
}
function logout() {
  localStorage.removeItem('cms_token');
  localStorage.removeItem('cms_user');
  window.location.href = 'index.html';
}

// Redirects to login if not authenticated, or to the correct dashboard if the
// logged-in role doesn't match the page that's being viewed.
function requireSession(expectedRole) {
  const token = getToken();
  const user = getUser();
  if (!token || !user) {
    window.location.href = 'index.html';
    return null;
  }
  // Allow any logged-in user to access dashboard features
  return user;
}

async function apiFetch(path, { method = 'GET', body, isForm = false } = {}) {
  const headers = {};
  const token = getToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (!isForm && body) headers['Content-Type'] = 'application/json';

  const resp = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: isForm ? body : (body ? JSON.stringify(body) : undefined)
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    if (resp.status === 401 && token && path !== '/auth/login' && path !== '/complaints') {
      logout();
    }
    throw new Error(data.error || `Request failed (${resp.status})`);
  }
  return data;
}

function statusTagClass(status) {
  switch (status) {
    case 'Pending': return 'tag-pending';
    case 'In Progress': return 'tag-progress';
    case 'Resolved': return 'tag-resolved';
    case 'Closed': return 'tag-closed';
    case 'Unverified': return 'tag-unverified';
    case 'Rejected': return 'tag-rejected';
    default: return '';
  }
}

function fmtDate(iso) {
  if (!iso) return '—';
  // SQLite CURRENT time columns are UTC ("YYYY-MM-DD HH:MM:SS"); datetime-local values ("...T18:00") are already local.
  const d = /^\d{4}-\d\d-\d\d \d\d:\d\d(:\d\d)?$/.test(iso) ? new Date(iso.replace(' ', 'T') + 'Z') : new Date(iso);
  return isNaN(d) ? iso : d.toLocaleString();
}

// ---------- Safety: escape anything user-typed before putting it into innerHTML ----------
function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}
const pct = x => `${Math.round((x || 0) * 100)}%`;

// ---------- AI verdict helpers (Pending, Verified, Rejected, Verification Failed) ----------
function verdictTag(v) {
  if (!v) return '—';
  const norm = String(v).trim();
  if (norm === 'Verified') {
    return `<span class="tag tag-verified">Verified</span>`;
  }
  if (norm === 'Rejected' || norm === 'Mismatch') {
    return `<span class="tag tag-rejected">Rejected</span>`;
  }
  if (norm === 'Verification Failed' || norm === 'Unavailable' || norm === 'Inconclusive') {
    return `<span class="tag tag-verification-failed">Verification Failed</span>`;
  }
  if (norm === 'Pending') {
    return `<span class="tag tag-pending">Pending</span>`;
  }
  return `<span class="tag">${esc(norm)}</span>`;
}
function aiSummary(c) {
  return c.ai_category ? `${esc(c.ai_category)} (${pct(c.ai_confidence)})` : (c.ai_verdict === 'Verification Failed' ? 'Service Unavailable' : '—');
}

// ---------- Evidence (photo / audio) - fetched through the authenticated endpoint ----------
function evidenceUrl(id, kind) {
  const token = getToken();
  return token
    ? `${API_BASE}/complaints/${id}/evidence/${kind}?token=${encodeURIComponent(token)}`
    : `${API_BASE}/complaints/${id}/evidence/${kind}`;
}

function evidenceHtml(c) {
  if (!c.has_photo && !c.has_audio) return '<p class="muted">No photo or audio evidence attached.</p>';
  const photoUrl = c.has_photo ? evidenceUrl(c.id, 'photo') : '';
  const audioUrl = c.has_audio ? evidenceUrl(c.id, 'audio') : '';
  return `<div class="evidence-grid">
    ${c.has_photo ? `<div>
        <div class="muted">Photo evidence (click to enlarge)</div>
        <a href="${photoUrl}" target="_blank" id="photoLink-${c.id}">
          <img src="${photoUrl}" alt="Photo evidence"
               onerror="this.style.display='none'; document.getElementById('photoFallback-${c.id}').style.display='inline-block';">
        </a>
        <a id="photoFallback-${c.id}" href="${photoUrl}" target="_blank"
           style="display:none; padding:8px 14px; background:var(--accent-soft); color:var(--accent); border-radius:3px; font-size:0.88rem;"
           >📷 Open photo in new tab</a>
      </div>` : ''}
    ${c.has_audio ? `<div><div class="muted">Audio evidence (Mandatory)</div>
        <audio controls preload="none" src="${audioUrl}"></audio></div>` : ''}
  </div>`;
}

function aiReportHtml(c) {
  if (c.category !== 'Noise Disturbance' && !c.has_audio) return '';
  if (!c.has_audio) {
    return `<div class="ai-box bad"><strong>Missing Audio Evidence:</strong> Audio verification is mandatory to submit a complaint.</div>`;
  }

  const d = c.ai_details || {};
  const isFailed = c.ai_verdict === 'Verification Failed' || c.ai_verdict === 'Unavailable' || (!c.ai_category && c.ai_verdict !== 'Verified');
  const isRejected = c.ai_verdict === 'Rejected' || c.ai_verdict === 'Mismatch' || (c.ai_category === 'Silence');
  const isVerified = c.ai_verdict === 'Verified';

  let cls = isVerified ? '' : (isRejected ? 'bad' : 'warn');
  let verdictState = isVerified ? 'Verified' : (isRejected ? 'Rejected' : (isFailed ? 'Verification Failed' : 'Pending'));

  let verdictText = '';
  if (isVerified) {
    verdictText = 'Audio evidence confirmed. The recording matches and supports the reported complaint.';
  } else if (isRejected) {
    if (c.ai_category === 'Silence') {
      verdictText = 'The uploaded audio clip was silent or contained no acoustic activity.';
    } else if (c.claimed_noise_type && c.ai_category && c.claimed_noise_type !== c.ai_category) {
      verdictText = `The audio was detected as <strong>${esc(c.ai_category)}</strong>, which does not match reported <strong>${esc(c.claimed_noise_type)}</strong>.`;
    } else {
      verdictText = 'Audio evidence did not meet verification criteria.';
    }
  } else if (isFailed) {
    verdictText = 'AI audio verification service is currently unavailable or encountered an error. Audio evidence is preserved for administrator review.';
  } else {
    verdictText = 'Audio verification is currently pending.';
  }

  const retryButtonHtml = `<div style="margin-top:10px;">
    <button class="secondary" id="retryVerifBtn-${c.id}" onclick="retryVerification(${c.id})">🔄 Retry Verification</button>
    <span id="retryVerifStatus-${c.id}" class="muted" style="margin-left:8px;"></span>
  </div>`;

  const bars = (d.top_predictions || []).map(p =>
    `<div class="bar-row"><span class="lbl">${esc(p.label)}</span><span class="bar" style="width:${Math.max(2, Math.round(p.score * 180))}px"></span><span class="val">${pct(p.score)}</span></div>`).join('');

  return `<div class="ai-box ${cls}">
    <div><strong>AI Audio Verification (YAMNet)</strong> ${verdictTag(verdictState)}${d.mock ? ' <span class="tag tag-rejected">MOCK MODE</span>' : ''}</div>
    <div style="margin:6px 0;">${verdictText}</div>
    ${c.ai_category && c.ai_confidence ? `<div>Detected: <strong>${esc(c.ai_category)}</strong> · confidence <strong>${pct(c.ai_confidence)}</strong> ·
         loudness <span class="noise-${esc(c.noise_level)}">${esc(c.noise_level)}</span>${d.noise_db_relative != null ? ` (${d.noise_db_relative} dBFS, relative)` : ''}</div>` : ''}
    ${bars ? `<div style="margin-top:8px;"><div class="muted">Strongest sounds heard</div>${bars}</div>` : ''}
    ${isFailed ? retryButtonHtml : ''}
  </div>`;
}

// ---------- Complaint details dialog (used by all three roles) ----------
async function openComplaintDetail(id, extraHtml = '') {
  let dlg = document.getElementById('detailDialog');
  if (!dlg) {
    dlg = document.createElement('dialog');
    dlg.id = 'detailDialog';
    document.body.appendChild(dlg);
  }
  dlg.innerHTML = `<div class="dlg-head"><h2>Complaint #${esc(id)}</h2><button class="secondary" onclick="this.closest('dialog').close()">Close</button></div>
                   <div class="dlg-body">Loading…</div>`;
  dlg.showModal();
  const body = dlg.querySelector('.dlg-body');
  try {
    const currentUser = getUser();
    const complaintEndpoint = (currentUser && currentUser.role === 'admin')
      ? `/admin/complaints/${id}`
      : `/complaints/${id}`;
    const [c, timeline] = await Promise.all([
      apiFetch(complaintEndpoint),
      apiFetch(`/complaints/${id}/timeline`)
    ]);
    const actionLabel = { COMPLAINT_SUBMITTED: 'Complaint submitted', STATUS_CHANGED: 'Status changed', ASSIGNED: 'Assigned', FLAGGED_REVIEW: 'Admin reviewed flagged complaint',
      RESIDENCY_RESPONSE: 'Committee response', MEETING_SCHEDULED: 'Meeting proposed', ESCALATED_TO_ADMIN: 'Escalated to admin', FEEDBACK_SUBMITTED: 'Feedback submitted', MARKED_RESOLVED: 'Marked resolved', AI_REANALYZED: 'AI audio re-analysis' };
    body.innerHTML = `
      <dl class="kv">
        <dt>Status</dt><dd><span class="tag ${statusTagClass(c.status)}">${esc(c.status)}</span></dd>
        <dt>Category</dt><dd>${esc(c.category)}${c.claimed_noise_type ? ` — reported as ${esc(c.claimed_noise_type)}` : ''}</dd>
        ${c.resident_name ? `<dt>Raised by</dt><dd>${esc(c.resident_name)} ${esc(c.resident_flat || '')}</dd>` : ''}
        <dt>Against flat/unit</dt><dd>${esc(c.against_unit || '—')}</dd>
        <dt>Incident time</dt><dd>${fmtDate(c.incident_datetime)}</dd>
        <dt>Submitted</dt><dd>${fmtDate(c.created_at)}</dd>
        <dt>Description</dt><dd>${esc(c.description)}</dd>
        ${c.residency_response ? `<dt>Committee response</dt><dd>${esc(c.residency_response)}</dd>` : ''}
        ${c.meeting_proposed_at ? `<dt>Meeting proposed</dt><dd>${fmtDate(c.meeting_proposed_at)}</dd>` : ''}
        ${c.rating ? `<dt>Rating</dt><dd>${'★'.repeat(c.rating)}${'☆'.repeat(5 - c.rating)} ${esc(c.feedback || '')}</dd>` : ''}
      </dl>
      <h3>Evidence</h3>${evidenceHtml(c)}
      ${c.has_audio ? `<h3>AI audio verification</h3>${aiReportHtml(c)}${currentUser && currentUser.role === 'admin' && c.ai_verdict !== 'Verification Failed' ? `<div style="margin-top:10px;"><button class="secondary" id="reanalyzeBtn-${c.id}" onclick="triggerReanalyze(${c.id})">🔄 Re-run AI analysis</button><span id="reanalyzeStatus-${c.id}" class="muted" style="margin-left:8px;"></span></div>` : ''}` : ''}
      ${extraHtml}
      <h3>Progress</h3>
      <ul class="timeline">${timeline.map(t => `<li><strong>${esc(actionLabel[t.action] || t.action)}</strong>
        <div class="muted">${fmtDate(t.created_at)}${t.actor ? ` · ${esc(t.actor)}` : ''}${t.details ? ` · ${esc(t.details)}` : ''}</div></li>`).join('')}</ul>`;
  } catch (err) {
    body.innerHTML = `<p class="error-msg">${esc(err.message)}</p>`;
  }
}

// User-facing and admin retry verification helper
window.retryVerification = async function(id) {
  const btn = document.getElementById(`retryVerifBtn-${id}`);
  const status = document.getElementById(`retryVerifStatus-${id}`);
  if (btn) btn.disabled = true;
  if (status) status.textContent = 'Retrying AI verification…';
  try {
    await apiFetch(`/complaints/${id}/reanalyze`, { method: 'POST' });
    if (typeof loadMine === 'function') loadMine();
    if (typeof loadStats === 'function') loadStats();
    if (typeof loadFlagged === 'function') loadFlagged();
    openComplaintDetail(id);
  } catch (err) {
    if (status) status.textContent = 'Retry error: ' + err.message;
    if (btn) btn.disabled = false;
  }
};

window.triggerReanalyze = async function(id) {
  const btn = document.getElementById(`reanalyzeBtn-${id}`);
  const status = document.getElementById(`reanalyzeStatus-${id}`);
  if (btn) btn.disabled = true;
  if (status) status.textContent = 'Analysing audio clip…';
  try {
    await apiFetch(`/complaints/${id}/reanalyze`, { method: 'POST' });
    if (typeof loadStats === 'function') loadStats();
    if (typeof loadFlagged === 'function') loadFlagged();
    openComplaintDetail(id);
  } catch (err) {
    if (status) status.textContent = 'Error: ' + err.message;
    if (btn) btn.disabled = false;
  }
};

// ---------- Strong Password Helpers ----------
function validatePassword(pw) {
  if (!pw || typeof pw !== 'string') return 'Password is required';
  if (pw.length < 8) return 'Password must be at least 8 characters long';
  if (!/[A-Z]/.test(pw)) return 'Password must contain at least 1 uppercase letter (A–Z)';
  if (!/[a-z]/.test(pw)) return 'Password must contain at least 1 lowercase letter (a–z)';
  if (!/[0-9]/.test(pw)) return 'Password must contain at least 1 number (0–9)';
  if (!/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?`~]/.test(pw)) return 'Password must contain at least 1 special character (@, #, $, !, %, etc.)';
  return null;
}

function togglePassword(inputId, btn) {
  const input = document.getElementById(inputId);
  if (!input) return;
  if (input.type === 'password') {
    input.type = 'text';
    btn.textContent = '🙈';
    btn.title = 'Hide password';
    btn.setAttribute('aria-label', 'Hide password');
  } else {
    input.type = 'password';
    btn.textContent = '👁️';
    btn.title = 'Show password';
    btn.setAttribute('aria-label', 'Show password');
  }
}

function bindPasswordChecklist(inputId, containerId) {
  const input = document.getElementById(inputId);
  const container = document.getElementById(containerId);
  if (!input || !container) return;

  const reqLength = container.querySelector('.req-len');
  const reqUpper = container.querySelector('.req-upper');
  const reqLower = container.querySelector('.req-lower');
  const reqNum = container.querySelector('.req-num');
  const reqSpecial = container.querySelector('.req-special');

  const update = () => {
    const val = input.value || '';
    if (reqLength) {
      const ok = val.length >= 8;
      reqLength.classList.toggle('valid', ok);
      reqLength.classList.toggle('invalid', !ok);
    }
    if (reqUpper) {
      const ok = /[A-Z]/.test(val);
      reqUpper.classList.toggle('valid', ok);
      reqUpper.classList.toggle('invalid', !ok);
    }
    if (reqLower) {
      const ok = /[a-z]/.test(val);
      reqLower.classList.toggle('valid', ok);
      reqLower.classList.toggle('invalid', !ok);
    }
    if (reqNum) {
      const ok = /[0-9]/.test(val);
      reqNum.classList.toggle('valid', ok);
      reqNum.classList.toggle('invalid', !ok);
    }
    if (reqSpecial) {
      const ok = /[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?`~]/.test(val);
      reqSpecial.classList.toggle('valid', ok);
      reqSpecial.classList.toggle('invalid', !ok);
    }
  };

  input.addEventListener('input', update);
  update();
}

function passwordRequirementsHtml(containerId = 'pwReqs') {
  return `
    <div class="password-requirements" id="${containerId}">
      <div class="req-title">Password must contain:</div>
      <ul>
        <li class="req-len invalid">Minimum 8 characters</li>
        <li class="req-upper invalid">At least 1 uppercase letter (A–Z)</li>
        <li class="req-lower invalid">At least 1 lowercase letter (a–z)</li>
        <li class="req-num invalid">At least 1 number (0–9)</li>
        <li class="req-special invalid">At least 1 special character (@, #, $, !, %, etc.)</li>
      </ul>
    </div>
  `;
}

function openChangePasswordDialog() {
  let dlg = document.getElementById('changePasswordDialog');
  if (!dlg) {
    dlg = document.createElement('dialog');
    dlg.id = 'changePasswordDialog';
    document.body.appendChild(dlg);
  }

  dlg.innerHTML = `
    <div class="dlg-head">
      <h2>Change Password</h2>
      <button class="secondary" onclick="this.closest('dialog').close()">Cancel</button>
    </div>
    <div class="dlg-body">
      <form id="changePasswordForm">
        <label for="currentPassword">Current password</label>
        <div class="password-wrap">
          <input type="password" id="currentPassword" required autocomplete="current-password">
          <button type="button" class="password-toggle-btn" onclick="togglePassword('currentPassword', this)" title="Show password" aria-label="Show password">👁️</button>
        </div>

        <label for="newPassword">New password</label>
        <div class="password-wrap">
          <input type="password" id="newPassword" required autocomplete="new-password">
          <button type="button" class="password-toggle-btn" onclick="togglePassword('newPassword', this)" title="Show password" aria-label="Show password">👁️</button>
        </div>
        ${passwordRequirementsHtml('changePwReqs')}

        <label for="confirmNewPassword">Confirm new password</label>
        <div class="password-wrap">
          <input type="password" id="confirmNewPassword" required autocomplete="new-password">
          <button type="button" class="password-toggle-btn" onclick="togglePassword('confirmNewPassword', this)" title="Show password" aria-label="Show password">👁️</button>
        </div>

        <button type="submit" style="width:100%; margin-top:16px;" id="changePwBtn">Update password</button>
        <p class="error-msg" id="changePwErr" style="display:none;"></p>
        <p class="success-msg" id="changePwSuccess" style="display:none;"></p>
      </form>
    </div>
  `;

  bindPasswordChecklist('newPassword', 'changePwReqs');

  const form = dlg.querySelector('#changePasswordForm');
  const errP = dlg.querySelector('#changePwErr');
  const succP = dlg.querySelector('#changePwSuccess');
  const btn = dlg.querySelector('#changePwBtn');

  form.onsubmit = async (e) => {
    e.preventDefault();
    errP.style.display = 'none';
    succP.style.display = 'none';

    const current_password = document.getElementById('currentPassword').value;
    const new_password = document.getElementById('newPassword').value;
    const confirm = document.getElementById('confirmNewPassword').value;

    const pwErr = validatePassword(new_password);
    if (pwErr) {
      errP.textContent = pwErr;
      errP.style.display = 'block';
      return;
    }

    if (new_password !== confirm) {
      errP.textContent = 'New passwords do not match';
      errP.style.display = 'block';
      return;
    }

    btn.disabled = true;
    try {
      const res = await apiFetch('/auth/change-password', {
        method: 'POST',
        body: { current_password, new_password }
      });
      succP.textContent = res.message || 'Password changed successfully.';
      succP.style.display = 'block';
      form.reset();
      bindPasswordChecklist('newPassword', 'changePwReqs');
      setTimeout(() => dlg.close(), 1800);
    } catch (err) {
      errP.textContent = err.message;
      errP.style.display = 'block';
    } finally {
      btn.disabled = false;
    }
  };

  dlg.showModal();
}

// ---------- Announcements feed (resident + committee + admin) ----------
async function loadAnnouncementFeed(container, { markSeen = true } = {}) {
  const rows = await apiFetch('/announcements');
  container.innerHTML = rows.length ? rows.map(a => `
    <div class="panel announce-card">
      <h2>${esc(a.title)}</h2>
      <div class="muted">${fmtDate(a.created_at)} · ${esc(a.posted_by || 'Admin')}</div>
      <p style="white-space:pre-wrap; color:var(--ink);">${esc(a.body)}</p>
    </div>`).join('') : '<div class="empty-state">No announcements yet.</div>';
  if (markSeen && rows.length) localStorage.setItem('cms_seen_announce', String(rows[0].id));
  return rows;
}
async function refreshAnnouncementBadge(tabButton) {
  try {
    const rows = await apiFetch('/announcements');
    const seen = Number(localStorage.getItem('cms_seen_announce') || 0);
    const unread = rows.filter(r => r.id > seen).length;
    tabButton.querySelector('.badge')?.remove();
    if (unread) tabButton.insertAdjacentHTML('beforeend', `<span class="badge">${unread}</span>`);
  } catch (e) {}
}

// ---------- In-browser audio recorder -> 16 kHz mono WAV (what YAMNet wants) ----------
function setupPhotoEvidence(inputId) {
  const input = document.getElementById(inputId);
  const preview = document.getElementById(inputId + 'Preview');
  const video = document.getElementById('cameraPreview');
  const box = document.getElementById('cameraBox');
  const error = document.getElementById('photoError');
  const open = document.getElementById('openCamera');
  const capture = document.getElementById('capturePhoto');
  const remove = document.getElementById('removePhoto');
  let file = null, stream = null, previewUrl = null, requestId = 0;
  function close() {
    requestId++;
    if (stream) stream.getTracks().forEach(track => track.stop());
    stream = null;
    video.srcObject = null;
    box.hidden = true;
    open.disabled = false;
  }
  function select(next) {
    if (next && (!next.type.startsWith('image/') || next.size > 25 * 1024 * 1024)) {
      error.textContent = 'Choose an image smaller than 25 MB.';
      input.value = '';
      return;
    }
    error.textContent = '';
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    file = next || null;
    previewUrl = file ? URL.createObjectURL(file) : null;
    if (previewUrl) preview.src = previewUrl;
    else preview.removeAttribute('src');
    preview.style.display = file ? 'block' : 'none';
    remove.hidden = !file;
  }
  input.onchange = () => { close(); select(input.files[0]); };
  open.onclick = async () => {
    close();
    const id = requestId;
    open.disabled = true;
    error.textContent = '';
    try {
      const next = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
      if (id !== requestId) { next.getTracks().forEach(track => track.stop()); return; }
      stream = next;
      video.srcObject = stream;
      box.hidden = false;
      await video.play();
    } catch (err) {
      if (id !== requestId) return;
      close();
      error.textContent = 'Camera unavailable. Allow camera access or attach a photo from your device.';
    }
  };
  capture.onclick = () => {
    if (!video.videoWidth || !stream) { error.textContent = 'Wait for the camera preview, then try again.'; return; }
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0);
    const id = requestId;
    capture.disabled = true;
    canvas.toBlob(blob => {
      capture.disabled = false;
      if (id !== requestId) return;
      if (!blob) { error.textContent = 'Could not capture the photo. Please try again.'; return; }
      input.value = '';
      select(new File([blob], 'live-photo.jpg', { type: 'image/jpeg' }));
      close();
    }, 'image/jpeg', 0.9);
  };
  document.getElementById('closeCamera').onclick = close;
  function reset() { close(); input.value = ''; select(null); }
  remove.onclick = reset;
  window.addEventListener('pagehide', close);
  return { get file() { return file; }, close, reset };
}

const AudioRecorder = {
  mediaRecorder: null, chunks: [], stream: null, timer: null,
  async start(onTick) {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this.chunks = [];
    this.mediaRecorder = new MediaRecorder(this.stream);
    this.mediaRecorder.ondataavailable = e => e.data.size && this.chunks.push(e.data);
    this.mediaRecorder.start();
    const t0 = Date.now();
    this.timer = setInterval(() => onTick && onTick((Date.now() - t0) / 1000), 200);
  },
  stop() {
    return new Promise((resolve, reject) => {
      clearInterval(this.timer);
      this.mediaRecorder.onstop = async () => {
        this.stream.getTracks().forEach(t => t.stop());
        try { resolve(await AudioRecorder.toWav(new Blob(this.chunks, { type: this.mediaRecorder.mimeType }))); }
        catch (err) { reject(err); }
      };
      this.mediaRecorder.stop();
    });
  },
  async toWav(blob) {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
    ctx.close();
    // resample to 16 kHz mono
    const off = new OfflineAudioContext(1, Math.ceil(decoded.duration * 16000), 16000);
    const src = off.createBufferSource(); src.buffer = decoded; src.connect(off.destination); src.start();
    const pcm = (await off.startRendering()).getChannelData(0);
    const buf = new ArrayBuffer(44 + pcm.length * 2), v = new DataView(buf);
    const w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
    w(0, 'RIFF'); v.setUint32(4, 36 + pcm.length * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, 16000, true); v.setUint32(28, 32000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    w(36, 'data'); v.setUint32(40, pcm.length * 2, true);
    for (let i = 0; i < pcm.length; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, pcm[i])) * 0x7fff, true);
    return new File([buf], 'recording.wav', { type: 'audio/wav' });
  }
};
