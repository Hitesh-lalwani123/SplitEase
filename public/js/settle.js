// Settlement flow
const Settle = {
    currentGroupId: null,
    isProcessing: false,

    async open(groupId) {
        this.currentGroupId = groupId;

        try {
            const balances = await API.get(`/settlements/${groupId}/balances`);
            const container = document.getElementById('settle-transactions');

            if (!balances.transactions.length) {
                container.innerHTML = `
          <div class="empty-state">
            <div style="font-size:2rem;margin-bottom:0.5rem">✨</div>
            All settled up! No pending payments.
          </div>
        `;
            } else {
                container.innerHTML = balances.transactions.map(t => `
          <div class="settle-item">
            <div class="settle-info">
              <strong>${this.escHtml(t.from.name)}</strong>
              <span style="color:var(--text-muted);margin:0 0.3rem">owes</span>
              <strong>${this.escHtml(t.to.name)}</strong>
            </div>
            <span class="settle-amount-display">${App.currency(t.amount)}</span>
            ${t.from.id === App.currentUser.id
                        ? `<button class="btn-settle" onclick="Settle.confirm(${t.to.id}, ${t.amount}, '${this.escHtml(t.to.name)}')">Pay</button>`
                        : (t.to.id === App.currentUser.id
                            ? `<span style="font-size:0.75rem;color:var(--text-muted);padding:0.3rem 0.6rem;background:rgba(255,255,255,0.05);border-radius:6px">Awaiting their payment</span>`
                            : '')
                    }
          </div>
        `).join('');
            }

            App.openModal('settle-modal');
        } catch (err) {
            App.toast(err.message, 'error');
        }
    },

    // Confirmation step before recording
    confirm(paidToId, amount, payeeName) {
        if (this.isProcessing) return;
        const confirmed = window.confirm(
            `Confirm payment of ${App.currency(amount)} to ${payeeName}?\n\nThis will record the settlement and notify them.`
        );
        if (confirmed) {
            this.record(paidToId, amount);
        }
    },

    async record(paidTo, amount) {
        if (this.isProcessing) return;
        this.isProcessing = true;

        // Disable all pay buttons in modal
        document.querySelectorAll('#settle-transactions .btn-settle').forEach(b => {
            b.disabled = true;
            b.textContent = 'Processing…';
        });

        try {
            await API.post(`/settlements/${this.currentGroupId}/settle`, {
                paid_to: paidTo,
                amount,
            });
            App.toast('Settlement recorded! 🎉');
            App.closeModal('settle-modal');

            // Refresh balances
            if (Groups.currentGroupId) Groups.loadDetail();
            if (App.currentPage === 'dashboard') Dashboard.load();
        } catch (err) {
            App.toast(err.message, 'error');
            // Re-enable buttons on error
            document.querySelectorAll('#settle-transactions .btn-settle').forEach(b => {
                b.disabled = false;
                b.textContent = 'Pay';
            });
        } finally {
            this.isProcessing = false;
        }
    },

    escHtml(str) {
        const d = document.createElement('div');
        d.textContent = str || '';
        return d.innerHTML;
    },
};
