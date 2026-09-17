const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret';

// ─────────────────────────────────────────────────────────────────────────────
// Core token verification
// ─────────────────────────────────────────────────────────────────────────────

/**
 * authMiddleware — verifies the Bearer JWT and attaches req.user.
 *
 * req.user shape after this middleware:
 * {
 *   id:              string  (MongoDB ObjectId)
 *   role:            string  (legacy primary role)
 *   roles:           string[]  (all roles this user holds — from JWT)
 *   activeWorkspace: string  (current workspace context — from JWT)
 * }
 *
 * The backend NEVER trusts frontend-supplied role values in the request body.
 * All authorization decisions use req.user which comes from the signed JWT.
 */
function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token provided' });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    // Normalise: ensure roles array is always present
    if (!req.user.roles) {
      req.user.roles = req.user.role ? [req.user.role] : [];
    }
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Legacy single-role guard (unchanged — keeps existing routes working)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * requireRole — checks the legacy single `role` field in the JWT.
 * Existing routes continue to use this; new routes use requireAnyRole.
 */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user?.role)) {
      return res.status(403).json({ error: 'Access denied' });
    }
    next();
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Multi-role guards
// ─────────────────────────────────────────────────────────────────────────────

/**
 * requireAnyRole — grants access if the user holds ANY of the listed roles.
 *
 * Checks BOTH req.user.role (legacy) AND req.user.roles[] (multi-role array)
 * so it works whether the token was issued by old or new auth code.
 *
 * Usage:
 *   router.post('/send', authMiddleware, requireAnyRole('hod'), ...)
 *   router.get('/report', authMiddleware, requireAnyRole('hod', 'faculty'), ...)
 */
function requireAnyRole(...allowedRoles) {
  return (req, res, next) => {
    const userRoles = new Set([
      ...(req.user?.roles || []),
      ...(req.user?.role ? [req.user.role] : []),
    ]);
    const hasRole = allowedRoles.some(r => userRoles.has(r));
    if (!hasRole) {
      return res.status(403).json({
        error: 'Access denied — insufficient role',
        required: allowedRoles,
        held: [...userRoles],
      });
    }
    next();
  };
}

/**
 * requireWorkspace — ensures the user's ACTIVE WORKSPACE matches the given workspace.
 *
 * This enforces that a user with both HOD and Faculty roles can only perform
 * HOD actions when they are in the HOD workspace, and Faculty actions when in
 * the Faculty workspace. The workspace is stored in the JWT (activeWorkspace field).
 *
 * IMPORTANT: requireAnyRole must run BEFORE requireWorkspace so req.user is set.
 *
 * Usage:
 *   router.post('/send', authMiddleware, requireAnyRole('hod'), requireWorkspace('hod'), ...)
 */
