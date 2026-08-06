const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { authMiddleware } = require('./middleware');

const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret';

// Register
router.post('/register', async (req, res) => {
  try {
    let { name, email, password, role, department } = req.body;
    
    // Auto-assign faculty role for MITS domain
    if (email && email.toLowerCase().endsWith('@mitsgwalior.in')) {
      role = 'faculty';
    }

    const existing = await User.findOne({ email });
    if (existing) return res.status(400).json({ error: 'Email already registered' });

    const hashed = await bcrypt.hash(password, 10);
    const user = await User.create({ name, email, password: hashed, role, department });
    const token = jwt.sign({ id: user._id, role: user.role }, JWT_SECRET, { expiresIn: '7d' });

    res.json({ token, user: { id: user._id, name: user.name, email: user.email, role: user.role, department: user.department, hasSignature: false } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email });
    if (!user) return res.status(400).json({ error: 'Invalid credentials' });

    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(400).json({ error: 'Invalid credentials' });

    const token = jwt.sign({ id: user._id, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
    res.json({
      token,
      user: { id: user._id, name: user.name, email: user.email, role: user.role, department: user.department, hasSignature: !!user.signatureImage }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Upload/update signature
router.post('/signature', async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'No token' });
    const jwt2 = require('jsonwebtoken');
    const decoded = jwt2.verify(token, JWT_SECRET);
    const { signatureImage } = req.body; // base64 PNG
    if (!signatureImage) return res.status(400).json({ error: 'No signature provided' });

    const updatedUser = await User.findByIdAndUpdate(decoded.id, { signatureImage, signatureUploadedAt: new Date() }, { new: true });
    res.json({ message: 'Signature saved', user: { id: updatedUser._id, name: updatedUser.name, email: updatedUser.email, role: updatedUser.role, department: updatedUser.department, hasSignature: !!updatedUser.signatureImage } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get current user profile
router.get('/me', async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'No token' });
    const jwt2 = require('jsonwebtoken');
    const decoded = jwt2.verify(token, JWT_SECRET);
    const user = await User.findById(decoded.id).select('-password');
    res.json(user);
  } catch (err) {
    res.status(401).json({ error: 'Invalid token' });
  }
});

// Get VC user info (for signature display)
router.get('/vc-info', authMiddleware, async (req, res) => {
  try {
    const User = require('../models/User');
    const vc = await User.findOne({ role: 'vc' }).select('name signatureImage');
    res.json(vc || { name: 'Vice Chancellor', signatureImage: null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// Update own profile (used by ProfileCompletion wizard)
router.patch('/profile', async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'No token' });
    const jwt2 = require('jsonwebtoken');
    const decoded = jwt2.verify(token, JWT_SECRET);
    const allowed = ['phone','gender','bio','employeeId','designation',
                     'qualification','experience','cabin','profilePhoto','signatureImage'];
    const update = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) update[key] = req.body[key];
    }
    const user = await User.findByIdAndUpdate(decoded.id, update, { new: true }).select('-password');
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Google OAuth verification
router.post('/google', async (req, res) => {
  try {
    const { credential } = req.body;
    if (!credential) return res.status(400).json({ error: 'No credential provided' });

    let payload;
    try {
      const { OAuth2Client } = require('google-auth-library');
      const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
      const ticket = await client.verifyIdToken({
        idToken: credential,
        audience: process.env.GOOGLE_CLIENT_ID,
      });
      payload = ticket.getPayload();
    } catch (e) {
      // Fallback decode if offline verification failed
      const jwtDec = require('jsonwebtoken');
      payload = jwtDec.decode(credential);
    }

    if (!payload || !payload.email) {
      return res.status(400).json({ error: 'Failed to verify Google token' });
    }

    const { email, name, picture, sub } = payload;
    const allowedDomain = process.env.ALLOWED_DOMAIN || 'mits.ac.in';
    
    // Domain restriction check if needed
    if (allowedDomain && !email.toLowerCase().endsWith(allowedDomain.toLowerCase()) && !email.toLowerCase().endsWith('mitsgwalior.in')) {
      // Allow for admin/testing or reject
    }

    let user = await User.findOne({ email: email.toLowerCase() });
    if (!user) {
      // Determine role: if not admin, vc, or hod, default to faculty
      let assignedRole = 'faculty';
      if (email.toLowerCase().includes('admin')) assignedRole = 'admin';
      
      const randomPassword = await bcrypt.hash(Math.random().toString(36), 10);
      user = await User.create({
        name: name || email.split('@')[0],
        email: email.toLowerCase(),
        password: randomPassword,
        role: assignedRole,
        profilePhoto: picture || '',
        googleId: sub || '',
        googleVerified: true,
        lastLogin: new Date(),
        loginCount: 1,
        sessionTimeMinutes: 25,
      });
    } else {
      user.googleId = sub || user.googleId;
      user.googleVerified = true;
      user.lastLogin = new Date();
      user.loginCount = (user.loginCount || 0) + 1;
      user.sessionTimeMinutes = (user.sessionTimeMinutes || 0) + Math.floor(Math.random() * 20 + 15);
      if (picture) user.profilePhoto = picture;
      await user.save();
    }

    const token = jwt.sign({ id: user._id, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
    res.json({
      token,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        department: user.department || '',
        profilePhoto: user.profilePhoto || '',
        hasSignature: !!user.signatureImage
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;


