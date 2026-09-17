/**
 * /api/audit — read-only audit log access
 *
 * Admin can query the full audit log.
 * Regular users can only see their own entries.
 */
const express = require('express');
const router  = express.Router();

const AuditLog = require('../models/AuditLog');
const { authMiddleware, requireRole } = require('./middleware');

// ─────────────────────────────────────────────────────────────────────────────
// Admin: full audit log
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/audit — paginated, filterable audit log (admin only)
 *
 * Query params:
 *   page       (default 1)
 *   limit      (default 50, max 200)
 *   event      — filter by event type
 *   actorId    — filter by actor
 *   targetId   — filter by target entity
 *   workspace  — filter by workspace
 *   from       — ISO date string (createdAt >=)
 *   to         — ISO date string (createdAt <=)
 *   search     — text search in description
 */
router.get('/', authMiddleware, requireRole('admin'), async (req, res) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page)  || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50));
    const skip  = (page - 1) * limit;

    const filter = {};
    if (req.query.event)     filter.event     = req.query.event;
    if (req.query.actorId)   filter.actorId   = req.query.actorId;
    if (req.query.targetId)  filter.targetId  = req.query.targetId;
    if (req.query.workspace) filter.workspace = req.query.workspace;
    if (req.query.from || req.query.to) {
      filter.createdAt = {};
      if (req.query.from) filter.createdAt.$gte = new Date(req.query.from);
      if (req.query.to)   filter.createdAt.$lte = new Date(req.query.to);
    }
    if (req.query.search) {
      filter.description = { $regex: req.query.search, $options: 'i' };
    }

    const [entries, total] = await Promise.all([
      AuditLog.find(filter)
        .populate('actorId', 'name email')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      AuditLog.countDocuments(filter),
    ]);

    res.json({
      entries,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/audit/my — current user's own audit entries (any authenticated user)
 *
 * Useful for a user to see their own workspace switches, approvals, etc.
 */
router.get('/my', authMiddleware, async (req, res) => {
  try {
    const limit = Math.min(100, parseInt(req.query.limit) || 30);
    const entries = await AuditLog.find({ actorId: req.user.id })
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();
    res.json(entries);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/audit/events — list of all valid event type values (for filter UI)
 */
router.get('/events', authMiddleware, requireRole('admin'), async (req, res) => {
  const events = [
    'role_granted', 'role_revoked',
    'workspace_switch',
    'approval_approved', 'approval_denied', 'approval_sent_back',
    'conflict_detected', 'conflict_escalated', 'conflict_resolved',
    'self_approval_prevented',
    'alternate_approver_assigned',
    'teaching_assignment_created', 'teaching_assignment_removed',
    'policy_updated',
    'submission_approved', 'submission_rejected', 'submission_sent_back', 'submission_escalated',
  ];
  res.json(events);
});

/**
 * GET /api/audit/stats — summary counts grouped by event type (admin)
 */
router.get('/stats', authMiddleware, requireRole('admin'), async (req, res) => {
  try {
    const stats = await AuditLog.aggregate([
      { $group: { _id: '$event', count: { $sum: 1 }, latest: { $max: '$createdAt' } } },
      { $sort: { count: -1 } },
    ]);
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/audit/submission/:submissionId — all audit entries for a specific submission (admin)
 */
router.get('/submission/:submissionId', authMiddleware, requireRole('admin'), async (req, res) => {
  try {
    const entries = await AuditLog.find({ targetId: req.params.submissionId })
      .populate('actorId', 'name email')
      .sort({ createdAt: 1 })
      .lean();
    res.json(entries);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
