/**
 * Realtime module — Socket.IO client for SplitEase.
 *
 * Usage:
 *   Realtime.init(token)         — call after login
 *   Realtime.joinGroup(groupId)  — call when opening a group page
 *   Realtime.leaveGroup(groupId) — call when leaving a group page
 */
const Realtime = (() => {
    let socket = null;
    let currentGroupId = null;

    function init(token) {
        if (socket) {
            socket.disconnect();
            socket = null;
        }

        socket = io({ auth: { token }, reconnectionAttempts: 5 });

        socket.on('connect', () => {
            console.log('[realtime] connected, id:', socket.id);
            // Rejoin current group room after a reconnect
            if (currentGroupId) {
                socket.emit('join-group', currentGroupId);
            }
        });

        socket.on('connect_error', (err) => {
            // Silent — app works without real-time (graceful degradation)
            console.warn('[realtime] connection error:', err.message);
        });

        // ── expense:new ───────────────────────────────────────────────────────
        socket.on('expense:new', ({ expense, balances }) => {
            console.log('[realtime] expense:new', expense.id);

            // If we're viewing the group this expense belongs to
            if (Groups.currentGroupId && Number(Groups.currentGroupId) === Number(expense.group_id)) {
                // Remove any optimistic card that matches description+amount within 10s window
                // (the current user's own expense — avoid duplicate)
                const optimisticCards = document.querySelectorAll('.expense-card[data-optimistic]');
                let replaced = false;
                optimisticCards.forEach(card => {
                    if (
                        card.dataset.description === expense.description &&
                        Math.abs(Number(card.dataset.amount) - Number(expense.amount)) < 0.01
                    ) {
                        card.outerHTML = Expenses.renderItem(expense, false);
                        replaced = true;
                    }
                });

                if (!replaced) {
                    // Another user added this expense — prepend it
                    const list = document.getElementById('group-expenses-list');
                    if (list) {
                        const emptyState = list.querySelector('.empty-state');
                        if (emptyState) emptyState.remove();

                        const div = document.createElement('div');
                        div.innerHTML = Expenses.renderItem(expense, false);
                        list.prepend(div.firstElementChild);
                    }
                }

                // Update the balance section with fresh server-computed data
                if (balances) Realtime._updateBalancesUI(balances, expense.group_id);
            }

            // Refresh dashboard recent activity if visible
            if (typeof Dashboard !== 'undefined') {
                const dashPage = document.getElementById('dashboard-page');
                if (dashPage?.classList.contains('active')) {
                    Dashboard.load().catch(() => { });
                }
            }
        });

        // ── expense:updated ───────────────────────────────────────────────────
        socket.on('expense:updated', ({ expense, balances }) => {
            console.log('[realtime] expense:updated', expense.id);

            if (Groups.currentGroupId && Number(Groups.currentGroupId) === Number(expense.group_id)) {
                const existing = document.querySelector(`.expense-card[data-expense-id="${expense.id}"]`);
                if (existing) {
                    existing.outerHTML = Expenses.renderItem(expense, false);
                } else {
                    // Edge case: card not in DOM yet, do a full refresh
                    Groups.loadDetail().catch(() => { });
                    return;
                }

                if (balances) Realtime._updateBalancesUI(balances, expense.group_id);
            }
        });

        // ── expense:deleted ───────────────────────────────────────────────────
        socket.on('expense:deleted', ({ expenseId, balances }) => {
            console.log('[realtime] expense:deleted', expenseId);

            const card = document.querySelector(`.expense-card[data-expense-id="${expenseId}"]`);
            if (card) {
                card.style.transition = 'opacity 0.3s';
                card.style.opacity = '0';
                setTimeout(() => card.remove(), 300);
            }

            if (balances && Groups.currentGroupId) {
                Realtime._updateBalancesUI(balances, Groups.currentGroupId);
            }
        });

        socket.on('disconnect', (reason) => {
            console.log('[realtime] disconnected:', reason);
        });
    }

    function joinGroup(groupId) {
        currentGroupId = groupId;
        if (socket?.connected) {
            socket.emit('join-group', groupId);
        }
    }

    function leaveGroup(groupId) {
        if (socket?.connected) {
            socket.emit('leave-group', groupId);
        }
        if (currentGroupId == groupId) currentGroupId = null;
    }

    /**
     * Update the balances section in the group detail page
     * using fresh balance data pushed from the worker.
     */
    function _updateBalancesUI(balances, groupId) {
        // Trigger a lightweight balances refresh from server (includes simplifyDebts)
        // We use the existing settlements endpoint which returns { transactions, balances }
        if (!Groups.currentGroupId || Number(Groups.currentGroupId) !== Number(groupId)) return;

        API.get(`/settlements/${groupId}/balances`)
            .then(data => {
                const balanceDetails = document.getElementById('group-balance-details');
                if (!balanceDetails) return;

                if (data.transactions && data.transactions.length) {
                    balanceDetails.innerHTML = data.transactions.map(t => {
                        const isMyDebt = t.from.id === App.currentUser?.id;
                        return `
                          <div class="balance-row">
                            <strong>${Groups.escHtml(t.from.name)}</strong>
                            <span class="arrow">→</span>
                            <strong>${Groups.escHtml(t.to.name)}</strong>
                            <span class="settle-amount">${App.currency(t.amount)}</span>
                            ${isMyDebt ? `<button class="btn-settle" onclick="Settle.open(${groupId})">Settle Up</button>` : ''}
                          </div>
                        `;
                    }).join('');
                } else {
                    balanceDetails.innerHTML = '<div class="empty-state" style="padding:0.5rem">All settled up! ✨</div>';
                }
            })
            .catch(() => { }); // silent — non-critical
    }

    return { init, joinGroup, leaveGroup, _updateBalancesUI };
})();
