const express = require('express');
const { query, withTransaction } = require('../db/database');
const { authenticate } = require('../middleware/auth');
const { categorize } = require('../utils/categorizer');
const { sendExpenseNotification } = require('../utils/mailer');
const { enqueue } = require('../utils/queue');

const router = express.Router();

// ─── Helper: get full expense with payers and splits ─────────────────────────
async function getFullExpense(expenseId) {
    const result = await query(`
        SELECT e.*, c.name AS category_name, c.icon AS category_icon, c.color AS category_color,
               u.name AS paid_by_name, u.avatar_color AS paid_by_color
        FROM expenses e
        LEFT JOIN categories c ON e.category_id = c.id
        LEFT JOIN users u ON e.paid_by = u.id
        WHERE e.id = $1
    `, [expenseId]);

    if (!result.rows.length) return null;
    const expense = result.rows[0];

    const payers = await query(`
        SELECT ep.*, u.name AS user_name, u.avatar_color
        FROM expense_payers ep
        JOIN users u ON ep.user_id = u.id
        WHERE ep.expense_id = $1
    `, [expenseId]);
    expense.payers = payers.rows;

    const splits = await query(`
        SELECT es.*, u.name AS user_name, u.avatar_color
        FROM expense_splits es
        JOIN users u ON es.user_id = u.id
        WHERE es.expense_id = $1
    `, [expenseId]);
    expense.splits = splits.rows;

    return expense;
}

// ─── Helper: insert payers and splits (uses a pg client inside a transaction) ─
async function insertPayersAndSplits(client, expenseId, groupId, amount, splitType, payers, splits, involvedMembers) {
    for (const p of payers) {
        await client.query(
            'INSERT INTO expense_payers (expense_id, user_id, amount_paid) VALUES ($1, $2, $3)',
            [expenseId, p.user_id, p.amount_paid]
        );
    }

    if (splitType === 'exact' && splits && splits.length) {
        for (const s of splits) {
            await client.query(
                'INSERT INTO expense_splits (expense_id, user_id, amount_owed) VALUES ($1, $2, $3)',
                [expenseId, s.user_id, s.amount]
            );
        }
    } else if (splitType === 'percentage' && splits && splits.length) {
        for (const s of splits) {
            const owed = Math.round((amount * s.percentage / 100) * 100) / 100;
            await client.query(
                'INSERT INTO expense_splits (expense_id, user_id, amount_owed) VALUES ($1, $2, $3)',
                [expenseId, s.user_id, owed]
            );
        }
    } else {
        // Equal split
        let memberIds;
        if (involvedMembers && involvedMembers.length) {
            memberIds = involvedMembers;
        } else {
            const members = await client.query('SELECT user_id FROM group_members WHERE group_id = $1', [groupId]);
            memberIds = members.rows.map(m => m.user_id);
        }
        const splitAmount = Math.round((amount / memberIds.length) * 100) / 100;
        for (const userId of memberIds) {
            await client.query(
                'INSERT INTO expense_splits (expense_id, user_id, amount_owed) VALUES ($1, $2, $3)',
                [expenseId, userId, splitAmount]
            );
        }
    }
}

// ─── Helper: collect involved user IDs (payers ∪ split members) ──────────────
function buildInvolvedSet(payers, splits, splitType, involvedMembers, allGroupMemberIds) {
    const ids = new Set();
    if (payers) payers.forEach(p => ids.add(Number(p.user_id)));
    if (splitType === 'exact' || splitType === 'percentage') {
        if (splits) splits.forEach(s => ids.add(Number(s.user_id)));
    } else {
        // equal split
        const members = (involvedMembers && involvedMembers.length) ? involvedMembers : allGroupMemberIds;
        members.forEach(id => ids.add(Number(id)));
    }
    return ids;
}

