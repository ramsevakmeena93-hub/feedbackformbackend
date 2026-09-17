const mongoose = require('mongoose');

const submissionSchema = new mongoose.Schema({
  hodId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  reports: [{ type: mongoose.Schema.Types.ObjectId, ref: 'FacultyReport' }],

  /**
   * Approval status — extended state machine:
   *
   *  submitted   → initial state when HOD sends to VC
   *  pending     → synonym for submitted (alias kept for clarity in multi-HOD flow)
   *  approved    → VC/approver accepted
   *  rejected    → VC/approver rejected (terminal for this version)
   *  reviewed    → legacy alias for approved
   *  sent_back   → returned to HOD with comments for revision
   *  conflict    → self-approval conflict detected, awaiting resolution
   *  escalated   → conflict could not be auto-resolved; admin intervention needed
   */
  status: {
    type: String,
    enum: ['submitted', 'pending', 'approved', 'rejected', 'reviewed', 'sent_back', 'conflict', 'escalated'],
    default: 'submitted',
  },

  vcComment: { type: String, default: '' },
  department: { type: String, default: '' },
  academicYear: { type: String, default: '' },
  semester: { type: String, default: '' },
  session: { type: String, default: '' },           // "jul-dec" | "jan-may"
  feedbackFormNo: { type: String, default: 'I' },   // "I" | "II"
  submissionDate: { type: Date, default: null },     // date HOD submitted CSV
  finalReportDate: { type: Date, default: null },    // date VC / approver approved
  submittedAt: { type: Date, default: Date.now },

  // ── Multi-role approval fields ──────────────────────────────────────

  /**
   * The user who will actually approve this submission.
   * Normally the VC, but can be an alternate HOD if the primary HOD has a
   * self-conflict (i.e., the HOD is also the evaluated faculty).
   */
  approverId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

  /**
   * The alternate approver selected when a self-conflict was detected.
   * Populated by the backend conflict-resolution logic; never set by the client.
   */
  alternateApproverId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

  /**
   * Human-readable description of why a conflict was detected.
   * e.g. "Submitting HOD is also the evaluated faculty for report <id>"
   */
  conflictReason: { type: String, default: '' },

  /**
   * When the conflict was first detected (for SLA tracking).
   */
  conflictDetectedAt: { type: Date, default: null },

  /**
   * When an escalation was raised (status = 'escalated').
   */
  escalatedAt: { type: Date, default: null },

  /**
   * Workspace context the submitting HOD was in when they created this.
   * Recorded for audit purposes.
   */
  submittedFromWorkspace: { type: String, default: 'hod' },

}, { timestamps: true });

module.exports = mongoose.model('Submission', submissionSchema);
