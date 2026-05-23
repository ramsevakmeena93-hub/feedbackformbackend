const mongoose = require('mongoose');

const systemLogSchema = new mongoose.Schema({
  level:     { type: String, enum: ['info','warn','error'], default: 'info' },
  source:    { type: String, default: 'system' }, // e.g. 'auth', 'pdf', 'ai', 'process'
  message:   { type: String, required: true },
  stack:     { type: String, default: '' },
  meta:      { type: Object, default: {} },       // extra context (userId, route, etc.)
  resolved:  { type: Boolean, default: false },
  resolvedBy:{ type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  resolvedAt:{ type: Date, default: null },
  resolution:{ type: String, default: '' },       // admin's note on how it was fixed
  aiSuggestion: { type: String, default: '' },    // AI-generated fix suggestion
}, { timestamps: true });

module.exports = mongoose.model('SystemLog', systemLogSchema);