// ─── GET expenses for a group ─────────────────────────────────────────────────
router.get('/group/:groupId', authenticate, async (req, res) => {
    try {
        const { groupId } = req.params;
        const { category, startDate, endDate, limit, offset } = req.query;

        const member = await query('SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2', [groupId, req.userId]);
        if (!member.rows.length) return res.status(403).json({ error: 'Not a member of this group' });

        const group = await query('SELECT retention_days FROM groups_ WHERE id = $1', [groupId]);
        const retentionDays = group.rows[0]?.retention_days;

        const params = [groupId];
        let idx = 2;
        let conditions = '';

        if (retentionDays && retentionDays > 0) {
            conditions += ` AND e.date >= CURRENT_DATE - INTERVAL '${parseInt(retentionDays)} days'`;
        }
        if (category) { conditions += ` AND e.category_id = $${idx++}`; params.push(category); }
        if (startDate) { conditions += ` AND e.date >= $${idx++}`; params.push(startDate); }
        if (endDate) { conditions += ` AND e.date <= $${idx++}`; params.push(endDate); }

        let sql = `
            SELECT e.*, c.name AS category_name, c.icon AS category_icon, c.color AS category_color,
                   u.name AS paid_by_name, u.avatar_color AS paid_by_color
            FROM expenses e
            LEFT JOIN categories c ON e.category_id = c.id
            LEFT JOIN users u ON e.paid_by = u.id
            WHERE e.group_id = $1 ${conditions}
            ORDER BY e.date DESC, e.created_at DESC
        `;
        if (limit) {
            sql += ` LIMIT $${idx++}`; params.push(parseInt(limit));
            if (offset) { sql += ` OFFSET $${idx++}`; params.push(parseInt(offset)); }
        }

        const expenses = await query(sql, params);
        const rows = expenses.rows;

        // Fetch payers/splits in parallel per expense
        await Promise.all(rows.map(async (exp) => {
            const [p, s] = await Promise.all([
                query('SELECT ep.*, u.name AS user_name, u.avatar_color FROM expense_payers ep JOIN users u ON ep.user_id = u.id WHERE ep.expense_id = $1', [exp.id]),
                query('SELECT es.*, u.name AS user_name, u.avatar_color FROM expense_splits es JOIN users u ON es.user_id = u.id WHERE es.expense_id = $1', [exp.id]),
            ]);
            exp.payers = p.rows;
            exp.splits = s.rows;
        }));

        res.json(rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

// ─── GET recent expenses ──────────────────────────────────────────────────────
router.get('/recent', authenticate, async (req, res) => {
    try {
        const expenses = await query(`
            SELECT e.*, c.name AS category_name, c.icon AS category_icon, c.color AS category_color,
                   u.name AS paid_by_name, u.avatar_color AS paid_by_color, g.name AS group_name
            FROM expenses e
            LEFT JOIN categories c ON e.category_id = c.id
            LEFT JOIN users u ON e.paid_by = u.id
            LEFT JOIN groups_ g ON e.group_id = g.id
            JOIN group_members gm ON e.group_id = gm.group_id AND gm.user_id = $1
            ORDER BY e.date DESC, e.created_at DESC LIMIT 100
        `, [req.userId]);

        const rows = expenses.rows;
        await Promise.all(rows.map(async (exp) => {
            const p = await query(
                'SELECT ep.*, u.name AS user_name FROM expense_payers ep JOIN users u ON ep.user_id = u.id WHERE ep.expense_id = $1',
                [exp.id]
            );
            exp.payers = p.rows;
        }));

        res.json(rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

// ─── GET all categories ───────────────────────────────────────────────────────
router.get('/categories', authenticate, async (req, res) => {
    try {
        const cats = await query(`
            SELECT * FROM categories
            WHERE is_custom = 0 OR created_by = $1
            ORDER BY is_custom ASC, id ASC
        `, [req.userId]);
        // keywords is JSONB — already an array from pg, no need to JSON.parse
        const result = cats.rows.map(c => ({
            ...c,
            keywords: Array.isArray(c.keywords) ? c.keywords : (c.keywords ? c.keywords : []),
        }));
        res.json(result);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

// ─── POST create custom category ─────────────────────────────────────────────
router.post('/categories', authenticate, async (req, res) => {
    try {
        const { name, icon, color, keywords } = req.body;
        if (!name || !name.trim()) return res.status(400).json({ error: 'Category name is required' });
        if (!icon) return res.status(400).json({ error: 'Category icon is required' });
        if (!color) return res.status(400).json({ error: 'Category color is required' });

        const existing = await query('SELECT id FROM categories WHERE LOWER(name) = LOWER($1)', [name.trim()]);
        if (existing.rows.length) return res.status(409).json({ error: 'A category with this name already exists' });

        let kwJson = null;
        if (Array.isArray(keywords) && keywords.length) {
            const cleaned = keywords.map(k => k.trim().toLowerCase()).filter(Boolean);
            if (cleaned.length) kwJson = cleaned; // store as native array for JSONB
        }

        const result = await query(
            'INSERT INTO categories (name, icon, color, is_custom, created_by, keywords) VALUES ($1, $2, $3, 1, $4, $5) RETURNING *',
            [name.trim(), icon.trim(), color.trim(), req.userId, kwJson ? JSON.stringify(kwJson) : null]
        );
        const cat = result.rows[0];
        res.status(201).json({ ...cat, keywords: cat.keywords || [] });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

// ─── DELETE custom category ───────────────────────────────────────────────────
router.delete('/categories/:id', authenticate, async (req, res) => {
    try {
        const catId = parseInt(req.params.id);
        const catResult = await query('SELECT * FROM categories WHERE id = $1', [catId]);
        if (!catResult.rows.length) return res.status(404).json({ error: 'Category not found' });
        const category = catResult.rows[0];
        if (!category.is_custom) return res.status(403).json({ error: 'Cannot delete system categories' });
        if (Number(category.created_by) !== Number(req.userId)) return res.status(403).json({ error: 'Only the creator can delete this category' });

        await query('UPDATE expenses SET category_id = 10 WHERE category_id = $1', [catId]);
        await query('DELETE FROM categories WHERE id = $1', [catId]);
        res.json({ success: true, message: 'Category deleted. Expenses moved to "Other".' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

// ─── POST auto-categorize ─────────────────────────────────────────────────────
router.post('/auto-categorize', authenticate, async (req, res) => {
    try {
        const { description } = req.body;
        const categoryName = await categorize(description, true);
        const cat = await query('SELECT * FROM categories WHERE name = $1', [categoryName]);
        res.json(cat.rows[0] || { id: 10, name: 'Other', icon: '📦', color: '#64748b' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

// ─── POST add expense ─────────────────────────────────────────────────────────
router.post('/group/:groupId', authenticate, async (req, res) => {
    try {
        const { groupId } = req.params;
        const { amount, description, category_id, split_type, date, payers, splits, involved_members } = req.body;

        if (!description) return res.status(400).json({ error: 'Description is required' });
        if (!payers || !payers.length) return res.status(400).json({ error: 'At least one payer is required' });

        const totalAmount = payers.reduce((sum, p) => sum + Number(p.amount_paid), 0);
        if (totalAmount <= 0) return res.status(400).json({ error: 'Total amount must be greater than 0' });
        if (amount && Math.abs(Number(amount) - totalAmount) > 0.02)
            return res.status(400).json({ error: `Payers total (${totalAmount}) doesn't match declared amount (${amount})` });

        const member = await query('SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2', [groupId, req.userId]);
        if (!member.rows.length) return res.status(403).json({ error: 'Not a member of this group' });

        // Auto-categorize if no category provided
        let finalCategoryId = category_id;
        if (!finalCategoryId) {
            const catName = await categorize(description, true);
            const cat = await query('SELECT id FROM categories WHERE name = $1', [catName]);
            finalCategoryId = cat.rows[0]?.id || 10;
        }

        const primaryPayerId = payers[0].user_id;

        const expenseId = await withTransaction(async (client) => {
            const result = await client.query(`
                INSERT INTO expenses (group_id, paid_by, amount, description, category_id, split_type, date)
                VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id
            `, [groupId, primaryPayerId, totalAmount, description.trim(), finalCategoryId,
                split_type || 'equal', date || new Date().toISOString().split('T')[0]]);
            const expenseId = result.rows[0].id;
            await insertPayersAndSplits(client, expenseId, groupId, totalAmount, split_type || 'equal', payers, splits, involved_members);
            return expenseId;
        });

        const expense = await getFullExpense(expenseId);

        // Collect all group member IDs for equal-split fallback
        const allGroupMembers = await query('SELECT user_id FROM group_members WHERE group_id = $1', [groupId]);
        const allGroupMemberIds = allGroupMembers.rows.map(m => Number(m.user_id));
        const involvedUserIds = buildInvolvedSet(payers, splits, split_type || 'equal', involved_members, allGroupMemberIds);

        // Fetch group + member emails — fire-and-forget notification
        const [membersResult, groupResult] = await Promise.all([
            query('SELECT u.id, u.name, u.email FROM users u JOIN group_members gm ON u.id = gm.user_id WHERE gm.group_id = $1', [groupId]),
            query('SELECT name FROM groups_ WHERE id = $1', [groupId]),
        ]);

        // Response is sent immediately; email happens in background
        res.status(201).json(expense);

        enqueue(() => sendExpenseNotification({
            members: membersResult.rows,
            involvedUserIds,
            currentUserId: req.userId,
            expense: { ...expense, amount: totalAmount },
            payers: expense.payers,
            groupName: groupResult.rows[0]?.name || '',
            isUpdate: false,
        }));

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

// ─── PUT update expense ───────────────────────────────────────────────────────
router.put('/:id', authenticate, async (req, res) => {
    try {
        const expenseResult = await query('SELECT * FROM expenses WHERE id = $1', [req.params.id]);
        if (!expenseResult.rows.length) return res.status(404).json({ error: 'Expense not found' });
        const expense = expenseResult.rows[0];

        const member = await query('SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2', [expense.group_id, req.userId]);
        if (!member.rows.length) return res.status(403).json({ error: 'Only group members can edit expenses' });

        const { description, category_id, split_type, date, payers, splits, involved_members } = req.body;

        let totalAmount = Number(expense.amount);
        if (payers && payers.length) {
            totalAmount = payers.reduce((sum, p) => sum + Number(p.amount_paid), 0);
        }

        await withTransaction(async (client) => {
            const primaryPayerId = payers && payers.length ? payers[0].user_id : expense.paid_by;
            await client.query(`
                UPDATE expenses SET amount = $1, description = $2, category_id = $3, split_type = $4, date = $5, paid_by = $6
                WHERE id = $7
            `, [
                totalAmount,
                description || expense.description,
                category_id || expense.category_id,
                split_type || expense.split_type,
                date || expense.date,
                primaryPayerId,
                expense.id,
            ]);

            await client.query('DELETE FROM expense_payers WHERE expense_id = $1', [expense.id]);
            await client.query('DELETE FROM expense_splits WHERE expense_id = $1', [expense.id]);

            if (payers && payers.length) {
                await insertPayersAndSplits(client, expense.id, expense.group_id, totalAmount,
                    split_type || expense.split_type, payers, splits, involved_members);
            }
        });

        const updated = await getFullExpense(expense.id);

        // Build involved set for targeted emails
        const allGroupMembers = await query('SELECT user_id FROM group_members WHERE group_id = $1', [expense.group_id]);
        const allGroupMemberIds = allGroupMembers.rows.map(m => Number(m.user_id));
        const involvedUserIds = buildInvolvedSet(
            payers || updated.payers,
            splits || updated.splits,
            split_type || expense.split_type,
            involved_members,
            allGroupMemberIds
        );

        const [membersResult, groupResult] = await Promise.all([
            query('SELECT u.id, u.name, u.email FROM users u JOIN group_members gm ON u.id = gm.user_id WHERE gm.group_id = $1', [expense.group_id]),
            query('SELECT name FROM groups_ WHERE id = $1', [expense.group_id]),
        ]);

        // Respond immediately, email in background
        res.json(updated);

        enqueue(() => sendExpenseNotification({
            members: membersResult.rows,
            involvedUserIds,
            currentUserId: req.userId,
            expense: { ...updated, amount: totalAmount },
            payers: updated.payers,
            groupName: groupResult.rows[0]?.name || '',
            isUpdate: true,
        }));

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

// ─── DELETE expense ───────────────────────────────────────────────────────────
router.delete('/:id', authenticate, async (req, res) => {
    try {
        const expenseResult = await query('SELECT * FROM expenses WHERE id = $1', [req.params.id]);
        if (!expenseResult.rows.length) return res.status(404).json({ error: 'Expense not found' });
        const expense = expenseResult.rows[0];

        const member = await query('SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2', [expense.group_id, req.userId]);
        if (!member.rows.length) return res.status(403).json({ error: 'Only group members can delete expenses' });

        await query('DELETE FROM expenses WHERE id = $1', [req.params.id]);
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

module.exports = router;
