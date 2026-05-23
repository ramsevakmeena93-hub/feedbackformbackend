const express = require('express');
const router = express.Router();
const FacultyReport = require('../models/FacultyReport');
const { authMiddleware, requireRole } = require('./middleware');
const { testGeminiConnection, analyzeCommentsWithAI } = require('../services/aiAnalyzer');
const { log } = require('../services/logger');

// Helper: get faculty first name from DB for regex queries
async function getFacultyName(userId) {
  try {
    const User = require('../models/User');
    const user = await User.findById(userId).select('name');
    return user ? user.name.split(' ')[0] : null;
  } catch { return null; }
}

// Test AI connection
router.get('/ai/test', authMiddleware, async (req, res) => {
  const result = await testGeminiConnection();
  res.json(result);
});

// Re-analyze report using AI
router.post('/:id/ai-analyze', authMiddleware, async (req, res) => {
  try {
    const report = await FacultyReport.findOne({ _id: req.params.id, hodId: req.user.id });
    if (!report) return res.status(404).json({ error: 'Report not found' });
    const allComments = [...(report.appreciation || []), ...(report.commentsNeedingAttention || []), ...(req.body.extraComments || [])].filter(Boolean);
    if (allComments.length === 0) return res.status(400).json({ error: 'No comments to analyze' });
    const aiResult = await analyzeCommentsWithAI(allComments);
    const updated = await FacultyReport.findByIdAndUpdate(report._id, {
      appreciation: aiResult.appreciation,
      commentsNeedingAttention: aiResult.commentsNeedingAttention,
      appreciationCount: aiResult.appreciation.length,
      attentionCount: aiResult.commentsNeedingAttention.length
    }, { new: true });
    res.json({ report: updated, aiResult });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Fix metadata from PDFs
router.post('/my/fix-metadata', authMiddleware, async (req, res) => {
  try {
    const reports = await FacultyReport.find({ hodId: req.user.id, driveLink: { $exists: true, $ne: '' } });
    let fixed = 0;
    for (const report of reports) {
      try {
        const response = await require('axios').get(require('../services/pdfAnalyzer').convertDriveLink(report.driveLink), {
          responseType: 'arraybuffer', timeout: 30000, headers: { 'User-Agent': 'Mozilla/5.0' }, maxRedirects: 5
        });
        const meta = await require('../services/pdfAnalyzer').extractMetaFromPDF(Buffer.from(response.data));
        if (meta.facultyName) {
          await FacultyReport.findByIdAndUpdate(report._id, {
            facultyName: meta.facultyName,
            subjectCode: meta.subjectCode || report.subjectCode,
            programme: meta.programme || report.programme,
            semester: meta.semester || report.semester,
            ffiScore: meta.ffiScore ?? report.ffiScore
          });
          fixed++;
        }
      } catch {}
    }
    res.json({ fixed, total: reports.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete all reports for HOD that are NOT approved by faculty AND not approved by VC
router.delete('/my/all', authMiddleware, async (req, res) => {
  try {
    const Submission = require('../models/Submission');
    // Find all approved submissions for this HOD
    const approvedSubmissions = await Submission.find({ hodId: req.user.id, status: 'approved' });
    const approvedReportIds = approvedSubmissions.flatMap(sub => sub.reports.map(r => r.toString()));

    // Delete reports for this HOD that are NOT approved by faculty AND NOT in approvedReportIds
    const result = await FacultyReport.deleteMany({
      hodId: req.user.id,
      status: { $ne: 'faculty_approved' },
      _id: { $nin: approvedReportIds }
    });

    res.json({ deleted: result.deletedCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Bulk send multiple reports to faculty
router.post('/bulk-send-to-faculty', authMiddleware, async (req, res) => {
  try {
    const { reportIds } = req.body;
    if (!reportIds?.length) return res.status(400).json({ error: 'No report IDs provided' });
    const User = require('../models/User');
    let sent = 0;
    for (const reportId of reportIds) {
      const report = await FacultyReport.findOne({ _id: reportId, hodId: req.user.id });
      if (!report || report.status !== 'processed') continue;
      let facultyUserId = report.facultyUserId;
      if (!facultyUserId && report.facultyName) {
        const fu = await User.findOne({ role: 'faculty', name: { $regex: report.facultyName.split(' ')[0], $options: 'i' } });
        if (fu) facultyUserId = fu._id;
      }
      const updated = await FacultyReport.findByIdAndUpdate(report._id, { status: 'sent_to_faculty', sentToFacultyAt: new Date(), ...(facultyUserId ? { facultyUserId } : {}) }, { new: true });
      
      // Create notification
      if (facultyUserId) {
        try {
          const Notification = require('../models/Notification');
          await Notification.create({
            userId: facultyUserId,
            type: 'sent_to_faculty',
            message: `HOD has sent a feedback report for ${updated.subjectCode || 'your subject'} for your review. Please acknowledge it.`,
            reportId: updated._id
          });
        } catch {}
      }

      sent++;
    }
    res.json({ sent, total: reportIds.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Export reports as CSV
router.get('/my/export', authMiddleware, async (req, res) => {
  try {
    const reports = await FacultyReport.find({ hodId: req.user.id });
    const rows = [['S.No','Faculty Name','Subject Code','Programme','FFI Score','Appreciation','Attention','Status','Faculty Acknowledged','HOD Remarks','Action Taken','Year']];
    reports.forEach((r, i) => {
      rows.push([i+1, r.facultyName||'', r.subjectCode||'', r.programme||'', r.ffiScore?.toFixed(2)||'', r.appreciationCount||0, r.attentionCount||0, r.status||'', r.facultyAcknowledged?'Yes':'No', r.hodRemarks||'', r.actionTaken||'', r.academicYear||'']);
    });
    const csv = rows.map(row => row.map(c => `"${String(c).replace(/"/g,'""')}"`).join(',')).join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="feedback-reports.csv"');
    res.send(csv);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Send report to faculty — also links facultyUserId by name match
router.post('/:id/send-to-faculty', authMiddleware, async (req, res) => {
  try {
    const report = await FacultyReport.findOne({ _id: req.params.id, hodId: req.user.id });
    if (!report) return res.status(404).json({ error: 'Report not found' });

    // Try to find faculty user account by name match
    const User = require('../models/User');
    let facultyUserId = report.facultyUserId;
    if (!facultyUserId && report.facultyName) {
      const facultyUser = await User.findOne({
        role: 'faculty',
        name: { $regex: report.facultyName.split(' ')[0], $options: 'i' }
      });
      if (facultyUser) facultyUserId = facultyUser._id;
    }

    const updated = await FacultyReport.findByIdAndUpdate(
      report._id,
      {
        status: 'sent_to_faculty',
        sentToFacultyAt: new Date(),
        ...(facultyUserId ? { facultyUserId } : {})
      },
      { new: true }
    );

    // Create notification
    if (facultyUserId) {
      try {
        const Notification = require('../models/Notification');
        await Notification.create({
          userId: facultyUserId,
          type: 'sent_to_faculty',
          message: `HOD has sent your feedback report for ${updated.subjectCode || 'your subject'} for your review. Please acknowledge it.`,
          reportId: updated._id
        });
      } catch (err) {
        console.error('Failed to create faculty notification:', err);
      }
    }

    res.json(updated);
    log(req.user.id, 'sent_to_faculty', `Report sent to faculty: ${report.facultyName}`, { reportId: report._id }, 'success');
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update editable fields
router.patch('/:id/edit', authMiddleware, async (req, res) => {
  try {
    const { programme, semester, goodComments, badComments, hodRemarks, facultyName, subjectCode, status, actionTaken } = req.body;
    const update = {};
    if (programme !== undefined) update.programme = programme;
    if (semester !== undefined) update.semester = semester;
    if (goodComments !== undefined) update.goodComments = goodComments;
    if (badComments !== undefined) update.badComments = badComments;
    if (hodRemarks !== undefined) update.hodRemarks = hodRemarks;
    if (facultyName !== undefined) update.facultyName = facultyName;
    if (subjectCode !== undefined) update.subjectCode = subjectCode;
    if (actionTaken !== undefined) update.actionTaken = actionTaken;
    // Allow HOD to force-approve status
    if (status === 'faculty_approved') {
      update.status = 'faculty_approved';
      update.facultyAcknowledged = true;
      update.facultyAcknowledgedAt = new Date();
    }
    const report = await FacultyReport.findOneAndUpdate(
      { _id: req.params.id, hodId: req.user.id },
      update,
      { new: true }
    );
    if (!report) return res.status(404).json({ error: 'Report not found' });

    // Create notification for Faculty on force approval
    if (status === 'faculty_approved') {
      try {
        let facultyUserId = report.facultyUserId;
        if (!facultyUserId && report.facultyName) {
          const User = require('../models/User');
          const facultyUser = await User.findOne({
            role: 'faculty',
            name: { $regex: report.facultyName.split(' ')[0], $options: 'i' }
          });
          if (facultyUser) facultyUserId = facultyUser._id;
        }
        if (facultyUserId) {
          const Notification = require('../models/Notification');
          const User = require('../models/User');
          const hodUser = await User.findById(req.user.id).select('name');
          const hodName = hodUser ? hodUser.name : 'HOD';

          await Notification.create({
            userId: facultyUserId,
            type: 'hod_force_approved',
            message: `HOD ${hodName} has approved your feedback report for ${report.subjectCode || 'your subject'}. Reason: ${actionTaken || 'N/A'}`,
            reportId: report._id
          });
        }
      } catch (err) {
        console.error('Failed to create HOD force-approval notification:', err);
      }
    }

    res.json(report);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Faculty: Get advanced analytics (trend, peer comparison, recommendations)
router.get('/faculty/advanced-analytics', authMiddleware, async (req, res) => {
  try {
    const User = require('../models/User');
    const faculty = await User.findById(req.user.id);

    // All reports for this faculty (all time)
    const myReports = await FacultyReport.find({
      $or: [
        { facultyUserId: req.user.id },
        { facultyName: { $regex: (await getFacultyName(req.user.id)) || "__NO_MATCH__", $options: "i" } }
      ],
      status: { $in: ['sent_to_faculty', 'faculty_approved'] }
    }).sort({ createdAt: 1 });

    // FFI trend over time (semester by semester)
    const trendMap = {};
    myReports.forEach(r => {
      const key = `${r.academicYear || 'Unknown'}-Sem${r.semester || '?'}`;
      if (!trendMap[key]) trendMap[key] = { key, ffis: [], appreciation: 0, attention: 0 };
      if (r.ffiScore) trendMap[key].ffis.push(r.ffiScore);
      trendMap[key].appreciation += r.appreciationCount || 0;
      trendMap[key].attention += r.attentionCount || 0;
    });
    const trend = Object.values(trendMap).map(t => ({
      period: t.key,
      avgFFI: t.ffis.length ? parseFloat((t.ffis.reduce((s, v) => s + v, 0) / t.ffis.length).toFixed(2)) : 0,
      appreciation: t.appreciation,
      attention: t.attention
    }));

    // Improvement detection (compare last 2 periods)
    let improvement = null;
    if (trend.length >= 2) {
      const last = trend[trend.length - 1];
      const prev = trend[trend.length - 2];
      const diff = parseFloat((last.avgFFI - prev.avgFFI).toFixed(2));
      improvement = { diff, direction: diff > 0 ? 'up' : diff < 0 ? 'down' : 'same', from: prev.period, to: last.period };
    }

    // Peer comparison (anonymous — compare with dept average)
    const deptReports = await FacultyReport.find({
      hodId: { $in: myReports.map(r => r.hodId) },
      status: { $in: ['sent_to_faculty', 'faculty_approved'] },
      ffiScore: { $ne: null }
    });
    const deptAvgFFI = deptReports.length
      ? parseFloat((deptReports.reduce((s, r) => s + (r.ffiScore || 0), 0) / deptReports.length).toFixed(2))
      : 0;
    const myAvgFFI = myReports.filter(r => r.ffiScore).length
      ? parseFloat((myReports.filter(r => r.ffiScore).reduce((s, r) => s + r.ffiScore, 0) / myReports.filter(r => r.ffiScore).length).toFixed(2))
      : 0;

    // Teaching dimension analysis from comments
    const allAttention = myReports.flatMap(r => r.commentsNeedingAttention || []);
    const dimensions = {
      'Speed': allAttention.filter(c => /fast|slow|speed|quick/i.test(c)).length,
      'Clarity': allAttention.filter(c => /unclear|confus|understand|explain/i.test(c)).length,
      'Examples': allAttention.filter(c => /example|practical|application/i.test(c)).length,
      'Availability': allAttention.filter(c => /available|doubt|question|help/i.test(c)).length,
      'Material': allAttention.filter(c => /notes|material|slide|pdf|book/i.test(c)).length,
    };

    // Smart recommendations based on attention comments
    const recommendations = [];
    if (dimensions['Speed'] > 0) recommendations.push({ icon: '⏱️', title: 'Adjust Teaching Pace', desc: `${dimensions['Speed']} student(s) mentioned speed issues. Consider pausing more frequently for questions.` });
    if (dimensions['Clarity'] > 0) recommendations.push({ icon: '💡', title: 'Improve Explanation Clarity', desc: `${dimensions['Clarity']} student(s) had clarity concerns. Try using more visual aids and step-by-step explanations.` });
    if (dimensions['Examples'] > 0) recommendations.push({ icon: '📝', title: 'Add More Examples', desc: `${dimensions['Examples']} student(s) want more practical examples. Connect theory to real-world applications.` });
    if (dimensions['Material'] > 0) recommendations.push({ icon: '📚', title: 'Share Study Materials', desc: `${dimensions['Material']} student(s) mentioned materials. Consider sharing notes/slides before class.` });
    if (myAvgFFI >= 4.0) recommendations.push({ icon: '🌟', title: 'Maintain Excellence', desc: 'Your FFI is excellent! Keep up the great work and mentor junior faculty.' });
    if (recommendations.length === 0) recommendations.push({ icon: '✅', title: 'No Major Issues', desc: 'Students are satisfied with your teaching. Continue your current approach.' });

    res.json({ trend, improvement, deptAvgFFI, myAvgFFI, dimensions, recommendations, totalReports: myReports.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
router.get('/faculty/my', authMiddleware, async (req, res) => {
  try {
    const { year, semester } = req.query;
    const query = {
      $or: [
        { facultyUserId: req.user.id },
        { facultyName: { $regex: (await getFacultyName(req.user.id)) || "__NO_MATCH__", $options: "i" }, status: { $in: ['sent_to_faculty', 'faculty_approved'] } }
      ]
    };
    if (year) query.academicYear = year;
    if (semester) query.semester = semester;

    const reports = await FacultyReport.find(query).sort({ createdAt: -1 });
    res.json(reports);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Faculty: Get analysis summary (year/semester wise)
router.get('/faculty/analysis', authMiddleware, async (req, res) => {
  try {
    const { year, semester } = req.query;
    const matchQuery = {
      $or: [
        { facultyUserId: req.user.id },
        { facultyName: { $regex: (await getFacultyName(req.user.id)) || "__NO_MATCH__", $options: "i" } }
      ],
      status: { $in: ['sent_to_faculty', 'faculty_approved'] }
    };
    if (year) matchQuery.academicYear = year;
    if (semester) matchQuery.semester = semester;

    const reports = await FacultyReport.find(matchQuery);

    if (reports.length === 0) return res.json({ reports: [], summary: null });

    // Calculate analysis
    const totalReports = reports.length;
    const avgFFI = reports.reduce((s, r) => s + (r.ffiScore || 0), 0) / totalReports;
    const totalAppreciation = reports.reduce((s, r) => s + (r.appreciationCount || 0), 0);
    const totalAttention = reports.reduce((s, r) => s + (r.attentionCount || 0), 0);

    // FFI trend by subject
    const ffiBySubject = reports.map(r => ({
      subject: r.subjectCode || r.programme || 'Unknown',
      ffi: r.ffiScore || 0,
      semester: r.semester,
      year: r.academicYear
    }));

    // Performance grade
    let grade = 'C';
    if (avgFFI >= 4.5) grade = 'A+';
    else if (avgFFI >= 4.0) grade = 'A';
    else if (avgFFI >= 3.5) grade = 'B+';
    else if (avgFFI >= 3.0) grade = 'B';
    else if (avgFFI >= 2.5) grade = 'C+';

    // Available years and semesters for filter
    const allReports = await FacultyReport.find({
      $or: [
        { facultyUserId: req.user.id },
        { facultyName: { $regex: (await getFacultyName(req.user.id)) || "__NO_MATCH__", $options: "i" } }
      ]
    }).select('academicYear semester');

    const years = [...new Set(allReports.map(r => r.academicYear).filter(Boolean))].sort().reverse();
    const semesters = [...new Set(allReports.map(r => r.semester).filter(Boolean))].sort();

    // Comment percentage aggregation
    const allAppreciation = reports.flatMap(r => r.appreciation || []);
    const commentPcts = {};
    const KEYWORDS = { 'Excellent': ['excellent', 'outstanding'], 'Very Good': ['very good', 'very well'], 'Good': ['good', 'great', 'nice'] };
    allAppreciation.forEach(c => {
      const lower = c.toLowerCase();
      for (const [label, kws] of Object.entries(KEYWORDS)) {
        if (kws.some(k => lower.includes(k))) { commentPcts[label] = (commentPcts[label] || 0) + 1; break; }
      }
    });
    const total = Object.values(commentPcts).reduce((s, v) => s + v, 0);
    const commentPercentages = total > 0
      ? Object.fromEntries(Object.entries(commentPcts).map(([k, v]) => [k, Math.round((v / total) * 100)]))
      : {};

    res.json({
      reports,
      summary: {
        totalReports,
        avgFFI: parseFloat(avgFFI.toFixed(2)),
        totalAppreciation,
        totalAttention,
        grade,
        ffiBySubject,
        commentPercentages,
        years,
        semesters
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Faculty: Acknowledge report
router.post('/:id/acknowledge', authMiddleware, async (req, res) => {
  try {
    const report = await FacultyReport.findByIdAndUpdate(
      req.params.id,
      { facultyAcknowledged: true, facultyAcknowledgedAt: new Date(), status: 'faculty_approved' },
      { new: true }
    );
    if (!report) return res.status(404).json({ error: 'Report not found' });

    // Create notification for HOD
    try {
      const Notification = require('../models/Notification');
      await Notification.create({
        userId:   report.hodId,
        type:     'faculty_approved',
        message:  `${report.facultyName || 'Faculty'} has approved their feedback report (${report.subjectCode || ''})`,
        reportId: report._id,
      });
    } catch {}

    res.json(report);
    log(report.hodId, 'faculty_approved', `Faculty acknowledged: ${report.facultyName}`, { reportId: report._id }, 'success');
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get all reports for HOD
router.get('/my', authMiddleware, async (req, res) => {
  try {
    const { status, search } = req.query;
    const query = { hodId: req.user.id };
    if (status) query.status = status;
    if (search) {
      query.$or = [
        { facultyName: { $regex: search, $options: 'i' } },
        { subjectCode: { $regex: search, $options: 'i' } }
      ];
    }
    const reports = await FacultyReport.find(query).sort({ createdAt: -1 });
    res.json(reports);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get single report
router.get('/:id', authMiddleware, async (req, res) => {
  try {
    const report = await FacultyReport.findById(req.params.id);
    if (!report) return res.status(404).json({ error: 'Report not found' });
    res.json(report);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update HOD remarks
router.patch('/:id/remarks', authMiddleware, async (req, res) => {
  try {
    const { hodRemarks } = req.body;
    const report = await FacultyReport.findOneAndUpdate(
      { _id: req.params.id, hodId: req.user.id },
      { hodRemarks },
      { new: true }
    );
    if (!report) return res.status(404).json({ error: 'Report not found' });
    res.json(report);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// VC: get submission reports
router.get('/submission/:submissionId', authMiddleware, requireRole('vc'), async (req, res) => {
  try {
    const Submission = require('../models/Submission');
    const submission = await Submission.findById(req.params.submissionId)
      .populate('hodId', 'name email department')
      .populate({
        path: 'reports',
        model: 'FacultyReport',
        select: 'facultyName subjectCode programme semester ffiScore appreciationCount attentionCount status commentsNeedingAttention appreciation commentPercentages actionTaken hodRemarks driveLink academicYear'
      });
    if (!submission) return res.status(404).json({ error: 'Submission not found' });

    // Deduplicate reports by _id
    const seen = new Set();
    const uniqueReports = (submission.reports || []).filter(r => {
      if (!r || !r._id) return false; // skip null/unpopulated
      const key = r._id?.toString();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    res.json({ ...submission.toObject(), reports: uniqueReports });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;


