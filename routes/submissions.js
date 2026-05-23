const express = require('express');
const router = express.Router();
const Submission = require('../models/Submission');
const FacultyReport = require('../models/FacultyReport');
const { authMiddleware, requireRole } = require('./middleware');

// HOD: Send reports to VC
router.post('/send', authMiddleware, requireRole('hod'), async (req, res) => {
  try {
    const { reportIds, academicYear, department, semester, force } = req.body;
    if (!reportIds?.length) return res.status(400).json({ error: 'No report IDs provided' });

    const reports = await FacultyReport.find({
      _id: { $in: reportIds },
      hodId: req.user.id
    });

    if (reports.length === 0) return res.status(400).json({ error: 'No reports found' });

    // Check if all are faculty_approved — strictly enforced!
    const notReady = reports.filter(r => r.status !== 'faculty_approved');
    if (notReady.length > 0) {
      return res.status(400).json({
        error: `${notReady.length} report(s) must be approved by faculty first.`,
        notApproved: notReady.map(r => ({ id: r._id, name: r.facultyName, status: r.status }))
      });
    }

    const submission = await Submission.create({
      hodId: req.user.id,
      reports: reports.map(r => r._id),
      academicYear: academicYear || new Date().getFullYear().toString(),
      department: department || req.user.department || '',
      semester: semester || '',
      session: req.body.session || '',
      feedbackFormNo: req.body.feedbackFormNo || 'I',
      submissionDate: req.body.submissionDate ? new Date(req.body.submissionDate) : new Date(),
      status: 'submitted'
    });

    res.json({ message: 'Reports sent to VC successfully', submission });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// HOD: Get own submissions with VC status
router.get('/my', authMiddleware, requireRole('hod'), async (req, res) => {
  try {
    const submissions = await Submission.find({ hodId: req.user.id })
      .populate({
        path: 'reports',
        model: 'FacultyReport',
        select: 'facultyName subjectCode ffiScore status semester programme appreciationCount attentionCount commentsNeedingAttention appreciation commentPercentages actionTaken hodRemarks driveLink academicYear'
      })
      .sort({ createdAt: -1 });
    res.json(submissions);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Faculty: Get submissions that contain their own reports (only VC-approved submissions, and only return their own reports!)
router.get('/faculty', authMiddleware, requireRole('faculty'), async (req, res) => {
  try {
    const getFacultyName = async (userId) => {
      const User = require('../models/User');
      const user = await User.findById(userId).select('name');
      return user ? user.name.split(' ')[0] : null;
    };

    const firstName = await getFacultyName(req.user.id);
    const facultyNameRegex = firstName ? new RegExp(firstName, 'i') : null;

    // Find all approved submissions
    const submissions = await Submission.find({ status: 'approved' })
      .populate('hodId', 'name email department')
      .populate({
        path: 'reports',
        model: 'FacultyReport',
        select: 'facultyName subjectCode ffiScore status semester programme appreciationCount attentionCount commentsNeedingAttention appreciation commentPercentages actionTaken hodRemarks driveLink academicYear facultyUserId'
      });

    // For each submission, filter reports to only keep the faculty member's reports
    const filteredSubmissions = submissions.map(sub => {
      const subObj = sub.toObject();
      subObj.reports = (subObj.reports || []).filter(r => {
        if (!r) return false;
        const matchesUser = r.facultyUserId?.toString() === req.user.id.toString();
        const matchesName = facultyNameRegex && r.facultyName && facultyNameRegex.test(r.facultyName.split(' ')[0]);
        return matchesUser || matchesName;
      });
      return subObj;
    }).filter(sub => sub.reports.length > 0); // Only keep submissions that have at least one report for this faculty

    res.json(filteredSubmissions);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// VC: Get all submissions
router.get('/all', authMiddleware, requireRole('vc'), async (req, res) => {
  try {
    const submissions = await Submission.find()
      .populate('hodId', 'name email department')
      .populate({
        path: 'reports',
        model: 'FacultyReport',
        select: 'facultyName subjectCode ffiScore status appreciationCount attentionCount commentsNeedingAttention appreciation commentPercentages actionTaken hodRemarks driveLink'
      })
      .sort({ createdAt: -1 });
    res.json(submissions);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// VC: Update submission status + notify HOD & Faculty
router.patch('/:id/status', authMiddleware, requireRole('vc'), async (req, res) => {
  try {
    const { status, vcComment } = req.body;
    const submission = await Submission.findByIdAndUpdate(
      req.params.id,
      { status, vcComment, ...(status === 'approved' ? { finalReportDate: new Date() } : {}) },
      { new: true }
    ).populate('hodId', 'name email');
    if (!submission) return res.status(404).json({ error: 'Submission not found' });

    // Create notifications on VC update
    try {
      const Notification = require('../models/Notification');
      const User = require('../models/User');

      // 1. Notify HOD
      if (status === 'approved') {
        await Notification.create({
          userId: submission.hodId._id || submission.hodId,
          type: 'vc_approved',
          message: `VC has approved your submission for Academic Year ${submission.academicYear || ''}, Session ${submission.session === 'jan-may' ? 'Jan-May' : 'Aug-Dec'}.`,
          submissionId: submission._id
        });

        // 2. Notify all Faculty whose reports were in this submission!
        const reports = await FacultyReport.find({ _id: { $in: submission.reports } });
        for (const report of reports) {
          let facultyUserId = report.facultyUserId;
          // If facultyUserId is not linked, try name search
          if (!facultyUserId && report.facultyName) {
            const facultyUser = await User.findOne({
              role: 'faculty',
              name: { $regex: report.facultyName.split(' ')[0], $options: 'i' }
            });
            if (facultyUser) facultyUserId = facultyUser._id;
          }

          if (facultyUserId) {
            await Notification.create({
              userId: facultyUserId,
              type: 'vc_approved',
              message: `Your feedback report for ${report.subjectCode || 'your subject'} is approved by the VC and is now available in your History.`,
              reportId: report._id,
              submissionId: submission._id
            });
          }
        }
      } else if (status === 'rejected') {
        await Notification.create({
          userId: submission.hodId._id || submission.hodId,
          type: 'vc_rejected',
          message: `VC has rejected your submission for Academic Year ${submission.academicYear || ''}, Session ${submission.session === 'jan-may' ? 'Jan-May' : 'Aug-Dec'}. Reason: ${vcComment || 'N/A'}.`,
          submissionId: submission._id
        });
      }
    } catch (notifErr) {
      console.error('Failed to create VC update notifications:', notifErr);
    }

    res.json(submission);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Download final PDF after VC approval — supports ?semester=X for semester-wise download
router.get('/:id/download-pdf', authMiddleware, async (req, res) => {
  try {
    const submission = await Submission.findById(req.params.id)
      .populate('hodId', 'name email department signatureImage')
      .populate({ path:'reports', model:'FacultyReport' });

    if (!submission) return res.status(404).json({ error: 'Submission not found' });
    if (submission.status !== 'approved') return res.status(403).json({ error: 'PDF only available after VC approval' });

    const User = require('../models/User');
    const vcUser = await User.findOne({ role: 'vc' }).select('name signatureImage');

    // Load reports
    let reportDocs = submission.reports || [];
    if (reportDocs.length === 0 || typeof reportDocs[0] === 'string' || !reportDocs[0].facultyName) {
      reportDocs = await FacultyReport.find({ hodId: submission.hodId._id || submission.hodId });
      console.log('[PDF] Fallback: loaded', reportDocs.length, 'reports from DB');
    }

    // STRICT ROLE FILTER FOR FACULTY: If logged-in user is a faculty member, they can ONLY download their own report!
    if (req.user.role === 'faculty') {
      const getFacultyName = async (userId) => {
        const User = require('../models/User');
        const user = await User.findById(userId).select('name');
        return user ? user.name.split(' ')[0] : null;
      };
      const firstName = await getFacultyName(req.user.id);
      const facultyNameRegex = firstName ? new RegExp(firstName, 'i') : null;

      reportDocs = reportDocs.filter(r => {
        if (!r) return false;
        const matchesUser = r.facultyUserId?.toString() === req.user.id.toString();
        const matchesName = facultyNameRegex && r.facultyName && facultyNameRegex.test(r.facultyName.split(' ')[0]);
        return matchesUser || matchesName;
      });

      if (reportDocs.length === 0) {
        return res.status(403).json({ error: 'You are not authorized to download this report' });
      }
    }

    // Filter by semester if ?semester=X provided
    const semFilter = req.query.semester;
    if (semFilter) {
      reportDocs = reportDocs.filter(r => String(r.semester) === String(semFilter));
      console.log(`[PDF] Semester filter: ${semFilter} → ${reportDocs.length} reports`);
    }

    if (reportDocs.length === 0) {
      return res.status(404).json({ error: `No reports found for semester ${semFilter}` });
    }

    const { generateFeedbackReportPDF } = require('../services/pdfGenerator');

    const pdfBuffer = await generateFeedbackReportPDF({
      submission,
      reports: reportDocs,
      hodUser: submission.hodId,
      vcUser,
      approvedAt: submission.updatedAt
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
