const mongoose = require('mongoose');

const activityLogSchema = new mongoose.Schema({
  hodId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  type: { type: String, enum: ['csv_upload', 'pdf_processed', 'pdf_error', 'sent_to_faculty', 'sent_to_vc', 'faculty_approved', 'report_deleted', 'ai_analysis'], required: true },
  message: { type: String, required: true },
  metadata: { type: Object, default: {} },
  status: { type: String, enum: ['success', 'error', 'info'], default: 'info' }
}, { timestamps: true });

module.exports = mongoose.model('ActivityLog', activityLogSchema);
