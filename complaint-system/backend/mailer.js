// Simple e-mail sending for announcements and status updates.
//
//  * If SMTP_HOST (etc.) is set in .env  -> real emails are sent via that SMTP server
//    (Gmail, Outlook, Brevo, Mailtrap ... any SMTP account works).
//  * If not -> "console mode": nothing is sent; each email is written to
//    backend/outbox.log so you can demo/verify the feature with zero setup.
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');

const configured = !!process.env.SMTP_HOST;
const FROM = process.env.MAIL_FROM || process.env.SMTP_USER || 'complaints@society.local';

let transporter = null;
if (configured) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || 'false') === 'true', // true for port 465
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
    pool: true,
  });
}

function mode() { return configured ? 'smtp' : 'console'; }

async function sendMail(to, subject, text) {
  if (!to) throw new Error('No recipient');
  if (!configured) {
    const entry = `[${new Date().toISOString()}] TO: ${to}\nSUBJECT: ${subject}\n${text}\n${'-'.repeat(60)}\n`;
    fs.appendFileSync(path.join(__dirname, 'outbox.log'), entry);
    return { simulated: true };
  }
  await transporter.sendMail({ from: FROM, to, subject, text });
  return { simulated: false };
}

// Fire-and-forget helper for status notifications - never breaks the request if mail fails.
function notify(to, subject, text) {
  sendMail(to, subject, text).catch(err => console.error('[mail] failed to send to', to, '-', err.message));
}

// Send the same message to many people (one email each, so addresses aren't exposed).
async function sendMany(recipients, subject, text, concurrency = 5) {
  let sent = 0, failed = 0;
  const queue = [...recipients];
  async function worker() {
    while (queue.length) {
      const to = queue.shift();
      try { await sendMail(to, subject, text); sent++; }
      catch (err) { failed++; console.error('[mail] failed:', to, err.message); }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  return { sent, failed };
}

module.exports = { sendMail, sendMany, notify, mode };
