/**
 * /api/assignments — teaching assignment management
 *
 * Admin can create / list / update / delete assignments.
 * Faculty/HOD can read their own assignments.
 *
 * Teaching assignments are deliberately separate from roles so that
 * an HOD can teach across multiple branches/sections without role changes.
 */
const express = require('express');
const router  = express.Router();

const TeachingAssignment = require('../models/TeachingAssignment');
const AuditLog           = require('../models/AuditLog');
const { authMiddleware, requireRole, requireAnyRole } = require('./middleware');

const adminOnly = [authMiddleware, requireRole('admin')];

// ─────────────────────────────────────────────────────────────────────────────
// Admin: full CRUD
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/assignments — list all assignments (admin)
 * Query params: facultyUserId, department, academicYear, active
 */
router.get('/', ...adminOnly, async (req, res) => {
  try {
    const filter = {};
    if (req.query.facultyUserId) filter.facultyUserId = req.query.facultyUserId;
    if (req.query.department)    filter.department    = req.query.department;
    if (req.query.academicYear)  filter.academicYear  = req.query.academicYear;
    if (req.query.active !== undefined) filter.active = req.query.active === 'true';

    const assignments = await TeachingAssignment.find(filter)
      .populate('facultyUserId', 'name email department role')
      .populate('createdBy', 'name email')
      .sort({ createdAt: -1 });
    res.json(assignments);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/assignments — create a new teaching assignment (admin)
 *
 * Body: {
 *   facultyUserId, subjectCode, subjectName?, programme?, branch?,
 *   section?, semester?, academicYear?, department?
 * }
 */
router.post('/', ...adminOnly, async (req, res) => {
  try {
    const {
      facultyUserId, subjectCode, subjectName = '',
      programme = '', branch = '', section = '',
      semester = '', academicYear = '', department = '',
    } = req.body;

    if (!facultyUserId || !subjectCode) {
      return res.status(400).json({ error: 'facultyUserId and subjectCode are required' });
    }

    const assignment = await TeachingAssignment.create({
      facultyUserId, subjectCode, subjectName,
      programme, branch, section, semester, academicYear, department,
      createdBy: req.user.id,
    });

    await AuditLog.record({
      actorId:     req.user.id,
      actorRole:   req.user.role,
      workspace:   req.user.activeWorkspace || req.user.role,
      event:       'teaching_assignment_created',
      description: `Teaching assignment created: ${subjectCode} → faculty ${facultyUserId} (${branch} Sec ${section})`,
      targetType:  'user',
      targetId:    facultyUserId,
      meta:        { subjectCode, branch, section, semester, academicYear, department },
    });

    const populated = await TeachingAssignment.findById(assignment._id)
      .populate('facultyUserId', 'name email department');
    res.status(201).json(populated);
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ error: 'This exact assignment already exists' });
    }
    res.status(500).json({ error: err.message });
  }
});

/** GET /api/assignments/:id — get a single assignment */
router.get('/:id', authMiddleware, requireAnyRole('admin', 'hod', 'faculty'), async (req, res) => {
  try {
    const a = await TeachingAssignment.findById(req.params.id)
      .populate('facultyUserId', 'name email department')
      .populate('createdBy', 'name email');
    if (!a) return res.status(404).json({ error: 'Assignment not found' });

    // Faculty/HOD can only see their own
    if (req.user.role !== 'admin') {
      if (a.facultyUserId?._id?.toString() !== req.user.id) {
        return res.status(403).json({ error: 'Access denied' });
      }
    }
    res.json(a);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** PATCH /api/assignments/:id — update an assignment (admin only) */
router.patch('/:id', ...adminOnly, async (req, res) => {
  try {
    const allowed = ['subjectCode','subjectName','programme','branch','section',
                     'semester','academicYear','department','active'];
    const update = {};
    for (const k of allowed) {
      if (req.body[k] !== undefined) update[k] = req.body[k];
    }
    const a = await TeachingAssignment.findByIdAndUpdate(req.params.id, update, { new: true })
      .populate('facultyUserId', 'name email');
    if (!a) return res.status(404).json({ error: 'Assignment not found' });
    res.json(a);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** DELETE /api/assignments/:id — delete assignment (admin only) */
router.delete('/:id', ...adminOnly, async (req, res) => {
  try {
    const a = await TeachingAssignment.findByIdAndDelete(req.params.id)
      .populate('facultyUserId', 'name email');
    if (!a) return res.status(404).json({ error: 'Assignment not found' });

    await AuditLog.record({
      actorId:     req.user.id,
      actorRole:   req.user.role,
      workspace:   req.user.activeWorkspace || req.user.role,
      event:       'teaching_assignment_removed',
      description: `Teaching assignment removed: ${a.subjectCode} from faculty ${a.facultyUserId?.name || a.facultyUserId}`,
      targetType:  'user',
      targetId:    a.facultyUserId?._id || a.facultyUserId,
      meta:        { subjectCode: a.subjectCode, branch: a.branch, section: a.section },
    });

    res.json({ message: 'Assignment deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Faculty / HOD: read own assignments
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/assignments/my/list — faculty/HOD gets their own active assignments
 * Query: academicYear, semester, active (default true)
 */
router.get('/my/list', authMiddleware, requireAnyRole('faculty', 'hod'), async (req, res) => {
  try {
    const filter = {
      facultyUserId: req.user.id,
      active: req.query.active === 'false' ? false : true,
    };
    if (req.query.academicYear) filter.academicYear = req.query.academicYear;
    if (req.query.semester)     filter.semester     = req.query.semester;

    const assignments = await TeachingAssignment.find(filter)
      .sort({ academicYear: -1, semester: 1, subjectCode: 1 });
    res.json(assignments);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/assignments/faculty/:facultyUserId — admin views assignments for a specific faculty
 */
router.get('/faculty/:facultyUserId', ...adminOnly, async (req, res) => {
  try {
    const assignments = await TeachingAssignment.find({ facultyUserId: req.params.facultyUserId })
      .populate('facultyUserId', 'name email department')
      .sort({ createdAt: -1 });
    res.json(assignments);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
