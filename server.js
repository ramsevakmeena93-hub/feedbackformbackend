require('dotenv').config();
const express = require('express');
const http = require('http');
const cors = require('cors');
const mongoose = require('mongoose');

// ── MUST be first — intercepts all console.log/error/warn ──
const logstream = require('./routes/logstream');

const app = express();
const httpServer = http.createServer(app);

const allowedOrigins = [
  'http://localhost:5173',
  'http://localhost:5174',
  'http://localhost:5175',
  'http://localhost:5176',
  'http://localhost:5177',
  process.env.FRONTEND_URL,
].filter(Boolean);

const corsOptions = {
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    if (
      allowedOrigins.some(o => origin.startsWith(o)) ||
      origin.includes('vercel.app') ||
      origin.includes('render.com') ||
      origin.includes('onrender.com')
    ) {
      return callback(null, true);
    }
    return callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
};

app.use(cors(corsOptions));
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

// ── Multi-role RBAC routes ────────────────────────────────────────────────
app.use('/api/workspace',   require('./routes/workspace'));   // workspace switch + /me
app.use('/api/roles',       require('./routes/roles'));       // role assignment + approval policy
app.use('/api/assignments', require('./routes/assignments')); // teaching assignments
app.use('/api/audit',       require('./routes/audit'));       // audit log (admin + /my)

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

    // ── Socket.IO setup ──
    const { Server } = require('socket.io');
    const jwt = require('jsonwebtoken');
    const User = require('./models/User');

    const io = new Server(httpServer, {
      cors: corsOptions,
      transports: ['websocket', 'polling'],
    });

    // JWT authentication middleware
    io.use((socket, next) => {
      const token = socket.handshake.auth?.token || socket.handshake.query?.token;
      if (!token) return next(new Error('No token'));
      try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'dev_secret');
        socket.user = decoded;
        next();
      } catch {
        next(new Error('Invalid token'));
      }
    });

    // Track online users: userId → Set of socketIds
    const onlineUsers = new Map();

    io.on('connection', async (socket) => {
      const userId = socket.user?.id;
      const role   = socket.user?.role || 'user';
      const ip     = (socket.handshake.headers['x-forwarded-for'] || socket.handshake.address || 'unknown')
                       .split(',')[0].trim();
      const ua     = socket.handshake.headers['user-agent'] || '';
      const device = /mobile|android|iphone|ipad/i.test(ua) ? 'Mobile' : 'Desktop';

      // ── Register socket ──────────────────────────────────────────────────
      const isFirstSocket = !onlineUsers.has(userId);
      if (!onlineUsers.has(userId)) onlineUsers.set(userId, new Set());
      onlineUsers.get(userId).add(socket.id);

      // Look up name for readable logs
      let userName = userId;
      try {
        const u = await User.findById(userId).select('name email role').lean();
        if (u) userName = `${u.name} <${u.email}> [${u.role}]`;
      } catch {}

      // ── Mark user ONLINE — record currentLoginAt on first socket only ───
      if (isFirstSocket) {
        try {
          await User.findByIdAndUpdate(userId, {
            isOnline:       true,
            currentLoginAt: new Date(),
            lastSeen:       new Date(),
          });
        } catch {}
      }

      console.log(`[Socket] User connected: ${userName} (${ip}, ${device})`);

      // Broadcast online count + updated user list to admins
      io.to('admins').emit('online_count', { total: onlineUsers.size });
      io.to('admins').emit('user_online', { userId, name: userName, loginAt: new Date() });

      // Join admin room so admin gets live broadcasts
      if (role === 'admin') socket.join('admins');

      // ── ping_activity: keep lastSeen fresh ──────────────────────────────
      socket.on('ping_activity', async () => {
        try {
          await User.findByIdAndUpdate(userId, { lastSeen: new Date() });
        } catch {}
      });

      // ── disconnect: mark OFFLINE only when ALL sockets for this user gone ─
      socket.on('disconnect', async () => {
        const sockets = onlineUsers.get(userId);
        if (sockets) {
          sockets.delete(socket.id);
          if (sockets.size === 0) {
            onlineUsers.delete(userId);
            // Mark offline and record leave time
            try {
              await User.findByIdAndUpdate(userId, {
                isOnline:    false,
                lastSeen:    new Date(),
                lastLeaveAt: new Date(),
              });
            } catch {}
            console.log(`[Socket] User offline: ${userName} (${ip})`);
            io.to('admins').emit('user_offline', { userId, leaveAt: new Date() });
          }
        }
        io.to('admins').emit('online_count', { total: onlineUsers.size });
      });
    });

    // Expose io globally for use in routes
    app.set('io', io);

    // Preload AI model in background so it's ready for first request
    try {
      const { testGeminiConnection } = require('./services/aiAnalyzer');
      testGeminiConnection().then(r => {
        if (r.ok) console.log('[AI] Model ready:', r.engine);
        else console.warn('[AI] Model not ready:', r.error);
      }).catch(() => {});
    } catch {}

    httpServer.listen(PORT, () => console.log(`Server running on port ${PORT}`));
  })
  .catch(err => {
    console.error('MongoDB connection error:', err);
    process.exit(1);
  });
