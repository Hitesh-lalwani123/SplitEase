const express = require('express');
const crypto = require('crypto');
const { getDb } = require('../db/database');
const { authenticate } = require('../middleware/auth');
const { sendInvitationEmail } = require('../utils/mailer');

const router = express.Router();

// Send invitation
router.post('/send', authenticate, async (req, res) => {
    const { groupId, email } = req.body;
    if (!groupId || !email) {
        return res.status(400).json({ error: 'groupId and email are required' });
    }

    const db = getDb();

    // Verify requester is member of group
    const isMember = db.prepare('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?').get(groupId, req.userId);
    if (!isMember) return res.status(403).json({ error: 'Not a member of this group' });

    const group = db.prepare('SELECT * FROM groups_ WHERE id = ?').get(groupId);
    if (!group) return res.status(404).json({ error: 'Group not found' });

    const inviter = db.prepare('SELECT name, email FROM users WHERE id = ?').get(req.userId);

    // Check if already a member
    const existingUser = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase().trim());
    if (existingUser) {
        const alreadyMember = db.prepare('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?').get(groupId, existingUser.id);
        if (alreadyMember) return res.status(409).json({ error: 'User is already a member of this group' });
    }

    // Check for existing pending invite
    const existingInvite = db.prepare(
        'SELECT id FROM group_invitations WHERE group_id = ? AND invited_email = ? AND status = ?'
    ).get(groupId, email.toLowerCase().trim(), 'pending');
    if (existingInvite) return res.status(409).json({ error: 'Invitation already sent to this email' });

    const token = crypto.randomBytes(32).toString('hex');
    const normalizedEmail = email.toLowerCase().trim();

    db.prepare(
        'INSERT INTO group_invitations (group_id, invited_email, token, invited_by) VALUES (?, ?, ?, ?)'
    ).run(groupId, normalizedEmail, token, req.userId);

    const appUrl = process.env.APP_URL || 'http://localhost:3000';
    const inviteUrl = `${appUrl}/invite/${token}`;

    // Send email (non-blocking)
    sendInvitationEmail({
        toEmail: normalizedEmail,
        inviterName: inviter.name,
        groupName: group.name,
        inviteUrl,
    }).catch(() => { }); // fail silently

    res.status(201).json({ success: true, inviteUrl, message: 'Invitation sent' });
});

// List pending invitations for a group
router.get('/group/:groupId', authenticate, (req, res) => {
    const db = getDb();
    const { groupId } = req.params;

    const isMember = db.prepare('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?').get(groupId, req.userId);
    if (!isMember) return res.status(403).json({ error: 'Not a member of this group' });

    const invitations = db.prepare(`
    SELECT gi.*, u.name as invited_by_name
    FROM group_invitations gi
    JOIN users u ON gi.invited_by = u.id
    WHERE gi.group_id = ? AND gi.status = 'pending'
    ORDER BY gi.created_at DESC
  `).all(groupId);

    res.json(invitations);
});

// Accept invitation (GET — handles both logged-in and not logged-in)
router.get('/accept/:token', (req, res) => {
    const db = getDb();
    const invitation = db.prepare(
        "SELECT * FROM group_invitations WHERE token = ? AND status = 'pending'"
    ).get(req.params.token);

    if (!invitation) {
        return res.redirect('/?error=invalid_or_expired_invite');
    }

    const appUrl = process.env.APP_URL || 'http://localhost:3000';
    // Redirect to frontend with token in URL so the SPA can handle it
    res.redirect(`${appUrl}/invite/${req.params.token}`);
});

// Accept invitation via API (called by frontend when user is logged in)
router.post('/accept', authenticate, (req, res) => {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: 'Token is required' });

    const db = getDb();
    const invitation = db.prepare(
        "SELECT * FROM group_invitations WHERE token = ? AND status = 'pending'"
    ).get(token);

    if (!invitation) return res.status(404).json({ error: 'Invalid or expired invitation' });

    // Check user email matches invite (or allow any)
    const user = db.prepare('SELECT email FROM users WHERE id = ?').get(req.userId);
    if (user.email !== invitation.invited_email) {
        return res.status(403).json({ error: `This invitation was sent to ${invitation.invited_email}. Please log in with that email.` });
    }

    // Check not already a member
    const alreadyMember = db.prepare(
        'SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?'
    ).get(invitation.group_id, req.userId);

    if (!alreadyMember) {
        db.prepare('INSERT INTO group_members (group_id, user_id) VALUES (?, ?)').run(invitation.group_id, req.userId);
    }

    db.prepare("UPDATE group_invitations SET status = 'accepted' WHERE token = ?").run(token);

    const group = db.prepare('SELECT * FROM groups_ WHERE id = ?').get(invitation.group_id);
    res.json({ success: true, group });
});

// Cancel/revoke invitation
router.delete('/:id', authenticate, (req, res) => {
    const db = getDb();
    const invite = db.prepare('SELECT * FROM group_invitations WHERE id = ?').get(req.params.id);
    if (!invite) return res.status(404).json({ error: 'Invitation not found' });

    const isMember = db.prepare('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?').get(invite.group_id, req.userId);
    if (!isMember) return res.status(403).json({ error: 'Permission denied' });

    db.prepare("UPDATE group_invitations SET status = 'cancelled' WHERE id = ?").run(req.params.id);
    res.json({ success: true });
});

module.exports = router;
