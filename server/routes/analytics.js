const express = require('express');
const { getDb } = require('../db/database');
const { authenticate } = require('../middleware/auth');
const { calculateGroupBalances, simplifyDebts } = require('../utils/balanceCalculator');

const router = express.Router();

// ── Helper: build date filter from startDate / endDate query params ──────────
function buildDateFilter(startDate, endDate, alias = 'e') {
    const filters = [];
    if (startDate) filters.push(`${alias}.date >= '${startDate}'`);
    if (endDate) filters.push(`${alias}.date <= '${endDate}'`);
    return filters.length ? 'AND ' + filters.join(' AND ') : '';
}

// ── Dashboard summary ────────────────────────────────────────────────────────
router.get('/dashboard', authenticate, (req, res) => {
    const db = getDb();

    const groups = db.prepare(`
    SELECT g.id, g.name, g.retention_days FROM groups_ g
    JOIN group_members gm ON g.id = gm.group_id WHERE gm.user_id = ?
  `).all(req.userId);

    let totalOwed = 0;
    let totalOwe = 0;
    const groupBalances = [];

    for (const group of groups) {
        const balances = calculateGroupBalances(db, group.id, group.retention_days);
        const myBalance = balances.find(b => b.userId === req.userId);
        if (myBalance) {
            if (myBalance.amount > 0.01) totalOwed += myBalance.amount;
            else if (myBalance.amount < -0.01) totalOwe += Math.abs(myBalance.amount);
            groupBalances.push({
                groupId: group.id,
                groupName: group.name,
                balance: Math.round(myBalance.amount * 100) / 100,
            });
        }
    }

    res.json({
        totalOwed: Math.round(totalOwed * 100) / 100,
        totalOwe: Math.round(totalOwe * 100) / 100,
        netBalance: Math.round((totalOwed - totalOwe) * 100) / 100,
        groupBalances,
    });
});

// ── My spending: category breakdown ─────────────────────────────────────────
// GET /analytics/my/categories?startDate=&endDate=&groupId=all|<id>
router.get('/my/categories', authenticate, (req, res) => {
    const db = getDb();
    const { startDate, endDate, groupId } = req.query;
    const dateFilter = buildDateFilter(startDate, endDate);

    let groupFilter = '';
    const params = [req.userId, req.userId];

    if (groupId && groupId !== 'all') {
        groupFilter = 'AND e.group_id = ?';
        params.push(parseInt(groupId));
    }

    const spending = db.prepare(`
    SELECT c.name, c.icon, c.color,
      SUM(es.amount_owed) as total,
      COUNT(DISTINCT e.id) as count
    FROM expense_splits es
    JOIN expenses e ON es.expense_id = e.id
    LEFT JOIN categories c ON e.category_id = c.id
    JOIN group_members gm ON e.group_id = gm.group_id AND gm.user_id = ?
    WHERE es.user_id = ? ${dateFilter} ${groupFilter}
    GROUP BY c.id
    ORDER BY total DESC
  `).all(...params);

    res.json(spending);
});

// ── My spending: monthly timeline ────────────────────────────────────────────
// GET /analytics/my/timeline?startDate=&endDate=&groupId=all|<id>
router.get('/my/timeline', authenticate, (req, res) => {
    const db = getDb();
    const { startDate, endDate, groupId } = req.query;
    const dateFilter = buildDateFilter(startDate, endDate);

    let groupFilter = '';
    const params = [req.userId, req.userId];

    if (groupId && groupId !== 'all') {
        groupFilter = 'AND e.group_id = ?';
        params.push(parseInt(groupId));
    }

    const spending = db.prepare(`
    SELECT strftime('%Y-%m', e.date) as month,
      SUM(es.amount_owed) as total
    FROM expense_splits es
    JOIN expenses e ON es.expense_id = e.id
    JOIN group_members gm ON e.group_id = gm.group_id AND gm.user_id = ?
    WHERE es.user_id = ? ${dateFilter} ${groupFilter}
    GROUP BY strftime('%Y-%m', e.date)
    ORDER BY month ASC
  `).all(...params);

    res.json(spending);
});

