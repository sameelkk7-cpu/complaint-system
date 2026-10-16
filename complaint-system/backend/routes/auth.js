const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const db = require('../db');
const mailer = require('../mailer');
const { signToken, requireAuth } = require('../middleware/auth');

const router = express.Router();

/**
 * Validates password strength according to society security requirements:
 * - Minimum 8 characters
 * - At least 1 uppercase letter (A–Z)
 * - At least 1 lowercase letter (a–z)
 * - At least 1 number (0–9)
 * - At least 1 special character (@, #, $, !, %, etc.)
 */
function validatePassword(password) {
  if (!password || typeof password !== 'string') {
    return 'Password is required';
  }
  if (password.length < 8) {
    return 'Password must be at least 8 characters long';
  }
  if (!/[A-Z]/.test(password)) {
    return 'Password must contain at least 1 uppercase letter (A–Z)';
  }
  if (!/[a-z]/.test(password)) {
    return 'Password must contain at least 1 lowercase letter (a–z)';
  }
  if (!/[0-9]/.test(password)) {
    return 'Password must contain at least 1 number (0–9)';
  }
  if (!/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?`~]/.test(password)) {
    return 'Password must contain at least 1 special character (@, #, $, !, %, etc.)';
  }
  return null;
}

router.post('/register', (req, res) => {
  const { name, password, role, flat_number, block } = req.body;
  const email = (req.body.email || '').trim().toLowerCase();

  if (!name || !email || !password || !role) {
    return res.status(400).json({ error: 'name, email, password, and role are required' });
  }

  // Strong password check on the backend
  const pwError = validatePassword(password);
  if (pwError) {
    return res.status(400).json({ error: pwError });
  }

  if (!['user', 'residency'].includes(role)) {
    return res.status(400).json({ error: "role must be 'user' or 'residency'" });
  }
  if (db.prepare('SELECT id FROM users WHERE email = ?').get(email)) {
    return res.status(409).json({ error: 'An account with this email already exists' });
  }

  const info = db.prepare(`INSERT INTO users (name, email, password_hash, role, flat_number, block, status)
                           VALUES (?, ?, ?, ?, ?, ?, 'approved')`)
    .run(name.trim(), email, bcrypt.hashSync(password, 10), role, flat_number || null, (block || '').trim().toUpperCase() || null);

  const newUser = db.prepare('SELECT id, name, email, role, flat_number, block, status FROM users WHERE id = ?').get(info.lastInsertRowid);
  const token = signToken(newUser);

  res.status(201).json({
    message: 'Account created and approved successfully.',
    token,
    user: { id: newUser.id, name: newUser.name, role: newUser.role, block: newUser.block, flat_number: newUser.flat_number }
  });
});

router.post('/login', (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  const { password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'email and password are required' });

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  if (user.status !== 'approved') {
    db.prepare("UPDATE users SET status = 'approved' WHERE id = ?").run(user.id);
    user.status = 'approved';
  }
  res.json({
    token: signToken(user),
    user: { id: user.id, name: user.name, role: user.role, block: user.block, flat_number: user.flat_number }
  });
});

// Authenticated password change
router.post('/change-password', requireAuth, (req, res) => {
  const { current_password, new_password } = req.body;
  if (!current_password || !new_password) {
    return res.status(400).json({ error: 'current_password and new_password are required' });
  }

  const user = db.prepare('SELECT id, password_hash FROM users WHERE id = ?').get(req.user.id);
  if (!user || !bcrypt.compareSync(current_password, user.password_hash)) {
    return res.status(400).json({ error: 'Current password is incorrect' });
  }

  if (current_password === new_password) {
    return res.status(400).json({ error: 'New password cannot be identical to the current password' });
  }

  const pwError = validatePassword(new_password);
  if (pwError) {
    return res.status(400).json({ error: pwError });
  }

  const newHash = bcrypt.hashSync(new_password, 10);
  db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(newHash, user.id);
  res.json({ message: 'Password changed successfully' });
});

// Request password reset code
router.post('/forgot-password', (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  if (!email) return res.status(400).json({ error: 'Email is required' });

  const user = db.prepare('SELECT id, name, email FROM users WHERE email = ?').get(email);
  if (!user) {
    return res.json({ message: 'If an account exists for this email, a reset code has been generated.' });
  }

  const code = crypto.randomInt(100000, 999999).toString();
  const expiresAt = new Date(Date.now() + 3600000).toISOString();

  db.prepare('DELETE FROM password_resets WHERE email = ?').run(email);
  db.prepare('INSERT INTO password_resets (email, token, expires_at) VALUES (?, ?, ?)')
    .run(email, code, expiresAt);

  mailer.notify(
    email,
    'Password Reset Code — Residents\' Complaint Desk',
    `Hello ${user.name},\n\nYour password reset code is: ${code}\nThis code will expire in 1 hour.\n\n— Residents' Complaint Desk`
  );

  res.json({
    message: 'If an account exists for this email, a reset code has been sent.',
    // For local developer/demo convenience in console mode, provide the code directly
    dev_reset_code: mailer.mode() === 'console' ? code : undefined
  });
});

// Complete password reset with code and new password
router.post('/reset-password', (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  const token = (req.body.token || '').trim();
  const { new_password } = req.body;

  if (!email || !token || !new_password) {
    return res.status(400).json({ error: 'Email, reset code, and new password are required' });
  }

  const record = db.prepare('SELECT * FROM password_resets WHERE email = ? AND token = ?').get(email, token);
  if (!record) {
    return res.status(400).json({ error: 'Invalid or expired reset code' });
  }

  if (new Date(record.expires_at).getTime() < Date.now()) {
    db.prepare('DELETE FROM password_resets WHERE id = ?').run(record.id);
    return res.status(400).json({ error: 'Reset code has expired. Please request a new one.' });
  }

  const pwError = validatePassword(new_password);
  if (pwError) {
    return res.status(400).json({ error: pwError });
  }

  const user = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  const newHash = bcrypt.hashSync(new_password, 10);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(newHash, user.id);
  db.prepare('DELETE FROM password_resets WHERE email = ?').run(email);

  res.json({ message: 'Password has been reset successfully. You can now sign in.' });
});

module.exports = router;
module.exports.validatePassword = validatePassword;
