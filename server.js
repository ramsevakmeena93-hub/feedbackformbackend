require('dotenv').config();
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');

// ── MUST be first — intercepts all console.log/error/warn ──
require('./routes/logstream');

const app = express();

const allowedOrigins = [
  'http://localhost:5173',
  'http://localhost:5174',
  'http://localhost:5175',
  'http://localhost:5176',
  'http://localhost:5177',
  process.env.FRONTEND_URL, // Set this in Render env vars
].filter(Boolean);

app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (mobile apps, Postman, curl)
    if (!origin) return callback(null, true);
    if (allowedOrigins.some(o => origin.startsWith(o)) || origin.includes('vercel.app')) {
      return callback(null, true);
    }
    return callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Request logger middleware — logs errors to DB
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    if (res.statusCode >= 500) {
      try {
        const logger = require('./services/logger');
        logger.error('http', `${req.method} ${req.path} → ${res.statusCode}`, {
          method: req.method, path: req.path, status: res.statusCode,
          duration: Date.now() - start, userId: req.user?.id
        });
      } catch(e) {}
    }
  });
  next();
});

// Routes
app.use('/api/auth',          require('./routes/auth'));
app.use('/api/reports',       require('./routes/reports'));
app.use('/api/submissions',   require('./routes/submissions'));
app.use('/api/process',       require('./routes/process'));
app.use('/api/logs',          require('./routes/logs'));
app.use('/api/notifications', require('./routes/notifications'));
app.use('/api/admin',         require('./routes/admin'));
app.use('/api/logstream',     require('./routes/logstream'));
app.use('/api/codeeditor',    require('./routes/codeeditor'));

// Health check
app.get('/api/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

// Global error handler — catches unhandled errors and logs them
app.use((err, req, res, next) => {
  try {
    const logger = require('./services/logger');
    logger.error('uncaught', err.message, {
      method: req.method, path: req.path, userId: req.user?.id
    }, err.stack);
  } catch(e) {}
  res.status(500).json({ error: err.message || 'Internal server error' });
});

const PORT = process.env.PORT || 5000;
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/faculty_feedback';

mongoose.connect(MONGO_URI)
  .then(async () => {
    console.log('MongoDB connected');

    // Preload AI model in background so it's ready for first request
    try {
      const { testGeminiConnection } = require('./services/aiAnalyzer');
      testGeminiConnection().then(r => {
        if (r.ok) console.log('[AI] Model ready:', r.engine);
        else console.warn('[AI] Model not ready:', r.error);
      }).catch(() => {});
    } catch {}

    app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
  })
  .catch(err => {
    console.error('MongoDB connection error:', err);
    process.exit(1);
  });
