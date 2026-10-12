const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const db = require('../db');

// JWT secret: use JWT_SECRET from .env, otherwise generate one once and keep it in
// .jwt_secret so the app still runs (and logins survive restarts) without any setup.
function getSecret() {
  if (process.env.JWT_SECRET && process.env.JWT_SECRET !== 'change_this_to_a_long_random_secret') {
    return process.env.JWT_SECRET;
  }
  const file = path.join(__dirname, '..', '.jwt_secret');
  if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(48).toString('hex'));
  return fs.readFileSync(file, 'utf8').trim();
}
const SECRET = getSecret();

function signToken(user) {
  return jwt.sign({ id: user.id, role: user.role }, SECRET, { expiresIn: '12h' });
}

// Verifies the token AND re-reads the user from the database, so a deactivated account
// or a changed block takes effect immediately instead of when the token expires.
function userFromToken(token) {
  const payload = jwt.verify(token, SECRET);
  const u = db.prepare('SELECT id, name, email, role, block, flat_number, status FROM users WHERE id = ?').get(payload.id);
  if (!u || u.status !== 'approved') throw new Error('Account not active');
  return u;
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing auth token' });
  try {
    req.user = userFromToken(token);
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }
}

function optionalAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : (req.query?.token || null);
  if (token) {
    try {
      req.user = userFromToken(token);
    } catch (err) {
      req.user = null;
    }
  } else {
    req.user = null;
  }
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Forbidden: insufficient role' });
    }
    next();
  };
}

module.exports = { requireAuth, optionalAuth, requireRole, signToken, userFromToken };
