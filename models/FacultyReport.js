const mongoose = require('mongoose');

const facultyReportSchema = new mongoose.Schema({
  hodId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  facultyUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }, // linked faculty account

  // Core fields (editable by HOD)
  facultyName: { type: String, default: '' },
  subjectCode: { type: String, default: '' },
  programme: { type: String, default: '' },
  semester: { type: String, default: '' },
  pdfLink: { type: String, default: '' },
  driveLink: { type: String, default: '' },

  // AI + color-based analysis
  appreciation: [{ type: String }],
  commentsNeedingAttention: [{ type: String }],
  appreciationCount: { type: Number, default: 0 },
  attentionCount: { type: Number, default: 0 },
  ffiScore: { type: Number, default: null },
  responseCount: { type: Number, default: null }, // Number of students who gave feedback
  commentPercentages: { type: Object, default: {} }, // { "Excellent": 10, "Very Good": 25, "Good": 65 }

  // HOD editable fields
  hodRemarks: { type: String, default: '' },
  actionTaken: { type: String, default: '' },  // HOD action taken comment
  goodComments: [{ type: String }],
  badComments: [{ type: String }],

  // Faculty acknowledgment
  facultyAcknowledged: { type: Boolean, default: false },
  facultyAcknowledgedAt: { type: Date },
  sentToFacultyAt: { type: Date },

  status: { type: String, enum: ['pending', 'processed', 'error', 'sent_to_faculty', 'faculty_approved'], default: 'pending' },
  errorMessage: { type: String },
  analyzedAt: { type: Date },
  academicYear: { type: String, default: () => new Date().getFullYear().toString() } // e.g. "2025"
}, { timestamps: true });

module.exports = mongoose.model('FacultyReport', facultyReportSchema);