// ── My spending: per-group summary (bar chart) ───────────────────────────────
// GET /analytics/my/groups?startDate=&endDate=
router.get('/my/groups', authenticate, (req, res) => {
    const db = getDb();
    const { startDate, endDate } = req.query;
    const dateFilter = buildDateFilter(startDate, endDate);

    const spending = db.prepare(`
    SELECT g.name as group_name, g.id as group_id,
      SUM(es.amount_owed) as total
    FROM expense_splits es
    JOIN expenses e ON es.expense_id = e.id
    JOIN groups_ g ON e.group_id = g.id
    JOIN group_members gm ON e.group_id = gm.group_id AND gm.user_id = ?
    WHERE es.user_id = ? ${dateFilter}
    GROUP BY g.id
    ORDER BY total DESC
  `).all(req.userId, req.userId);

    res.json(spending);
});

// ── Group detail: category breakdown ─────────────────────────────────────────
// GET /analytics/group/:id/categories?startDate=&endDate=
router.get('/group/:id/categories', authenticate, (req, res) => {
    const db = getDb();
    const groupId = parseInt(req.params.id);
    const { startDate, endDate } = req.query;
    const dateFilter = buildDateFilter(startDate, endDate);

    const isMember = db.prepare('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?').get(groupId, req.userId);
    if (!isMember) return res.status(403).json({ error: 'Not a member' });

    const spending = db.prepare(`
    SELECT c.name, c.icon, c.color,
      SUM(e.amount) as total,
      COUNT(DISTINCT e.id) as count
    FROM expenses e
    LEFT JOIN categories c ON e.category_id = c.id
    WHERE e.group_id = ? ${dateFilter}
    GROUP BY c.id
    ORDER BY total DESC
  `).all(groupId);

    res.json(spending);
});

// ── Group detail: member-wise spending ───────────────────────────────────────
// GET /analytics/group/:id/members?startDate=&endDate=
router.get('/group/:id/members', authenticate, (req, res) => {
    const db = getDb();
    const groupId = parseInt(req.params.id);
    const { startDate, endDate } = req.query;
    const dateFilter = buildDateFilter(startDate, endDate);

    const isMember = db.prepare('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?').get(groupId, req.userId);
    if (!isMember) return res.status(403).json({ error: 'Not a member' });

    // How much each member paid (as payer)
    const memberSpend = db.prepare(`
    SELECT u.name, u.avatar_color,
      SUM(ep.amount_paid) as total_paid,
      COUNT(DISTINCT e.id) as expense_count
    FROM expense_payers ep
    JOIN expenses e ON ep.expense_id = e.id
    JOIN users u ON ep.user_id = u.id
    WHERE e.group_id = ? ${dateFilter}
    GROUP BY ep.user_id
    ORDER BY total_paid DESC
  `).all(groupId);

    res.json(memberSpend);
});

// ── Group detail: monthly timeline ───────────────────────────────────────────
// GET /analytics/group/:id/timeline?startDate=&endDate=
router.get('/group/:id/timeline', authenticate, (req, res) => {
    const db = getDb();
    const groupId = parseInt(req.params.id);
    const { startDate, endDate } = req.query;
    const dateFilter = buildDateFilter(startDate, endDate);

    const isMember = db.prepare('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?').get(groupId, req.userId);
    if (!isMember) return res.status(403).json({ error: 'Not a member' });

    const timeline = db.prepare(`
    SELECT strftime('%Y-%m', e.date) as month,
      SUM(e.amount) as total
    FROM expenses e
    WHERE e.group_id = ? ${dateFilter}
    GROUP BY strftime('%Y-%m', e.date)
    ORDER BY month ASC
  `).all(groupId);

    res.json(timeline);
});

// ── All groups summary: per-group totals (bar chart) ─────────────────────────
// GET /analytics/groups/summary?startDate=&endDate=
router.get('/groups/summary', authenticate, (req, res) => {
    const db = getDb();
    const { startDate, endDate } = req.query;
    const dateFilter = buildDateFilter(startDate, endDate);

    const summary = db.prepare(`
    SELECT g.name as group_name, g.id as group_id,
      SUM(e.amount) as total,
      COUNT(DISTINCT e.id) as expense_count
    FROM expenses e
    JOIN groups_ g ON e.group_id = g.id
    JOIN group_members gm ON e.group_id = gm.group_id AND gm.user_id = ?
    WHERE 1=1 ${dateFilter}
    GROUP BY g.id
    ORDER BY total DESC
  `).all(req.userId);

    res.json(summary);
});

