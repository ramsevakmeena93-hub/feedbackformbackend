const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  // Core identity
  name:         { type: String, required: true },
  email:        { type: String, required: true, unique: true },
  password:     { type: String, required: true },
  role:         { type: String, enum: ['hod', 'vc', 'faculty', 'admin'], default: 'hod' },
  department:   { type: String, default: '' },

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
