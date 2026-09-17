/**
 * /api/roles — multi-role management (admin only)
 *
 * Endpoints:
 *   GET    /api/roles/user/:userId          — list all roles for a user
 *   POST   /api/roles/user/:userId          — assign a role to a user
 *   DELETE /api/roles/user/:userId/:roleId  — revoke a specific role
 *   GET    /api/roles/policy/:department    — get approval policy for a department
 *   PUT    /api/roles/policy/:department    — upsert approval policy
 *   POST   /api/roles/policy/:department/alternate — set alternate approver for a faculty
 *   DELETE /api/roles/policy/:department/alternate/:facultyUserId — remove alternate approver
 */
const express = require('express');
const router  = express.Router();

const User           = require('../models/User');
const UserRole       = require('../models/UserRole');
const ApprovalPolicy = require('../models/ApprovalPolicy');
const AuditLog       = require('../models/AuditLog');
const { authMiddleware, requireRole } = require('./middleware');

const adminOnly = [authMiddleware, requireRole('admin')];

// ─────────────────────────────────────────────────────────────────────────────
// ROLE MANAGEMENT
// ─────────────────────────────────────────────────────────────────────────────

/** GET /api/roles/user/:userId — list all roles held by this user */
router.get('/user/:userId', ...adminOnly, async (req, res) => {
  try {
    const roles = await UserRole.find({ userId: req.params.userId })
      .populate('grantedBy', 'name email')
      .sort({ createdAt: -1 });
    res.json(roles);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/roles/user/:userId — assign a new role to a user
 *
 * Body: { role: 'hod'|'faculty'|'vc'|'admin', departmentScope?: string }
 *
 * Side effects:
 *  - Creates/reactivates a UserRole document
 *  - Updates User.roles[] cache
 *  - Sets User.activeWorkspace if it's their first role
 *  - Records AuditLog entry
 */
router.post('/user/:userId', ...adminOnly, async (req, res) => {
  try {
    const { role, departmentScope = '' } = req.body;
    if (!role) return res.status(400).json({ error: 'role is required' });

    const targetUser = await User.findById(req.params.userId);
    if (!targetUser) return res.status(404).json({ error: 'User not found' });

    // Upsert the UserRole (reactivate if it was previously revoked)
    const existing = await UserRole.findOne({
      userId: req.params.userId,
      role,
      departmentScope,
    });

    let userRole;
    if (existing) {
      // Reactivate
      existing.active    = true;
      existing.grantedBy = req.user.id;
      existing.grantedAt = new Date();
      existing.revokedBy = null;
      existing.revokedAt = null;
      await existing.save();
      userRole = existing;
    } else {
      userRole = await UserRole.create({
        userId: req.params.userId,
        role,
        departmentScope,
        grantedBy: req.user.id,
      });
    }

    // Sync User.roles[] cache
    const allActive = await UserRole.find({ userId: req.params.userId, active: true }).select('role');
    const rolesCache = [...new Set(allActive.map(r => r.role))];
    const updates = { roles: rolesCache };

    // Keep legacy role field as the "primary" role (first assigned, or most privileged)
    const PRIORITY = ['admin', 'vc', 'hod', 'faculty'];
    const primary = PRIORITY.find(r => rolesCache.includes(r)) || role;
    updates.role = primary;

    // Set activeWorkspace on first role assignment if not already set
    if (!targetUser.activeWorkspace) updates.activeWorkspace = role;

    await User.findByIdAndUpdate(req.params.userId, updates);

    await AuditLog.record({
      actorId:     req.user.id,
      actorName:   req.user.name || '',
      actorRole:   req.user.role,
      workspace:   req.user.activeWorkspace || req.user.role,
      event:       'role_granted',
      description: `Role '${role}' granted to user '${targetUser.name}' (${targetUser.email}) with scope '${departmentScope || 'global'}'`,
      targetType:  'user',
      targetId:    targetUser._id,
      meta:        { role, departmentScope, grantedTo: targetUser.email },
    });

    res.json({ message: 'Role assigned', userRole, rolesCache });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: 'This role+scope is already assigned to the user' });
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/roles/user/:userId/:roleId — revoke a specific UserRole document
 */
router.delete('/user/:userId/:roleId', ...adminOnly, async (req, res) => {
  try {
    const userRole = await UserRole.findOne({
      _id: req.params.roleId,
      userId: req.params.userId,
    });
    if (!userRole) return res.status(404).json({ error: 'Role assignment not found' });

    userRole.active    = false;
    userRole.revokedBy = req.user.id;
    userRole.revokedAt = new Date();
    await userRole.save();

    // Sync User.roles[] cache
    const allActive = await UserRole.find({ userId: req.params.userId, active: true }).select('role');
    const rolesCache = [...new Set(allActive.map(r => r.role))];
    const PRIORITY   = ['admin', 'vc', 'hod', 'faculty'];
    const primary    = PRIORITY.find(r => rolesCache.includes(r)) || rolesCache[0] || 'faculty';

    await User.findByIdAndUpdate(req.params.userId, { roles: rolesCache, role: primary });

    const targetUser = await User.findById(req.params.userId).select('name email');

    await AuditLog.record({
      actorId:     req.user.id,
      actorName:   req.user.name || '',
      actorRole:   req.user.role,
      workspace:   req.user.activeWorkspace || req.user.role,
      event:       'role_revoked',
      description: `Role '${userRole.role}' revoked from user '${targetUser?.name}' (${targetUser?.email})`,
      targetType:  'user',
      targetId:    req.params.userId,
      meta:        { role: userRole.role, departmentScope: userRole.departmentScope },
    });

    res.json({ message: 'Role revoked', rolesCache });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * PATCH /api/roles/user/:userId/alternate — set the default alternate approver for a user (HOD)
 * Body: { alternateApproverId: ObjectId }
 */
router.patch('/user/:userId/alternate', ...adminOnly, async (req, res) => {
  try {
    const { alternateApproverId } = req.body;
    if (!alternateApproverId) return res.status(400).json({ error: 'alternateApproverId is required' });

    const alt = await User.findById(alternateApproverId).select('name email');
    if (!alt) return res.status(404).json({ error: 'Alternate approver user not found' });

    await User.findByIdAndUpdate(req.params.userId, { defaultAlternateApproverId: alternateApproverId });

    const targetUser = await User.findById(req.params.userId).select('name email');

    await AuditLog.record({
      actorId:     req.user.id,
      actorName:   req.user.name || '',
      actorRole:   req.user.role,
      workspace:   req.user.activeWorkspace || req.user.role,
      event:       'alternate_approver_assigned',
      description: `Default alternate approver for '${targetUser?.name}' set to '${alt.name}' (${alt.email})`,
      targetType:  'user',
      targetId:    req.params.userId,
      meta:        { alternateApproverId, alternateName: alt.name },
    });

    res.json({ message: 'Alternate approver set', alternateApprover: { id: alt._id, name: alt.name, email: alt.email } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// APPROVAL POLICY
// ─────────────────────────────────────────────────────────────────────────────

/** GET /api/roles/policy/:department — fetch policy (use 'global' for the default policy) */
router.get('/policy/:department', ...adminOnly, async (req, res) => {
  try {
    const dept   = req.params.department === 'global' ? '' : req.params.department;
    const policy = await ApprovalPolicy.findOne({ department: dept })
      .populate('alternateApprovers.facultyUserId',    'name email')
      .populate('alternateApprovers.alternateHodUserId','name email');
    if (!policy) return res.status(404).json({ error: 'No policy found for this department' });
    res.json(policy);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * PUT /api/roles/policy/:department — create or update a department's approval policy
 * Body: { onConflict: 'alternate'|'escalate'|'block' }
 */
router.put('/policy/:department', ...adminOnly, async (req, res) => {
  try {
    const dept = req.params.department === 'global' ? '' : req.params.department;
    const { onConflict } = req.body;
    if (!['alternate', 'escalate', 'block'].includes(onConflict)) {
      return res.status(400).json({ error: "onConflict must be 'alternate', 'escalate', or 'block'" });
    }

    const policy = await ApprovalPolicy.findOneAndUpdate(
      { department: dept },
      { onConflict, updatedBy: req.user.id },
      { new: true, upsert: true }
    );

    await AuditLog.record({
      actorId:     req.user.id,
      actorRole:   req.user.role,
      workspace:   req.user.activeWorkspace || req.user.role,
      event:       'policy_updated',
      description: `Approval policy for dept '${dept || 'global'}' set to onConflict='${onConflict}'`,
      targetType:  'policy',
      targetId:    policy._id,
      meta:        { department: dept, onConflict },
    });

    res.json(policy);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/roles/policy/:department/alternate — add or update per-faculty alternate approver
 * Body: { facultyUserId, alternateHodUserId }
 */
router.post('/policy/:department/alternate', ...adminOnly, async (req, res) => {
  try {
    const dept = req.params.department === 'global' ? '' : req.params.department;
    const { facultyUserId, alternateHodUserId } = req.body;
    if (!facultyUserId || !alternateHodUserId) {
      return res.status(400).json({ error: 'facultyUserId and alternateHodUserId are required' });
    }

    const [faculty, altHod] = await Promise.all([
      User.findById(facultyUserId).select('name email'),
      User.findById(alternateHodUserId).select('name email'),
    ]);
    if (!faculty) return res.status(404).json({ error: 'Faculty user not found' });
    if (!altHod)  return res.status(404).json({ error: 'Alternate HOD user not found' });

    // Upsert the alternateApprovers entry
    let policy = await ApprovalPolicy.findOne({ department: dept });
    if (!policy) {
      policy = await ApprovalPolicy.create({ department: dept, onConflict: 'alternate', updatedBy: req.user.id });
    }

    const existingIdx = policy.alternateApprovers.findIndex(
      e => e.facultyUserId?.toString() === facultyUserId
    );
    const entry = { facultyUserId, alternateHodUserId, setBy: req.user.id, setAt: new Date() };

    if (existingIdx >= 0) {
      policy.alternateApprovers[existingIdx] = entry;
    } else {
      policy.alternateApprovers.push(entry);
    }
    await policy.save();

    await AuditLog.record({
      actorId:     req.user.id,
      actorRole:   req.user.role,
      workspace:   req.user.activeWorkspace || req.user.role,
      event:       'alternate_approver_assigned',
      description: `Alternate approver for faculty '${faculty.name}' set to HOD '${altHod.name}' in dept '${dept || 'global'}'`,
      targetType:  'policy',
      targetId:    policy._id,
      meta:        { facultyUserId, facultyName: faculty.name, alternateHodUserId, altHodName: altHod.name },
    });

    res.json({ message: 'Alternate approver set in policy', policy });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/roles/policy/:department/alternate/:facultyUserId — remove alternate approver entry
 */
router.delete('/policy/:department/alternate/:facultyUserId', ...adminOnly, async (req, res) => {
  try {
    const dept = req.params.department === 'global' ? '' : req.params.department;
    const policy = await ApprovalPolicy.findOne({ department: dept });
    if (!policy) return res.status(404).json({ error: 'Policy not found' });

    policy.alternateApprovers = policy.alternateApprovers.filter(
      e => e.facultyUserId?.toString() !== req.params.facultyUserId
    );
    await policy.save();

    res.json({ message: 'Alternate approver removed', policy });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
