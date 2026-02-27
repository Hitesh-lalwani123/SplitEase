const express = require('express');
const { getDb, generateJoinCode } = require('../db/database');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

// Helper: check if user is admin of group
function isAdmin(db, groupId, userId) {
    const m = db.prepare('SELECT role FROM group_members WHERE group_id = ? AND user_id = ?').get(groupId, userId);
    return m && m.role === 'admin';
}

// Helper: check if user is owner (creator) of group
function isOwner(db, groupId, userId) {
    const g = db.prepare('SELECT created_by FROM groups_ WHERE id = ?').get(groupId);
    return g && g.created_by === userId;
}

// Helper: check membership
function isMember(db, groupId, userId) {
    return !!db.prepare('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?').get(groupId, userId);
}

// List user's groups
router.get('/', authenticate, (req, res) => {
    const db = getDb();
    const groups = db.prepare(`
        SELECT g.*, COUNT(gm.user_id) as member_count
        FROM groups_ g
        JOIN group_members gm ON gm.group_id = g.id
        WHERE gm.user_id = ?
        GROUP BY g.id
        ORDER BY g.created_at DESC
    `).all(req.userId);
    res.json(groups);
});

// Create group
router.post('/', authenticate, (req, res) => {
    const db = getDb();
    const { name, description } = req.body;
    if (!name) return res.status(400).json({ error: 'Group name is required' });

    let join_code;
    let attempts = 0;
    do {
        join_code = generateJoinCode();
        attempts++;
    } while (db.prepare('SELECT 1 FROM groups_ WHERE join_code = ?').get(join_code) && attempts < 10);

    const result = db.prepare(
        'INSERT INTO groups_ (name, description, created_by, join_code) VALUES (?, ?, ?, ?)'
    ).run(name.trim(), description?.trim() || '', req.userId, join_code);

    const groupId = result.lastInsertRowid;
    // Creator is primary admin
    db.prepare('INSERT INTO group_members (group_id, user_id, role) VALUES (?, ?, ?)').run(groupId, req.userId, 'admin');

    const group = db.prepare('SELECT * FROM groups_ WHERE id = ?').get(groupId);
    res.status(201).json(group);
});

// Get group detail
router.get('/:id', authenticate, (req, res) => {
    const db = getDb();
    const groupId = parseInt(req.params.id);

    if (!isMember(db, groupId, req.userId)) {
        return res.status(403).json({ error: 'Not a member of this group' });
    }

    const group = db.prepare('SELECT * FROM groups_ WHERE id = ?').get(groupId);
    if (!group) return res.status(404).json({ error: 'Group not found' });

    const members = db.prepare(`
        SELECT u.id, u.name, u.email, u.avatar_color, u.profile_photo, gm.role, gm.joined_at
        FROM group_members gm
        JOIN users u ON u.id = gm.user_id
        WHERE gm.group_id = ?
        ORDER BY gm.role DESC, gm.joined_at ASC
    `).all(groupId);

    const myRole = members.find(m => m.id === req.userId)?.role || 'member';

    res.json({ ...group, members, myRole });
});

// Update group (owner only — rename, description, retention_days)
router.put('/:id', authenticate, (req, res) => {
    const db = getDb();
    const groupId = parseInt(req.params.id);

    if (!isMember(db, groupId, req.userId)) return res.status(403).json({ error: 'Not a member' });
    if (!isOwner(db, groupId, req.userId)) return res.status(403).json({ error: 'Only the group owner can edit group settings' });

    const group = db.prepare('SELECT * FROM groups_ WHERE id = ?').get(groupId);
    if (!group) return res.status(404).json({ error: 'Group not found' });

    const { name, description, retention_days } = req.body;

    const newName = (name && name.trim()) ? name.trim() : group.name;
    const newDesc = description !== undefined ? (description.trim() || '') : group.description;
    // retention_days: null = no retention, 0 = disable, positive integer = days
    let newRetention = group.retention_days;
    if (retention_days !== undefined) {
        newRetention = retention_days === null || retention_days === '' ? null : parseInt(retention_days);
        if (isNaN(newRetention)) newRetention = null;
        if (newRetention !== null && newRetention <= 0) newRetention = null;
    }

    db.prepare('UPDATE groups_ SET name = ?, description = ?, retention_days = ? WHERE id = ?')
        .run(newName, newDesc, newRetention, groupId);

    const updated = db.prepare('SELECT * FROM groups_ WHERE id = ?').get(groupId);
    res.json(updated);
});

