# Residential Neighbour Complaint Management System

Residents raise complaints with **photo** and **audio** evidence, an **AI model (YAMNet)** checks noise
recordings, the **admin** verifies / assigns / reports, the **committee** responds, and the admin's
**announcements** appear on every user's page **and are e-mailed**.

```
complaint-system/
├── backend/      Node.js + Express + SQLite  (API, uploads, e-mail)
├── ai-service/   Python Flask + YAMNet       (audio verification) - model is bundled, works offline
└── frontend/     HTML/CSS/JS                 (served by the backend)
```

## Run it

Needs **Node.js 18+** and **Python 3.9–3.12**. (Optional: **ffmpeg**, only for unusual audio formats such as .m4a.)

- **Windows:** double-click `start-windows.bat`, then open http://localhost:4000
- **Mac/Linux:** `./start-mac-linux.sh`

Or manually, in two terminals:

```bash
# Terminal 1 - AI service
cd ai-service
pip install -r requirements.txt
python app.py            # must print "YAMNet model loaded."

# Terminal 2 - web server
cd backend
npm install
npm start                # http://localhost:4000
```

Admin login: **admin@society.local / admin123** (change it for real use).
Residents and committee members register on the site; the admin approves them (*Resident verification* tab).

> If `pip install ai-edge-litert` fails on your Python version, run `pip install tensorflow` instead; the code uses it automatically.
> YAMNet needs no download: `ai-service/models/yamnet.tflite` is included.

## How the main features work

### Photo evidence
The resident attaches a photo (preview shown). It is stored under a random name; only the resident who raised it,
the admin, and the assigned committee member can view it. Click any complaint number (#) to open the **details window**:
photo, audio player, AI report, committee reply, meeting, and progress timeline.

### Audio + AI verification (YAMNet)
The resident uploads an audio file **or records with the microphone** (needs `localhost` or https) and says what kind of
noise it is. The AI listens to the clip, frame by frame, and decides:

| AI result | What happens |
|---|---|
| Sound matches what was reported, confidence ≥ 30 % | **Verified** -> straight to *Pending* |
| Sound differs from what was reported | **Mismatch** -> admin's *Flagged for review* |
| Silent / unclear clip | **Inconclusive** -> admin's *Flagged for review* |
| AI service not running | **Unavailable** -> flagged for manual review (complaint is never lost) |

Loudness is a **relative** level (dBFS) because phone/laptop microphones are not calibrated; it is not a true dB(A) reading.
Tune it in `ai-service/yamnet_classifier.py` (`_noise_level`, `MIN_CATEGORY_SCORE`) and `AI_MIN_CONFIDENCE` in `.env`.
Categories: Dog Barking, Shouting, Loud Music, Construction Noise, Crying, Banging / Slamming, Party / Crowd Noise (else "Other").

### Announcements -> user pages and e-mail
Admin -> *Announcements* -> write -> **Broadcast**. It shows at once on every resident's and committee member's page
(badge + banner for unread) and an e-mail is sent to every approved account. Residents are also e-mailed when their
account is approved, a complaint status changes, the committee replies, or a meeting is proposed.

**Make e-mail really send (simplest = Gmail):**
1. Google Account -> Security -> turn on **2-Step Verification** -> search **App passwords** -> create one (16 characters).
2. In `backend/`, copy `.env.example` to `.env` and set:
   ```
   SMTP_HOST=smtp.gmail.com
   SMTP_PORT=587
   SMTP_USER=yourname@gmail.com
   SMTP_PASS=your16characterapppassword
   MAIL_FROM="Society Complaint Desk <yourname@gmail.com>"
   ```
3. Restart `npm start`.

Without these settings the app runs in **demo mode**: nothing is sent, but every e-mail is written to `backend/outbox.log`.

## Roles
- **Admin:** approve residents, all complaints, flagged review with evidence, assign to a committee member/block, change status, repeat offenders (same flat complained about 2+ times), reports + CSV export, announcements.
- **Resident:** submit complaints (photo / audio / microphone), track status + timeline, see committee replies, rate resolved complaints, read announcements.
- **Committee:** sees complaints for their block or assigned to them, views evidence + AI report, replies, proposes a meeting, marks resolved, escalates to admin.

## Limitations (good to mention in your viva)
- YAMNet is a general sound classifier (521 sounds), not a legal noise-measurement tool; accuracy depends on recording quality.
- SQLite + local files suit one society; use PostgreSQL + cloud storage to scale.
- Use HTTPS before real use; change the admin password and `JWT_SECRET`.
