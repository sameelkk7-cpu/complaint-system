const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { signToken } = require('../middleware/auth');

const router = express.Router();

router.post('/register', (req, res) => {
  const { name, password, role, flat_number, block } = req.body;
  const email = (req.body.email || '').trim().toLowerCase();

  if (!name || !email || !password || !role) {
    return res.status(400).json({ error: 'name, email, password, and role are required' });
  }
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  if (!['user', 'residency'].includes(role)) {
    return res.status(400).json({ error: "role must be 'user' or 'residency'" });
  }
  if (db.prepare('SELECT id FROM users WHERE email = ?').get(email)) {
    return res.status(409).json({ error: 'An account with this email already exists' });
  }

  const info = db.prepare(`INSERT INTO users (name, email, password_hash, role, flat_number, block, status)
                           VALUES (?, ?, ?, ?, ?, ?, 'pending')`)
    .run(name.trim(), email, bcrypt.hashSync(password, 10), role, flat_number || null, (block || '').trim().toUpperCase() || null);

  res.status(201).json({ message: 'Registration submitted. Your account is pending admin approval.', userId: info.lastInsertRowid });
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
    return res.status(403).json({ error: `Account status is '${user.status}'. Contact the admin.` });
  }
  res.json({
    token: signToken(user),
    user: { id: user.id, name: user.name, role: user.role, block: user.block, flat_number: user.flat_number }
  });
});

module.exports = router;