// Delete group (owner only)
router.delete('/:id', authenticate, (req, res) => {
    const db = getDb();
    const groupId = parseInt(req.params.id);

    if (!isMember(db, groupId, req.userId)) return res.status(403).json({ error: 'Not a member' });
    if (!isOwner(db, groupId, req.userId)) return res.status(403).json({ error: 'Only the group owner can delete this group' });

    const group = db.prepare('SELECT * FROM groups_ WHERE id = ?').get(groupId);
    if (!group) return res.status(404).json({ error: 'Group not found' });

    // CASCADE via FK handles group_members, expenses, settlements, join_requests, group_invitations
    db.prepare('DELETE FROM groups_ WHERE id = ?').run(groupId);

    res.json({ success: true, message: `Group "${group.name}" has been deleted` });
});

// Add member by email (admin only)
router.post('/:id/members', authenticate, (req, res) => {
    const db = getDb();
    const groupId = parseInt(req.params.id);

    if (!isMember(db, groupId, req.userId)) return res.status(403).json({ error: 'Not a member' });
    if (!isAdmin(db, groupId, req.userId)) return res.status(403).json({ error: 'Admin only' });

    const { email } = req.body;
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email?.toLowerCase().trim());
    if (!user) return res.status(404).json({ error: 'User not found with that email' });

    const already = isMember(db, groupId, user.id);
    if (already) return res.status(409).json({ error: 'User is already a member' });

    db.prepare('INSERT INTO group_members (group_id, user_id, role) VALUES (?, ?, ?)').run(groupId, user.id, 'member');
    res.status(201).json({ message: 'Member added' });
});

// Remove member (admin only; cannot remove primary admin/creator)
router.delete('/:id/members/:uid', authenticate, (req, res) => {
    const db = getDb();
    const groupId = parseInt(req.params.id);
    const targetId = parseInt(req.params.uid);

    if (!isAdmin(db, groupId, req.userId)) return res.status(403).json({ error: 'Admin only' });

    const group = db.prepare('SELECT created_by FROM groups_ WHERE id = ?').get(groupId);
    if (targetId === group.created_by) return res.status(403).json({ error: 'Cannot remove the group creator' });

    db.prepare('DELETE FROM group_members WHERE group_id = ? AND user_id = ?').run(groupId, targetId);
    res.json({ message: 'Member removed' });
});

// Change member role (admin only; cannot change primary admin)
router.put('/:id/members/:uid/role', authenticate, (req, res) => {
    const db = getDb();
    const groupId = parseInt(req.params.id);
    const targetId = parseInt(req.params.uid);
    const { role } = req.body;

    if (!['admin', 'member'].includes(role)) return res.status(400).json({ error: 'Role must be admin or member' });
    if (!isAdmin(db, groupId, req.userId)) return res.status(403).json({ error: 'Admin only' });

    const group = db.prepare('SELECT created_by FROM groups_ WHERE id = ?').get(groupId);
    if (targetId === group.created_by && role === 'member') {
        return res.status(403).json({ error: 'Cannot demote the group creator' });
    }

    if (!isMember(db, groupId, targetId)) return res.status(404).json({ error: 'User is not a member' });

    db.prepare('UPDATE group_members SET role = ? WHERE group_id = ? AND user_id = ?').run(role, groupId, targetId);
    res.json({ message: `Role updated to ${role}` });
});

// --- JOIN REQUESTS ---

