const express = require('express');
const crypto = require('crypto');
const { query } = require('../db/database');
const { authenticate } = require('../middleware/auth');
const { sendInvitationEmail } = require('../utils/mailer');
const { enqueue } = require('../utils/queue');

const router = express.Router();

// Send invitation
router.post('/send', authenticate, async (req, res) => {
    try {
        const { groupId, email } = req.body;
        if (!groupId || !email) return res.status(400).json({ error: 'groupId and email are required' });

        const member = await query('SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2', [groupId, req.userId]);
        if (!member.rows.length) return res.status(403).json({ error: 'Not a member of this group' });

        const group = await query('SELECT * FROM groups_ WHERE id = $1', [groupId]);
        if (!group.rows.length) return res.status(404).json({ error: 'Group not found' });

        const inviter = await query('SELECT name, email FROM users WHERE id = $1', [req.userId]);

        const existingUser = await query('SELECT id FROM users WHERE email = $1', [email.toLowerCase().trim()]);
        if (existingUser.rows.length) {
            const alreadyMember = await query('SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2', [groupId, existingUser.rows[0].id]);
            if (alreadyMember.rows.length) return res.status(409).json({ error: 'User is already a member of this group' });
        }

        const existingInvite = await query(
            "SELECT id FROM group_invitations WHERE group_id = $1 AND invited_email = $2 AND status = 'pending'",
            [groupId, email.toLowerCase().trim()]
        );
        if (existingInvite.rows.length) return res.status(409).json({ error: 'Invitation already sent to this email' });

        const token = crypto.randomBytes(32).toString('hex');
        const normalizedEmail = email.toLowerCase().trim();

        await query(
            'INSERT INTO group_invitations (group_id, invited_email, token, invited_by) VALUES ($1, $2, $3, $4)',
            [groupId, normalizedEmail, token, req.userId]
        );

        const appUrl = process.env.APP_URL || 'http://localhost:3000';
        const inviteUrl = `${appUrl}/invite/${token}`;

        res.status(201).json({ success: true, inviteUrl, message: 'Invitation sent' });

        // Fire invite email in background
        enqueue(() => sendInvitationEmail({
            toEmail: normalizedEmail,
            inviterName: inviter.rows[0]?.name,
            groupName: group.rows[0].name,
            inviteUrl,
        }));

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

// List pending invitations for a group
router.get('/group/:groupId', authenticate, async (req, res) => {
    try {
        const { groupId } = req.params;
        const member = await query('SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2', [groupId, req.userId]);
        if (!member.rows.length) return res.status(403).json({ error: 'Not a member of this group' });

        const invitations = await query(`
            SELECT gi.*, u.name AS invited_by_name
            FROM group_invitations gi
            JOIN users u ON gi.invited_by = u.id
            WHERE gi.group_id = $1 AND gi.status = 'pending'
            ORDER BY gi.created_at DESC
        `, [groupId]);
        res.json(invitations.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Accept invitation (GET — redirect to SPA)
router.get('/accept/:token', async (req, res) => {
    try {
        const invitation = await query(
            "SELECT * FROM group_invitations WHERE token = $1 AND status = 'pending'",
            [req.params.token]
        );
        if (!invitation.rows.length) return res.redirect('/?error=invalid_or_expired_invite');
        const appUrl = process.env.APP_URL || 'http://localhost:3000';
        res.redirect(`${appUrl}/invite/${req.params.token}`);
    } catch (err) {
        console.error(err);
        res.redirect('/?error=invite_error');
    }
});

// Accept invitation via API (authenticated)
router.post('/accept', authenticate, async (req, res) => {
    try {
        const { token } = req.body;
        if (!token) return res.status(400).json({ error: 'Token is required' });

        const invResult = await query(
            "SELECT * FROM group_invitations WHERE token = $1 AND status = 'pending'",
            [token]
        );
        if (!invResult.rows.length) return res.status(404).json({ error: 'Invalid or expired invitation' });
        const invitation = invResult.rows[0];

        const user = await query('SELECT email FROM users WHERE id = $1', [req.userId]);
        if (user.rows[0].email !== invitation.invited_email) {
            return res.status(403).json({ error: `This invitation was sent to ${invitation.invited_email}. Please log in with that email.` });
        }

        const alreadyMember = await query('SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2', [invitation.group_id, req.userId]);
        if (!alreadyMember.rows.length) {
            await query('INSERT INTO group_members (group_id, user_id) VALUES ($1, $2)', [invitation.group_id, req.userId]);
        }
        await query("UPDATE group_invitations SET status = 'accepted' WHERE token = $1", [token]);

        const group = await query('SELECT * FROM groups_ WHERE id = $1', [invitation.group_id]);
        res.json({ success: true, group: group.rows[0] });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Cancel/revoke invitation
router.delete('/:id', authenticate, async (req, res) => {
    try {
        const invite = await query('SELECT * FROM group_invitations WHERE id = $1', [req.params.id]);
        if (!invite.rows.length) return res.status(404).json({ error: 'Invitation not found' });

        const member = await query('SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2', [invite.rows[0].group_id, req.userId]);
        if (!member.rows.length) return res.status(403).json({ error: 'Permission denied' });

        await query("UPDATE group_invitations SET status = 'cancelled' WHERE id = $1", [req.params.id]);
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

module.exports = router;
