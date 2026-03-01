const express = require('express');
const { query } = require('../db/database');
const { authenticate } = require('../middleware/auth');
const { simplifyDebts, calculateGroupBalances } = require('../utils/balanceCalculator');
const { sendSettlementNotification } = require('../utils/mailer');
const { enqueue } = require('../utils/queue');

const router = express.Router();

// Get simplified balances for a group
router.get('/:groupId/balances', authenticate, async (req, res) => {
  try {
    const { groupId } = req.params;
    const member = await query('SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2', [groupId, req.userId]);
    if (!member.rows.length) return res.status(403).json({ error: 'Not a member of this group' });

    const group = await query('SELECT retention_days FROM groups_ WHERE id = $1', [groupId]);
    const retentionDays = group.rows[0]?.retention_days;

    const balances = await calculateGroupBalances(groupId, retentionDays);
    const transactions = await simplifyDebts(balances);

    res.json({ balances, transactions });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Record a settlement
router.post('/:groupId/settle', authenticate, async (req, res) => {
  try {
    const { groupId } = req.params;
    const { paid_to, amount } = req.body;

    if (!paid_to || !amount) return res.status(400).json({ error: 'paid_to and amount are required' });

    const member = await query('SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2', [groupId, req.userId]);
    if (!member.rows.length) return res.status(403).json({ error: 'Not a member of this group' });

    const group = await query('SELECT * FROM groups_ WHERE id = $1', [groupId]);
    const retentionDays = group.rows[0]?.retention_days;
    const balances = await calculateGroupBalances(groupId, retentionDays);
    const transactions = await simplifyDebts(balances);

    const owedTx = transactions.find(t =>
      Number(t.from.id) === Number(req.userId) && Number(t.to.id) === Number(paid_to)
    );
    if (!owedTx) return res.status(400).json({ error: 'No outstanding debt found from you to this user' });

    const settleAmount = Math.min(Number(amount), owedTx.amount);

    const result = await query(
      'INSERT INTO settlements (group_id, paid_by, paid_to, amount) VALUES ($1, $2, $3, $4) RETURNING id',
      [groupId, req.userId, paid_to, settleAmount]
    );

    const settlement = await query(`
            SELECT s.*,
                payer.name AS paid_by_name, payer.email AS paid_by_email, payer.avatar_color AS paid_by_color,
                payee.name AS paid_to_name, payee.email AS paid_to_email, payee.avatar_color AS paid_to_color
            FROM settlements s
            JOIN users payer ON s.paid_by = payer.id
            JOIN users payee ON s.paid_to = payee.id
            WHERE s.id = $1
        `, [result.rows[0].id]);

    const s = settlement.rows[0];

    // Respond immediately; emails fire in background
    res.status(201).json(s);

    enqueue(() => sendSettlementNotification({
      payerEmail: s.paid_by_email,
      payerName: s.paid_by_name,
      payeeEmail: s.paid_to_email,
      payeeName: s.paid_to_name,
      amount: Number(settleAmount),
      groupName: group.rows[0]?.name || '',
    }));

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get settlement history for a group
router.get('/:groupId/settlements', authenticate, async (req, res) => {
  try {
    const { groupId } = req.params;
    const member = await query('SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2', [groupId, req.userId]);
    if (!member.rows.length) return res.status(403).json({ error: 'Not a member of this group' });

    const settlements = await query(`
            SELECT s.*,
                payer.name AS paid_by_name, payer.avatar_color AS paid_by_color,
                payee.name AS paid_to_name, payee.avatar_color AS paid_to_color
            FROM settlements s
            JOIN users payer ON s.paid_by = payer.id
            JOIN users payee ON s.paid_to = payee.id
            WHERE s.group_id = $1
            ORDER BY s.created_at DESC
        `, [groupId]);

    res.json(settlements.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
