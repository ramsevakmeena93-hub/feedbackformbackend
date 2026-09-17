const express = require('express');
const router  = express.Router();
const bcrypt  = require('bcryptjs');
const User           = require('../models/User');
const UserRole       = require('../models/UserRole');
const TeachingAssignment = require('../models/TeachingAssignment');
const ApprovalPolicy = require('../models/ApprovalPolicy');
const AuditLog       = require('../models/AuditLog');
const SystemLog      = require('../models/SystemLog');
const FacultyReport  = require('../models/FacultyReport');
const Submission     = require('../models/Submission');
const { authMiddleware, requireRole } = require('./middleware');
const logger         = require('../services/logger');

const adminOnly = [authMiddleware, requireRole('admin')];

// ─────────────────────────────────────────────────────────────────────────────
// USER MANAGEMENT
// ─────────────────────────────────────────────────────────────────────────────

/** GET /api/admin/users/online — users currently online */
router.get('/users/online', ...adminOnly, async (req, res) => {
  try {
    const online = await User.find({ isOnline: true }, '-password -signatureImage')
      .sort({ currentLoginAt: -1 });
    res.json(online);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/** GET /api/admin/users/stats — quick count summary */
router.get('/users/stats', ...adminOnly, async (req, res) => {
  try {
    // Start of today (midnight local → UTC)
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const [total, active, suspended, online, googleAuth, todayUsers] = await Promise.all([
      User.countDocuments(),
      User.countDocuments({ status: 'active' }),
      User.countDocuments({ status: 'suspended' }),
      User.countDocuments({ isOnline: true }),
      User.countDocuments({ $or: [{ googleVerified: true }, { googleId: { $ne: '' } }] }),
      // Users who logged in today
      User.find(
        { currentLoginAt: { $gte: todayStart } },
        'currentLoginAt lastLeaveAt lastSeen isOnline'
      ).lean(),
    ]);

    // Calculate total minutes spent today across all users
    // For online users: now - loginAt
    // For offline users who logged in today: leaveAt - loginAt
    let totalMinutesToday = 0;
    const now = Date.now();
    for (const u of todayUsers) {
      const loginAt = u.currentLoginAt ? new Date(u.currentLoginAt).getTime() : null;
      if (!loginAt) continue;
      const endAt = u.isOnline
        ? now
        : (u.lastLeaveAt ? new Date(u.lastLeaveAt).getTime() : (u.lastSeen ? new Date(u.lastSeen).getTime() : now));
      const mins = Math.max(0, Math.round((endAt - loginAt) / 60000));
      totalMinutesToday += mins;
    }

    // Format as "Xh Ym"
    const hours = Math.floor(totalMinutesToday / 60);
    const mins  = totalMinutesToday % 60;
    const totalTimeToday = totalMinutesToday === 0
      ? '0m'
      : hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;

    res.json({
      total, active, suspended, online,
      offline: total - online,
      googleAuth,
      totalMinutesToday,
      totalTimeToday,
      activeSessionsToday: todayUsers.length,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/** GET /api/admin/users — list all users (with optional roles info) */
router.get('/users', ...adminOnly, async (req, res) => {
  try {
    const { role, department, status, withRoles } = req.query;
    const filter = {};
    if (role)       filter.role       = role;
    if (department) filter.department = department;
    if (status)     filter.status     = status;

    const users = await User.find(filter, '-password -signatureImage').sort({ createdAt: -1 });

    // Optionally enrich with UserRole documents
    if (withRoles === 'true') {
      const enriched = await Promise.all(users.map(async u => {
        const roles = await UserRole.find({ userId: u._id, active: true })
          .select('role departmentScope grantedAt')
          .lean();
        return { ...u.toObject(), roleDetails: roles };
      }));
      return res.json(enriched);
    }

    res.json(users);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/** GET /api/admin/users/:id — single user with full role details */
router.get('/users/:id', ...adminOnly, async (req, res) => {
  try {
    const user = await User.findById(req.params.id, '-password');
    if (!user) return res.status(404).json({ error: 'User not found' });

    const roleDetails = await UserRole.find({ userId: user._id })
      .populate('grantedBy', 'name email')
      .sort({ createdAt: -1 });

    const assignments = await TeachingAssignment.find({ facultyUserId: user._id, active: true })
      .sort({ academicYear: -1, semester: 1 });

    res.json({ ...user.toObject(), roleDetails, assignments });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/** POST /api/admin/users — create user + initial UserRole */
router.post('/users', ...adminOnly, async (req, res) => {
  try {
    const {
      name, email, password, role, department,
      phone, designation, experience, qualification,
      employeeId, gender, status, roles: extraRoles,
    } = req.body;

    if (!name || !email || !password || !role) {
      return res.status(400).json({ error: 'name, email, password, role required' });
    }
    const existing = await User.findOne({ email });
    if (existing) return res.status(400).json({ error: 'Email already registered' });

    const hashed = await bcrypt.hash(password, 10);

    // Determine the full roles list (legacy role + any extras provided)
    const allRoles = [...new Set([role, ...(extraRoles || [])])].filter(r =>
      ['hod','faculty','vc','admin'].includes(r)
    );

    const user = await User.create({
      name, email, password: hashed, role,
      roles:           allRoles,
      activeWorkspace: role,
      department:      department || '',
      phone:           phone       || '',
      designation:     designation || '',
      experience:      experience  || '',
      qualification:   qualification || '',
      employeeId:      employeeId || '',
      gender:          gender     || '',
      status:          status     || 'active',
    });

    // Create UserRole documents for every role in allRoles
    for (const r of allRoles) {
      await UserRole.create({
        userId:          user._id,
        role:            r,
        departmentScope: department || '',
        grantedBy:       req.user.id,
      });
    }

    await logger.info('admin', `User created: ${email} (${allRoles.join(',')})`, { by: req.user.id });
    await AuditLog.record({
      actorId:     req.user.id,
      actorRole:   'admin',
      workspace:   'admin',
      event:       'role_granted',
      description: `Admin created user ${email} with roles: ${allRoles.join(', ')}`,
      targetType:  'user',
      targetId:    user._id,
      meta:        { roles: allRoles, department },
    });

    res.json({ message: 'User created', user: { id: user._id, name, email, role, roles: allRoles, department: user.department } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/** PATCH /api/admin/users/:id — update user fields */
router.patch('/users/:id', ...adminOnly, async (req, res) => {
  try {
    const allowed = ['name','email','role','department','password','phone',
                     'designation','experience','qualification','employeeId',
                     'gender','status','bio','cabin','signatureStatus','activeWorkspace',
                     'defaultAlternateApproverId'];
    const update = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        update[key] = key === 'password'
          ? await bcrypt.hash(req.body[key], 10)
          : req.body[key];
      }
    }

    // If role is being changed, sync User.roles[] too
    if (update.role) {
      const existing = await UserRole.find({ userId: req.params.id, active: true }).select('role');
      const currentRoles = existing.map(r => r.role);
      if (!currentRoles.includes(update.role)) {
        await UserRole.create({
          userId: req.params.id, role: update.role,
          departmentScope: update.department || '',
          grantedBy: req.user.id,
        });
        currentRoles.push(update.role);
      }
      update.roles = [...new Set(currentRoles)];
    }

    const user = await User.findByIdAndUpdate(req.params.id, update, { new: true })
      .select('-password -signatureImage -profilePhoto');
    if (!user) return res.status(404).json({ error: 'User not found' });

    await logger.info('admin', `User updated: ${user.email}`, { by: req.user.id, changes: Object.keys(update) });
    res.json(user);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/** DELETE /api/admin/users/:id — delete user + their roles + assignments */
router.delete('/users/:id', ...adminOnly, async (req, res) => {
  try {
    const user = await User.findByIdAndDelete(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Clean up associated data
    await Promise.all([
      UserRole.deleteMany({ userId: req.params.id }),
      TeachingAssignment.deleteMany({ facultyUserId: req.params.id }),
    ]);

    await logger.warn('admin', `User deleted: ${user.email} (${user.role})`, { by: req.user.id });
    res.json({ message: 'User deleted' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/** POST /api/admin/users/:id/reset-password */
router.post('/users/:id/reset-password', ...adminOnly, async (req, res) => {
  try {
    const { password } = req.body;
    if (!password || password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }
    const hashed = await bcrypt.hash(password, 10);
    await User.findByIdAndUpdate(req.params.id, { password: hashed });
    res.json({ message: 'Password reset successfully' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/** PATCH /api/admin/users/:id/status — suspend / activate */
router.patch('/users/:id/status', ...adminOnly, async (req, res) => {
  try {
    const { status } = req.body;
    if (!['active','suspended','pending'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }
    const user = await User.findByIdAndUpdate(req.params.id, { status }, { new: true })
      .select('-password -signatureImage');
    if (!user) return res.status(404).json({ error: 'User not found' });
    await logger.info('admin', `User ${status}: ${user.email}`, { by: req.user.id });
    res.json(user);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// MULTI-ROLE MANAGEMENT (inline endpoints — mirror of /api/roles for admin UI)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/admin/users/:id/roles — all role assignments for a user
 */
router.get('/users/:id/roles', ...adminOnly, async (req, res) => {
  try {
    const roles = await UserRole.find({ userId: req.params.id })
      .populate('grantedBy', 'name email')
      .sort({ createdAt: -1 });
    res.json(roles);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/**
 * POST /api/admin/users/:id/roles — assign a role to a user
 * Body: { role, departmentScope? }
 */
router.post('/users/:id/roles', ...adminOnly, async (req, res) => {
  try {
    const { role, departmentScope = '' } = req.body;
    if (!role) return res.status(400).json({ error: 'role is required' });

    const targetUser = await User.findById(req.params.id);
    if (!targetUser) return res.status(404).json({ error: 'User not found' });

    const existing = await UserRole.findOne({ userId: req.params.id, role, departmentScope });
    if (existing) {
      existing.active = true; existing.grantedBy = req.user.id; existing.grantedAt = new Date();
      existing.revokedBy = null; existing.revokedAt = null;
      await existing.save();
    } else {
      await UserRole.create({ userId: req.params.id, role, departmentScope, grantedBy: req.user.id });
    }

    // Sync User.roles[] cache
    const allActive = await UserRole.find({ userId: req.params.id, active: true }).select('role');
    const rolesCache = [...new Set(allActive.map(r => r.role))];
    const PRIORITY   = ['admin','vc','hod','faculty'];
    const primary    = PRIORITY.find(r => rolesCache.includes(r)) || role;
    await User.findByIdAndUpdate(req.params.id, { roles: rolesCache, role: primary });

    await AuditLog.record({
      actorId: req.user.id, actorRole: 'admin', workspace: 'admin',
      event: 'role_granted',
      description: `Role '${role}' granted to '${targetUser.name}' with scope '${departmentScope || 'global'}'`,
      targetType: 'user', targetId: req.params.id,
      meta: { role, departmentScope },
    });

    res.json({ message: 'Role assigned', rolesCache });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: 'Role already assigned' });
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/admin/users/:id/roles/:roleId — revoke a specific role assignment
 */
router.delete('/users/:id/roles/:roleId', ...adminOnly, async (req, res) => {
  try {
    const userRole = await UserRole.findOne({ _id: req.params.roleId, userId: req.params.id });
    if (!userRole) return res.status(404).json({ error: 'Role not found' });

    userRole.active = false; userRole.revokedBy = req.user.id; userRole.revokedAt = new Date();
    await userRole.save();

    const allActive = await UserRole.find({ userId: req.params.id, active: true }).select('role');
    const rolesCache = [...new Set(allActive.map(r => r.role))];
    const PRIORITY   = ['admin','vc','hod','faculty'];
    const primary    = PRIORITY.find(r => rolesCache.includes(r)) || rolesCache[0] || 'faculty';
    await User.findByIdAndUpdate(req.params.id, { roles: rolesCache, role: primary });

    await AuditLog.record({
      actorId: req.user.id, actorRole: 'admin', workspace: 'admin',
      event: 'role_revoked',
      description: `Role '${userRole.role}' revoked from user ${req.params.id}`,
      targetType: 'user', targetId: req.params.id,
      meta: { role: userRole.role },
    });

    res.json({ message: 'Role revoked', rolesCache });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// TEACHING ASSIGNMENTS (inline — mirror of /api/assignments)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/admin/users/:id/assignments — teaching assignments for a faculty
 */
router.get('/users/:id/assignments', ...adminOnly, async (req, res) => {
  try {
    const assignments = await TeachingAssignment.find({ facultyUserId: req.params.id })
      .sort({ createdAt: -1 });
    res.json(assignments);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/**
 * POST /api/admin/users/:id/assignments — add a teaching assignment to a faculty
 */
router.post('/users/:id/assignments', ...adminOnly, async (req, res) => {
  try {
    const { subjectCode, subjectName, programme, branch, section, semester, academicYear, department } = req.body;
    if (!subjectCode) return res.status(400).json({ error: 'subjectCode required' });

    const assignment = await TeachingAssignment.create({
      facultyUserId: req.params.id,
      subjectCode, subjectName: subjectName || '',
      programme: programme || '', branch: branch || '',
      section: section || '', semester: semester || '',
      academicYear: academicYear || '', department: department || '',
      createdBy: req.user.id,
    });

    await AuditLog.record({
      actorId: req.user.id, actorRole: 'admin', workspace: 'admin',
      event: 'teaching_assignment_created',
      description: `Assignment ${subjectCode} created for faculty ${req.params.id} (${branch} Sec ${section})`,
      targetType: 'user', targetId: req.params.id,
      meta: { subjectCode, branch, section, semester, academicYear },
    });

    res.status(201).json(assignment);
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: 'This exact assignment already exists' });
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/admin/users/:id/assignments/:assignmentId — remove an assignment
 */
router.delete('/users/:id/assignments/:assignmentId', ...adminOnly, async (req, res) => {
  try {
    const a = await TeachingAssignment.findOneAndDelete({
      _id: req.params.assignmentId,
      facultyUserId: req.params.id,
    });
    if (!a) return res.status(404).json({ error: 'Assignment not found' });

    await AuditLog.record({
      actorId: req.user.id, actorRole: 'admin', workspace: 'admin',
      event: 'teaching_assignment_removed',
      description: `Assignment ${a.subjectCode} removed from faculty ${req.params.id}`,
      targetType: 'user', targetId: req.params.id,
      meta: { subjectCode: a.subjectCode, branch: a.branch, section: a.section },
    });

    res.json({ message: 'Assignment removed' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// APPROVAL POLICY MANAGEMENT
// ─────────────────────────────────────────────────────────────────────────────

/** GET /api/admin/policies — list all department policies */
router.get('/policies', ...adminOnly, async (req, res) => {
  try {
    const policies = await ApprovalPolicy.find()
      .populate('alternateApprovers.facultyUserId',     'name email')
      .populate('alternateApprovers.alternateHodUserId', 'name email')
      .sort({ department: 1 });
    res.json(policies);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/** PUT /api/admin/policies/:department — upsert a department's approval policy */
router.put('/policies/:department', ...adminOnly, async (req, res) => {
  try {
    const dept = req.params.department === 'global' ? '' : req.params.department;
    const { onConflict } = req.body;
    if (!['alternate','escalate','block'].includes(onConflict)) {
      return res.status(400).json({ error: "onConflict must be 'alternate', 'escalate', or 'block'" });
    }
    const policy = await ApprovalPolicy.findOneAndUpdate(
      { department: dept },
      { onConflict, updatedBy: req.user.id },
      { new: true, upsert: true }
    );

    await AuditLog.record({
      actorId: req.user.id, actorRole: 'admin', workspace: 'admin',
      event: 'policy_updated',
      description: `Approval policy for '${dept || 'global'}' set to '${onConflict}'`,
      targetType: 'policy', targetId: policy._id,
      meta: { department: dept, onConflict },
    });

    res.json(policy);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// CONFLICT MANAGEMENT — admin resolves escalated submissions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/admin/conflicts — list submissions with conflict or escalated status
 */
router.get('/conflicts', ...adminOnly, async (req, res) => {
  try {
    const conflicts = await Submission.find({ status: { $in: ['conflict','escalated'] } })
      .populate('hodId', 'name email department')
      .populate('alternateApproverId', 'name email')
      .populate({ path: 'reports', model: 'FacultyReport', select: 'facultyName subjectCode status' })
      .sort({ createdAt: -1 });
    res.json(conflicts);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/**
 * PATCH /api/admin/conflicts/:id/resolve — admin manually assigns alternate approver
 * Body: { alternateApproverId }
 */
router.patch('/conflicts/:id/resolve', ...adminOnly, async (req, res) => {
  try {
    const { alternateApproverId } = req.body;
    if (!alternateApproverId) return res.status(400).json({ error: 'alternateApproverId required' });

    const altUser = await User.findById(alternateApproverId).select('name email');
    if (!altUser) return res.status(404).json({ error: 'Alternate approver not found' });

    const submission = await Submission.findByIdAndUpdate(
      req.params.id,
      { status: 'conflict', alternateApproverId },
      { new: true }
    ).populate('hodId', 'name email');
    if (!submission) return res.status(404).json({ error: 'Submission not found' });

    await AuditLog.record({
      actorId: req.user.id, actorRole: 'admin', workspace: 'admin',
      event: 'conflict_resolved',
      description: `Admin resolved conflict on submission ${req.params.id} by assigning alternate approver ${altUser.name}`,
      targetType: 'submission', targetId: req.params.id,
      meta: { alternateApproverId, alternateName: altUser.name },
    });

    res.json({ message: 'Conflict resolved — alternate approver assigned', submission });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// DEPARTMENT MANAGEMENT
// ─────────────────────────────────────────────────────────────────────────────

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
      name:        d.name,
      hod:         d.hod,
      facultyCount: d.faculty.filter(f => f.role === 'faculty').length,
      totalUsers:   d.faculty.length,
    }));
    res.json(departments);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/departments', ...adminOnly, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'Department name required' });
    const exists = await User.findOne({ department: name });
    if (exists) return res.status(400).json({ error: 'Department already exists' });
    await logger.info('admin', `Department created: ${name}`, { by: req.user.id });
    res.json({ message: 'Department created', name });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

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

    // Ensure HOD UserRole document exists
    const existingHOD = await UserRole.findOne({ userId, role: 'hod', departmentScope: deptName });
    if (!existingHOD) {
      await UserRole.create({ userId, role: 'hod', departmentScope: deptName, grantedBy: req.user.id });
    } else {
      existingHOD.active = true; existingHOD.grantedBy = req.user.id; existingHOD.grantedAt = new Date();
      await existingHOD.save();
    }

    // Sync roles cache
    const allActive = await UserRole.find({ userId, active: true }).select('role');
    const rolesCache = [...new Set(allActive.map(r => r.role))];
    await User.findByIdAndUpdate(userId, { roles: rolesCache });

    await logger.info('admin', `HOD assigned: ${user.email} → ${deptName}`, { by: req.user.id });
    res.json(user);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// SYSTEM STATS
// ─────────────────────────────────────────────────────────────────────────────

router.get('/stats', ...adminOnly, async (req, res) => {
  try {
    const [
      totalUsers, reports, submissions,
      errorLogs, warnLogs, unresolvedLogs,
      conflicts, escalated, multiRoleUsers,
    ] = await Promise.all([
      User.countDocuments(),
      FacultyReport.countDocuments(),
      Submission.countDocuments(),
      SystemLog.countDocuments({ level: 'error' }),
      SystemLog.countDocuments({ level: 'warn' }),
      SystemLog.countDocuments({ resolved: false }),
      Submission.countDocuments({ status: 'conflict' }),
      Submission.countDocuments({ status: 'escalated' }),
      User.countDocuments({ $expr: { $gt: [{ $size: { $ifNull: ['$roles', []] } }, 1] } }),
    ]);

    const usersByRole = await User.aggregate([
      { $group: { _id: '$role', count: { $sum: 1 } } },
    ]);
    const usersByDept = await User.aggregate([
      { $match: { department: { $ne: '' } } },
      { $group: { _id: '$department', count: { $sum: 1 } } },
    ]);
    const recentUsers = await User.find({}, 'name email role roles department createdAt status')
      .sort({ createdAt: -1 }).limit(5);

    res.json({
      totalUsers, reports, submissions,
      errorLogs, warnLogs, unresolvedLogs,
      conflicts, escalated, multiRoleUsers,
      usersByRole, usersByDept, recentUsers,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

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
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// SYSTEM LOGS
// ─────────────────────────────────────────────────────────────────────────────

router.get('/logs', ...adminOnly, async (req, res) => {
  try {
    const { level, source, resolved, limit = 100, page = 1, search } = req.query;
    const filter = {};
    if (level)                filter.level    = level;
    if (source)               filter.source   = source;
    if (resolved !== undefined) filter.resolved = resolved === 'true';
    if (search)               filter.message  = { $regex: search, $options: 'i' };
    const total = await SystemLog.countDocuments(filter);
    const logs  = await SystemLog.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(Number(limit))
      .populate('resolvedBy', 'name email');
    res.json({ logs, total, page: Number(page), pages: Math.ceil(total / limit) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.patch('/logs/:id/resolve', ...adminOnly, async (req, res) => {
  try {
    const { resolution } = req.body;
    const log = await SystemLog.findByIdAndUpdate(req.params.id, {
      resolved: true, resolvedBy: req.user.id,
      resolvedAt: new Date(), resolution: resolution || '',
    }, { new: true });
    if (!log) return res.status(404).json({ error: 'Log not found' });
    res.json(log);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/logs/:id', ...adminOnly, async (req, res) => {
  try {
    await SystemLog.findByIdAndDelete(req.params.id);
    res.json({ message: 'Log deleted' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/logs/clear/resolved', ...adminOnly, async (req, res) => {
  try {
    const { deletedCount } = await SystemLog.deleteMany({ resolved: true });
    res.json({ message: `Cleared ${deletedCount} resolved logs` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/logs/:id/ai-suggest', ...adminOnly, async (req, res) => {
  try {
    const logEntry = await SystemLog.findById(req.params.id);
    if (!logEntry) return res.status(404).json({ error: 'Log not found' });
    let suggestion = generateRuleSuggestion(logEntry);
    try {
      const { analyzeWithAI } = require('../services/aiAnalyzer');
      suggestion = await analyzeWithAI(
        `Analyze this error and give fix steps:\n${logEntry.message}\nSource:${logEntry.source}\nStack:${logEntry.stack || 'N/A'}`
      );
    } catch {}
    await SystemLog.findByIdAndUpdate(logEntry._id, { aiSuggestion: suggestion });
    res.json({ suggestion });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// NOTIFICATIONS
// ─────────────────────────────────────────────────────────────────────────────

router.get('/notifications', ...adminOnly, async (req, res) => {
  try {
    const [recentUsers, recentLogs, conflicts, escalated] = await Promise.all([
      User.find({
        createdAt: { $gte: new Date(Date.now() - 48 * 3600000) } // last 48h
      }, 'name email role department createdAt status').sort({ createdAt: -1 }).limit(10),
      SystemLog.find({ level: { $in: ['warn','error'] }, resolved: false }).sort({ createdAt: -1 }).limit(10),
      Submission.find({ status: 'conflict' }).populate('hodId', 'name email').sort({ createdAt: -1 }).limit(5),
      Submission.find({ status: 'escalated' }).populate('hodId', 'name email').sort({ createdAt: -1 }).limit(5),
    ]);

    const notifications = [];

    // Escalation alerts — highest priority
    for (const s of escalated) {
      notifications.push({
        id:           'esc_' + s._id,
        type:         'escalation',
        title:        'Submission Escalated — Admin Action Required',
        body:         `HOD ${s.hodId?.name || 'Unknown'} has a self-approval conflict that requires admin intervention. Reason: ${s.conflictReason || 'N/A'}`,
        time:         s.escalatedAt || s.createdAt,
        read:         false,
        submissionId: s._id,
      });
    }

    // Conflict alerts
    for (const s of conflicts) {
      notifications.push({
        id:           'cfl_' + s._id,
        type:         'conflict',
        title:        'Self-Approval Conflict Detected',
        body:         `Submission by HOD ${s.hodId?.name || 'Unknown'} has a self-approval conflict. An alternate approver ${s.alternateApproverId ? 'has been assigned' : 'needs to be assigned'}.`,
        time:         s.conflictDetectedAt || s.createdAt,
        read:         false,
        submissionId: s._id,
      });
    }

    // System errors
    for (const l of recentLogs.filter(l => l.level === 'error')) {
      notifications.push({
        id:    'err_' + l._id,
        type:  'error',
        title: `System Error — ${l.source || 'backend'}`,
        body:  l.message?.slice(0, 160) || 'An unresolved error was logged.',
        time:  l.createdAt,
        read:  false,
        logId: l._id,
      });
    }

    // System warnings
    for (const l of recentLogs.filter(l => l.level === 'warn')) {
      notifications.push({
        id:    'wrn_' + l._id,
        type:  'warning',
        title: `Warning — ${l.source || 'system'}`,
        body:  l.message?.slice(0, 160) || 'A warning was logged.',
        time:  l.createdAt,
        read:  l.resolved,
        logId: l._id,
      });
    }

    // New user registrations
    for (const u of recentUsers) {
      notifications.push({
        id:   'usr_' + u._id,
        type: 'user',
        title: `New ${u.role.toUpperCase()} registered`,
        body:  `${u.name} (${u.email}) joined${u.department ? ' — ' + u.department : ''}`,
        time:  u.createdAt,
        read:  false,
      });
    }

    // Sort by time descending
    notifications.sort((a, b) => new Date(b.time) - new Date(a.time));
    res.json(notifications);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// AI ANALYSIS
// ─────────────────────────────────────────────────────────────────────────────

router.post('/ai-analyze', ...adminOnly, async (req, res) => {
  try {
    const { message, level } = req.body;
    if (!message) return res.status(400).json({ error: 'message required' });
    res.json({ suggestion: generateDetailedSuggestion({ message, level }) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// GOOGLE AUTH USERS
// ─────────────────────────────────────────────────────────────────────────────

router.get('/google-users', ...adminOnly, async (req, res) => {
  try {
    const googleUsers = await User.find({
      $or: [{ googleVerified: true }, { googleId: { $ne: '' } }],
    }, '-password').sort({ lastLogin: -1 });
    res.json(googleUsers);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// DIGITAL SIGNATURES
// ─────────────────────────────────────────────────────────────────────────────

router.get('/signatures', ...adminOnly, async (req, res) => {
  try {
    const { status } = req.query;
    const filter = { signatureImage: { $ne: '' } };
    if (status) filter.signatureStatus = status;
    const users = await User.find(filter, 'name email role department signatureImage signatureUploadedAt signatureStatus employeeId designation profilePhoto');
    res.json(users);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/signatures', ...adminOnly, async (req, res) => {
  try {
    const { userId, signatureImage, status } = req.body;
    if (!userId || !signatureImage) return res.status(400).json({ error: 'userId and signatureImage required' });
    const user = await User.findByIdAndUpdate(userId, {
      signatureImage, signatureStatus: status || 'verified', signatureUploadedAt: new Date(),
    }, { new: true }).select('name email role signatureImage signatureStatus');
    if (!user) return res.status(404).json({ error: 'User not found' });
    await logger.info('admin', `Signature uploaded for ${user.email}`, { by: req.user.id });
    res.json(user);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.patch('/signatures/:id/status', ...adminOnly, async (req, res) => {
  try {
    const update = {};
    if (req.body.status)         update.signatureStatus   = req.body.status;
    if (req.body.signatureImage) { update.signatureImage  = req.body.signatureImage; update.signatureUploadedAt = new Date(); }
    const user = await User.findByIdAndUpdate(req.params.id, update, { new: true })
      .select('name email role signatureStatus signatureImage');
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/signatures/:id', ...adminOnly, async (req, res) => {
  try {
    const user = await User.findByIdAndUpdate(req.params.id, { signatureImage: '', signatureStatus: '' }, { new: true })
      .select('name email role');
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ message: 'Signature deleted' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// REPORT MANAGEMENT
// ─────────────────────────────────────────────────────────────────────────────

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
    if (department) {
      reports = reports.filter(r =>
        (r.hodId?.department || '').toLowerCase().includes(department.toLowerCase())
      );
    }
    const enriched = reports.map(r => ({
      ...r.toObject(),
      hodName:       r.hodId?.name       || '',
      hodEmail:      r.hodId?.email      || '',
      hodDepartment: r.hodId?.department || '',
    }));
    res.json({ reports: enriched, total: enriched.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/reports/:id', ...adminOnly, async (req, res) => {
  try {
    const report = await FacultyReport.findById(req.params.id).populate('hodId', 'name email department');
    if (!report) return res.status(404).json({ error: 'Report not found' });
    res.json(report);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.patch('/reports/:id', ...adminOnly, async (req, res) => {
  try {
    const allowed = ['facultyName','subjectCode','programme','semester','branch','section',
                     'hodRemarks','actionTaken','ffiScore','status',
                     'appreciation','commentsNeedingAttention','academicYear'];
    const update = {};
    allowed.forEach(k => { if (req.body[k] !== undefined) update[k] = req.body[k]; });
    const report = await FacultyReport.findByIdAndUpdate(req.params.id, update, { new: true });
    if (!report) return res.status(404).json({ error: 'Report not found' });
    await logger.info('admin', `Report edited by admin: ${report.facultyName} (${report._id})`, { by: req.user.id });
    res.json(report);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/reports/:id', ...adminOnly, async (req, res) => {
  try {
    const report = await FacultyReport.findByIdAndDelete(req.params.id);
    if (!report) return res.status(404).json({ error: 'Report not found' });
    await logger.warn('admin', `Report deleted by admin: ${report.facultyName}`, { by: req.user.id });
    res.json({ message: 'Report deleted' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function generateRuleSuggestion(logEntry) {
  const msg = (logEntry.message || '').toLowerCase();
  if (msg.includes('mongo') || msg.includes('connection'))
    return '**Root cause:** MongoDB connection failed.\n**Fix:** 1. Check MONGO_URI in .env 2. Ensure MongoDB is running 3. Check network/firewall.\n**Prevention:** Add connection retry with exponential backoff.';
  if (msg.includes('jwt') || msg.includes('token') || msg.includes('unauthorized'))
    return '**Root cause:** JWT authentication failure.\n**Fix:** 1. Check JWT_SECRET in .env 2. Verify token expiry.\n**Prevention:** Add token refresh mechanism.';
  if (msg.includes('pdf') || msg.includes('drive'))
    return '**Root cause:** PDF download/generation failed.\n**Fix:** 1. Check Google Drive link is public 2. Check available memory.\n**Prevention:** Add retry logic and file size limits.';
  return `**Root cause:** ${logEntry.level === 'error' ? 'Runtime error' : 'Warning'} in ${logEntry.source}.\n**Fix:** Check the stack trace and add error handling.\n**Prevention:** Add comprehensive error boundaries and input validation.`;
}

function generateDetailedSuggestion({ message, level }) {
  const msg = (message || '').toLowerCase();
  if (msg.includes('cannot read') && msg.includes('undefined'))
    return '**Root cause:** Accessing property on undefined/null.\n**Fix:** Use optional chaining `obj?.prop`.\n**Prevention:** Use optional chaining throughout.';
  if (msg.includes('mongo') || msg.includes('connection refused'))
    return '**Root cause:** MongoDB connection failed.\n**Fix:** Check MONGO_URI in .env.\n**Prevention:** Add connection retry with exponential backoff.';
  return `**Root cause:** ${level === 'error' ? 'Runtime error' : 'Warning'} — ${message.slice(0, 100)}.\n**Fix:** Check stack trace and add try/catch.\n**Prevention:** Add input validation.`;
}

module.exports = router;
