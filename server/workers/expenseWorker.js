require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const { Worker } = require('bullmq');
const { connection } = require('../queue/expenseQueue');
const { query } = require('../db/database');
const { calculateGroupBalances } = require('../utils/balanceCalculator');
const { sendExpenseNotification } = require('../utils/mailer');
const { getIO } = require('../socketInstance');

/**
 * BullMQ Worker — processes expense jobs in the background.
 *
 * Supported job names:
 *   expense.created  — recalc balances + email + socket emit
 *   expense.updated  — recalc balances + email + socket emit
 *   expense.deleted  — recalc balances + socket emit
 */
const worker = new Worker(
    'expenses',
    async (job) => {
        const { name, data } = job;
        console.log(`[worker] processing job ${job.id}: ${name}`);

        const io = getIO();

        if (name === 'expense.created' || name === 'expense.updated') {
            const {
                expenseId,
                groupId,
                currentUserId,
                involvedUserIds,  // stored as array — convert back to Set
                isUpdate,
            } = data;

            // 1. Re-fetch full expense from DB (worker may run after short delay)
            const expResult = await query(`
                SELECT e.*, c.name AS category_name, c.icon AS category_icon, c.color AS category_color,
                       u.name AS paid_by_name, u.avatar_color AS paid_by_color
                FROM expenses e
                LEFT JOIN categories c ON e.category_id = c.id
                LEFT JOIN users u ON e.paid_by = u.id
                WHERE e.id = $1
            `, [expenseId]);

            if (!expResult.rows.length) {
                console.warn(`[worker] expense ${expenseId} not found, skipping job`);
                return;
            }

            const expense = expResult.rows[0];

            const [payersResult, splitsResult, membersResult, groupResult, groupMeta] = await Promise.all([
                query('SELECT ep.*, u.name AS user_name, u.avatar_color FROM expense_payers ep JOIN users u ON ep.user_id = u.id WHERE ep.expense_id = $1', [expenseId]),
                query('SELECT es.*, u.name AS user_name, u.avatar_color FROM expense_splits es JOIN users u ON es.user_id = u.id WHERE es.expense_id = $1', [expenseId]),
                query('SELECT u.id, u.name, u.email FROM users u JOIN group_members gm ON u.id = gm.user_id WHERE gm.group_id = $1', [groupId]),
                query('SELECT name FROM groups_ WHERE id = $1', [groupId]),
                query('SELECT retention_days FROM groups_ WHERE id = $1', [groupId]),
            ]);

            expense.payers = payersResult.rows;
            expense.splits = splitsResult.rows;

            // 2. Recalculate balances
            const retentionDays = groupMeta.rows[0]?.retention_days;
            const balances = await calculateGroupBalances(groupId, retentionDays);

            // 3. Emit real-time event to all group members
            const eventName = isUpdate ? 'expense:updated' : 'expense:new';
            if (io) {
                io.to(`group:${groupId}`).emit(eventName, { expense, balances });
                console.log(`[worker] emitted ${eventName} to group:${groupId}`);
            }

            // 4. Send email notifications (fire-and-forget within worker)
            const involvedSet = new Set((involvedUserIds || []).map(Number));
            try {
                await sendExpenseNotification({
                    members: membersResult.rows,
                    involvedUserIds: involvedSet,
                    currentUserId,
                    expense: { ...expense, amount: expense.amount },
                    payers: expense.payers,
                    groupName: groupResult.rows[0]?.name || '',
                    isUpdate: !!isUpdate,
                });
                console.log(`[worker] emails sent for expense ${expenseId}`);
            } catch (emailErr) {
                console.warn('[worker] email send failed (non-fatal):', emailErr.message);
            }

        } else if (name === 'expense.deleted') {
            const { expenseId, groupId } = data;

            // Recalculate balances after deletion
            const groupMeta = await query('SELECT retention_days FROM groups_ WHERE id = $1', [groupId]);
            const retentionDays = groupMeta.rows[0]?.retention_days;
            const balances = await calculateGroupBalances(groupId, retentionDays);

            if (io) {
                io.to(`group:${groupId}`).emit('expense:deleted', { expenseId, balances });
                console.log(`[worker] emitted expense:deleted to group:${groupId}`);
            }
        } else {
            console.warn(`[worker] unknown job name: ${name}`);
        }
    },
    {
        connection,
        concurrency: 5,
    }
);

worker.on('completed', (job) => {
    console.log(`[worker] ✅ job ${job.id} (${job.name}) completed`);
});

worker.on('failed', (job, err) => {
    console.error(`[worker] ❌ job ${job?.id} (${job?.name}) failed:`, err.message);
});

worker.on('error', (err) => {
    console.error('[worker] worker error:', err.message);
});

console.log('🔄 SplitEase expense worker started');

module.exports = { worker };
