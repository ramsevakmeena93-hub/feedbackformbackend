const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { authMiddleware, requireRole } = require('./middleware');

const adminOnly = [authMiddleware, requireRole('admin')];

// Root of the project — go up from routes/ to backend/
const BACKEND_ROOT  = path.join(__dirname, '..');
const FRONTEND_ROOT = path.join(__dirname, '../../frontend/src');

// Allowed extensions to read/edit
const ALLOWED_EXT = ['.js', '.jsx', '.ts', '.tsx', '.json', '.env.example', '.md'];

function safePath(base, rel) {
  const full = path.resolve(base, rel);
  if (!full.startsWith(path.resolve(base))) throw new Error('Path traversal blocked');
  return full;
}

function buildTree(dir, base, maxDepth = 4, depth = 0) {
  if (depth > maxDepth) return [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries
    .filter(e => !['node_modules', '.git', 'dist', '.env'].includes(e.name))
    .map(e => {
      const rel = path.relative(base, path.join(dir, e.name)).replace(/\\/g, '/');
      if (e.isDirectory()) {
        return { name: e.name, path: rel, type: 'dir', children: buildTree(path.join(dir, e.name), base, maxDepth, depth + 1) };
      }
      const ext = path.extname(e.name);
      if (!ALLOWED_EXT.includes(ext)) return null;
      return { name: e.name, path: rel, type: 'file', ext };
    })
    .filter(Boolean);
}

// Get file tree
router.get('/tree/:side', ...adminOnly, (req, res) => {
  try {
    const root = req.params.side === 'frontend' ? FRONTEND_ROOT : BACKEND_ROOT;
    const tree = buildTree(root, root);
    res.json({ tree, side: req.params.side });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Read a file
router.get('/file/:side', ...adminOnly, (req, res) => {
  try {
    const root = req.params.side === 'frontend' ? FRONTEND_ROOT : BACKEND_ROOT;
    const filePath = safePath(root, req.query.path);
    const ext = path.extname(filePath);
    if (!ALLOWED_EXT.includes(ext)) return res.status(403).json({ error: 'File type not allowed' });
    const content = fs.readFileSync(filePath, 'utf8');
    res.json({ content, path: req.query.path, lines: content.split('\n').length });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Save a file
router.post('/file/:side', ...adminOnly, (req, res) => {
  try {
    const root = req.params.side === 'frontend' ? FRONTEND_ROOT : BACKEND_ROOT;
    const { filePath, content } = req.body;
    if (!filePath || content === undefined) return res.status(400).json({ error: 'filePath and content required' });
    const full = safePath(root, filePath);
    const ext = path.extname(full);
    if (!ALLOWED_EXT.includes(ext)) return res.status(403).json({ error: 'File type not allowed' });
    // Backup original
    const backup = full + '.bak';
    if (fs.existsSync(full)) fs.copyFileSync(full, backup);
    fs.writeFileSync(full, content, 'utf8');
    // Log the edit
    try {
      const logger = require('../services/logger');
      logger.info('code-editor', `File saved: ${filePath}`, { by: req.user?.id, side: req.params.side });
    } catch {}
    res.json({ message: 'File saved', lines: content.split('\n').length });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Restore from backup
router.post('/file/:side/restore', ...adminOnly, (req, res) => {
  try {
    const root = req.params.side === 'frontend' ? FRONTEND_ROOT : BACKEND_ROOT;
    const { filePath } = req.body;
    const full = safePath(root, filePath);
    const backup = full + '.bak';
    if (!fs.existsSync(backup)) return res.status(404).json({ error: 'No backup found' });
    fs.copyFileSync(backup, full);
    const content = fs.readFileSync(full, 'utf8');
    res.json({ message: 'Restored from backup', content });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;

const { execSync } = require('child_process');
const GIT_ROOT = path.join(__dirname, '../..');

function runGit(cmd) {
  return execSync(cmd, { cwd: GIT_ROOT, encoding: 'utf8', timeout: 30000 }).trim();
}

// Get git status
router.get('/git/status', ...adminOnly, (req, res) => {
  try {
    const status = runGit('git status --short');
    const branch = runGit('git rev-parse --abbrev-ref HEAD');
    const lastCommit = runGit('git log -1 --format="%h %s (%ar)"');
    const remote = runGit('git remote get-url origin');
    res.json({ status, branch, lastCommit, remote });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Git diff for a specific file
router.get('/git/diff', ...adminOnly, (req, res) => {
  try {
    const filePath = req.query.path;
    if (!filePath) return res.status(400).json({ error: 'path required' });
    const diff = runGit(`git diff HEAD -- "${filePath}"`);
    res.json({ diff: diff || '(no changes)' });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Commit and push
router.post('/git/push', ...adminOnly, (req, res) => {
  try {
    const { message, files } = req.body;
    if (!message) return res.status(400).json({ error: 'commit message required' });

    // Stage specific files or all
    if (files && files.length > 0) {
      files.forEach(f => {
        try { runGit(`git add "${f}"`); } catch {}
      });
    } else {
      runGit('git add -A');
    }

    // Check if there's anything to commit
    const staged = runGit('git diff --cached --name-only');
    if (!staged) return res.json({ message: 'Nothing to commit', pushed: false });

    // Commit
    runGit(`git commit -m "${message.replace(/"/g, "'")}"`);

    // Push
    runGit('git push origin HEAD');

    const lastCommit = runGit('git log -1 --format="%h %s (%ar)"');
    res.json({ message: 'Pushed successfully', lastCommit, pushed: true, files: staged.split('\n').filter(Boolean) });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// Get recent commits
router.get('/git/log', ...adminOnly, (req, res) => {
  try {
    const log = runGit('git log -10 --format="%h|%s|%an|%ar"');
    const commits = log.split('\n').filter(Boolean).map(line => {
      const [hash, subject, author, time] = line.split('|');
      return { hash, subject, author, time };
    });
    res.json({ commits });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Create a new file
router.post('/file/:side/create', ...adminOnly, (req, res) => {
  try {
    const root = req.params.side === 'frontend' ? FRONTEND_ROOT : BACKEND_ROOT;
    const { filePath, content = '' } = req.body;
    if (!filePath) return res.status(400).json({ error: 'filePath required' });
    const full = safePath(root, filePath);
    if (fs.existsSync(full)) return res.status(400).json({ error: 'File already exists' });
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
    res.json({ message: 'File created', path: filePath });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Create a new folder
router.post('/folder/:side/create', ...adminOnly, (req, res) => {
  try {
    const root = req.params.side === 'frontend' ? FRONTEND_ROOT : BACKEND_ROOT;
    const { folderPath } = req.body;
    if (!folderPath) return res.status(400).json({ error: 'folderPath required' });
    const full = safePath(root, folderPath);
    fs.mkdirSync(full, { recursive: true });
    res.json({ message: 'Folder created', path: folderPath });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Rename file or folder
router.post('/rename/:side', ...adminOnly, (req, res) => {
  try {
    const root = req.params.side === 'frontend' ? FRONTEND_ROOT : BACKEND_ROOT;
    const { oldPath, newPath } = req.body;
    if (!oldPath || !newPath) return res.status(400).json({ error: 'oldPath and newPath required' });
    const oldFull = safePath(root, oldPath);
    const newFull = safePath(root, newPath);
    if (!fs.existsSync(oldFull)) return res.status(404).json({ error: 'File not found' });
    if (fs.existsSync(newFull)) return res.status(400).json({ error: 'Target already exists' });
    fs.mkdirSync(path.dirname(newFull), { recursive: true });
    fs.renameSync(oldFull, newFull);
    res.json({ message: 'Renamed', oldPath, newPath });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Delete file or folder
router.delete('/file/:side', ...adminOnly, (req, res) => {
  try {
    const root = req.params.side === 'frontend' ? FRONTEND_ROOT : BACKEND_ROOT;
    const filePath = req.query.path;
    if (!filePath) return res.status(400).json({ error: 'path required' });
    const full = safePath(root, filePath);
    if (!fs.existsSync(full)) return res.status(404).json({ error: 'Not found' });
    const stat = fs.statSync(full);
    if (stat.isDirectory()) {
      fs.rmSync(full, { recursive: true, force: true });
    } else {
      fs.unlinkSync(full);
    }
    res.json({ message: 'Deleted', path: filePath });
  } catch(err) { res.status(500).json({ error: err.message }); }
});
