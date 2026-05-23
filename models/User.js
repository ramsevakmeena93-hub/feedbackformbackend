const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  role: { type: String, enum: ['hod', 'vc', 'faculty', 'admin'], default: 'hod' },
  department: { type: String },
  signatureImage: { type: String, default: '' }, // base64 PNG signature
  signatureUploadedAt: { type: Date }
}, { timestamps: true });

module.exports = mongoose.model('User', userSchema);
