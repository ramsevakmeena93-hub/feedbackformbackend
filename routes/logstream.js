const express = require('express');
const router = express.Router();
const { authMiddleware, requireRole } = require('./middleware');

// In-memory circular buffer — last 500 log lines
const LOG_BUFFER_SIZE = 500;
const logBuffer = [];
const clients = new Set(); // SSE clients

// Intercept console methods at startup
const originalLog   = console.log.bind(console);
const originalError = console.error.bind(console);
const originalWarn  = console.warn.bind(console);
const originalInfo  = console.info.bind(console);

function formatArgs(args) {
  return args.map(a => {
    if (typeof a === 'string') return a;
    try { return JSON.stringify(a, null, 0); } catch { return String(a); }
  }).join(' ');
}

// Extract file:line from a stack trace string
function extractFileRef(msg) {
  // Match patterns like: at Object.<anonymous> (routes/auth.js:45:12)
  const m = msg.match(/\(([^)]+\.(?:js|jsx|ts|tsx)):(\d+):\d+\)/);
  if (m) {
    const filePath = m[1].replace(/\\/g, '/');
    // Determine side
    const side = filePath.includes('frontend') || filePath.includes('src/') ? 'frontend' : 'backend';
    // Extract relative path
    const rel = filePath.replace(/.*?(routes\/|services\/|models\/|src\/)/, (_, p) => p);
    return { file: rel, line: parseInt(m[2]), side };
  }
  return null;
}

function pushLog(level, args) {
  const msg = formatArgs(args);
  const fileRef = extractFileRef(msg);
  const entry = {
    id: Date.now() + Math.random(),
    ts: new Date().toISOString(),
    level,
    msg,
    fileRef, // { file, line, side } or null
  };
  logBuffer.push(entry);
  if (logBuffer.length > LOG_BUFFER_SIZE) logBuffer.shift();
  // Broadcast to all connected SSE clients
  const data = JSON.stringify(entry);
  clients.forEach(client => {
    try { client.write(`data: ${data}\n\n`); } catch(e) { clients.delete(client); }
  });
  return entry;
}

// Override console methods
console.log   = (...args) => { originalLog(...args);   pushLog('log',   args); };
console.error = (...args) => { originalError(...args); pushLog('error', args); };
console.warn  = (...args) => { originalWarn(...args);  pushLog('warn',  args); };
console.info  = (...args) => { originalInfo(...args);  pushLog('info',  args); };

// Catch unhandled errors
process.on('uncaughtException', (err) => {
  pushLog('error', [`[UNCAUGHT] ${err.message}`, err.stack]);
});
process.on('unhandledRejection', (reason) => {
  pushLog('error', [`[UNHANDLED REJECTION] ${reason}`]);
});

// SSE endpoint — streams live logs
router.get('/stream', (req, res) => {
  // Accept token from query param (EventSource can't set headers)
  const token = req.query.token || req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    const jwt = require('jsonwebtoken');
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'dev_secret');
    if (decoded.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  } catch { return res.status(401).json({ error: 'Invalid token' }); }
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  // Send last 200 buffered lines immediately
  const recent = logBuffer.slice(-200);
  recent.forEach(entry => {
    res.write(`data: ${JSON.stringify(entry)}\n\n`);
  });

  // Add to active clients
  clients.add(res);

  // Heartbeat every 15s to keep connection alive
  const heartbeat = setInterval(() => {
    try { res.write(': heartbeat\n\n'); } catch { clearInterval(heartbeat); }
  }, 15000);

  req.on('close', () => {
    clients.delete(res);
    clearInterval(heartbeat);
  });
});

// Get buffered logs (REST fallback)
router.get('/buffer', authMiddleware, requireRole('admin'), (req, res) => {
  const limit = parseInt(req.query.limit) || 200;
  res.json(logBuffer.slice(-limit));
});

// Clear buffer
router.delete('/buffer', authMiddleware, requireRole('admin'), (req, res) => {
  logBuffer.length = 0;
  res.json({ message: 'Log buffer cleared' });
});

module.exports = router;