// Request to join (creates a pending request)
router.post('/join', authenticate, (req, res) => {
    const db = getDb();
    const { join_code } = req.body;
    if (!join_code) return res.status(400).json({ error: 'Join code is required' });

    const group = db.prepare('SELECT * FROM groups_ WHERE join_code = ?').get(join_code.toUpperCase().trim());
    if (!group) return res.status(404).json({ error: 'Invalid join code' });

    if (isMember(db, group.id, req.userId)) {
        return res.status(409).json({ error: 'You are already a member of this group' });
    }

    // Check if already requested
    const existing = db.prepare('SELECT * FROM join_requests WHERE group_id = ? AND user_id = ?').get(group.id, req.userId);
    if (existing) {
        if (existing.status === 'pending') return res.status(409).json({ error: 'You already have a pending join request for this group' });
        // Re-request if rejected
        db.prepare('UPDATE join_requests SET status = ?, requested_at = CURRENT_TIMESTAMP WHERE group_id = ? AND user_id = ?')
            .run('pending', group.id, req.userId);
    } else {
        db.prepare('INSERT INTO join_requests (group_id, user_id) VALUES (?, ?)').run(group.id, req.userId);
    }

    res.status(201).json({ message: `Join request sent to "${group.name}". Waiting for admin approval.`, group_name: group.name });
});

// Get pending join requests for a group (admin only)
router.get('/:id/join-requests', authenticate, (req, res) => {
    const db = getDb();
    const groupId = parseInt(req.params.id);

    if (!isAdmin(db, groupId, req.userId)) return res.status(403).json({ error: 'Admin only' });

    const requests = db.prepare(`
        SELECT jr.id, jr.status, jr.requested_at, u.id as user_id, u.name, u.email, u.avatar_color
        FROM join_requests jr
        JOIN users u ON u.id = jr.user_id
        WHERE jr.group_id = ? AND jr.status = 'pending'
        ORDER BY jr.requested_at ASC
    `).all(groupId);

    res.json(requests);
});

// Approve a join request (admin only)
router.post('/:id/join-requests/:uid/approve', authenticate, (req, res) => {
    const db = getDb();
    const groupId = parseInt(req.params.id);
    const userId = parseInt(req.params.uid);

    if (!isAdmin(db, groupId, req.userId)) return res.status(403).json({ error: 'Admin only' });

    const req_ = db.prepare('SELECT * FROM join_requests WHERE group_id = ? AND user_id = ? AND status = ?').get(groupId, userId, 'pending');
    if (!req_) return res.status(404).json({ error: 'No pending request found' });

    if (!isMember(db, groupId, userId)) {
        db.prepare('INSERT INTO group_members (group_id, user_id, role) VALUES (?, ?, ?)').run(groupId, userId, 'member');
    }
    db.prepare("UPDATE join_requests SET status = 'approved' WHERE group_id = ? AND user_id = ?").run(groupId, userId);

    res.json({ message: 'Request approved' });
});

// Reject a join request (admin only)
router.post('/:id/join-requests/:uid/reject', authenticate, (req, res) => {
    const db = getDb();
    const groupId = parseInt(req.params.id);
    const userId = parseInt(req.params.uid);

    if (!isAdmin(db, groupId, req.userId)) return res.status(403).json({ error: 'Admin only' });

    db.prepare("UPDATE join_requests SET status = 'rejected' WHERE group_id = ? AND user_id = ?").run(groupId, userId);
    res.json({ message: 'Request rejected' });
});

// Regenerate join code (admin only)
router.post('/:id/regen-code', authenticate, (req, res) => {
    const db = getDb();
    const groupId = parseInt(req.params.id);

    if (!isAdmin(db, groupId, req.userId)) return res.status(403).json({ error: 'Admin only' });

    let code;
    let attempts = 0;
    do { code = generateJoinCode(); attempts++; }
    while (db.prepare('SELECT 1 FROM groups_ WHERE join_code = ?').get(code) && attempts < 10);

    db.prepare('UPDATE groups_ SET join_code = ? WHERE id = ?').run(code, groupId);
    res.json({ join_code: code });
});

// ── Leave Group Flow ─────────────────────────────────────────────────────────

