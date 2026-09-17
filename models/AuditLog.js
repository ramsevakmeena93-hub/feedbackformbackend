const mongoose = require('mongoose');

/**
 * AuditLog — immutable append-only record of all security/authorization events.
 *
 * Events recorded:
 *  role_granted, role_revoked
 *  workspace_switch
 *  approval_approved, approval_denied, approval_sent_back
 *  conflict_detected, conflict_escalated, conflict_resolved
 *  self_approval_prevented
 *  alternate_approver_assigned
 *  teaching_assignment_created, teaching_assignment_removed
 *  policy_updated
 *  submission_approved, submission_rejected
 */
const auditLogSchema = new mongoose.Schema({
  /** Who performed the action */
  actorId:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  actorName: { type: String, default: '' },
  actorRole: { type: String, default: '' },   // role they were acting in at the time

  /** The workspace they were in when the action was taken */
  workspace: { type: String, default: '' },   // 'hod', 'faculty', 'vc', 'admin'

  /** Event type */
  event: {
    type: String,
    required: true,
    enum: [
      'role_granted',
      'role_revoked',
      'workspace_switch',
      'approval_approved',
      'approval_denied',
      'approval_sent_back',
      'conflict_detected',
      'conflict_escalated',
      'conflict_resolved',
      'self_approval_prevented',
      'alternate_approver_assigned',
      'teaching_assignment_created',
      'teaching_assignment_removed',
      'policy_updated',
      'submission_approved',
      'submission_rejected',
      'submission_sent_back',
      'submission_escalated',
    ],
    index: true,
  },

  /** Free-text description */
  description: { type: String, default: '' },

  /** The target entity (could be a userId, submissionId, reportId, etc.) */
  targetType: { type: String, default: '' },  // 'user', 'submission', 'report', 'policy'
  targetId:   { type: mongoose.Schema.Types.ObjectId, default: null },

  /** Extra structured data for this event */
  meta: { type: Object, default: {} },

  /** IP address (if available) */
  ip: { type: String, default: '' },

}, {
  timestamps: true,
  // Never allow updates — audit logs are append-only
  strict: true,
});

// Prevent accidental updates (no findByIdAndUpdate, etc.)
auditLogSchema.pre('findOneAndUpdate', function() {
  throw new Error('AuditLog is append-only — updates are not allowed');
});
auditLogSchema.pre('updateOne', function() {
  throw new Error('AuditLog is append-only — updates are not allowed');
});
auditLogSchema.pre('updateMany', function() {
  throw new Error('AuditLog is append-only — updates are not allowed');
});

// Convenience static to create an entry
auditLogSchema.statics.record = async function(data) {
  try {
    return await this.create(data);
  } catch (err) {
    // Audit log failures must never crash the main flow
    console.error('[AuditLog] Failed to record:', err.message);
    return null;
  }
};

module.exports = mongoose.model('AuditLog', auditLogSchema);
