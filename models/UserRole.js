const mongoose = require('mongoose');

/**
 * UserRole — assigns a role to a user with optional department/programme scope.
 * One user can have many UserRole documents (one per role they hold).
 *
 * Example: Prof. Sharma is both HOD of CSE and a Faculty member.
 * → UserRole { userId, role:'hod',     departmentScope:'CSE' }
 * → UserRole { userId, role:'faculty', departmentScope:'CSE' }
 */
const userRoleSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },

  /** Role name — must align with the legacy enum values */
  role: {
    type: String,
    enum: ['hod', 'faculty', 'vc', 'admin'],
    required: true,
  },

  /**
   * Scope — which department this role applies to.
   * For VC / admin leave blank (global scope).
   * For HOD / Faculty fill with department name.
   */
  departmentScope: { type: String, default: '' },

  /** Active flag — admin can deactivate a role without deleting it */
  active: { type: Boolean, default: true },

  /** Who granted this role (audit trail) */
  grantedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  grantedAt:  { type: Date, default: Date.now },

  /** Who revoked (if revoked) */
  revokedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  revokedAt:  { type: Date, default: null },

}, { timestamps: true });

// Compound unique: one entry per user-role-department combination
userRoleSchema.index({ userId: 1, role: 1, departmentScope: 1 }, { unique: true });

module.exports = mongoose.model('UserRole', userRoleSchema);