// Request to leave a group (member only, blocked if unsettled debts > ₹1)
router.post('/:id/leave', authenticate, (req, res) => {
    const db = getDb();
    const groupId = parseInt(req.params.id);
    const { simplifyDebts, calculateGroupBalances } = require('../utils/balanceCalculator');

    if (!isMember(db, groupId, req.userId)) {
        return res.status(403).json({ error: 'Not a member of this group' });
    }

    // Owner cannot leave — must delete the group or transfer ownership
    if (isOwner(db, groupId, req.userId)) {
        return res.status(400).json({ error: 'As the owner, you cannot leave. Delete the group or transfer ownership instead.' });
    }

    // Check for unsettled debts
    const group = db.prepare('SELECT * FROM groups_ WHERE id = ?').get(groupId);
    const balances = calculateGroupBalances(db, groupId, group?.retention_days);
    const transactions = simplifyDebts(balances, db);

    const myDebts = transactions.filter(t => t.from.id === req.userId && t.amount > 1);
    if (myDebts.length > 0) {
        const total = myDebts.reduce((s, t) => s + t.amount, 0);
        return res.status(400).json({
            error: `You have unsettled debts of ₹${total.toFixed(2)}. Please settle up before leaving.`,
            unsettled: true,
            amount: total,
        });
    }

    // Check if already requested
    const existing = db.prepare('SELECT * FROM leave_requests WHERE group_id = ? AND user_id = ?').get(groupId, req.userId);
    if (existing && existing.status === 'pending') {
        return res.status(409).json({ error: 'You already have a pending leave request for this group.' });
    }

    // Upsert leave request
    if (existing) {
        db.prepare("UPDATE leave_requests SET status = 'pending', requested_at = CURRENT_TIMESTAMP WHERE group_id = ? AND user_id = ?")
            .run(groupId, req.userId);
    } else {
        db.prepare('INSERT INTO leave_requests (group_id, user_id) VALUES (?, ?)').run(groupId, req.userId);
    }

    res.status(201).json({ message: 'Leave request sent. Waiting for admin approval.' });
});

// Get pending leave requests for a group (admin only)
router.get('/:id/leave-requests', authenticate, (req, res) => {
    const db = getDb();
    const groupId = parseInt(req.params.id);

    if (!isAdmin(db, groupId, req.userId)) return res.status(403).json({ error: 'Admin only' });

    const requests = db.prepare(`
        SELECT lr.id, lr.status, lr.requested_at,
               u.id as user_id, u.name, u.email, u.avatar_color
        FROM leave_requests lr
        JOIN users u ON u.id = lr.user_id
        WHERE lr.group_id = ? AND lr.status = 'pending'
        ORDER BY lr.requested_at ASC
    `).all(groupId);

    res.json(requests);
});

// Approve a leave request — removes member but keeps all expense/settlement data
router.post('/:id/leave-requests/:uid/approve', authenticate, (req, res) => {
    const db = getDb();
    const groupId = parseInt(req.params.id);
    const userId = parseInt(req.params.uid);

    if (!isAdmin(db, groupId, req.userId)) return res.status(403).json({ error: 'Admin only' });

    const leaveReq = db.prepare("SELECT * FROM leave_requests WHERE group_id = ? AND user_id = ? AND status = 'pending'")
        .get(groupId, userId);
    if (!leaveReq) return res.status(404).json({ error: 'No pending leave request found' });

    db.transaction(() => {
        // Remove from group_members — expenses/splits/settlements are NOT deleted
        db.prepare('DELETE FROM group_members WHERE group_id = ? AND user_id = ?').run(groupId, userId);
        db.prepare("UPDATE leave_requests SET status = 'approved' WHERE group_id = ? AND user_id = ?").run(groupId, userId);
    })();

    res.json({ message: 'Leave request approved. Member removed. Their expense history is preserved.' });
});

// Reject a leave request
router.post('/:id/leave-requests/:uid/reject', authenticate, (req, res) => {
    const db = getDb();
    const groupId = parseInt(req.params.id);
    const userId = parseInt(req.params.uid);

    if (!isAdmin(db, groupId, req.userId)) return res.status(403).json({ error: 'Admin only' });

    db.prepare("UPDATE leave_requests SET status = 'rejected' WHERE group_id = ? AND user_id = ?").run(groupId, userId);
    res.json({ message: 'Leave request rejected' });
});

module.exports = router;

