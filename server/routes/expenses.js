const express = require('express');
const { getDb } = require('../db/database');
const { authenticate } = require('../middleware/auth');
const { categorize } = require('../utils/categorizer');
const { sendExpenseNotification } = require('../utils/mailer');

const router = express.Router();

// Helper: get full expense with payers and splits
function getFullExpense(db, expenseId) {
    const expense = db.prepare(`
    SELECT e.*, c.name as category_name, c.icon as category_icon, c.color as category_color,
           u.name as paid_by_name, u.avatar_color as paid_by_color
    FROM expenses e
    LEFT JOIN categories c ON e.category_id = c.id
    LEFT JOIN users u ON e.paid_by = u.id
    WHERE e.id = ?
  `).get(expenseId);

    if (!expense) return null;

    expense.payers = db.prepare(`
    SELECT ep.*, u.name as user_name, u.avatar_color
    FROM expense_payers ep
    JOIN users u ON ep.user_id = u.id
    WHERE ep.expense_id = ?
  `).all(expenseId);

    expense.splits = db.prepare(`
    SELECT es.*, u.name as user_name, u.avatar_color
    FROM expense_splits es
    JOIN users u ON es.user_id = u.id
    WHERE es.expense_id = ?
  `).all(expenseId);

    return expense;
}

// Helper: insert payers and splits
function insertPayersAndSplits(db, expenseId, groupId, amount, splitType, payers, splits, involvedMembers) {
    // Insert payers
    const insertPayer = db.prepare('INSERT INTO expense_payers (expense_id, user_id, amount_paid) VALUES (?, ?, ?)');
    for (const p of payers) {
        insertPayer.run(expenseId, p.user_id, p.amount_paid);
    }

    // Insert splits
    const insertSplit = db.prepare('INSERT INTO expense_splits (expense_id, user_id, amount_owed) VALUES (?, ?, ?)');

    if (splitType === 'exact' && splits && splits.length) {
        for (const s of splits) {
            insertSplit.run(expenseId, s.user_id, s.amount);
        }
    } else if (splitType === 'percentage' && splits && splits.length) {
        for (const s of splits) {
            insertSplit.run(expenseId, s.user_id, Math.round((amount * s.percentage / 100) * 100) / 100);
        }
    } else {
        // Equal split — use involvedMembers if provided, else all group members
        let memberIds;
        if (involvedMembers && involvedMembers.length) {
            memberIds = involvedMembers;
        } else {
            memberIds = db.prepare('SELECT user_id FROM group_members WHERE group_id = ?').all(groupId).map(m => m.user_id);
        }
        const splitAmount = Math.round((amount / memberIds.length) * 100) / 100;
        for (const userId of memberIds) {
            insertSplit.run(expenseId, userId, splitAmount);
        }
    }
}

// Get expenses for a group (respects retention_days)
router.get('/group/:groupId', authenticate, (req, res) => {
    const db = getDb();
    const { groupId } = req.params;
    const { category, startDate, endDate, limit, offset } = req.query;

    const isMember = db.prepare('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?').get(groupId, req.userId);
    if (!isMember) return res.status(403).json({ error: 'Not a member of this group' });

    // Get group retention policy
    const group = db.prepare('SELECT retention_days FROM groups_ WHERE id = ?').get(groupId);
    const retentionDays = group ? group.retention_days : null;

    let query = `
    SELECT e.*, c.name as category_name, c.icon as category_icon, c.color as category_color,
           u.name as paid_by_name, u.avatar_color as paid_by_color
    FROM expenses e
    LEFT JOIN categories c ON e.category_id = c.id
    LEFT JOIN users u ON e.paid_by = u.id
    WHERE e.group_id = ?
  `;
    const params = [groupId];

    if (retentionDays && retentionDays > 0) {
        query += ` AND e.date >= date('now', '-${parseInt(retentionDays)} days')`;
    }
    if (category) { query += ' AND e.category_id = ?'; params.push(category); }
    if (startDate) { query += ' AND e.date >= ?'; params.push(startDate); }
    if (endDate) { query += ' AND e.date <= ?'; params.push(endDate); }

    query += ' ORDER BY e.date DESC, e.created_at DESC';

    if (limit) {
        query += ' LIMIT ?'; params.push(parseInt(limit));
        if (offset) { query += ' OFFSET ?'; params.push(parseInt(offset)); }
    }

    const expenses = db.prepare(query).all(...params);

    for (const exp of expenses) {
        exp.payers = db.prepare(`
      SELECT ep.*, u.name as user_name, u.avatar_color
      FROM expense_payers ep JOIN users u ON ep.user_id = u.id WHERE ep.expense_id = ?
    `).all(exp.id);
        exp.splits = db.prepare(`
      SELECT es.*, u.name as user_name, u.avatar_color
      FROM expense_splits es JOIN users u ON es.user_id = u.id WHERE es.expense_id = ?
    `).all(exp.id);
    }

    res.json(expenses);
});

