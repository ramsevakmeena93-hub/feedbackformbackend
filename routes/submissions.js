const express = require('express');
const router = express.Router();
const Submission   = require('../models/Submission');
const FacultyReport = require('../models/FacultyReport');
const AuditLog     = require('../models/AuditLog');
const {
  authMiddleware,
  requireRole,
  requireAnyRole,
  requireWorkspace,
  checkSelfApprovalConflict,
  resolveAlternateApprover,
} = require('./middleware');

// ─────────────────────────────────────────────────────────────────────────────
// HOD: Send reports to VC
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /api/submissions/send
 *
 * Multi-role upgrade:
 *  1. HOD must be in the 'hod' workspace (requireWorkspace enforced)
 *  2. Self-approval conflict is detected BEFORE creating the submission
 *  3. If a conflict is found the alternate approver is resolved via policy
 *  4. Conflict details + alternateApproverId are stored on the Submission
 *  5. AuditLog entries are written for conflict detection + self-approval-prevented
 */
router.post('/send',
  authMiddleware,
  requireAnyRole('hod'),
  requireWorkspace('hod'),
  async (req, res) => {
    try {
      const { reportIds, academicYear, department, semester } = req.body;
      if (!reportIds?.length) return res.status(400).json({ error: 'No report IDs provided' });

      // Only load reports that belong to this HOD
      const reports = await FacultyReport.find({
        _id: { $in: reportIds },
        hodId: req.user.id,
      });

      if (reports.length === 0) return res.status(400).json({ error: 'No reports found' });

      // Enforce all-faculty-approved
      const notReady = reports.filter(r => r.status !== 'faculty_approved');
      if (notReady.length > 0) {
        return res.status(400).json({
          error: `${notReady.length} report(s) must be approved by faculty first.`,
          notApproved: notReady.map(r => ({ id: r._id, name: r.facultyName, status: r.status })),
        });
      }

      // ── Self-approval conflict check ──────────────────────────────────────
      const submissionDraft = { reports: reports.map(r => r._id), department: department || '' };
      const conflictCheck   = await checkSelfApprovalConflict(submissionDraft, req.user.id);

      let submissionStatus      = 'submitted';
      let alternateApproverId   = null;
      let conflictReason        = '';
      let conflictDetectedAt    = null;
      let escalatedAt           = null;

      if (conflictCheck.conflict) {
        // Log the conflict detection immediately
        await AuditLog.record({
          actorId:     req.user.id,
          actorRole:   req.user.role,
          workspace:   req.user.activeWorkspace || 'hod',
          event:       'conflict_detected',
          description: conflictCheck.reason,
          targetType:  'user',
          targetId:    req.user.id,
          meta: {
            conflictingReportIds:     conflictCheck.conflictingReportIds,
            conflictingFacultyNames:  conflictCheck.conflictingFacultyNames,
          },
        });

        // Self-approval prevention log
        await AuditLog.record({
          actorId:     req.user.id,
          actorRole:   req.user.role,
          workspace:   req.user.activeWorkspace || 'hod',
          event:       'self_approval_prevented',
          description: `HOD ${req.user.id} attempted to submit reports where they are also the evaluated faculty. Self-approval blocked.`,
          targetType:  'user',
          targetId:    req.user.id,
          meta:        { conflictingReportIds: conflictCheck.conflictingReportIds },
        });

        // Resolve alternate approver
        const resolution = await resolveAlternateApprover(
          submissionDraft,
          conflictCheck.conflictingReportIds.map(id => id.toString()),
          req.user.id
        );

        conflictReason     = conflictCheck.reason;
        conflictDetectedAt = new Date();

        if (resolution.action === 'block') {
          return res.status(409).json({
            error:  'Submission blocked: self-approval conflict detected',
            reason: conflictCheck.reason,
            policy: resolution.reason,
          });
        }

        if (resolution.action === 'escalate') {
          submissionStatus = 'escalated';
          escalatedAt      = new Date();

          await AuditLog.record({
            actorId:     req.user.id,
            actorRole:   req.user.role,
            workspace:   req.user.activeWorkspace || 'hod',
            event:       'conflict_escalated',
            description: `Submission escalated to admin due to self-approval conflict. Reason: ${resolution.reason}`,
            targetType:  'user',
            targetId:    req.user.id,
            meta:        { conflictReason: conflictCheck.reason },
          });
        }

        if (resolution.action === 'alternate' && resolution.approverId) {
          submissionStatus    = 'conflict';
          alternateApproverId = resolution.approverId;

          await AuditLog.record({
            actorId:     req.user.id,
            actorRole:   req.user.role,
            workspace:   req.user.activeWorkspace || 'hod',
            event:       'conflict_detected',
            description: `Self-conflict resolved via alternate approver (${resolution.approverId}). ${resolution.reason}`,
            targetType:  'user',
            targetId:    req.user.id,
            meta:        { alternateApproverId: resolution.approverId, conflictReason: conflictCheck.reason },
          });
        }
      }

      const submission = await Submission.create({
        hodId:              req.user.id,
        reports:            reports.map(r => r._id),
        academicYear:       academicYear || new Date().getFullYear().toString(),
        department:         department || req.user.department || '',
        semester:           semester || '',
        session:            req.body.session || '',
        feedbackFormNo:     req.body.feedbackFormNo || 'I',
        submissionDate:     req.body.submissionDate ? new Date(req.body.submissionDate) : new Date(),
        status:             submissionStatus,
        alternateApproverId,
        conflictReason,
        conflictDetectedAt,
        escalatedAt,
        submittedFromWorkspace: req.user.activeWorkspace || 'hod',
      });

      // Audit: submission sent
      await AuditLog.record({
        actorId:     req.user.id,
        actorRole:   req.user.role,
        workspace:   req.user.activeWorkspace || 'hod',
        event:       'submission_approved',  // using closest enum; status is 'submitted'
        description: `HOD submitted ${reports.length} report(s) to VC. Status: ${submissionStatus}`,
        targetType:  'submission',
        targetId:    submission._id,
        meta:        { reportCount: reports.length, status: submissionStatus },
      });

      res.json({
        message: conflictCheck.conflict
          ? `Reports submitted with conflict status: ${submissionStatus}`
          : 'Reports sent to VC successfully',
        submission,
        conflict: conflictCheck.conflict ? {
          detected:           true,
          status:             submissionStatus,
          reason:             conflictReason,
          alternateApproverId,
        } : { detected: false },
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// HOD: Get own submissions
// ─────────────────────────────────────────────────────────────────────────────

router.get('/my', authMiddleware, requireAnyRole('hod'), async (req, res) => {
  try {
    const submissions = await Submission.find({ hodId: req.user.id })
      .populate({
        path: 'reports',
        model: 'FacultyReport',
        select: 'facultyName subjectCode ffiScore status semester programme branch section appreciationCount attentionCount commentsNeedingAttention appreciation commentPercentages actionTaken hodRemarks driveLink academicYear responseCount totalResponses',
      })
      .populate('alternateApproverId', 'name email')
      .sort({ createdAt: -1 });
    res.json(submissions);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Faculty: Get approved submissions containing their reports
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Multi-role upgrade: faculty now matched by facultyUserId (exact) first,
 * then by name regex as fallback — same as before but also accepts the
 * new 'faculty' workspace requirement.
 */
router.get('/faculty', authMiddleware, requireAnyRole('faculty'), async (req, res) => {
  try {
    const User = require('../models/User');
    const user = await User.findById(req.user.id).select('name').lean();
    const firstName = user ? user.name.split(' ')[0] : null;
    const nameRegex = firstName ? new RegExp(firstName, 'i') : null;

    const submissions = await Submission.find({ status: 'approved' })
      .populate('hodId', 'name email department')
      .populate({
        path: 'reports',
        model: 'FacultyReport',
        select: 'facultyName subjectCode ffiScore status semester programme branch section appreciationCount attentionCount commentsNeedingAttention appreciation commentPercentages actionTaken hodRemarks driveLink academicYear facultyUserId responseCount totalResponses',
      });

    const filtered = submissions.map(sub => {
      const obj = sub.toObject();
      obj.reports = (obj.reports || []).filter(r => {
        if (!r) return false;
        const byId   = r.facultyUserId?.toString() === req.user.id.toString();
        const byName = nameRegex && r.facultyName && nameRegex.test(r.facultyName.split(' ')[0]);
        return byId || byName;
      });
      return obj;
    }).filter(s => s.reports.length > 0);

    res.json(filtered);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// VC: Get all submissions
// ─────────────────────────────────────────────────────────────────────────────

router.get('/all', authMiddleware, requireRole('vc'), async (req, res) => {
  try {
    const submissions = await Submission.find()
      .populate('hodId', 'name email department')
      .populate('alternateApproverId', 'name email')
      .populate({
        path: 'reports',
        model: 'FacultyReport',
        select: 'facultyName subjectCode ffiScore status appreciationCount attentionCount commentsNeedingAttention appreciation commentPercentages actionTaken hodRemarks driveLink responseCount totalResponses',
      })
      .sort({ createdAt: -1 });
    res.json(submissions);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// VC / alternate-approver: Update submission status
// ─────────────────────────────────────────────────────────────────────────────

/**
 * PATCH /api/submissions/:id/status
 *
 * Multi-role upgrade:
 *  - VC can approve any submission with status 'submitted'
 *  - Alternate approver (if set) can approve a 'conflict' submission
 *  - New status values: approved / rejected / sent_back / escalated
 *  - All transitions are written to AuditLog
 */
router.patch('/:id/status', authMiddleware, async (req, res) => {
  try {
    // Determine if caller is VC or an authorized alternate approver
    const callerRoles = new Set([
      ...(req.user?.roles || []),
      ...(req.user?.role ? [req.user.role] : []),
    ]);

    const isVC    = callerRoles.has('vc');
    const isAdmin = callerRoles.has('admin');

    if (!isVC && !isAdmin) {
      // Check if caller is the designated alternate approver for this submission
      const sub = await Submission.findById(req.params.id).select('alternateApproverId status');
      if (!sub) return res.status(404).json({ error: 'Submission not found' });

      const isAlternate = sub.alternateApproverId?.toString() === req.user.id.toString();
      if (!isAlternate) {
        return res.status(403).json({ error: 'Access denied — only VC or the designated alternate approver can update this submission' });
      }
      // Alternate can only act on 'conflict' submissions
      if (sub.status !== 'conflict') {
        return res.status(409).json({ error: `Submission is in '${sub.status}' state, not 'conflict'` });
      }
    }

    const { status, vcComment } = req.body;
    const allowedStatuses = ['approved', 'rejected', 'sent_back', 'escalated'];
    if (!allowedStatuses.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${allowedStatuses.join(', ')}` });
    }

    const updateData = {
      status,
      vcComment: vcComment || '',
      ...(status === 'approved'   ? { finalReportDate: new Date() } : {}),
      ...(status === 'escalated'  ? { escalatedAt: new Date() }     : {}),
    };

    const submission = await Submission.findByIdAndUpdate(
      req.params.id,
      updateData,
      { new: true }
    ).populate('hodId', 'name email department');

    if (!submission) return res.status(404).json({ error: 'Submission not found' });

    // ── Audit ───────────────────────────────────────────────────────────────
    const eventMap = {
      approved:  'submission_approved',
      rejected:  'submission_rejected',
      sent_back: 'submission_sent_back',
      escalated: 'submission_escalated',
    };

    await AuditLog.record({
      actorId:     req.user.id,
      actorRole:   req.user.role,
      workspace:   req.user.activeWorkspace || req.user.role,
      event:       eventMap[status] || 'submission_approved',
      description: `Submission ${submission._id} status changed to '${status}'. Comment: ${vcComment || 'N/A'}`,
      targetType:  'submission',
      targetId:    submission._id,
      meta:        { status, vcComment, hodId: submission.hodId?._id },
    });

    // ── Email notifications (existing logic preserved) ───────────────────────
    if (status === 'approved' || status === 'rejected') {
      try {
        const { emailHODVCApproved, emailHODVCRejected } = require('../services/emailService');
        if (status === 'approved') {
          await emailHODVCApproved({
            hodEmail:    submission.hodId.email,
            hodName:     submission.hodId.name,
            department:  submission.hodId.department || submission.department,
            academicYear: submission.academicYear,
            session:     submission.session,
            submissionId: submission._id,
          });
        } else {
          await emailHODVCRejected({
            hodEmail:   submission.hodId.email,
            hodName:    submission.hodId.name,
            department: submission.hodId.department || submission.department,
            academicYear: submission.academicYear,
            vcComment,
          });
        }
      } catch (emailErr) {
        console.warn('[Email] VC status email failed:', emailErr.message);
      }
    }

    // ── In-app notifications ─────────────────────────────────────────────────
    try {
      const Notification = require('../models/Notification');
      const User         = require('../models/User');

      if (status === 'approved') {
        await Notification.create({
          userId:       submission.hodId._id || submission.hodId,
          type:         'vc_approved',
          message:      `Your submission for Academic Year ${submission.academicYear || ''}, Session ${submission.session === 'jan-may' ? 'Jan-Jun' : 'Jul-Dec'} has been approved.`,
          submissionId: submission._id,
        });

        // Notify each faculty in the submission
        const rpts = await FacultyReport.find({ _id: { $in: submission.reports } });
        for (const rpt of rpts) {
          let fid = rpt.facultyUserId;
          if (!fid && rpt.facultyName) {
            const fu = await User.findOne({
              role: 'faculty',
              name: { $regex: rpt.facultyName.split(' ')[0], $options: 'i' },
            });
            if (fu) fid = fu._id;
          }
          if (fid) {
            await Notification.create({
              userId:       fid,
              type:         'vc_approved',
              message:      `Your feedback report for ${rpt.subjectCode || 'your subject'} is approved and available in History.`,
              reportId:     rpt._id,
              submissionId: submission._id,
            });
          }
        }
      } else if (status === 'rejected') {
        await Notification.create({
          userId:       submission.hodId._id || submission.hodId,
          type:         'vc_rejected',
          message:      `Your submission for ${submission.academicYear || ''} was rejected. Reason: ${vcComment || 'N/A'}`,
          submissionId: submission._id,
        });
      } else if (status === 'sent_back') {
        await Notification.create({
          userId:       submission.hodId._id || submission.hodId,
          type:         'vc_rejected',  // reuse existing type for notification routing
          message:      `Your submission was sent back for revision. Comment: ${vcComment || 'N/A'}`,
          submissionId: submission._id,
        });
      }
    } catch (notifErr) {
      console.error('[Notifications] Failed to create status notifications:', notifErr.message);
    }

    res.json(submission);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Download final PDF
// ─────────────────────────────────────────────────────────────────────────────

router.get('/:id/download-pdf', authMiddleware, async (req, res) => {
  try {
    const submission = await Submission.findById(req.params.id)
      .populate('hodId', 'name email department signatureImage')
      .populate({ path: 'reports', model: 'FacultyReport' });

    if (!submission) return res.status(404).json({ error: 'Submission not found' });
    if (submission.status !== 'approved') {
      return res.status(403).json({ error: 'PDF only available after approval' });
    }

    const User = require('../models/User');
    const vcUser = await User.findOne({ role: 'vc' }).select('name signatureImage');

    let reportDocs = submission.reports || [];
    if (reportDocs.length === 0 || typeof reportDocs[0] === 'string' || !reportDocs[0]?.facultyName) {
      reportDocs = await FacultyReport.find({ hodId: submission.hodId._id || submission.hodId });
    }

    // Faculty: only their own reports
    const callerRoles = new Set([
      ...(req.user?.roles || []),
      ...(req.user?.role ? [req.user.role] : []),
    ]);
    if (!callerRoles.has('vc') && !callerRoles.has('admin') && !callerRoles.has('hod')) {
      const u = await User.findById(req.user.id).select('name');
      const fn = u ? u.name.split(' ')[0] : null;
      const rx = fn ? new RegExp(fn, 'i') : null;
      reportDocs = reportDocs.filter(r => {
        if (!r) return false;
        return r.facultyUserId?.toString() === req.user.id || (rx && rx.test(r.facultyName?.split(' ')[0]));
      });
      if (reportDocs.length === 0) {
        return res.status(403).json({ error: 'You are not authorized to download this report' });
      }
    }

    // Semester filter
    const semFilter = req.query.semester;
    if (semFilter) reportDocs = reportDocs.filter(r => String(r.semester) === String(semFilter));
    if (reportDocs.length === 0) {
      return res.status(404).json({ error: `No reports found for semester ${semFilter}` });
    }

    const { generateFeedbackReportPDF } = require('../services/pdfGenerator');
    const pdfBuffer = await generateFeedbackReportPDF({
      submission, reports: reportDocs, hodUser: submission.hodId, vcUser, approvedAt: submission.updatedAt,
    });

    const semSuffix = semFilter ? `-sem${semFilter}` : '';
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="feedback-report-${submission._id}${semSuffix}.pdf"`);
    res.send(pdfBuffer);
  } catch (err) {
    console.error('[PDF Gen]', err.message, err.stack);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
