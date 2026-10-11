require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
require('./db'); // initializes schema + seeds admin on first run

const uploadRoot = process.env.UPLOADS_DIR || (process.env.DATA_DIR ? path.join(process.env.DATA_DIR, 'uploads') : path.join(__dirname, 'uploads'));
for (const dir of ['audio', 'photos']) {
  fs.mkdirSync(path.join(uploadRoot, dir), { recursive: true });
}

const authRoutes = require('./routes/auth');
const complaintRoutes = require('./routes/complaints');
const adminRoutes = require('./routes/admin');
const residencyRoutes = require('./routes/residency');
const announcementRoutes = require('./routes/announcements');

const app = express();

// Explicitly allowed origins for production Vercel frontend and local development
const allowedOrigins = [
  'https://complaint-system-2.vercel.app',
  'https://complaint-system-2-182mdexw1-sameel2.vercel.app',
  'https://complaint-system-2-sameel2.vercel.app',
  'http://localhost:3000',
  'http://localhost:4000',
  'http://localhost:5000',
  'http://127.0.0.1:4000'
];

if (process.env.CORS_ORIGIN) {
  process.env.CORS_ORIGIN.split(',').forEach(o => {
    const trimmed = o.trim();
    if (trimmed && !allowedOrigins.includes(trimmed)) {
      allowedOrigins.push(trimmed);
    }
  });
}

const corsOptions = {
  origin: (origin, callback) => {
    // Allow non-browser requests (e.g. curl, server-to-server)
    if (!origin) return callback(null, true);

    // Allow configured origins, wildcard, or any Vercel deployment preview domain
    if (
      process.env.CORS_ORIGIN === '*' ||
      allowedOrigins.includes('*') ||
      allowedOrigins.includes(origin) ||
      /\.vercel\.app$/.test(origin)
    ) {
      return callback(null, true);
    }
    return callback(null, true);
  },
  credentials: true,
  methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Origin', 'Accept', 'X-Requested-With'],
  optionsSuccessStatus: 204
};

// Apply CORS middleware and handle preflight OPTIONS before authentication and routes
app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

app.use(express.json());
// Evidence files are NOT served publicly; they go through /api/complaints/:id/evidence/:kind (auth + permission check)

// Serve the static frontend if available locally
app.use(express.static(path.join(__dirname, '..', 'frontend')));

app.use('/api/auth', authRoutes);
app.use('/api/complaints', complaintRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/residency', residencyRoutes);
app.use('/api/announcements', announcementRoutes);

app.get('/api/health', (req, res) => res.json({ status: 'ok', service: 'backend', uptime: process.uptime() }));
app.get('/health', (req, res) => res.json({ status: 'ok', service: 'backend', uptime: process.uptime() }));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 4000;
const HOST = process.env.HOST || '0.0.0.0';
app.listen(PORT, HOST, () => {
  console.log(`Complaint Management System backend running on http://${HOST}:${PORT}`);
});
