const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { getDb } = require('../db/database');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

// Register
router.post('/register', async (req, res) => {
    try {
        const { name, email, password } = req.body;
        if (!name || !email || !password) {
            return res.status(400).json({ error: 'Name, email, and password are required' });
        }
        if (password.length < 6) {
            return res.status(400).json({ error: 'Password must be at least 6 characters' });
        }

        const db = getDb();
        const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase());
        if (existing) {
            return res.status(409).json({ error: 'Email already registered' });
        }

        const colors = ['#14b8a6', '#f97316', '#3b82f6', '#a855f7', '#ec4899', '#10b981', '#6366f1', '#eab308'];
        const avatarColor = colors[Math.floor(Math.random() * colors.length)];

        const hash = await bcrypt.hash(password, 10);
        const result = db.prepare('INSERT INTO users (name, email, password_hash, avatar_color) VALUES (?, ?, ?, ?)').run(
            name.trim(), email.toLowerCase().trim(), hash, avatarColor
        );

        const userId = result.lastInsertRowid;

        // Auto-accept any pending invitations for this email
        const pendingInvites = db.prepare(
            "SELECT * FROM group_invitations WHERE invited_email = ? AND status = 'pending'"
        ).all(email.toLowerCase().trim());
        for (const invite of pendingInvites) {
            const alreadyMember = db.prepare(
                'SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?'
            ).get(invite.group_id, userId);
            if (!alreadyMember) {
                db.prepare('INSERT INTO group_members (group_id, user_id) VALUES (?, ?)').run(invite.group_id, userId);
            }
            db.prepare("UPDATE group_invitations SET status = 'accepted' WHERE id = ?").run(invite.id);
        }

        const token = jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: '30d' });
        res.status(201).json({
            token,
            id: userId, name: name.trim(), email: email.toLowerCase().trim(), avatar_color: avatarColor,
        });
    } catch (err) {
        console.error('Register error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Login
router.post('/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        if (!email || !password) {
            return res.status(400).json({ error: 'Email and password are required' });
        }

        const db = getDb();
        const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase().trim());
        if (!user) {
            return res.status(401).json({ error: 'Invalid email or password' });
        }
        if (!user.password_hash) {
            return res.status(401).json({ error: 'This account uses Google Sign-In. Please use the "Sign in with Google" button.' });
        }

        const valid = await bcrypt.compare(password, user.password_hash);
        if (!valid) {
            return res.status(401).json({ error: 'Invalid email or password' });
        }

        const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: '30d' });
        res.json({
            token,
            id: user.id, name: user.name, email: user.email, avatar_color: user.avatar_color,
        });
    } catch (err) {
        console.error('Login error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Get current user
router.get('/me', authenticate, (req, res) => {
    const db = getDb();
    const user = db.prepare('SELECT id, name, email, avatar_color, profile_photo, created_at FROM users WHERE id = ?').get(req.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
});

// Update profile
router.put('/profile', authenticate, async (req, res) => {
    try {
        const db = getDb();
        const { name, avatar_color, profile_photo, current_password, new_password } = req.body;

        const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
        if (!user) return res.status(404).json({ error: 'User not found' });

        const updates = {};
        if (name && name.trim()) updates.name = name.trim();
        if (avatar_color) updates.avatar_color = avatar_color;
        if (profile_photo !== undefined) updates.profile_photo = profile_photo;

        // Password change (only for non-Google users)
        if (new_password) {
            if (!user.password_hash) return res.status(400).json({ error: 'Google-authenticated users cannot set a password here' });
            if (!current_password) return res.status(400).json({ error: 'Current password required' });
            const valid = await bcrypt.compare(current_password, user.password_hash);
            if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });
            if (new_password.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters' });
            updates.password_hash = await bcrypt.hash(new_password, 10);
        }

        if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'Nothing to update' });

        const setClauses = Object.keys(updates).map(k => `${k} = ?`).join(', ');
        const values = [...Object.values(updates), req.userId];
        db.prepare(`UPDATE users SET ${setClauses} WHERE id = ?`).run(...values);

        const updated = db.prepare('SELECT id, name, email, avatar_color, profile_photo, created_at FROM users WHERE id = ?').get(req.userId);
        res.json(updated);
    } catch (err) {
        console.error('Profile update error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

module.exports = router;

