const express = require('express');
const { query, withTransaction, generateJoinCode } = require('../db/database');
const { authenticate } = require('../middleware/auth');
const { calculateGroupBalances, simplifyDebts } = require('../utils/balanceCalculator');

const router = express.Router();

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function isAdmin(groupId, userId) {
    const r = await query('SELECT role FROM group_members WHERE group_id = $1 AND user_id = $2', [groupId, userId]);
    return r.rows[0] && r.rows[0].role === 'admin';
}

async function isOwner(groupId, userId) {
    const r = await query('SELECT created_by FROM groups_ WHERE id = $1', [groupId]);
    return r.rows[0] && Number(r.rows[0].created_by) === Number(userId);
}

async function isMember(groupId, userId) {
    const r = await query('SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2', [groupId, userId]);
    return r.rows.length > 0;
}

// ─── List user's groups ───────────────────────────────────────────────────────
router.get('/', authenticate, async (req, res) => {
    try {
        const result = await query(`
            SELECT g.*, COUNT(gm.user_id) AS member_count
            FROM groups_ g
            JOIN group_members gm ON gm.group_id = g.id
            WHERE gm.user_id = $1
            GROUP BY g.id
            ORDER BY g.created_at DESC
        `, [req.userId]);
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

// ─── Create group ─────────────────────────────────────────────────────────────
router.post('/', authenticate, async (req, res) => {
    try {
        const { name, description } = req.body;
        if (!name) return res.status(400).json({ error: 'Group name is required' });

        // Generate unique join code
        let join_code;
        let attempts = 0;
        do {
            join_code = generateJoinCode();
            const existing = await query('SELECT 1 FROM groups_ WHERE join_code = $1', [join_code]);
            if (!existing.rows.length) break;
            attempts++;
        } while (attempts < 10);

        const result = await query(
            'INSERT INTO groups_ (name, description, created_by, join_code) VALUES ($1, $2, $3, $4) RETURNING id',
            [name.trim(), description?.trim() || '', req.userId, join_code]
        );
        const groupId = result.rows[0].id;

        await query('INSERT INTO group_members (group_id, user_id, role) VALUES ($1, $2, $3)', [groupId, req.userId, 'admin']);

        const group = await query('SELECT * FROM groups_ WHERE id = $1', [groupId]);
        res.status(201).json(group.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

// ─── Get group detail ─────────────────────────────────────────────────────────
router.get('/:id', authenticate, async (req, res) => {
    try {
        const groupId = parseInt(req.params.id);
        if (!await isMember(groupId, req.userId))
            return res.status(403).json({ error: 'Not a member of this group' });

        const groupResult = await query('SELECT * FROM groups_ WHERE id = $1', [groupId]);
        if (!groupResult.rows.length) return res.status(404).json({ error: 'Group not found' });
        const group = groupResult.rows[0];

        const members = await query(`
            SELECT u.id, u.name, u.email, u.avatar_color, u.profile_photo, gm.role, gm.joined_at
            FROM group_members gm
            JOIN users u ON u.id = gm.user_id
            WHERE gm.group_id = $1
            ORDER BY gm.role DESC, gm.joined_at ASC
        `, [groupId]);

        const myRole = members.rows.find(m => Number(m.id) === Number(req.userId))?.role || 'member';
        res.json({ ...group, members: members.rows, myRole });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

// ─── Update group (owner only) ───────────────────────────────────────────────
router.put('/:id', authenticate, async (req, res) => {
    try {
        const groupId = parseInt(req.params.id);
        if (!await isMember(groupId, req.userId)) return res.status(403).json({ error: 'Not a member' });
        if (!await isOwner(groupId, req.userId)) return res.status(403).json({ error: 'Only the group owner can edit group settings' });

        const groupResult = await query('SELECT * FROM groups_ WHERE id = $1', [groupId]);
        if (!groupResult.rows.length) return res.status(404).json({ error: 'Group not found' });
        const group = groupResult.rows[0];

        const { name, description, retention_days } = req.body;
        const newName = (name && name.trim()) ? name.trim() : group.name;
        const newDesc = description !== undefined ? (description.trim() || '') : group.description;
        let newRetention = group.retention_days;
        if (retention_days !== undefined) {
            newRetention = retention_days === null || retention_days === '' ? null : parseInt(retention_days);
            if (isNaN(newRetention)) newRetention = null;
            if (newRetention !== null && newRetention <= 0) newRetention = null;
        }

        await query('UPDATE groups_ SET name = $1, description = $2, retention_days = $3 WHERE id = $4',
            [newName, newDesc, newRetention, groupId]);
        const updated = await query('SELECT * FROM groups_ WHERE id = $1', [groupId]);
        res.json(updated.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

// ─── Delete group (owner only) ───────────────────────────────────────────────
router.delete('/:id', authenticate, async (req, res) => {
    try {
        const groupId = parseInt(req.params.id);
        if (!await isMember(groupId, req.userId)) return res.status(403).json({ error: 'Not a member' });
        if (!await isOwner(groupId, req.userId)) return res.status(403).json({ error: 'Only the group owner can delete this group' });

        const group = await query('SELECT * FROM groups_ WHERE id = $1', [groupId]);
        if (!group.rows.length) return res.status(404).json({ error: 'Group not found' });

        await query('DELETE FROM groups_ WHERE id = $1', [groupId]);
        res.json({ success: true, message: `Group "${group.rows[0].name}" has been deleted` });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

// ─── Add member by email (admin only) ────────────────────────────────────────
router.post('/:id/members', authenticate, async (req, res) => {
    try {
        const groupId = parseInt(req.params.id);
        if (!await isMember(groupId, req.userId)) return res.status(403).json({ error: 'Not a member' });
        if (!await isAdmin(groupId, req.userId)) return res.status(403).json({ error: 'Admin only' });

        const { email } = req.body;
        const userResult = await query('SELECT * FROM users WHERE email = $1', [email?.toLowerCase().trim()]);
        if (!userResult.rows.length) return res.status(404).json({ error: 'User not found with that email' });
        const user = userResult.rows[0];

        if (await isMember(groupId, user.id)) return res.status(409).json({ error: 'User is already a member' });

        await query('INSERT INTO group_members (group_id, user_id, role) VALUES ($1, $2, $3)', [groupId, user.id, 'member']);
        res.status(201).json({ message: 'Member added' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

// ─── Remove member (admin only) ──────────────────────────────────────────────
router.delete('/:id/members/:uid', authenticate, async (req, res) => {
    try {
        const groupId = parseInt(req.params.id);
        const targetId = parseInt(req.params.uid);
        if (!await isAdmin(groupId, req.userId)) return res.status(403).json({ error: 'Admin only' });

        const group = await query('SELECT created_by FROM groups_ WHERE id = $1', [groupId]);
        if (Number(targetId) === Number(group.rows[0].created_by))
            return res.status(403).json({ error: 'Cannot remove the group creator' });

        await query('DELETE FROM group_members WHERE group_id = $1 AND user_id = $2', [groupId, targetId]);
        res.json({ message: 'Member removed' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

// ─── Change member role (admin only) ─────────────────────────────────────────
router.put('/:id/members/:uid/role', authenticate, async (req, res) => {
    try {
        const groupId = parseInt(req.params.id);
        const targetId = parseInt(req.params.uid);
        const { role } = req.body;

        if (!['admin', 'member'].includes(role)) return res.status(400).json({ error: 'Role must be admin or member' });
        if (!await isAdmin(groupId, req.userId)) return res.status(403).json({ error: 'Admin only' });

        const group = await query('SELECT created_by FROM groups_ WHERE id = $1', [groupId]);
        if (Number(targetId) === Number(group.rows[0].created_by) && role === 'member')
            return res.status(403).json({ error: 'Cannot demote the group creator' });

        if (!await isMember(groupId, targetId)) return res.status(404).json({ error: 'User is not a member' });

        await query('UPDATE group_members SET role = $1 WHERE group_id = $2 AND user_id = $3', [role, groupId, targetId]);
        res.json({ message: `Role updated to ${role}` });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

// ─── JOIN REQUESTS ────────────────────────────────────────────────────────────

router.post('/join', authenticate, async (req, res) => {
    try {
        const { join_code } = req.body;
        if (!join_code) return res.status(400).json({ error: 'Join code is required' });

        const groupResult = await query('SELECT * FROM groups_ WHERE join_code = $1', [join_code.toUpperCase().trim()]);
        if (!groupResult.rows.length) return res.status(404).json({ error: 'Invalid join code' });
        const group = groupResult.rows[0];

        if (await isMember(group.id, req.userId))
            return res.status(409).json({ error: 'You are already a member of this group' });

        const existing = await query('SELECT * FROM join_requests WHERE group_id = $1 AND user_id = $2', [group.id, req.userId]);
        if (existing.rows.length) {
            if (existing.rows[0].status === 'pending')
                return res.status(409).json({ error: 'You already have a pending join request for this group' });
            await query('UPDATE join_requests SET status = $1, requested_at = NOW() WHERE group_id = $2 AND user_id = $3',
                ['pending', group.id, req.userId]);
        } else {
            await query('INSERT INTO join_requests (group_id, user_id) VALUES ($1, $2)', [group.id, req.userId]);
        }

        res.status(201).json({ message: `Join request sent to "${group.name}". Waiting for admin approval.`, group_name: group.name });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

router.get('/:id/join-requests', authenticate, async (req, res) => {
    try {
        const groupId = parseInt(req.params.id);
        if (!await isAdmin(groupId, req.userId)) return res.status(403).json({ error: 'Admin only' });

        const requests = await query(`
            SELECT jr.id, jr.status, jr.requested_at, u.id AS user_id, u.name, u.email, u.avatar_color
            FROM join_requests jr
            JOIN users u ON u.id = jr.user_id
            WHERE jr.group_id = $1 AND jr.status = 'pending'
            ORDER BY jr.requested_at ASC
        `, [groupId]);
        res.json(requests.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

router.post('/:id/join-requests/:uid/approve', authenticate, async (req, res) => {
    try {
        const groupId = parseInt(req.params.id);
        const userId = parseInt(req.params.uid);
        if (!await isAdmin(groupId, req.userId)) return res.status(403).json({ error: 'Admin only' });

        const req_ = await query("SELECT * FROM join_requests WHERE group_id = $1 AND user_id = $2 AND status = 'pending'", [groupId, userId]);
        if (!req_.rows.length) return res.status(404).json({ error: 'No pending request found' });

        await withTransaction(async (client) => {
            if (!await isMember(groupId, userId)) {
                await client.query('INSERT INTO group_members (group_id, user_id, role) VALUES ($1, $2, $3)', [groupId, userId, 'member']);
            }
            await client.query("UPDATE join_requests SET status = 'approved' WHERE group_id = $1 AND user_id = $2", [groupId, userId]);
        });

        res.json({ message: 'Request approved' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

router.post('/:id/join-requests/:uid/reject', authenticate, async (req, res) => {
    try {
        const groupId = parseInt(req.params.id);
        const userId = parseInt(req.params.uid);
        if (!await isAdmin(groupId, req.userId)) return res.status(403).json({ error: 'Admin only' });

        await query("UPDATE join_requests SET status = 'rejected' WHERE group_id = $1 AND user_id = $2", [groupId, userId]);
        res.json({ message: 'Request rejected' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

// ─── Regenerate join code (admin only) ───────────────────────────────────────
router.post('/:id/regen-code', authenticate, async (req, res) => {
    try {
        const groupId = parseInt(req.params.id);
        if (!await isAdmin(groupId, req.userId)) return res.status(403).json({ error: 'Admin only' });

        let code, attempts = 0;
        do {
            code = generateJoinCode();
            const existing = await query('SELECT 1 FROM groups_ WHERE join_code = $1', [code]);
            if (!existing.rows.length) break;
            attempts++;
        } while (attempts < 10);

        await query('UPDATE groups_ SET join_code = $1 WHERE id = $2', [code, groupId]);
        res.json({ join_code: code });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

// ─── LEAVE GROUP FLOW ─────────────────────────────────────────────────────────

router.post('/:id/leave', authenticate, async (req, res) => {
    try {
        const groupId = parseInt(req.params.id);
        if (!await isMember(groupId, req.userId))
            return res.status(403).json({ error: 'Not a member of this group' });
        if (await isOwner(groupId, req.userId))
            return res.status(400).json({ error: 'As the owner, you cannot leave. Delete the group or transfer ownership instead.' });

        const group = await query('SELECT * FROM groups_ WHERE id = $1', [groupId]);
        const balances = await calculateGroupBalances(groupId, group.rows[0]?.retention_days);
        const transactions = await simplifyDebts(balances);

        const myDebts = transactions.filter(t => Number(t.from.id) === Number(req.userId) && t.amount > 1);
        if (myDebts.length > 0) {
            const total = myDebts.reduce((s, t) => s + t.amount, 0);
            return res.status(400).json({
                error: `You have unsettled debts of ₹${total.toFixed(2)}. Please settle up before leaving.`,
                unsettled: true,
                amount: total,
            });
        }

        const existing = await query('SELECT * FROM leave_requests WHERE group_id = $1 AND user_id = $2', [groupId, req.userId]);
        if (existing.rows.length && existing.rows[0].status === 'pending')
            return res.status(409).json({ error: 'You already have a pending leave request for this group.' });

        if (existing.rows.length) {
            await query("UPDATE leave_requests SET status = 'pending', requested_at = NOW() WHERE group_id = $1 AND user_id = $2", [groupId, req.userId]);
        } else {
            await query('INSERT INTO leave_requests (group_id, user_id) VALUES ($1, $2)', [groupId, req.userId]);
        }

        res.status(201).json({ message: 'Leave request sent. Waiting for admin approval.' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

router.get('/:id/leave-requests', authenticate, async (req, res) => {
    try {
        const groupId = parseInt(req.params.id);
        if (!await isAdmin(groupId, req.userId)) return res.status(403).json({ error: 'Admin only' });

        const requests = await query(`
            SELECT lr.id, lr.status, lr.requested_at,
                   u.id AS user_id, u.name, u.email, u.avatar_color
            FROM leave_requests lr
            JOIN users u ON u.id = lr.user_id
            WHERE lr.group_id = $1 AND lr.status = 'pending'
            ORDER BY lr.requested_at ASC
        `, [groupId]);
        res.json(requests.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

router.post('/:id/leave-requests/:uid/approve', authenticate, async (req, res) => {
    try {
        const groupId = parseInt(req.params.id);
        const userId = parseInt(req.params.uid);
        if (!await isAdmin(groupId, req.userId)) return res.status(403).json({ error: 'Admin only' });

        const leaveReq = await query("SELECT * FROM leave_requests WHERE group_id = $1 AND user_id = $2 AND status = 'pending'", [groupId, userId]);
        if (!leaveReq.rows.length) return res.status(404).json({ error: 'No pending leave request found' });

        await withTransaction(async (client) => {
            await client.query('DELETE FROM group_members WHERE group_id = $1 AND user_id = $2', [groupId, userId]);
            await client.query("UPDATE leave_requests SET status = 'approved' WHERE group_id = $1 AND user_id = $2", [groupId, userId]);
        });

        res.json({ message: 'Leave request approved. Member removed. Their expense history is preserved.' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

router.post('/:id/leave-requests/:uid/reject', authenticate, async (req, res) => {
    try {
        const groupId = parseInt(req.params.id);
        const userId = parseInt(req.params.uid);
        if (!await isAdmin(groupId, req.userId)) return res.status(403).json({ error: 'Admin only' });

        await query("UPDATE leave_requests SET status = 'rejected' WHERE group_id = $1 AND user_id = $2", [groupId, userId]);
        res.json({ message: 'Leave request rejected' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

module.exports = router;