// Get recent expenses across all groups — last 100
router.get('/recent', authenticate, (req, res) => {
    const db = getDb();
    const expenses = db.prepare(`
    SELECT e.*, c.name as category_name, c.icon as category_icon, c.color as category_color,
           u.name as paid_by_name, u.avatar_color as paid_by_color, g.name as group_name
    FROM expenses e
    LEFT JOIN categories c ON e.category_id = c.id
    LEFT JOIN users u ON e.paid_by = u.id
    LEFT JOIN groups_ g ON e.group_id = g.id
    JOIN group_members gm ON e.group_id = gm.group_id AND gm.user_id = ?
    ORDER BY e.date DESC, e.created_at DESC LIMIT 100
  `).all(req.userId);

    for (const exp of expenses) {
        exp.payers = db.prepare(`
      SELECT ep.*, u.name as user_name FROM expense_payers ep
      JOIN users u ON ep.user_id = u.id WHERE ep.expense_id = ?
    `).all(exp.id);
    }

    res.json(expenses);
});

// Get all categories (system + user's custom)
router.get('/categories', authenticate, (req, res) => {
    const db = getDb();
    const categories = db.prepare(`
    SELECT * FROM categories
    WHERE is_custom = 0 OR created_by = ?
    ORDER BY is_custom ASC, id ASC
  `).all(req.userId);
    // Parse keywords JSON for each custom category
    const result = categories.map(c => ({
        ...c,
        keywords: c.keywords ? JSON.parse(c.keywords) : [],
    }));
    res.json(result);
});

