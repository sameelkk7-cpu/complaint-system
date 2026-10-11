// Shared helper for talking to the backend API and managing the logged-in session.
// In local development, defaults to '/api'. In production, uses the deployed Render backend URL (or CMS_API_URL override).
const DEFAULT_BACKEND_URL = 'https://complaint-system-backend-gtrc.onrender.com';
const API_BASE = (typeof window !== 'undefined' && (window.CMS_API_URL || window.__CMS_API_URL__))
  ? (window.CMS_API_URL || window.__CMS_API_URL__)
  : (typeof window !== 'undefined' && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'))
    ? '/api'
    : `${DEFAULT_BACKEND_URL}/api`;

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
  if (expectedRole && user.role !== expectedRole) {
    window.location.href = `${user.role}-dashboard.html`;
    return null;
  }
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
    if (resp.status === 401) { logout(); }
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

// ---------- AI verdict helpers ----------
function verdictTag(v) {
  if (!v) return '—';
  const label = { Verified: 'AI verified', Mismatch: 'Sound mismatch', Inconclusive: 'Inconclusive', Unavailable: 'AI unavailable' }[v] || v;
  return `<span class="tag tag-${esc(v.toLowerCase())}">${label}</span>`;
}
function aiSummary(c) {
  return c.ai_category ? `${esc(c.ai_category)} (${pct(c.ai_confidence)})` : '—';
}

// ---------- Evidence (photo / audio) - fetched through the authenticated endpoint ----------
function evidenceUrl(id, kind) {
  const token = getToken();
  if (!token) return '';
  return `${API_BASE}/complaints/${id}/evidence/${kind}?token=${encodeURIComponent(token)}`;
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
    ${c.has_audio ? `<div><div class="muted">Audio evidence</div>
        <audio controls preload="none" src="${audioUrl}"></audio></div>` : ''}
  </div>`;
}

function aiReportHtml(c) {
  if (!c.has_audio) return '';
  if (!c.ai_category) {
    return `<div class="ai-box bad"><strong>AI verification unavailable.</strong> The audio could not be analysed, so this complaint needs manual review.</div>`;
  }
  const d = c.ai_details || {};
  const cls = c.ai_verdict === 'Verified' ? '' : (c.ai_verdict === 'Mismatch' ? 'bad' : 'warn');
  const bars = (d.top_predictions || []).map(p =>
    `<div class="bar-row"><span class="lbl">${esc(p.label)}</span><span class="bar" style="width:${Math.max(2, Math.round(p.score * 180))}px"></span><span class="val">${pct(p.score)}</span></div>`).join('');
  const verdictText = {
    Verified: 'The audio supports this complaint.',
    Mismatch: `The recording sounds like <strong>${esc(c.ai_category)}</strong>, but the resident reported <strong>${esc(c.claimed_noise_type)}</strong>.`,
    Inconclusive: 'The audio was silent or the AI was not confident enough — please review manually.',
  }[c.ai_verdict] || '';
  return `<div class="ai-box ${cls}">
    <div><strong>AI audio verification (YAMNet)</strong> ${verdictTag(c.ai_verdict)}${d.mock ? ' <span class="tag tag-rejected">MOCK MODE</span>' : ''}</div>
    <div style="margin:6px 0;">${verdictText}</div>
    <div>Detected: <strong>${esc(c.ai_category)}</strong> · confidence <strong>${pct(c.ai_confidence)}</strong> ·
         loudness <span class="noise-${esc(c.noise_level)}">${esc(c.noise_level)}</span>${d.noise_db_relative != null ? ` (${d.noise_db_relative} dBFS, relative)` : ''}</div>
    ${bars ? `<div style="margin-top:8px;"><div class="muted">Strongest sounds heard</div>${bars}</div>` : ''}
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
    // Use the admin endpoint when available (gives richer data: resident email, assigned name);
    // fall back to the user-facing endpoint for other roles.
    const currentUser = getUser();
    const complaintEndpoint = (currentUser && currentUser.role === 'admin')
      ? `/admin/complaints/${id}`
      : `/complaints/${id}`;
    const [c, timeline] = await Promise.all([
      apiFetch(complaintEndpoint),
      apiFetch(`/complaints/${id}/timeline`)
    ]);
    const actionLabel = { COMPLAINT_SUBMITTED: 'Complaint submitted', STATUS_CHANGED: 'Status changed', ASSIGNED: 'Assigned', FLAGGED_REVIEW: 'Admin reviewed flagged complaint',
      RESIDENCY_RESPONSE: 'Committee response', MEETING_SCHEDULED: 'Meeting proposed', ESCALATED_TO_ADMIN: 'Escalated to admin', FEEDBACK_SUBMITTED: 'Feedback submitted', MARKED_RESOLVED: 'Marked resolved' };
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
      ${c.has_audio ? `<h3>AI audio verification</h3>${aiReportHtml(c)}` : ''}
      ${extraHtml}
      <h3>Progress</h3>
      <ul class="timeline">${timeline.map(t => `<li><strong>${esc(actionLabel[t.action] || t.action)}</strong>
        <div class="muted">${fmtDate(t.created_at)}${t.actor ? ` · ${esc(t.actor)}` : ''}${t.details ? ` · ${esc(t.details)}` : ''}</div></li>`).join('')}</ul>`;
  } catch (err) {
    body.innerHTML = `<p class="error-msg">${esc(err.message)}</p>`;
  }
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