// ── All groups: category breakdown (combined pie) ─────────────────────────────
// GET /analytics/groups/categories?startDate=&endDate=
router.get('/groups/categories', authenticate, (req, res) => {
    const db = getDb();
    const { startDate, endDate } = req.query;
    const dateFilter = buildDateFilter(startDate, endDate);

    const spending = db.prepare(`
    SELECT c.name, c.icon, c.color,
      SUM(e.amount) as total,
      COUNT(DISTINCT e.id) as count
    FROM expenses e
    LEFT JOIN categories c ON e.category_id = c.id
    JOIN group_members gm ON e.group_id = gm.group_id AND gm.user_id = ?
    WHERE 1=1 ${dateFilter}
    GROUP BY c.id
    ORDER BY total DESC
  `).all(req.userId);

    res.json(spending);
});

// ── All groups: per-group monthly timelines ───────────────────────────────────
// GET /analytics/groups/timelines?startDate=&endDate=
router.get('/groups/timelines', authenticate, (req, res) => {
    const db = getDb();
    const { startDate, endDate } = req.query;
    const dateFilter = buildDateFilter(startDate, endDate);

    // Returns rows: { group_name, group_id, month, total }
    const timelines = db.prepare(`
    SELECT g.name as group_name, g.id as group_id,
      strftime('%Y-%m', e.date) as month,
      SUM(e.amount) as total
    FROM expenses e
    JOIN groups_ g ON e.group_id = g.id
    JOIN group_members gm ON e.group_id = gm.group_id AND gm.user_id = ?
    WHERE 1=1 ${dateFilter}
    GROUP BY g.id, strftime('%Y-%m', e.date)
    ORDER BY month ASC
  `).all(req.userId);

    res.json(timelines);
});

// ── Legacy endpoints (backward compat with old charts.js period param) ────────
router.get('/categories', authenticate, (req, res) => {
    const db = getDb();
    const { period } = req.query;
    let dateFilter = '';
    if (period === 'month') dateFilter = "AND e.date >= date('now', '-1 month')";
    else if (period === '3months') dateFilter = "AND e.date >= date('now', '-3 months')";
    else if (period === '6months') dateFilter = "AND e.date >= date('now', '-6 months')";
    else if (period === 'year') dateFilter = "AND e.date >= date('now', '-1 year')";

    const spending = db.prepare(`
    SELECT c.name, c.icon, c.color,
      SUM(es.amount_owed) as total, COUNT(DISTINCT e.id) as count
    FROM expense_splits es
    JOIN expenses e ON es.expense_id = e.id
    LEFT JOIN categories c ON e.category_id = c.id
    JOIN group_members gm ON e.group_id = gm.group_id AND gm.user_id = ?
    WHERE es.user_id = ? ${dateFilter}
    GROUP BY c.id ORDER BY total DESC
  `).all(req.userId, req.userId);
    res.json(spending);
});

router.get('/spending', authenticate, (req, res) => {
    const db = getDb();
    const { period } = req.query;
    let months = 6;
    if (period === 'month') months = 1;
    else if (period === '3months') months = 3;
    else if (period === 'year') months = 12;

    const spending = db.prepare(`
    SELECT strftime('%Y-%m', e.date) as month, SUM(es.amount_owed) as total
    FROM expense_splits es
    JOIN expenses e ON es.expense_id = e.id
    JOIN group_members gm ON e.group_id = gm.group_id AND gm.user_id = ?
    WHERE es.user_id = ? AND e.date >= date('now', '-${months} months')
    GROUP BY strftime('%Y-%m', e.date) ORDER BY month ASC
  `).all(req.userId, req.userId);
    res.json(spending);
});

router.get('/groups', authenticate, (req, res) => {
    const db = getDb();
    const { period } = req.query;
    let dateFilter = '';
    if (period === 'month') dateFilter = "AND e.date >= date('now', '-1 month')";
    else if (period === '3months') dateFilter = "AND e.date >= date('now', '-3 months')";
    else if (period === '6months') dateFilter = "AND e.date >= date('now', '-6 months')";
    else if (period === 'year') dateFilter = "AND e.date >= date('now', '-1 year')";

    const spending = db.prepare(`
    SELECT g.name as group_name, g.id as group_id, SUM(es.amount_owed) as total
    FROM expense_splits es
    JOIN expenses e ON es.expense_id = e.id
    JOIN groups_ g ON e.group_id = g.id
    JOIN group_members gm ON e.group_id = gm.group_id AND gm.user_id = ?
    WHERE es.user_id = ? ${dateFilter}
    GROUP BY g.id ORDER BY total DESC
  `).all(req.userId, req.userId);
    res.json(spending);
});

module.exports = router;
