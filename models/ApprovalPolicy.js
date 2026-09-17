const mongoose = require('mongoose');

/**
 * ApprovalPolicy — department-level configurable rules for approvals.
 *
 * One policy per department (or a global default with department:'').
 * Controls:
 *  - Who approves by default (the assigned HOD)
 *  - What happens on self-conflict (escalate vs. alternate)
 *  - Who the alternate approver is for a given faculty
 */
const alternateApproverEntrySchema = new mongoose.Schema({
  /** The faculty whose reports might create a self-conflict */
  facultyUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },

  /** The HOD who will approve instead when conflict occurs */
  alternateHodUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },

  /** Who set this alternate (for audit) */
  setBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  setAt:  { type: Date, default: Date.now },
}, { _id: true });

const approvalPolicySchema = new mongoose.Schema({
  /** Department this policy applies to. Empty string = global default. */
  department: { type: String, default: '', unique: true },

  /**
   * onConflict — what to do when the approving HOD is also the evaluated faculty.
   * 'alternate'  → automatically route to alternateHodUserId
   * 'escalate'   → set submission status = 'escalated', notify admin
   * 'block'      → reject the submission with explanation
   */
  onConflict: {
    type: String,
    enum: ['alternate', 'escalate', 'block'],
    default: 'alternate',
  },

  /** Per-faculty alternate approver map */
  alternateApprovers: [alternateApproverEntrySchema],

  /** Updated by */
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

}, { timestamps: true });

module.exports = mongoose.model('ApprovalPolicy', approvalPolicySchema);
