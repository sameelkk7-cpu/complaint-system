const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// Announcement feed - every logged-in role (resident, committee, admin) can read it.
router.get('/', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT a.id, a.title, a.body, a.created_at, u.name AS posted_by
    FROM announcements a LEFT JOIN users u ON u.id = a.created_by
    ORDER BY a.id DESC LIMIT 100`).all();
  res.json(rows);
});

module.exports = router;
