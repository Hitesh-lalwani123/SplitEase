const { Queue } = require('bullmq');
const IORedis = require('ioredis');

/**
 * Shared Redis connection for BullMQ.
 * maxRetriesPerRequest: null is required by BullMQ.
 */
const connection = new IORedis(process.env.REDIS_URL || 'redis://localhost:6379', {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
});

connection.on('error', (err) => {
    console.warn('[Redis] connection error (non-fatal):', err.message);
});

/**
 * The BullMQ queue for async expense processing.
 * Job names: 'expense.created' | 'expense.updated' | 'expense.deleted'
 */
const expenseQueue = new Queue('expenses', {
    connection,
    defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: 100, // keep last 100 completed jobs
        removeOnFail: 200,     // keep last 200 failed jobs
    },
});

module.exports = { expenseQueue, connection };
