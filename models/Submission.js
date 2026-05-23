const mongoose = require('mongoose');

const submissionSchema = new mongoose.Schema({
  hodId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  reports: [{ type: mongoose.Schema.Types.ObjectId, ref: 'FacultyReport' }],
  status: { type: String, enum: ['submitted', 'approved', 'rejected', 'reviewed'], default: 'submitted' },
  vcComment: { type: String, default: '' },
  department: { type: String, default: '' },
  academicYear: { type: String, default: '' },
  semester: { type: String, default: '' },
  session: { type: String, default: '' },           // "jul-dec" | "jan-may"
  feedbackFormNo: { type: String, default: 'I' },   // "I" | "II"
  submissionDate: { type: Date, default: null },     // date HOD submitted CSV
  finalReportDate: { type: Date, default: null },    // date VC approved
  submittedAt: { type: Date, default: Date.now }
}, { timestamps: true });

module.exports = mongoose.model('Submission', submissionSchema);
