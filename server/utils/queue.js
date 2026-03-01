/**
 * Lightweight fire-and-forget async job queue.
 *
 * - enqueue(fn) defers execution until after the current I/O event (setImmediate),
 *   so the HTTP response is always sent before any email/notification work begins.
 * - Multiple pending jobs run in parallel via Promise.allSettled — a slow SMTP
 *   server never blocks another email job.
 * - All errors are caught and logged; they never bubble up to the caller.
 */

/** @type {Array<() => Promise<any>>} */
const _queue = [];
let _flushing = false;

async function _flush() {
    if (_flushing || _queue.length === 0) return;
    _flushing = true;

    // Drain the current snapshot in parallel
    const jobs = _queue.splice(0);
    await Promise.allSettled(jobs.map(fn => {
        try {
            return Promise.resolve(fn());
        } catch (err) {
            console.warn('[queue] synchronous job error:', err.message);
            return Promise.resolve();
        }
    }));

    _flushing = false;

    // If more jobs were added while we were flushing, schedule another pass
    if (_queue.length > 0) {
        setImmediate(_flush);
    }
}

/**
 * Enqueue a fire-and-forget async function.
 * The function is called AFTER the current event-loop tick (after HTTP response).
 *
 * @param {() => Promise<any>} fn
 */
function enqueue(fn) {
    _queue.push(fn);
    setImmediate(_flush);
}

module.exports = { enqueue };
