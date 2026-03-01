const express = require('express');
const { query } = require('../db/database');
const { authenticate } = require('../middleware/auth');
const { calculateGroupBalances, simplifyDebts } = require('../utils/balanceCalculator');

const router = express.Router();

// ─── Helper: build date filter ──────────────────────────────────────────────
// Returns a SQL fragment (no user input interpolated directly — dates are validated)
function buildDateFilter(startDate, endDate, alias = 'e') {
  const filters = [];
  if (startDate) filters.push(`${alias}.date >= '${startDate}'`);
  if (endDate) filters.push(`${alias}.date <= '${endDate}'`);
  return filters.length ? 'AND ' + filters.join(' AND ') : '';
}

// ─── Dashboard summary ───────────────────────────────────────────────────────
router.get('/dashboard', authenticate, async (req, res) => {
  try {
    const groups = await query(`
            SELECT g.id, g.name, g.retention_days FROM groups_ g
            JOIN group_members gm ON g.id = gm.group_id WHERE gm.user_id = $1
        `, [req.userId]);

    let totalOwed = 0, totalOwe = 0;
    const groupBalances = [];

    await Promise.all(groups.rows.map(async (group) => {
      const balances = await calculateGroupBalances(group.id, group.retention_days);
      const myBalance = balances.find(b => b.userId === Number(req.userId));
      if (myBalance) {
        if (myBalance.amount > 0.01) totalOwed += myBalance.amount;
        else if (myBalance.amount < -0.01) totalOwe += Math.abs(myBalance.amount);
        groupBalances.push({
          groupId: group.id,
          groupName: group.name,
          balance: Math.round(myBalance.amount * 100) / 100,
        });
      }
    }));

    res.json({
      totalOwed: Math.round(totalOwed * 100) / 100,
      totalOwe: Math.round(totalOwe * 100) / 100,
      netBalance: Math.round((totalOwed - totalOwe) * 100) / 100,
      groupBalances,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── My spending: category breakdown ────────────────────────────────────────
router.get('/my/categories', authenticate, async (req, res) => {
  try {
    const { startDate, endDate, groupId } = req.query;
    const dateFilter = buildDateFilter(startDate, endDate);
    const params = [req.userId, req.userId];
    let groupFilter = '';
    if (groupId && groupId !== 'all') { groupFilter = `AND e.group_id = $3`; params.push(parseInt(groupId)); }

    const spending = await query(`
            SELECT c.name, c.icon, c.color,
                SUM(es.amount_owed) AS total,
                COUNT(DISTINCT e.id) AS count
            FROM expense_splits es
            JOIN expenses e ON es.expense_id = e.id
            LEFT JOIN categories c ON e.category_id = c.id
            JOIN group_members gm ON e.group_id = gm.group_id AND gm.user_id = $1
            WHERE es.user_id = $2 ${dateFilter} ${groupFilter}
            GROUP BY c.id, c.name, c.icon, c.color
            ORDER BY total DESC
        `, params);
    res.json(spending.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── My spending: monthly timeline ───────────────────────────────────────────
router.get('/my/timeline', authenticate, async (req, res) => {
  try {
    const { startDate, endDate, groupId } = req.query;
    const dateFilter = buildDateFilter(startDate, endDate);
    const params = [req.userId, req.userId];
    let groupFilter = '';
    if (groupId && groupId !== 'all') { groupFilter = `AND e.group_id = $3`; params.push(parseInt(groupId)); }

    const spending = await query(`
            SELECT TO_CHAR(e.date, 'YYYY-MM') AS month,
                SUM(es.amount_owed) AS total
            FROM expense_splits es
            JOIN expenses e ON es.expense_id = e.id
            JOIN group_members gm ON e.group_id = gm.group_id AND gm.user_id = $1
            WHERE es.user_id = $2 ${dateFilter} ${groupFilter}
            GROUP BY TO_CHAR(e.date, 'YYYY-MM')
            ORDER BY month ASC
        `, params);
    res.json(spending.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── My spending: per-group summary ──────────────────────────────────────────
router.get('/my/groups', authenticate, async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const dateFilter = buildDateFilter(startDate, endDate);

    const spending = await query(`
            SELECT g.name AS group_name, g.id AS group_id,
                SUM(es.amount_owed) AS total
            FROM expense_splits es
            JOIN expenses e ON es.expense_id = e.id
            JOIN groups_ g ON e.group_id = g.id
            JOIN group_members gm ON e.group_id = gm.group_id AND gm.user_id = $1
            WHERE es.user_id = $2 ${dateFilter}
            GROUP BY g.id, g.name
            ORDER BY total DESC
        `, [req.userId, req.userId]);
    res.json(spending.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── Group detail: category breakdown ────────────────────────────────────────
router.get('/group/:id/categories', authenticate, async (req, res) => {
  try {
    const groupId = parseInt(req.params.id);
    const { startDate, endDate } = req.query;
    const dateFilter = buildDateFilter(startDate, endDate);

    const member = await query('SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2', [groupId, req.userId]);
    if (!member.rows.length) return res.status(403).json({ error: 'Not a member' });

    const spending = await query(`
            SELECT c.name, c.icon, c.color,
                SUM(e.amount) AS total,
                COUNT(DISTINCT e.id) AS count
            FROM expenses e
            LEFT JOIN categories c ON e.category_id = c.id
            WHERE e.group_id = $1 ${dateFilter}
            GROUP BY c.id, c.name, c.icon, c.color
            ORDER BY total DESC
        `, [groupId]);
    res.json(spending.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── Group detail: member-wise spending ──────────────────────────────────────
router.get('/group/:id/members', authenticate, async (req, res) => {
  try {
    const groupId = parseInt(req.params.id);
    const { startDate, endDate } = req.query;
    const dateFilter = buildDateFilter(startDate, endDate);

    const member = await query('SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2', [groupId, req.userId]);
    if (!member.rows.length) return res.status(403).json({ error: 'Not a member' });

    const memberSpend = await query(`
            SELECT u.name, u.avatar_color,
                SUM(ep.amount_paid) AS total_paid,
                COUNT(DISTINCT e.id) AS expense_count
            FROM expense_payers ep
            JOIN expenses e ON ep.expense_id = e.id
            JOIN users u ON ep.user_id = u.id
            WHERE e.group_id = $1 ${dateFilter}
            GROUP BY ep.user_id, u.name, u.avatar_color
            ORDER BY total_paid DESC
        `, [groupId]);
    res.json(memberSpend.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── Group detail: monthly timeline ──────────────────────────────────────────
router.get('/group/:id/timeline', authenticate, async (req, res) => {
  try {
    const groupId = parseInt(req.params.id);
    const { startDate, endDate } = req.query;
    const dateFilter = buildDateFilter(startDate, endDate);

    const member = await query('SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2', [groupId, req.userId]);
    if (!member.rows.length) return res.status(403).json({ error: 'Not a member' });

    const timeline = await query(`
            SELECT TO_CHAR(e.date, 'YYYY-MM') AS month,
                SUM(e.amount) AS total
            FROM expenses e
            WHERE e.group_id = $1 ${dateFilter}
            GROUP BY TO_CHAR(e.date, 'YYYY-MM')
            ORDER BY month ASC
        `, [groupId]);
    res.json(timeline.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── All groups: per-group totals ─────────────────────────────────────────────
router.get('/groups/summary', authenticate, async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const dateFilter = buildDateFilter(startDate, endDate);

    const summary = await query(`
            SELECT g.name AS group_name, g.id AS group_id,
                SUM(e.amount) AS total,
                COUNT(DISTINCT e.id) AS expense_count
            FROM expenses e
            JOIN groups_ g ON e.group_id = g.id
            JOIN group_members gm ON e.group_id = gm.group_id AND gm.user_id = $1
            WHERE 1=1 ${dateFilter}
            GROUP BY g.id, g.name
            ORDER BY total DESC
        `, [req.userId]);
    res.json(summary.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── All groups: combined category breakdown ──────────────────────────────────
router.get('/groups/categories', authenticate, async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const dateFilter = buildDateFilter(startDate, endDate);

    const spending = await query(`
            SELECT c.name, c.icon, c.color,
                SUM(e.amount) AS total,
                COUNT(DISTINCT e.id) AS count
            FROM expenses e
            LEFT JOIN categories c ON e.category_id = c.id
            JOIN group_members gm ON e.group_id = gm.group_id AND gm.user_id = $1
            WHERE 1=1 ${dateFilter}
            GROUP BY c.id, c.name, c.icon, c.color
            ORDER BY total DESC
        `, [req.userId]);
    res.json(spending.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── All groups: per-group monthly timelines ──────────────────────────────────
router.get('/groups/timelines', authenticate, async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const dateFilter = buildDateFilter(startDate, endDate);

    const timelines = await query(`
            SELECT g.name AS group_name, g.id AS group_id,
                TO_CHAR(e.date, 'YYYY-MM') AS month,
                SUM(e.amount) AS total
            FROM expenses e
            JOIN groups_ g ON e.group_id = g.id
            JOIN group_members gm ON e.group_id = gm.group_id AND gm.user_id = $1
            WHERE 1=1 ${dateFilter}
            GROUP BY g.id, g.name, TO_CHAR(e.date, 'YYYY-MM')
            ORDER BY month ASC
        `, [req.userId]);
    res.json(timelines.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── Legacy endpoints (backward compat) ──────────────────────────────────────
router.get('/categories', authenticate, async (req, res) => {
  try {
    const { period } = req.query;
    let dateFilter = '';
    if (period === 'month') dateFilter = `AND e.date >= CURRENT_DATE - INTERVAL '1 month'`;
    else if (period === '3months') dateFilter = `AND e.date >= CURRENT_DATE - INTERVAL '3 months'`;
    else if (period === '6months') dateFilter = `AND e.date >= CURRENT_DATE - INTERVAL '6 months'`;
    else if (period === 'year') dateFilter = `AND e.date >= CURRENT_DATE - INTERVAL '1 year'`;

    const spending = await query(`
            SELECT c.name, c.icon, c.color,
                SUM(es.amount_owed) AS total, COUNT(DISTINCT e.id) AS count
            FROM expense_splits es
            JOIN expenses e ON es.expense_id = e.id
            LEFT JOIN categories c ON e.category_id = c.id
            JOIN group_members gm ON e.group_id = gm.group_id AND gm.user_id = $1
            WHERE es.user_id = $2 ${dateFilter}
            GROUP BY c.id, c.name, c.icon, c.color ORDER BY total DESC
        `, [req.userId, req.userId]);
    res.json(spending.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.get('/spending', authenticate, async (req, res) => {
  try {
    const { period } = req.query;
    let months = 6;
    if (period === 'month') months = 1;
    else if (period === '3months') months = 3;
    else if (period === 'year') months = 12;

    const spending = await query(`
            SELECT TO_CHAR(e.date, 'YYYY-MM') AS month, SUM(es.amount_owed) AS total
            FROM expense_splits es
            JOIN expenses e ON es.expense_id = e.id
            JOIN group_members gm ON e.group_id = gm.group_id AND gm.user_id = $1
            WHERE es.user_id = $2 AND e.date >= CURRENT_DATE - INTERVAL '${months} months'
            GROUP BY TO_CHAR(e.date, 'YYYY-MM') ORDER BY month ASC
        `, [req.userId, req.userId]);
    res.json(spending.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.get('/groups', authenticate, async (req, res) => {
  try {
    const { period } = req.query;
    let dateFilter = '';
    if (period === 'month') dateFilter = `AND e.date >= CURRENT_DATE - INTERVAL '1 month'`;
    else if (period === '3months') dateFilter = `AND e.date >= CURRENT_DATE - INTERVAL '3 months'`;
    else if (period === '6months') dateFilter = `AND e.date >= CURRENT_DATE - INTERVAL '6 months'`;
    else if (period === 'year') dateFilter = `AND e.date >= CURRENT_DATE - INTERVAL '1 year'`;

    const spending = await query(`
            SELECT g.name AS group_name, g.id AS group_id, SUM(es.amount_owed) AS total
            FROM expense_splits es
            JOIN expenses e ON es.expense_id = e.id
            JOIN groups_ g ON e.group_id = g.id
            JOIN group_members gm ON e.group_id = gm.group_id AND gm.user_id = $1
            WHERE es.user_id = $2 ${dateFilter}
            GROUP BY g.id, g.name ORDER BY total DESC
        `, [req.userId, req.userId]);
    res.json(spending.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