// Create a custom category
router.post('/categories', authenticate, (req, res) => {
    const db = getDb();
    const { name, icon, color, keywords } = req.body;

    if (!name || !name.trim()) return res.status(400).json({ error: 'Category name is required' });
    if (!icon) return res.status(400).json({ error: 'Category icon is required' });
    if (!color) return res.status(400).json({ error: 'Category color is required' });

    // Check for duplicate name (case-insensitive)
    const existing = db.prepare('SELECT id FROM categories WHERE LOWER(name) = LOWER(?)').get(name.trim());
    if (existing) return res.status(409).json({ error: 'A category with this name already exists' });

    // Validate and serialise keywords
    let kwJson = null;
    if (Array.isArray(keywords) && keywords.length) {
        const cleaned = keywords.map(k => k.trim().toLowerCase()).filter(Boolean);
        if (cleaned.length) kwJson = JSON.stringify(cleaned);
    }

    const result = db.prepare(
        'INSERT INTO categories (name, icon, color, is_custom, created_by, keywords) VALUES (?, ?, ?, 1, ?, ?)'
    ).run(name.trim(), icon.trim(), color.trim(), req.userId, kwJson);

    const category = db.prepare('SELECT * FROM categories WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json({ ...category, keywords: kwJson ? JSON.parse(kwJson) : [] });
});

// Delete a custom category (created_by only)
router.delete('/categories/:id', authenticate, (req, res) => {
    const db = getDb();
    const catId = parseInt(req.params.id);

    const category = db.prepare('SELECT * FROM categories WHERE id = ?').get(catId);
    if (!category) return res.status(404).json({ error: 'Category not found' });
    if (!category.is_custom) return res.status(403).json({ error: 'Cannot delete system categories' });
    if (category.created_by !== req.userId) return res.status(403).json({ error: 'Only the creator can delete this category' });

    // Move expenses using this category to "Other" (id=10)
    db.prepare('UPDATE expenses SET category_id = 10 WHERE category_id = ?').run(catId);
    db.prepare('DELETE FROM categories WHERE id = ?').run(catId);

    res.json({ success: true, message: 'Category deleted. Expenses moved to "Other".' });
});

// Auto-categorize — also checks custom category keywords via DB
router.post('/auto-categorize', authenticate, (req, res) => {
    const db = getDb();
    const { description } = req.body;
    const categoryName = categorize(description, db);
    const category = db.prepare('SELECT * FROM categories WHERE name = ?').get(categoryName);
    res.json(category || { id: 10, name: 'Other', icon: '📦', color: '#64748b' });
});

// Add expense
router.post('/group/:groupId', authenticate, (req, res) => {
    const db = getDb();
    const { groupId } = req.params;
    const { amount, description, category_id, split_type, date, payers, splits, involved_members } = req.body;

    if (!description) return res.status(400).json({ error: 'Description is required' });
    if (!payers || !payers.length) return res.status(400).json({ error: 'At least one payer is required' });

    // Calculate total from payers
    const totalAmount = payers.reduce((sum, p) => sum + Number(p.amount_paid), 0);
    if (totalAmount <= 0) return res.status(400).json({ error: 'Total amount must be greater than 0' });

    // If amount provided, verify it matches payers total (within rounding tolerance)
    if (amount && Math.abs(Number(amount) - totalAmount) > 0.02) {
        return res.status(400).json({ error: `Payers total (${totalAmount}) doesn't match declared amount (${amount})` });
    }

    const isMember = db.prepare('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?').get(groupId, req.userId);
    if (!isMember) return res.status(403).json({ error: 'Not a member of this group' });

    // Auto-categorize if no category provided
    let finalCategoryId = category_id;
    if (!finalCategoryId) {
        const catName = categorize(description);
        const cat = db.prepare('SELECT id FROM categories WHERE name = ?').get(catName);
        finalCategoryId = cat ? cat.id : 10;
    }

    // Primary payer = first payer (for display and legacy compat)
    const primaryPayerId = payers[0].user_id;

    const expenseId = db.transaction(() => {
        const result = db.prepare(`
      INSERT INTO expenses (group_id, paid_by, amount, description, category_id, split_type, date)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(groupId, primaryPayerId, totalAmount, description.trim(), finalCategoryId,
            split_type || 'equal', date || new Date().toISOString().split('T')[0]);

        insertPayersAndSplits(db, result.lastInsertRowid, groupId, totalAmount,
            split_type || 'equal', payers, splits, involved_members);

        return result.lastInsertRowid;
    })();

    const expense = getFullExpense(db, expenseId);

    // Send notifications async (non-blocking)
    const members = db.prepare(`
    SELECT u.name, u.email FROM users u
    JOIN group_members gm ON u.id = gm.user_id WHERE gm.group_id = ?
  `).all(groupId);
    const group = db.prepare('SELECT name FROM groups_ WHERE id = ?').get(groupId);
    sendExpenseNotification({
        members,
        expense: { ...expense, amount: totalAmount },
        payers: expense.payers,
        groupName: group ? group.name : '',
        isUpdate: false,
    }).catch(() => { });

    res.status(201).json(expense);
});

// Update expense — any group member can edit
router.put('/:id', authenticate, (req, res) => {
    const db = getDb();
    const expense = db.prepare('SELECT * FROM expenses WHERE id = ?').get(req.params.id);
    if (!expense) return res.status(404).json({ error: 'Expense not found' });

    // Allow any group member to edit (not just primary payer)
    const isMember = db.prepare('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?').get(expense.group_id, req.userId);
    if (!isMember) return res.status(403).json({ error: 'Only group members can edit expenses' });

    const { description, category_id, split_type, date, payers, splits, involved_members } = req.body;

    // Compute total from payers if provided
    let totalAmount = expense.amount;
    if (payers && payers.length) {
        totalAmount = payers.reduce((sum, p) => sum + Number(p.amount_paid), 0);
    }

    db.transaction(() => {
        const primaryPayerId = payers && payers.length ? payers[0].user_id : expense.paid_by;

        db.prepare(`
      UPDATE expenses SET amount = ?, description = ?, category_id = ?, split_type = ?, date = ?, paid_by = ? WHERE id = ?
    `).run(
            totalAmount,
            description || expense.description,
            category_id || expense.category_id,
            split_type || expense.split_type,
            date || expense.date,
            primaryPayerId,
            expense.id
        );

        // Delete old payers/splits and recreate
        db.prepare('DELETE FROM expense_payers WHERE expense_id = ?').run(expense.id);
        db.prepare('DELETE FROM expense_splits WHERE expense_id = ?').run(expense.id);

        if (payers && payers.length) {
            insertPayersAndSplits(db, expense.id, expense.group_id, totalAmount,
                split_type || expense.split_type, payers, splits, involved_members);
        }
    })();

    const updated = getFullExpense(db, expense.id);

    // Send notification (non-blocking)
    const members = db.prepare(`
    SELECT u.name, u.email FROM users u
    JOIN group_members gm ON u.id = gm.user_id WHERE gm.group_id = ?
  `).all(expense.group_id);
    const group = db.prepare('SELECT name FROM groups_ WHERE id = ?').get(expense.group_id);
    sendExpenseNotification({
        members,
        expense: { ...updated, amount: totalAmount },
        payers: updated.payers,
        groupName: group ? group.name : '',
        isUpdate: true,
    }).catch(() => { });

    res.json(updated);
});

// Delete expense — any group member can delete
router.delete('/:id', authenticate, (req, res) => {
    const db = getDb();
    const expense = db.prepare('SELECT * FROM expenses WHERE id = ?').get(req.params.id);
    if (!expense) return res.status(404).json({ error: 'Expense not found' });

    const isMember = db.prepare('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?').get(expense.group_id, req.userId);
    if (!isMember) return res.status(403).json({ error: 'Only group members can delete expenses' });

    db.prepare('DELETE FROM expenses WHERE id = ?').run(req.params.id);
    res.json({ success: true });
});

module.exports = router;
