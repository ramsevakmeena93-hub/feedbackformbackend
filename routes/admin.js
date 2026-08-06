const express = require('express');
const router  = express.Router();
const bcrypt  = require('bcryptjs');
const User    = require('../models/User');
const SystemLog    = require('../models/SystemLog');
const FacultyReport = require('../models/FacultyReport');
const Submission   = require('../models/Submission');
const { authMiddleware, requireRole } = require('./middleware');
const logger  = require('../services/logger');

const adminOnly = [authMiddleware, requireRole('admin')];

// ─────────────────────────────────────────────────────────────
// USER MANAGEMENT
// ─────────────────────────────────────────────────────────────

/** GET all users */
router.get('/users', ...adminOnly, async (req, res) => {
  try {
    const { role, department, status } = req.query;
    const filter = {};
    if (role)       filter.role       = role;
    if (department) filter.department = department;
    if (status)     filter.status     = status;
    const users = await User.find(filter, '-password -signatureImage -profilePhoto').sort({ createdAt: -1 });
    res.json(users);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

/** GET single user (includes signature preview) */
router.get('/users/:id', ...adminOnly, async (req, res) => {
  try {
    const user = await User.findById(req.params.id, '-password');
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

/** POST create user */
router.post('/users', ...adminOnly, async (req, res) => {
  try {
    const { name, email, password, role, department, phone, designation,
            experience, qualification, employeeId, gender, status } = req.body;
    if (!name || !email || !password || !role)
      return res.status(400).json({ error: 'name, email, password, role required' });
    const existing = await User.findOne({ email });
    if (existing) return res.status(400).json({ error: 'Email already registered' });
    const hashed = await bcrypt.hash(password, 10);
    const user = await User.create({
      name, email, password: hashed, role,
      department: department || '',
      phone:       phone       || '',
      designation: designation || '',
      experience:  experience  || '',
      qualification: qualification || '',
      employeeId: employeeId || '',
      gender:     gender     || '',
      status:     status     || 'active',
    });
    await logger.info('admin', `User created: ${email} (${role})`, { by: req.user.id });
    res.json({ message: 'User created', user: { id: user._id, name, email, role, department: user.department } });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

/** PATCH update user */
router.patch('/users/:id', ...adminOnly, async (req, res) => {
  try {
    const allowed = ['name','email','role','department','password','phone',
                     'designation','experience','qualification','employeeId',
                     'gender','status','bio','cabin','signatureStatus'];
    const update = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        update[key] = key === 'password'
          ? await bcrypt.hash(req.body[key], 10)
          : req.body[key];
      }
    }
    const user = await User.findByIdAndUpdate(req.params.id, update, { new: true })
      .select('-password -signatureImage -profilePhoto');
    if (!user) return res.status(404).json({ error: 'User not found' });
    await logger.info('admin', `User updated: ${user.email}`, { by: req.user.id, changes: Object.keys(update) });
    res.json(user);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

/** DELETE user */
router.delete('/users/:id', ...adminOnly, async (req, res) => {
  try {
    const user = await User.findByIdAndDelete(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    await logger.warn('admin', `User deleted: ${user.email} (${user.role})`, { by: req.user.id });
    res.json({ message: 'User deleted' });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

/** POST reset password */
router.post('/users/:id/reset-password', ...adminOnly, async (req, res) => {
  try {
    const { password } = req.body;
    if (!password || password.length < 6)
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    const hashed = await bcrypt.hash(password, 10);
    await User.findByIdAndUpdate(req.params.id, { password: hashed });
    res.json({ message: 'Password reset successfully' });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

/** PATCH suspend/activate user */
router.patch('/users/:id/status', ...adminOnly, async (req, res) => {
  try {
    const { status } = req.body;
    if (!['active','suspended','pending'].includes(status))
      return res.status(400).json({ error: 'Invalid status' });
    const user = await User.findByIdAndUpdate(
      req.params.id, { status }, { new: true }
    ).select('-password -signatureImage');
    if (!user) return res.status(404).json({ error: 'User not found' });
    await logger.info('admin', `User ${status}: ${user.email}`, { by: req.user.id });
    res.json(user);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────
// DEPARTMENT MANAGEMENT
// ─────────────────────────────────────────────────────────────

/** GET all departments (derived from users) */
router.get('/departments', ...adminOnly, async (req, res) => {
  try {
    const users = await User.find({ department: { $ne: '' } }, 'name email role department status');
    const deptMap = {};
    for (const u of users) {
      const d = u.department;
      if (!deptMap[d]) deptMap[d] = { name: d, faculty: [], hod: null };
      if (u.role === 'hod') deptMap[d].hod = { id: u._id, name: u.name, email: u.email };
      deptMap[d].faculty.push({ id: u._id, name: u.name, role: u.role });
    }
    const departments = Object.values(deptMap).map(d => ({
      name: d.name,
      hod:  d.hod,
      facultyCount: d.faculty.filter(f => f.role === 'faculty').length,
      totalUsers:   d.faculty.length,
    }));
    res.json(departments);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

/** POST create department (assigns to a dummy admin record if needed) */
router.post('/departments', ...adminOnly, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'Department name required' });
    // Check not already exists
    const exists = await User.findOne({ department: name });
    if (exists) return res.status(400).json({ error: 'Department already exists' });
    await logger.info('admin', `Department created: ${name}`, { by: req.user.id });
    res.json({ message: 'Department created', name });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

/** PATCH assign HOD to department */
router.patch('/departments/:name/hod', ...adminOnly, async (req, res) => {
  try {
    const { userId } = req.body;
    const deptName = decodeURIComponent(req.params.name);
    const user = await User.findByIdAndUpdate(
      userId,
      { role: 'hod', department: deptName },
      { new: true }
    ).select('-password -signatureImage');
    if (!user) return res.status(404).json({ error: 'User not found' });
    await logger.info('admin', `HOD assigned: ${user.email} → ${deptName}`, { by: req.user.id });
    res.json(user);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────
// SYSTEM STATS
// ─────────────────────────────────────────────────────────────

router.get('/stats', ...adminOnly, async (req, res) => {
  try {
    const [totalUsers, reports, submissions, errorLogs, warnLogs, unresolvedLogs] = await Promise.all([
      User.countDocuments(),
      FacultyReport.countDocuments(),
      Submission.countDocuments(),
      SystemLog.countDocuments({ level: 'error' }),
      SystemLog.countDocuments({ level: 'warn' }),
      SystemLog.countDocuments({ resolved: false }),
    ]);
    const usersByRole = await User.aggregate([
      { $group: { _id: '$role', count: { $sum: 1 } } }
    ]);
    const usersByDept = await User.aggregate([
      { $match: { department: { $ne: '' } } },
      { $group: { _id: '$department', count: { $sum: 1 } } }
    ]);
    const recentUsers = await User.find({}, 'name email role department createdAt status')
      .sort({ createdAt: -1 }).limit(5);

    res.json({
      totalUsers, reports, submissions,
      errorLogs, warnLogs, unresolvedLogs,
      usersByRole, usersByDept, recentUsers,
    });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

/** Server health metrics */
router.get('/metrics', ...adminOnly, async (req, res) => {
  try {
    const mem    = process.memoryUsage();
    const uptime = process.uptime();
    res.json({
      uptime:      Math.floor(uptime),
      memUsed:     Math.round(mem.heapUsed / 1024 / 1024),
      memTotal:    Math.round(mem.heapTotal / 1024 / 1024),
      rss:         Math.round(mem.rss / 1024 / 1024),
      pid:         process.pid,
      nodeVersion: process.version,
      platform:    process.platform,
    });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────
// AUDIT LOGS
// ─────────────────────────────────────────────────────────────

router.get('/logs', ...adminOnly, async (req, res) => {
  try {
    const { level, source, resolved, limit = 100, page = 1, search } = req.query;
    const filter = {};
    if (level)              filter.level    = level;
    if (source)             filter.source   = source;
    if (resolved !== undefined) filter.resolved = resolved === 'true';
    if (search)             filter.message  = { $regex: search, $options: 'i' };
    const total = await SystemLog.countDocuments(filter);
    const logs  = await SystemLog.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(Number(limit))
      .populate('resolvedBy', 'name email');
    res.json({ logs, total, page: Number(page), pages: Math.ceil(total / limit) });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

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

router.delete('/logs/:id', ...adminOnly, async (req, res) => {
  try {
    await SystemLog.findByIdAndDelete(req.params.id);
    res.json({ message: 'Log deleted' });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

router.delete('/logs/clear/resolved', ...adminOnly, async (req, res) => {
  try {
    const { deletedCount } = await SystemLog.deleteMany({ resolved: true });
    res.json({ message: `Cleared ${deletedCount} resolved logs` });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

router.post('/logs/:id/ai-suggest', ...adminOnly, async (req, res) => {
  try {
    const logEntry = await SystemLog.findById(req.params.id);
    if (!logEntry) return res.status(404).json({ error: 'Log not found' });
    let suggestion = generateRuleSuggestion(logEntry);
    try {
      const { analyzeWithAI } = require('../services/aiAnalyzer');
      suggestion = await analyzeWithAI(
        `Analyze this error and give fix steps:\n${logEntry.message}\nSource:${logEntry.source}\nStack:${logEntry.stack||'N/A'}`
      );
    } catch {}
    await SystemLog.findByIdAndUpdate(logEntry._id, { aiSuggestion: suggestion });
    res.json({ suggestion });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────
// NOTIFICATIONS (derived from recent system events)
// ─────────────────────────────────────────────────────────────

router.get('/notifications', ...adminOnly, async (req, res) => {
  try {
    const [recentUsers, recentLogs] = await Promise.all([
      User.find({}, 'name email role department createdAt status').sort({ createdAt: -1 }).limit(10),
      SystemLog.find({ level: { $in: ['warn','error'] }, resolved: false }).sort({ createdAt: -1 }).limit(10),
    ]);
    const notifications = [];
    for (const u of recentUsers) {
      notifications.push({
        id: 'user_' + u._id,
        type: 'user',
        title: `New ${u.role.toUpperCase()} joined`,
        body:  `${u.name} (${u.department || 'No dept'}) has been registered`,
        time:  u.createdAt,
        read:  false,
      });
    }
    for (const l of recentLogs) {
      notifications.push({
        id: 'log_' + l._id,
        type: l.level === 'error' ? 'system' : 'warning',
        title: `System ${l.level.toUpperCase()}: ${l.source}`,
        body:  l.message.slice(0, 120),
        time:  l.createdAt,
        read:  l.resolved,
      });
    }
    notifications.sort((a,b) => new Date(b.time) - new Date(a.time));
    res.json(notifications);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────
// AI ANALYSIS
// ─────────────────────────────────────────────────────────────

router.post('/ai-analyze', ...adminOnly, async (req, res) => {
  try {
    const { message, level } = req.body;
    if (!message) return res.status(400).json({ error: 'message required' });
    const suggestion = generateDetailedSuggestion({ message, level });
    res.json({ suggestion });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────
// HELPER FUNCTIONS
// ─────────────────────────────────────────────────────────────

function generateRuleSuggestion(logEntry) {
  const msg = (logEntry.message || '').toLowerCase();
  if (msg.includes('mongo') || msg.includes('connection'))
    return '**Root cause:** MongoDB connection failed.\n**Fix:** 1. Check MONGO_URI in .env 2. Ensure MongoDB is running 3. Check network/firewall rules.\n**Prevention:** Add connection retry logic with exponential backoff.';
  if (msg.includes('jwt') || msg.includes('token') || msg.includes('unauthorized'))
    return '**Root cause:** JWT authentication failure.\n**Fix:** 1. Check JWT_SECRET in .env 2. Verify token expiry 3. Ensure Authorization header is "Bearer <token>".\n**Prevention:** Add token refresh mechanism.';
  if (msg.includes('pdf') || msg.includes('drive'))
    return '**Root cause:** PDF download/generation failed.\n**Fix:** 1. Check Google Drive link is public 2. Verify pdf-lib version 3. Check available memory.\n**Prevention:** Add retry logic and file size limits.';
  return `**Root cause:** ${logEntry.level === 'error' ? 'Runtime error' : 'Warning'} in ${logEntry.source}.\n**Fix:** 1. Check the stack trace 2. Add error handling around the failing operation 3. Review recent changes.\n**Prevention:** Add comprehensive error boundaries and input validation.`;
}

function generateDetailedSuggestion({ message, level }) {
  const msg = (message || '').toLowerCase();
  if (msg.includes('cannot read') && msg.includes('undefined'))
    return '**Root cause:** Accessing property on undefined/null.\n**Fix:** Use optional chaining `obj?.prop` or add null checks.\n**Prevention:** Use optional chaining throughout the codebase.';
  if (msg.includes('mongo') || msg.includes('connection refused'))
    return '**Root cause:** MongoDB connection failed.\n**Fix:** 1. Check MONGO_URI in .env 2. Run `net start MongoDB` on Windows.\n**Prevention:** Add connection retry with exponential backoff.';
  if (msg.includes('enoent') || msg.includes('no such file'))
    return '**Root cause:** File not found.\n**Fix:** 1. Use `path.join(__dirname, ...)` 2. Add `fs.existsSync()` checks.\n**Prevention:** Always use __dirname-relative paths.';
  if (msg.includes('jwt') || msg.includes('invalid token'))
    return '**Root cause:** JWT token invalid or expired.\n**Fix:** 1. Check JWT_SECRET in .env 2. Verify `Authorization: Bearer <token>` format.\n**Prevention:** Add token refresh logic.';
  return `**Root cause:** ${level === 'error' ? 'Runtime error' : 'Warning'} — ${message.slice(0, 100)}.\n**Fix:** 1. Check the stack trace 2. Verify all variables are defined 3. Add try/catch around the failing operation.\n**Prevention:** Add input validation and error boundaries.`;
}

// ─────────────────────────────────────────────────────────────
// GOOGLE AUTH USERS TRACKING (SEPARATE VIEW)
// ─────────────────────────────────────────────────────────────

router.get('/google-users', ...adminOnly, async (req, res) => {
  try {
    const googleUsers = await User.find({
      $or: [{ googleVerified: true }, { googleId: { $ne: '' } }]
    }, '-password').sort({ lastLogin: -1 });
    res.json(googleUsers);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────
// DIGITAL SIGNATURES MANAGEMENT (FULL CRUD)
// ─────────────────────────────────────────────────────────────

router.get('/signatures', ...adminOnly, async (req, res) => {
  try {
    const { status } = req.query;
    const filter = { signatureImage: { $ne: '' } };
    if (status) filter.signatureStatus = status;
    const users = await User.find(filter, 'name email role department signatureImage signatureUploadedAt signatureStatus employeeId designation profilePhoto');
    res.json(users);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

router.post('/signatures', ...adminOnly, async (req, res) => {
  try {
    const { userId, signatureImage, status } = req.body;
    if (!userId || !signatureImage) {
      return res.status(400).json({ error: 'userId and signatureImage required' });
    }
    const user = await User.findByIdAndUpdate(userId, {
      signatureImage,
      signatureStatus: status || 'verified',
      signatureUploadedAt: new Date()
    }, { new: true }).select('name email role signatureImage signatureStatus');
    if (!user) return res.status(404).json({ error: 'User not found' });
    await logger.info('admin', `Signature uploaded for ${user.email}`, { by: req.user.id });
    res.json(user);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

router.patch('/signatures/:id/status', ...adminOnly, async (req, res) => {
  try {
    const { status, signatureImage } = req.body;
    const update = {};
    if (status) update.signatureStatus = status;
    if (signatureImage) {
      update.signatureImage = signatureImage;
      update.signatureUploadedAt = new Date();
    }
    const user = await User.findByIdAndUpdate(req.params.id, update, { new: true })
      .select('name email role signatureStatus signatureImage');
    if (!user) return res.status(404).json({ error: 'User not found' });
    await logger.info('admin', `Signature updated for ${user.email}`, { by: req.user.id });
    res.json(user);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

router.delete('/signatures/:id', ...adminOnly, async (req, res) => {
  try {
    const user = await User.findByIdAndUpdate(req.params.id, {
      signatureImage: '',
      signatureStatus: ''
    }, { new: true }).select('name email role');
    if (!user) return res.status(404).json({ error: 'User not found' });
    await logger.warn('admin', `Signature deleted for ${user.email}`, { by: req.user.id });
    res.json({ message: 'Signature deleted successfully' });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────
// SYSTEM LOGS (from DB — important events logged by logger.js)
// ─────────────────────────────────────────────────────────────

/** GET /api/admin/logs  — DB-persisted system logs */
router.get('/logs', ...adminOnly, async (req, res) => {
  try {
    const { level, source, limit = 200, skip = 0 } = req.query;
    const filter = {};
    if (level)  filter.level  = level;
    if (source) filter.source = source;
    const logs = await SystemLog.find(filter)
      .sort({ createdAt: -1 })
      .limit(parseInt(limit))
      .skip(parseInt(skip))
      .populate('resolvedBy', 'name email');
    const total = await SystemLog.countDocuments(filter);
    res.json({ logs, total });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

/** PATCH /api/admin/logs/:id — mark log as resolved */
router.patch('/logs/:id', ...adminOnly, async (req, res) => {
  try {
    const { resolved, resolution } = req.body;
    const log = await SystemLog.findByIdAndUpdate(req.params.id, {
      resolved: resolved ?? true,
      resolvedBy: req.user.id,
      resolvedAt: new Date(),
      resolution: resolution || ''
    }, { new: true });
    if (!log) return res.status(404).json({ error: 'Log not found' });
    res.json(log);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

/** DELETE /api/admin/logs/:id — delete a single log */
router.delete('/logs/:id', ...adminOnly, async (req, res) => {
  try {
    await SystemLog.findByIdAndDelete(req.params.id);
    res.json({ message: 'Log deleted' });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

/** DELETE /api/admin/logs — clear all logs */
router.delete('/logs', ...adminOnly, async (req, res) => {
  try {
    const result = await SystemLog.deleteMany({});
    res.json({ deleted: result.deletedCount });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────
// REPORT MANAGEMENT (Admin full access to all reports)
// ─────────────────────────────────────────────────────────────

/** GET /api/admin/all-reports — all reports across all departments */
router.get('/all-reports', ...adminOnly, async (req, res) => {
  try {
    const { department, status, limit = 300, skip = 0 } = req.query;
    const filter = {};
    if (status) filter.status = status;

    let reports = await FacultyReport.find(filter)
      .populate('hodId', 'name email department')
      .sort({ createdAt: -1 })
      .limit(parseInt(limit))
      .skip(parseInt(skip));

    // If department filter, filter by HOD's department
    if (department) {
      reports = reports.filter(r =>
        (r.hodId?.department || '').toLowerCase().includes(department.toLowerCase())
      );
    }

    // Add department info from HOD
    const enriched = reports.map(r => ({
      ...r.toObject(),
      hodName: r.hodId?.name || '',
      hodEmail: r.hodId?.email || '',
      hodDepartment: r.hodId?.department || '',
    }));

    res.json({ reports: enriched, total: enriched.length });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

/** GET /api/admin/reports/:id — single report (full) */
router.get('/reports/:id', ...adminOnly, async (req, res) => {
  try {
    const report = await FacultyReport.findById(req.params.id)
      .populate('hodId', 'name email department');
    if (!report) return res.status(404).json({ error: 'Report not found' });
    res.json(report);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

/** PATCH /api/admin/reports/:id — admin edits any field of any report */
router.patch('/reports/:id', ...adminOnly, async (req, res) => {
  try {
    const allowed = ['facultyName','subjectCode','programme','semester',
                     'hodRemarks','actionTaken','ffiScore','status',
                     'appreciation','commentsNeedingAttention','academicYear'];
    const update = {};
    allowed.forEach(k => { if (req.body[k] !== undefined) update[k] = req.body[k]; });

    const report = await FacultyReport.findByIdAndUpdate(req.params.id, update, { new: true });
    if (!report) return res.status(404).json({ error: 'Report not found' });

    await logger.info('admin', `Report edited by admin: ${report.facultyName} (${report._id})`, { by: req.user.id });
    res.json(report);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

/** DELETE /api/admin/reports/:id — admin deletes any report */
router.delete('/reports/:id', ...adminOnly, async (req, res) => {
  try {
    const report = await FacultyReport.findByIdAndDelete(req.params.id);
    if (!report) return res.status(404).json({ error: 'Report not found' });
    await logger.warn('admin', `Report deleted by admin: ${report.facultyName} (${report._id})`, { by: req.user.id });
    res.json({ message: 'Report deleted' });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;



