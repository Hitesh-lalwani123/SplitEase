const express = require('express');
const { getDb } = require('../db/database');
const { authenticate } = require('../middleware/auth');
const { simplifyDebts, calculateGroupBalances } = require('../utils/balanceCalculator');
const { sendSettlementNotification } = require('../utils/mailer');

const router = express.Router();

// Get simplified balances for a group (respects retention_days)
router.get('/:groupId/balances', authenticate, (req, res) => {
  const db = getDb();
  const { groupId } = req.params;

  const isMember = db.prepare('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?').get(groupId, req.userId);
  if (!isMember) return res.status(403).json({ error: 'Not a member of this group' });

  // Get group's retention policy
  const group = db.prepare('SELECT retention_days FROM groups_ WHERE id = ?').get(groupId);
  const retentionDays = group ? group.retention_days : null;

  const balances = calculateGroupBalances(db, groupId, retentionDays);
  const transactions = simplifyDebts(balances, db);

  res.json({ balances, transactions });
});

// Record a settlement
router.post('/:groupId/settle', authenticate, async (req, res) => {
  const db = getDb();
  const { groupId } = req.params;
  const { paid_to, amount } = req.body;

  if (!paid_to || !amount) {
    return res.status(400).json({ error: 'paid_to and amount are required' });
  }

  const isMember = db.prepare('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?').get(groupId, req.userId);
  if (!isMember) return res.status(403).json({ error: 'Not a member of this group' });

  // Validate that the current user actually owes money to paid_to
  const group = db.prepare('SELECT * FROM groups_ WHERE id = ?').get(groupId);
  const retentionDays = group ? group.retention_days : null;
  const balances = calculateGroupBalances(db, groupId, retentionDays);
  const transactions = simplifyDebts(balances, db);

  // Check if the current user (payer) genuinely owes to paid_to
  const owedTx = transactions.find(t =>
    t.from.id === req.userId && t.to.id === parseInt(paid_to)
  );
  if (!owedTx) {
    return res.status(400).json({ error: 'No outstanding debt found from you to this user' });
  }

  // Cap to what is actually owed (prevent over-settlement)
  const settleAmount = Math.min(Number(amount), owedTx.amount);

  const result = db.prepare(
    'INSERT INTO settlements (group_id, paid_by, paid_to, amount) VALUES (?, ?, ?, ?)'
  ).run(groupId, req.userId, paid_to, settleAmount);

  const settlement = db.prepare(`
    SELECT s.*,
      payer.name as paid_by_name, payer.email as paid_by_email, payer.avatar_color as paid_by_color,
      payee.name as paid_to_name, payee.email as paid_to_email, payee.avatar_color as paid_to_color
    FROM settlements s
    JOIN users payer ON s.paid_by = payer.id
    JOIN users payee ON s.paid_to = payee.id
    WHERE s.id = ?
  `).get(result.lastInsertRowid);

  // Send notification emails to BOTH parties (non-blocking)
  sendSettlementNotification({
    payerEmail: settlement.paid_by_email,
    payerName: settlement.paid_by_name,
    payeeEmail: settlement.paid_to_email,
    payeeName: settlement.paid_to_name,
    amount: Number(settleAmount),
    groupName: group ? group.name : '',
  }).catch(() => { });

  res.status(201).json(settlement);
});

// Get settlement history for a group
router.get('/:groupId/settlements', authenticate, (req, res) => {
  const db = getDb();
  const { groupId } = req.params;

  const isMember = db.prepare('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?').get(groupId, req.userId);
  if (!isMember) return res.status(403).json({ error: 'Not a member of this group' });

  const settlements = db.prepare(`
    SELECT s.*,
      payer.name as paid_by_name, payer.avatar_color as paid_by_color,
      payee.name as paid_to_name, payee.avatar_color as paid_to_color
    FROM settlements s
    JOIN users payer ON s.paid_by = payer.id
    JOIN users payee ON s.paid_to = payee.id
    WHERE s.group_id = ?
    ORDER BY s.created_at DESC
  `).all(groupId);

  res.json(settlements);
});

module.exports = router;
