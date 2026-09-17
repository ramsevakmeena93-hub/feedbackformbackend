const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  // Core identity
  name:         { type: String, required: true },
  email:        { type: String, required: true, unique: true },
  password:     { type: String, required: true },

  /**
   * Legacy single-role field — kept for backward compatibility.
   * New code should read roles from the UserRole collection.
   * This field is still used as the "primary" / "last-active" role
   * so existing queries don't break.
   */
  role:         { type: String, enum: ['hod', 'vc', 'faculty', 'admin'], default: 'hod' },
  department:   { type: String, default: '' },

  /**
   * Multi-role support:
   * Cached list of role names this user holds (populated from UserRole collection).
   * Backend always re-checks UserRole for authorization; this is a convenience cache.
   */
  roles: [{
    type: String,
    enum: ['hod', 'vc', 'faculty', 'admin'],
  }],

  /**
   * Active workspace — the role context the user is currently operating in.
   * Stored server-side so it survives page refreshes.
   * Values: 'hod' | 'faculty' | 'vc' | 'admin'
   */
  activeWorkspace: { type: String, enum: ['hod', 'vc', 'faculty', 'admin', ''], default: '' },

  /**
   * Alternate approver — when this user (as HOD) has a self-conflict,
   * route approvals to this user instead.
   * Overridden per-faculty by ApprovalPolicy.alternateApprovers.
   */
  defaultAlternateApproverId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null,
  },

  // Extended profile
  employeeId:   { type: String, default: '' },
  phone:        { type: String, default: '' },
  gender:       { type: String, enum: ['male', 'female', 'other', ''], default: '' },
  designation:  { type: String, default: '' },
  experience:   { type: String, default: '' },       // e.g. "5 years"
  qualification:{ type: String, default: '' },       // e.g. "PhD, M.Tech"
  bio:          { type: String, default: '' },
  cabin:        { type: String, default: '' },

  // Account status & session tracking
  status:       { type: String, enum: ['active', 'suspended', 'pending'], default: 'active' },
  lastLogin:    { type: Date },
  loginCount:   { type: Number, default: 0 },
  sessionTimeMinutes: { type: Number, default: 0 },

  // Online presence tracking
  isOnline:     { type: Boolean, default: false },
  lastSeen:     { type: Date, default: null },   // last time they were active / disconnected
  currentLoginAt: { type: Date, default: null }, // when current session started
  lastLeaveAt:    { type: Date, default: null }, // when they last went offline

  // Profile completion flag (used to prompt dept on first Google login)
  profileComplete: { type: Boolean, default: false },
  needsDeptSetup:  { type: Boolean, default: false }, // true for Google-auth users who skipped dept

  // Media
  profilePhoto:         { type: String, default: '' },  // base64 or URL
  signatureImage:       { type: String, default: '' },  // base64 PNG
  signatureUploadedAt:  { type: Date },
  signatureStatus:      { type: String, enum: ['pending', 'verified', 'rejected', ''], default: '' },

  // Google OAuth
  googleId:      { type: String, default: '' },
  googleVerified:{ type: Boolean, default: false },

}, { timestamps: true });

// Virtual: short employee ID derived from _id
userSchema.virtual('empId').get(function() {
  return this.employeeId || ('EMP' + this._id.toString().slice(-4).toUpperCase());
});

module.exports = mongoose.model('User', userSchema);
