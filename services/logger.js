const SystemLog = require('../models/SystemLog');

async function log(level, source, message, meta = {}, stack = '') {
  try {
    await SystemLog.create({ level, source, message, stack, meta });
  } catch(e) {
    // Never crash the app due to logging failure
    console.error('[Logger] Failed to save log:', e.message);
  }
}

module.exports = {
  info:  (source, msg, meta) => log('info',  source, msg, meta),
  warn:  (source, msg, meta) => log('warn',  source, msg, meta),
  error: (source, msg, meta, stack) => log('error', source, msg, meta, stack),
};
