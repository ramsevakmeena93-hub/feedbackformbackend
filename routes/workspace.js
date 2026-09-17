/**
 * /api/workspace — workspace context management
 *
 * POST /api/workspace/switch  — same as /api/auth/workspace/switch
 *   Kept as a separate mounted route so the frontend can use either URL.
 *
 * GET  /api/workspace/me      — returns the user's current workspace + all available workspaces
 */
const express = require('express');
const router  = express.Router();

const User     = require('../models/User');
const UserRole = require('../models/UserRole');
const AuditLog = require('../models/AuditLog');
const jwt      = require('jsonwebtoken');
const { authMiddleware } = require('./middleware');

const JWT_SECRET   = process.env.JWT_SECRET || 'dev_secret';
const TOKEN_EXPIRY = '7d';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers (duplicated from auth.js intentionally to keep this file self-contained)
// ─────────────────────────────────────────────────────────────────────────────

async function buildUserPayload(user) {
  const activeRoles = await UserRole.find({ userId: user._id, active: true })
    .select('role departmentScope')
    .lean();
  const rolesArray = [...new Set(activeRoles.map(r => r.role))];
  const PRIORITY   = ['admin', 'vc', 'hod', 'faculty'];
  const primaryRole = PRIORITY.find(r => rolesArray.includes(r)) || user.role || 'faculty';
  const activeWorkspace = user.activeWorkspace || primaryRole;

  return {
    id:                       user._id,
    name:                     user.name,
    email:                    user.email,
    role:                     primaryRole,
    roles:                    rolesArray.length ? rolesArray : [primaryRole],
    roleDetails:              activeRoles,
    activeWorkspace,
    department:               user.department || '',
    hasSignature:             !!user.signatureImage,
    profilePhoto:             user.profilePhoto || '',
    defaultAlternateApproverId: user.defaultAlternateApproverId || null,
  };
}

function signToken(user, roles, activeWorkspace) {
  return jwt.sign(
    {
      id:              user._id,
      role:            user.role,
      roles,
      activeWorkspace: activeWorkspace || user.role,
      department:      user.department || '',
      departmentScope: user.department || '',
    },
    JWT_SECRET,
    { expiresIn: TOKEN_EXPIRY }
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/workspace/me — current workspace + available workspaces
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns:
 * {
 *   activeWorkspace: 'hod',
 *   availableWorkspaces: ['hod', 'faculty'],   ← roles the user holds
 *   workspaceLabels: { hod: 'HOD Workspace', faculty: 'Faculty Workspace', ... }
 * }
 */
router.get('/me', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('name activeWorkspace role roles department');
    if (!user) return res.status(404).json({ error: 'User not found' });

    const activeRoles = await UserRole.find({ userId: user._id, active: true }).select('role departmentScope').lean();
    const rolesArray  = [...new Set(activeRoles.map(r => r.role))];

    const WORKSPACE_LABELS = {
      hod:     'HOD Workspace',
      faculty: 'Faculty Workspace',
      vc:      'VC Workspace',
      admin:   'Admin Workspace',
    };

    res.json({
      activeWorkspace:     user.activeWorkspace || user.role,
      availableWorkspaces: rolesArray,
      workspaceLabels:     WORKSPACE_LABELS,
      roleDetails:         activeRoles,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/workspace/switch — switch active workspace
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Body: { workspace: 'hod'|'faculty'|'vc'|'admin' }
 *
 * Security contract:
 *  1. The backend re-reads the user's active UserRole documents from MongoDB.
 *  2. If the requested workspace is not in that list → 403.
 *  3. Issues a brand-new JWT with the new activeWorkspace embedded.
 *  4. Persists activeWorkspace on the User document.
 *  5. Records AuditLog.
 *
 * The frontend MUST replace its stored token with the new one returned here.
 * All subsequent API calls use the new token so requireWorkspace guards work.
 */
router.post('/switch', authMiddleware, async (req, res) => {
  try {
    const { workspace } = req.body;
    if (!workspace) return res.status(400).json({ error: 'workspace is required' });

    // Always re-read from DB — never from request body
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const activeRoles = await UserRole.find({ userId: user._id, active: true }).select('role departmentScope');
    const rolesArray  = [...new Set(activeRoles.map(r => r.role))];

    if (!rolesArray.includes(workspace)) {
      return res.status(403).json({
        error: `You do not hold the '${workspace}' role and cannot switch to that workspace`,
        yourRoles: rolesArray,
      });
    }

    const previousWorkspace = user.activeWorkspace || user.role;
    await User.findByIdAndUpdate(user._id, { activeWorkspace: workspace });
    user.activeWorkspace = workspace;

    const payload = await buildUserPayload(user);
    const token   = signToken(user, rolesArray, workspace);

    await AuditLog.record({
      actorId:     user._id,
      actorName:   user.name,
      actorRole:   req.user.role,
      workspace,
      event:       'workspace_switch',
      description: `${user.name} switched workspace from '${previousWorkspace}' to '${workspace}'`,
      targetType:  'user',
      targetId:    user._id,
      meta: {
        from: previousWorkspace,
        to:   workspace,
        ip:   (req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim(),
      },
    });

    console.log(`[Workspace] ${user.name} switched: ${previousWorkspace} → ${workspace}`);
    res.json({ token, user: { ...payload, activeWorkspace: workspace } });
  } catch (err) {
    console.error('[Workspace] Switch error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
