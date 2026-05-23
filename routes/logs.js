const express = require('express');
const router = express.Router();
const ActivityLog = require('../models/ActivityLog');
const { authMiddleware } = require('./middleware');

// Get logs for HOD (paginated)
router.get('/my', authMiddleware, async (req, res) => {
  try {
    const { page = 1, limit = 50, type, status } = req.query;
    const query = { hodId: req.user.id };
    if (type) query.type = type;
    if (status) query.status = status;

    const logs = await ActivityLog.find(query)
      .sort({ createdAt: -1 })
      .limit(parseInt(limit))
      .skip((parseInt(page) - 1) * parseInt(limit));

    const total = await ActivityLog.countDocuments(query);
    res.json({ logs, total, page: parseInt(page) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Clear all logs for HOD
router.delete('/my', authMiddleware, async (req, res) => {
  try {
    const result = await ActivityLog.deleteMany({ hodId: req.user.id });
    res.json({ deleted: result.deletedCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