function requireWorkspace(...allowedWorkspaces) {
  return (req, res, next) => {
    const ws = req.user?.activeWorkspace;
    // If no workspace in token (old tokens) fall back to the legacy role value
    const effective = ws || req.user?.role || '';
    if (!allowedWorkspaces.includes(effective)) {
      return res.status(403).json({
        error: 'Action not permitted in your current workspace',
        currentWorkspace: effective,
        requiredWorkspace: allowedWorkspaces,
        hint: 'Switch to the correct workspace and try again.',
      });
    }
    next();
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Scope / relationship-based guards
// ─────────────────────────────────────────────────────────────────────────────

/**
 * requireDepartmentScope — verifies that a HOD is acting within their own department.
 *
 * Reads req.user.departmentScope (from JWT) and compares it to a value on
 * the target resource. Call this AFTER loading the resource into req.resource.
 *
 * Usage — attach the loaded resource first, then call this guard:
 *   req.resource = await FacultyReport.findById(id);
 *   requireDepartmentScope(req.resource.department)
 *
 * For VC / admin (global scope) the check is skipped.
 */
function requireDepartmentScope(resourceDepartment) {
  return (req, res, next) => {
    const role = req.user?.role;
    // VC and admin have global scope — always allowed
    if (role === 'vc' || role === 'admin') return next();

    const scope = req.user?.departmentScope || req.user?.department || '';
    if (!scope) return next(); // no scope in token — allow (old tokens)

    if (scope !== resourceDepartment) {
      return res.status(403).json({
        error: 'Access denied — resource is outside your department scope',
        yourDepartment: scope,
        resourceDepartment,
      });
    }
    next();
  };
}

/**
 * selfApprovalGuard — prevents a HOD from approving a submission where
 * they are also the evaluated faculty member.
 *
 * This is an async middleware factory. Pass the submission document.
 * If a conflict is found it returns 409 with conflict details;
 * the calling route handler should then invoke the alternate-approver logic.
 *
 * Returns { conflict: false } or { conflict: true, conflictingReportIds, reason }
 * via res.locals so the route can read it if needed.
 *
 * Usage:
 *   const guard = await checkSelfApprovalConflict(submission, req.user.id);
 *   if (guard.conflict) { ... handle conflict ... }
 */
async function checkSelfApprovalConflict(submission, hodUserId) {
  try {
    const FacultyReport = require('../models/FacultyReport');
    const User = require('../models/User');

    // Load the HOD's name for regex matching
    const hodUser = await User.findById(hodUserId).select('name').lean();
    if (!hodUser) return { conflict: false };

    const firstName = hodUser.name.split(' ')[0];
    const nameRegex = new RegExp(firstName, 'i');

    // Check each report in the submission
    const reportIds = submission.reports || [];
    const reports = await FacultyReport.find({ _id: { $in: reportIds } })
      .select('facultyUserId facultyName')
      .lean();

    const conflictingReports = reports.filter(r => {
      const matchesId   = r.facultyUserId?.toString() === hodUserId.toString();
      const matchesName = r.facultyName && nameRegex.test(r.facultyName.split(' ')[0]);
      return matchesId || matchesName;
    });

    if (conflictingReports.length === 0) return { conflict: false };

    return {
      conflict: true,
      conflictingReportIds: conflictingReports.map(r => r._id),
      conflictingFacultyNames: conflictingReports.map(r => r.facultyName),
      reason: `The approving HOD (${hodUser.name}) is also the evaluated faculty in ${conflictingReports.length} report(s): ${conflictingReports.map(r => r.facultyName).join(', ')}.`,
    };
  } catch (err) {
    console.error('[selfApprovalGuard] Error:', err.message);
    return { conflict: false }; // fail open — do not block on guard errors
  }
}

/**
 * resolveAlternateApprover — finds the correct alternate approver for a
 * self-conflict according to the department's ApprovalPolicy.
 *
 * Resolution order:
 *  1. ApprovalPolicy.alternateApprovers entry matching the specific faculty
 *  2. ApprovalPolicy global alternate for the department
 *  3. User.defaultAlternateApproverId on the conflicting HOD
 *  4. null (policy says 'escalate' or no alternate configured)
 *
 * Returns: { approverId, action: 'alternate'|'escalate'|'block', reason }
 */
async function resolveAlternateApprover(submission, conflictingFacultyUserIds, hodUserId) {
  try {
    const ApprovalPolicy = require('../models/ApprovalPolicy');
    const User = require('../models/User');

    const department = submission.department || '';

    // Load policy — department-specific first, then global default
    let policy = await ApprovalPolicy.findOne({ department }).lean();
    if (!policy) policy = await ApprovalPolicy.findOne({ department: '' }).lean();

    const onConflict = policy?.onConflict || 'alternate';

    if (onConflict === 'block') {
      return { approverId: null, action: 'block', reason: 'Approval policy for this department blocks self-approval conflicts.' };
    }

    if (onConflict === 'escalate') {
      return { approverId: null, action: 'escalate', reason: 'Approval policy requires admin escalation for self-approval conflicts.' };
    }

    // onConflict === 'alternate' — find the right alternate

    // 1. Check per-faculty entries in policy
    if (policy?.alternateApprovers?.length) {
      for (const fId of conflictingFacultyUserIds) {
        const entry = policy.alternateApprovers.find(
          e => e.facultyUserId?.toString() === fId?.toString()
        );
        if (entry?.alternateHodUserId) {
          return {
            approverId: entry.alternateHodUserId,
            action: 'alternate',
            reason: `Per-faculty alternate approver from department policy (faculty: ${fId}).`,
          };
        }
      }
    }

    // 2. Fall back to HOD's defaultAlternateApproverId
    const hod = await User.findById(hodUserId).select('defaultAlternateApproverId').lean();
    if (hod?.defaultAlternateApproverId) {
      return {
        approverId: hod.defaultAlternateApproverId,
        action: 'alternate',
        reason: 'HOD default alternate approver used.',
      };
    }

    // 3. No alternate found — escalate
    return {
      approverId: null,
      action: 'escalate',
      reason: 'No alternate approver configured. Escalating to admin.',
    };
  } catch (err) {
    console.error('[resolveAlternateApprover] Error:', err.message);
    return { approverId: null, action: 'escalate', reason: 'Error resolving alternate approver.' };
  }
}

module.exports = {
  authMiddleware,
  requireRole,
  requireAnyRole,
  requireWorkspace,
  requireDepartmentScope,
  checkSelfApprovalConflict,
  resolveAlternateApprover,
};
