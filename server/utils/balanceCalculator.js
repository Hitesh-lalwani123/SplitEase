const { query } = require('../db/database');

/**
 * Calculates net balances for each member in a group.
 * Positive = they are owed money, Negative = they owe money.
 * Supports optional retentionDays to filter out old transactions.
 */
async function calculateGroupBalances(groupId, retentionDays) {
    const members = await query('SELECT user_id FROM group_members WHERE group_id = $1', [groupId]);
    const balanceMap = {};
    for (const m of members.rows) {
        balanceMap[m.user_id] = 0;
    }

    // Build optional date filter
    let dateFilter = '';
    let retentionParam = [];
    if (retentionDays && retentionDays > 0) {
        dateFilter = `AND e.date >= CURRENT_DATE - INTERVAL '${parseInt(retentionDays)} days'`;
    }

    // What each person PAID (from expense_payers)
    const payers = await query(`
    SELECT ep.user_id, SUM(ep.amount_paid) AS total_paid
    FROM expense_payers ep
    JOIN expenses e ON ep.expense_id = e.id
    WHERE e.group_id = $1 ${dateFilter}
    GROUP BY ep.user_id
  `, [groupId]);

    for (const p of payers.rows) {
        if (balanceMap[p.user_id] !== undefined) {
            balanceMap[p.user_id] += Number(p.total_paid);
        }
    }

    // What each person OWES (from expense_splits)
    const splits = await query(`
    SELECT es.user_id, SUM(es.amount_owed) AS total_owed
    FROM expense_splits es
    JOIN expenses e ON es.expense_id = e.id
    WHERE e.group_id = $1 ${dateFilter}
    GROUP BY es.user_id
  `, [groupId]);

    for (const s of splits.rows) {
        if (balanceMap[s.user_id] !== undefined) {
            balanceMap[s.user_id] -= Number(s.total_owed);
        }
    }

    // Build settlement date filter
    let settleDateFilter = '';
    if (retentionDays && retentionDays > 0) {
        settleDateFilter = `AND s.created_at::date >= CURRENT_DATE - INTERVAL '${parseInt(retentionDays)} days'`;
    }

    // Subtract settlements
    const settlements = await query(`
    SELECT paid_by, paid_to, amount FROM settlements s
    WHERE group_id = $1 ${settleDateFilter}
  `, [groupId]);

    for (const s of settlements.rows) {
        // paid_by cleared their debt → balance goes UP
        if (balanceMap[s.paid_by] !== undefined) balanceMap[s.paid_by] += Number(s.amount);
        // paid_to received money → balance goes DOWN
        if (balanceMap[s.paid_to] !== undefined) balanceMap[s.paid_to] -= Number(s.amount);
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
async function simplifyDebts(balances) {
    const userIds = balances.map(b => b.userId);
    const users = {};
    await Promise.all(
        userIds.map(async (id) => {
            const res = await query('SELECT id, name, email, avatar_color FROM users WHERE id = $1', [id]);
            if (res.rows[0]) users[id] = res.rows[0];
        })
    );

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
