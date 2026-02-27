// Dashboard page
const Dashboard = {
    async load() {
        try {
            const [dashboard, recent] = await Promise.all([
                API.get('/analytics/dashboard'),
                API.get('/expenses/recent'),
            ]);

            // Update balance cards
            document.getElementById('total-owed').textContent = App.currency(dashboard.totalOwed);
            document.getElementById('total-owe').textContent = App.currency(dashboard.totalOwe);

            const netEl = document.getElementById('net-balance');
            const netCard = netEl.closest('.balance-card');
            netEl.textContent = (dashboard.netBalance >= 0 ? '+' : '-') + App.currency(dashboard.netBalance);
            netCard.className = `balance-card ${dashboard.netBalance >= 0 ? 'card-positive' : 'card-negative'} card-net`;

            // Group balances
            const gbList = document.getElementById('group-balances-list');
            if (dashboard.groupBalances.length) {
                gbList.innerHTML = dashboard.groupBalances.map(g => `
          <div class="group-balance-item" onclick="Groups.openDetail(${g.groupId})">
            <span class="gbi-name">${this.escHtml(g.groupName)}</span>
            <span class="gbi-amount ${g.balance > 0.01 ? 'positive' : g.balance < -0.01 ? 'negative' : 'zero'}">
              ${g.balance > 0.01 ? '+' : ''}${App.currency(g.balance)}
            </span>
          </div>
        `).join('');
            } else {
                gbList.innerHTML = '<div class="empty-state">No groups yet. Create one to start splitting!</div>';
            }

            // Recent expenses
            const recentList = document.getElementById('recent-expenses');
            if (recent.length) {
                recentList.innerHTML = recent.slice(0, 8).map(e => Expenses.renderItem(e, true)).join('');
            } else {
                recentList.innerHTML = '<div class="empty-state">No expenses yet. Add your first one!</div>';
            }
        } catch (err) {
            console.error('Dashboard load error:', err);
        }
    },

    escHtml(str) {
        const d = document.createElement('div');
        d.textContent = str;
        return d.innerHTML;
    },
};
