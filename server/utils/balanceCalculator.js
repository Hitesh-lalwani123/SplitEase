const { getDb } = require('../db/database');

/**
 * Calculates net balances for each member in a group.
 * Positive = they are owed money, Negative = they owe money.
 * Supports optional retentionDays to filter out old transactions.
 */
function calculateGroupBalances(db, groupId, retentionDays) {
    const members = db.prepare('SELECT user_id FROM group_members WHERE group_id = ?').all(groupId);
    const balanceMap = {};
    for (const m of members) {
        balanceMap[m.user_id] = 0;
    }

    // Build optional date filter
    let dateFilter = '';
    if (retentionDays && retentionDays > 0) {
        dateFilter = `AND e.date >= date('now', '-${parseInt(retentionDays)} days')`;
    }

    // What each person PAID (from expense_payers)
    const payers = db.prepare(`
    SELECT ep.user_id, SUM(ep.amount_paid) as total_paid
    FROM expense_payers ep
    JOIN expenses e ON ep.expense_id = e.id
    WHERE e.group_id = ? ${dateFilter}
    GROUP BY ep.user_id
  `).all(groupId);

    for (const p of payers) {
        if (balanceMap[p.user_id] !== undefined) {
            balanceMap[p.user_id] += p.total_paid;
        }
    }

    // What each person OWES (from expense_splits)
    const splits = db.prepare(`
    SELECT es.user_id, SUM(es.amount_owed) as total_owed
    FROM expense_splits es
    JOIN expenses e ON es.expense_id = e.id
    WHERE e.group_id = ? ${dateFilter}
    GROUP BY es.user_id
  `).all(groupId);

    for (const s of splits) {
        if (balanceMap[s.user_id] !== undefined) {
            balanceMap[s.user_id] -= s.total_owed;
        }
    }

    // Build settlement date filter (settlements also respect retention)
    let settleDateFilter = '';
    if (retentionDays && retentionDays > 0) {
        settleDateFilter = `AND date(s.created_at) >= date('now', '-${parseInt(retentionDays)} days')`;
    }

    // Subtract settlements (paid out)
    const settlements = db.prepare(`
    SELECT paid_by, paid_to, amount FROM settlements s WHERE group_id = ? ${settleDateFilter}
  `).all(groupId);

    for (const s of settlements) {
        // paid_by cleared their debt → their balance goes UP (less negative)
        if (balanceMap[s.paid_by] !== undefined) balanceMap[s.paid_by] += s.amount;
        // paid_to received money → they are owed less → balance goes DOWN
        if (balanceMap[s.paid_to] !== undefined) balanceMap[s.paid_to] -= s.amount;
    }

    return Object.entries(balanceMap).map(([userId, amount]) => ({
        userId: parseInt(userId),
        amount: Math.round(amount * 100) / 100,
    }));
}

/**
 * Simplify debts using a greedy algorithm.
 * Returns a minimal list of transactions to settle all balances.
 */
function simplifyDebts(balances, db) {
    // Get user info
    const userIds = balances.map(b => b.userId);
    const users = {};
    for (const id of userIds) {
        const u = db.prepare('SELECT id, name, email, avatar_color FROM users WHERE id = ?').get(id);
        if (u) users[id] = u;
    }

    const debtors = balances.filter(b => b.amount < -0.01).sort((a, b) => a.amount - b.amount);
    const creditors = balances.filter(b => b.amount > 0.01).sort((a, b) => b.amount - a.amount);

    const transactions = [];
    let i = 0, j = 0;

    while (i < debtors.length && j < creditors.length) {
        const debtor = { ...debtors[i] };
        const creditor = { ...creditors[j] };

        const amount = Math.min(Math.abs(debtor.amount), creditor.amount);

        if (amount > 0.01) {
            transactions.push({
                from: users[debtor.userId] || { id: debtor.userId, name: 'Unknown' },
                to: users[creditor.userId] || { id: creditor.userId, name: 'Unknown' },
                amount: Math.round(amount * 100) / 100,
            });
        }

        debtor.amount += amount;
        creditor.amount -= amount;

        if (Math.abs(debtor.amount) < 0.01) i++;
        if (Math.abs(creditor.amount) < 0.01) j++;
    }

    return transactions;
}

module.exports = { calculateGroupBalances, simplifyDebts };
