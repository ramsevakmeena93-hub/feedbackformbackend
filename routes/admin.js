const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const User = require('../models/User');
const SystemLog = require('../models/SystemLog');
const FacultyReport = require('../models/FacultyReport');
const Submission = require('../models/Submission');
const { authMiddleware, requireRole } = require('./middleware');
const logger = require('../services/logger');

const adminOnly = [authMiddleware, requireRole('admin')];

// ── USER MANAGEMENT ──────────────────────────────────────────

// Get all users
router.get('/users', ...adminOnly, async (req, res) => {
  try {
    const users = await User.find({}, '-password -signatureImage').sort({ createdAt: -1 });
    res.json(users);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Create user (add faculty/hod/vc)
router.post('/users', ...adminOnly, async (req, res) => {
  try {
    const { name, email, password, role, department } = req.body;
    if (!name || !email || !password || !role) return res.status(400).json({ error: 'name, email, password, role required' });
    const existing = await User.findOne({ email });
    if (existing) return res.status(400).json({ error: 'Email already registered' });
    const hashed = await bcrypt.hash(password, 10);
    const user = await User.create({ name, email, password: hashed, role, department });
    await logger.info('admin', `User created: ${email} (${role})`, { by: req.user.id });
    res.json({ message: 'User created', user: { id: user._id, name, email, role, department } });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Update user
router.patch('/users/:id', ...adminOnly, async (req, res) => {
  try {
    const { name, email, role, department, password } = req.body;
    const update = {};
    if (name) update.name = name;
    if (email) update.email = email;
    if (role) update.role = role;
    if (department !== undefined) update.department = department;
    if (password) update.password = await bcrypt.hash(password, 10);
    const user = await User.findByIdAndUpdate(req.params.id, update, { new: true }).select('-password -signatureImage');
    if (!user) return res.status(404).json({ error: 'User not found' });
    await logger.info('admin', `User updated: ${user.email}`, { by: req.user.id });
    res.json(user);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Delete user
router.delete('/users/:id', ...adminOnly, async (req, res) => {
  try {
    const user = await User.findByIdAndDelete(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    await logger.warn('admin', `User deleted: ${user.email} (${user.role})`, { by: req.user.id });
    res.json({ message: 'User deleted' });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Reset user password
router.post('/users/:id/reset-password', ...adminOnly, async (req, res) => {
  try {
    const { password } = req.body;
    if (!password) return res.status(400).json({ error: 'Password required' });
    const hashed = await bcrypt.hash(password, 10);
    await User.findByIdAndUpdate(req.params.id, { password: hashed });
    res.json({ message: 'Password reset successfully' });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── SYSTEM LOGS ──────────────────────────────────────────────

// Get logs with filters
router.get('/logs', ...adminOnly, async (req, res) => {
  try {
    const { level, source, resolved, limit = 100, page = 1 } = req.query;
    const filter = {};
    if (level) filter.level = level;
    if (source) filter.source = source;
    if (resolved !== undefined) filter.resolved = resolved === 'true';
    const total = await SystemLog.countDocuments(filter);
    const logs = await SystemLog.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(Number(limit))
      .populate('resolvedBy', 'name email');
    res.json({ logs, total, page: Number(page), pages: Math.ceil(total / limit) });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Mark log as resolved
router.patch('/logs/:id/resolve', ...adminOnly, async (req, res) => {
  try {
    const { resolution } = req.body;
    const log = await SystemLog.findByIdAndUpdate(req.params.id, {
      resolved: true, resolvedBy: req.user.id,
      resolvedAt: new Date(), resolution: resolution || ''
    }, { new: true });
    if (!log) return res.status(404).json({ error: 'Log not found' });
    res.json(log);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Delete a log entry
router.delete('/logs/:id', ...adminOnly, async (req, res) => {
  try {
    await SystemLog.findByIdAndDelete(req.params.id);
    res.json({ message: 'Log deleted' });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Clear all resolved logs
router.delete('/logs/clear/resolved', ...adminOnly, async (req, res) => {
  try {
    const { deletedCount } = await SystemLog.deleteMany({ resolved: true });
    res.json({ message: `Cleared ${deletedCount} resolved logs` });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// AI suggestion for a log error
router.post('/logs/:id/ai-suggest', ...adminOnly, async (req, res) => {
  try {
    const logEntry = await SystemLog.findById(req.params.id);
    if (!logEntry) return res.status(404).json({ error: 'Log not found' });

    // Build prompt for AI
    const prompt = `You are a senior Node.js/Express/MongoDB developer. Analyze this error and provide a concise fix suggestion.

Error: ${logEntry.message}
Source: ${logEntry.source}
Stack: ${logEntry.stack || 'N/A'}
Meta: ${JSON.stringify(logEntry.meta || {})}

Provide:
1. Root cause (1 sentence)
2. Fix steps (2-3 bullet points)
3. Prevention tip (1 sentence)

Keep it under 150 words.`;

    let suggestion = '';
    try {
      // Try HuggingFace/local AI
      const { analyzeWithAI } = require('../services/aiAnalyzer');
      suggestion = await analyzeWithAI(prompt);
    } catch(e) {
      suggestion = generateRuleSuggestion(logEntry);
    }

    await SystemLog.findByIdAndUpdate(logEntry._id, { aiSuggestion: suggestion });
    res.json({ suggestion });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Rule-based fallback suggestions
function generateRuleSuggestion(logEntry) {
  const msg = (logEntry.message || '').toLowerCase();
  const src = (logEntry.source || '').toLowerCase();

  if (msg.includes('mongo') || msg.includes('connection')) {
    return '**Root cause:** MongoDB connection failed.\n**Fix:** 1. Check MONGO_URI in .env 2. Ensure MongoDB is running 3. Check network/firewall rules.\n**Prevention:** Add connection retry logic with exponential backoff.';
  }
  if (msg.includes('jwt') || msg.includes('token') || msg.includes('unauthorized')) {
    return '**Root cause:** JWT authentication failure.\n**Fix:** 1. Check JWT_SECRET in .env matches token signing 2. Verify token expiry 3. Ensure Authorization header format is "Bearer <token>".\n**Prevention:** Add token refresh mechanism.';
  }
  if (msg.includes('pdf') || msg.includes('drive') || msg.includes('download')) {
    return '**Root cause:** PDF download/generation failed.\n**Fix:** 1. Check Google Drive link is public 2. Verify pdf-lib version compatibility 3. Check available memory for large PDFs.\n**Prevention:** Add retry logic and file size limits.';
  }
  if (msg.includes('cast') || msg.includes('objectid') || msg.includes('validation')) {
    return '**Root cause:** MongoDB validation/cast error.\n**Fix:** 1. Validate input IDs before DB queries 2. Add try/catch around findById calls 3. Check schema field types match input data.\n**Prevention:** Add input validation middleware (e.g., express-validator).';
  }
  if (msg.includes('enoent') || msg.includes('no such file')) {
    return '**Root cause:** File not found on disk.\n**Fix:** 1. Check file path is correct relative to __dirname 2. Ensure assets folder exists 3. Verify file was uploaded/created before reading.\n**Prevention:** Add fs.existsSync() checks before file operations.';
  }
  if (src.includes('ai') || msg.includes('model') || msg.includes('hugging')) {
    return '**Root cause:** AI model inference failed.\n**Fix:** 1. Check HuggingFace model is loaded 2. Verify input text is not empty 3. Restart backend to reload model.\n**Prevention:** Add fallback rule-based analysis when AI fails.';
  }
  return `**Root cause:** ${logEntry.level === 'error' ? 'Runtime error in ' + logEntry.source : 'Warning in ' + logEntry.source}.\n**Fix:** 1. Check the stack trace for the exact line 2. Add error handling around the failing operation 3. Review recent code changes.\n**Prevention:** Add comprehensive error boundaries and input validation.`;
}

// ── SYSTEM STATS ─────────────────────────────────────────────

router.get('/stats', ...adminOnly, async (req, res) => {
  try {
    const [users, reports, submissions, errorLogs, warnLogs, unresolvedLogs] = await Promise.all([
      User.countDocuments(),
      FacultyReport.countDocuments(),
      Submission.countDocuments(),
      SystemLog.countDocuments({ level: 'error' }),
      SystemLog.countDocuments({ level: 'warn' }),
      SystemLog.countDocuments({ resolved: false }),
    ]);
    const usersByRole = await User.aggregate([{ $group: { _id: '$role', count: { $sum: 1 } } }]);
    res.json({ users, reports, submissions, errorLogs, warnLogs, unresolvedLogs, usersByRole });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Get server health metrics
router.get('/metrics', ...adminOnly, async (req, res) => {
  try {
    const mem = process.memoryUsage();
    const uptime = process.uptime();
    res.json({
      uptime: Math.floor(uptime),
      memUsed: Math.round(mem.heapUsed / 1024 / 1024),
      memTotal: Math.round(mem.heapTotal / 1024 / 1024),
      rss: Math.round(mem.rss / 1024 / 1024),
      pid: process.pid,
      nodeVersion: process.version,
      platform: process.platform,
    });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// AI analyze a log message — reads the actual file content for context
router.post('/ai-analyze', ...adminOnly, async (req, res) => {
  try {
    const { message, level, ts, fileRef } = req.body;
    if (!message) return res.status(400).json({ error: 'message required' });

    let fileContext = null;
    let surroundingCode = null;

    // If we have a file reference, read the actual code around the error line
    if (fileRef && fileRef.file && fileRef.line) {
      try {
        const fs = require('fs');
        const path = require('path');
        const BACKEND_ROOT  = path.join(__dirname, '..');
        const FRONTEND_ROOT = path.join(__dirname, '../../frontend/src');
        const root = fileRef.side === 'frontend' ? FRONTEND_ROOT : BACKEND_ROOT;

        // Try multiple path patterns
        const candidates = [
          path.join(root, fileRef.file),
          path.join(BACKEND_ROOT, fileRef.file),
          path.join(BACKEND_ROOT, 'routes', path.basename(fileRef.file)),
          path.join(BACKEND_ROOT, 'services', path.basename(fileRef.file)),
          path.join(BACKEND_ROOT, 'models', path.basename(fileRef.file)),
        ];

        let filePath = null;
        for (const c of candidates) {
          if (fs.existsSync(c)) { filePath = c; break; }
        }

        if (filePath) {
          const lines = fs.readFileSync(filePath, 'utf8').split('\n');
          const errLine = fileRef.line - 1; // 0-indexed
          const start = Math.max(0, errLine - 5);
          const end   = Math.min(lines.length - 1, errLine + 5);
          surroundingCode = lines.slice(start, end + 1)
            .map((l, i) => `${start + i + 1}${start + i === errLine ? ' ►' : '  '} | ${l}`)
            .join('\n');
          fileContext = { file: fileRef.file, line: fileRef.line, totalLines: lines.length };
        }
      } catch(e) { /* file read failed, continue without context */ }
    }

    const suggestion = generateDetailedSuggestion({ message, level, fileContext, surroundingCode });
    res.json({ suggestion, fileContext, surroundingCode });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

function generateDetailedSuggestion({ message, level, fileContext, surroundingCode }) {
  const msg = (message || '').toLowerCase();
  let fix = '';

  // Determine error type and generate specific fix
  if (msg.includes('cannot read') && msg.includes('undefined')) {
    const prop = message.match(/Cannot read propert(?:y|ies) (?:of undefined|'([^']+)')/)?.[1] || 'property';
    fix = `**Root cause:** Accessing \`${prop}\` on an undefined/null value.\n\n**Fix:**\n\`\`\`js\n// Add optional chaining:\nconst value = obj?.${prop};\n// Or add a null check:\nif (obj && obj.${prop}) { ... }\n\`\`\`\n\n**Prevention:** Use optional chaining (?.) for nested property access.`;
  } else if (msg.includes('is not a function')) {
    const fn = message.match(/(\w+) is not a function/)?.[1] || 'function';
    fix = `**Root cause:** \`${fn}\` is undefined or not callable at this point.\n\n**Fix:**\n\`\`\`js\n// Check it exists before calling:\nif (typeof ${fn} === 'function') ${fn}();\n// Or check the import/require is correct\n\`\`\`\n\n**Prevention:** Verify imports and that the module exports the function correctly.`;
  } else if (msg.includes('mongo') || msg.includes('connection refused')) {
    fix = `**Root cause:** MongoDB connection failed.\n\n**Fix:**\n\`\`\`js\n// In .env file:\nMONGO_URI=mongodb://localhost:27017/faculty_feedback\n// Or check if MongoDB service is running:\n// Windows: net start MongoDB\n\`\`\`\n\n**Prevention:** Add connection retry with exponential backoff.`;
  } else if (msg.includes('enoent') || msg.includes('no such file')) {
    const file = message.match(/open '([^']+)'/)?.[1] || 'file';
    fix = `**Root cause:** File not found: \`${file}\`\n\n**Fix:**\n\`\`\`js\n// Use path.join with __dirname:\nconst filePath = path.join(__dirname, '../assets/filename.png');\n// Check existence first:\nif (fs.existsSync(filePath)) { ... }\n\`\`\`\n\n**Prevention:** Always use \`path.join(__dirname, ...)\` for file paths.`;
  } else if (msg.includes('jwt') || msg.includes('invalid token') || msg.includes('unauthorized')) {
    fix = `**Root cause:** JWT token invalid or expired.\n\n**Fix:**\n\`\`\`js\n// Verify JWT_SECRET matches in .env:\nJWT_SECRET=your_secret_key\n// Check token format in request:\n// Authorization: Bearer <token>\n\`\`\`\n\n**Prevention:** Add token refresh logic and clear error messages.`;
  } else if (msg.includes('cast to objectid') || msg.includes('objectid failed')) {
    fix = `**Root cause:** Invalid MongoDB ObjectId format.\n\n**Fix:**\n\`\`\`js\nconst mongoose = require('mongoose');\n// Validate before query:\nif (!mongoose.Types.ObjectId.isValid(id)) {\n  return res.status(400).json({ error: 'Invalid ID' });\n}\n\`\`\`\n\n**Prevention:** Always validate IDs before DB queries.`;
  } else if (msg.includes('cors')) {
    fix = `**Root cause:** CORS policy blocking the request.\n\n**Fix:**\n\`\`\`js\n// In server.js:\napp.use(cors({ origin: ['http://localhost:5173', 'http://localhost:5176'] }));\n\`\`\`\n\n**Prevention:** Configure CORS explicitly for all frontend ports.`;
  } else if (msg.includes('syntax') || msg.includes('unexpected token')) {
    fix = `**Root cause:** JavaScript syntax error in the file.\n\n**Fix:** Check the highlighted line for:\n- Missing closing bracket \`}\` or parenthesis \`)\`\n- Missing comma in object/array\n- Unclosed string literal\n- Invalid arrow function syntax\n\n**Prevention:** Use ESLint to catch syntax errors before runtime.`;
  } else {
    fix = `**Root cause:** ${level === 'error' ? 'Runtime error' : 'Warning'} — ${message.slice(0, 100)}\n\n**Fix steps:**\n1. Check the highlighted line in the code editor\n2. Verify all variables are defined before use\n3. Add try/catch around the failing operation\n\n**Prevention:** Add input validation and error boundaries.`;
  }

  if (fileContext) {
    fix += `\n\n**Location:** \`${fileContext.file}\` line ${fileContext.line}`;
  }
  if (surroundingCode) {
    fix += `\n\n**Code context:**\n\`\`\`\n${surroundingCode}\n\`\`\``;
  }

  return fix;
}

module.exports = router;
