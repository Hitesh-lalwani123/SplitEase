const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { query } = require('../db/database');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

// Register
router.post('/register', async (req, res) => {
    try {
        const { name, email, password } = req.body;
        if (!name || !email || !password)
            return res.status(400).json({ error: 'Name, email, and password are required' });
        if (password.length < 6)
            return res.status(400).json({ error: 'Password must be at least 6 characters' });

        const existing = await query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
        if (existing.rows.length)
            return res.status(409).json({ error: 'Email already registered' });

        const colors = ['#14b8a6', '#f97316', '#3b82f6', '#a855f7', '#ec4899', '#10b981', '#6366f1', '#eab308'];
        const avatarColor = colors[Math.floor(Math.random() * colors.length)];

        const hash = await bcrypt.hash(password, 10);
        const result = await query(
            'INSERT INTO users (name, email, password_hash, avatar_color) VALUES ($1, $2, $3, $4) RETURNING id',
            [name.trim(), email.toLowerCase().trim(), hash, avatarColor]
        );
        const userId = result.rows[0].id;

        // Auto-accept any pending invitations for this email
        const pendingInvites = await query(
            "SELECT * FROM group_invitations WHERE invited_email = $1 AND status = 'pending'",
            [email.toLowerCase().trim()]
        );
        for (const invite of pendingInvites.rows) {
            const alreadyMember = await query(
                'SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2',
                [invite.group_id, userId]
            );
            if (!alreadyMember.rows.length) {
                await query('INSERT INTO group_members (group_id, user_id) VALUES ($1, $2)', [invite.group_id, userId]);
            }
            await query("UPDATE group_invitations SET status = 'accepted' WHERE id = $1", [invite.id]);
        }

        const token = jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: '30d' });
        res.status(201).json({ token, id: userId, name: name.trim(), email: email.toLowerCase().trim(), avatar_color: avatarColor });
    } catch (err) {
        console.error('Register error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Login
router.post('/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        if (!email || !password)
            return res.status(400).json({ error: 'Email and password are required' });

        const result = await query('SELECT * FROM users WHERE email = $1', [email.toLowerCase().trim()]);
        const user = result.rows[0];
        if (!user) return res.status(401).json({ error: 'Invalid email or password' });
        if (!user.password_hash)
            return res.status(401).json({ error: 'This account uses Google Sign-In. Please use the "Sign in with Google" button.' });

        const valid = await bcrypt.compare(password, user.password_hash);
        if (!valid) return res.status(401).json({ error: 'Invalid email or password' });

        const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: '30d' });
        res.json({ token, id: user.id, name: user.name, email: user.email, avatar_color: user.avatar_color });
    } catch (err) {
        console.error('Login error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Get current user
router.get('/me', authenticate, async (req, res) => {
    try {
        const result = await query(
            'SELECT id, name, email, avatar_color, profile_photo, created_at FROM users WHERE id = $1',
            [req.userId]
        );
        if (!result.rows.length) return res.status(404).json({ error: 'User not found' });
        res.json(result.rows[0]);
    } catch (err) {
        console.error('Me error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Update profile
router.put('/profile', authenticate, async (req, res) => {
    try {
        const { name, avatar_color, profile_photo, current_password, new_password } = req.body;

        const result = await query('SELECT * FROM users WHERE id = $1', [req.userId]);
        const user = result.rows[0];
        if (!user) return res.status(404).json({ error: 'User not found' });

        const setClauses = [];
        const values = [];
        let idx = 1;

        if (name && name.trim()) { setClauses.push(`name = $${idx++}`); values.push(name.trim()); }
        if (avatar_color) { setClauses.push(`avatar_color = $${idx++}`); values.push(avatar_color); }
        if (profile_photo !== undefined) { setClauses.push(`profile_photo = $${idx++}`); values.push(profile_photo); }

        // Password change (only for non-Google users)
        if (new_password) {
            if (!user.password_hash)
                return res.status(400).json({ error: 'Google-authenticated users cannot set a password here' });
            if (!current_password)
                return res.status(400).json({ error: 'Current password required' });
            const valid = await bcrypt.compare(current_password, user.password_hash);
            if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });
            if (new_password.length < 6)
                return res.status(400).json({ error: 'New password must be at least 6 characters' });
            setClauses.push(`password_hash = $${idx++}`);
            values.push(await bcrypt.hash(new_password, 10));
        }

        if (setClauses.length === 0)
            return res.status(400).json({ error: 'Nothing to update' });

        values.push(req.userId);
        await query(`UPDATE users SET ${setClauses.join(', ')} WHERE id = $${idx}`, values);

        const updated = await query(
            'SELECT id, name, email, avatar_color, profile_photo, created_at FROM users WHERE id = $1',
            [req.userId]
        );
        res.json(updated.rows[0]);
    } catch (err) {
        console.error('Profile update error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

module.exports = router;
