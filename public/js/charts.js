// Analytics Charts — full rewrite with view modes, date range picker, group selector
const Charts = {
    instances: {},   // chart instances keyed by canvas id
    groups: [],      // user's groups list

    // ── Init ─────────────────────────────────────────────────────────────────
    async init() {
        await this.loadGroups();
        this.buildControls();
        this.bindEvents();
        this.setDefaultDates();
        this.load();
    },

    async loadGroups() {
        try {
            this.groups = await API.get('/groups');
        } catch (e) {
            this.groups = [];
        }
    },

    // ── Build controls HTML ───────────────────────────────────────────────────
    buildControls() {
        const wrap = document.getElementById('analytics-controls');
        if (!wrap) return;

        const groupOptions = this.groups.map(g =>
            `<option value="${g.id}">${this.esc(g.name)}</option>`
        ).join('');

        wrap.innerHTML = `
      <div class="analytics-controls-row">

        <!-- View mode -->
        <div class="ctrl-group">
          <label class="ctrl-label">View</label>
          <select id="analytics-view-mode" class="select-input ctrl-select">
            <option value="my">My Spending</option>
            <option value="group">Group Spending</option>
          </select>
        </div>

        <!-- Group selector (shown in group mode) -->
        <div class="ctrl-group" id="analytics-group-wrap" style="display:none">
          <label class="ctrl-label">Group</label>
          <select id="analytics-group-sel" class="select-input ctrl-select">
            <option value="all">All Groups</option>
            ${groupOptions}
          </select>
        </div>

        <!-- Date range -->
        <div class="ctrl-group">
          <label class="ctrl-label">From</label>
          <input type="date" id="analytics-start" class="date-input ctrl-date">
        </div>
        <div class="ctrl-group">
          <label class="ctrl-label">To</label>
          <input type="date" id="analytics-end" class="date-input ctrl-date">
        </div>

        <!-- Quick shortcuts -->
        <div class="ctrl-group ctrl-shortcuts">
          <button class="shortcut-btn" data-days="30">1M</button>
          <button class="shortcut-btn" data-days="90">3M</button>
          <button class="shortcut-btn" data-days="180">6M</button>
          <button class="shortcut-btn" data-days="365">1Y</button>
        </div>

        <button id="analytics-apply-btn" class="btn btn-primary btn-sm">Apply</button>
      </div>
    `;
    },

    bindEvents() {
        document.getElementById('analytics-controls')?.addEventListener('change', (e) => {
            if (e.target.id === 'analytics-view-mode') {
                const isGroup = e.target.value === 'group';
                document.getElementById('analytics-group-wrap').style.display = isGroup ? '' : 'none';
            }
        });

        document.getElementById('analytics-controls')?.addEventListener('click', (e) => {
            if (e.target.classList.contains('shortcut-btn')) {
                const days = parseInt(e.target.dataset.days);
                const end = new Date();
                const start = new Date();
                start.setDate(end.getDate() - days);
                document.getElementById('analytics-start').value = start.toISOString().split('T')[0];
                document.getElementById('analytics-end').value = end.toISOString().split('T')[0];
            }
            if (e.target.id === 'analytics-apply-btn') {
                this.load();
            }
        });
    },

    setDefaultDates() {
        const end = new Date();
        const start = new Date();
        start.setMonth(end.getMonth() - 3);
        const s = document.getElementById('analytics-start');
        const e2 = document.getElementById('analytics-end');
        if (s) s.value = start.toISOString().split('T')[0];
        if (e2) e2.value = end.toISOString().split('T')[0];
    },

    getParams() {
        return {
            startDate: document.getElementById('analytics-start')?.value || '',
            endDate: document.getElementById('analytics-end')?.value || '',
            viewMode: document.getElementById('analytics-view-mode')?.value || 'my',
            groupId: document.getElementById('analytics-group-sel')?.value || 'all',
        };
    },

    // ── Main load router ──────────────────────────────────────────────────────
    async load() {
        const { viewMode, groupId, startDate, endDate } = this.getParams();
        const qs = `startDate=${startDate}&endDate=${endDate}`;

        this.showLoading(true);
        try {
            if (viewMode === 'my') {
                await this.loadMySpending(qs);
            } else if (viewMode === 'group' && groupId !== 'all') {
                await this.loadGroupDetail(groupId, qs);
            } else {
                await this.loadAllGroups(qs);
            }
        } catch (err) {
            console.error('Analytics load error:', err);
        } finally {
            this.showLoading(false);
        }
    },

    // ── Mode 1: My Spending ───────────────────────────────────────────────────
    async loadMySpending(qs) {
        const [cats, timeline, groups] = await Promise.all([
            API.get(`/analytics/my/categories?${qs}`),
            API.get(`/analytics/my/timeline?${qs}`),
            API.get(`/analytics/my/groups?${qs}`),
        ]);

        const total = cats.reduce((s, c) => s + (c.total || 0), 0);

        this.setLayout(`
      <div class="analytics-summary-row">
        <div class="analytics-stat-card">
          <div class="stat-label">Total Spent (my share)</div>
          <div class="stat-value">${App.currency(total)}</div>
        </div>
        <div class="analytics-stat-card">
          <div class="stat-label">Categories</div>
          <div class="stat-value">${cats.length}</div>
        </div>
        <div class="analytics-stat-card">
          <div class="stat-label">Groups</div>
          <div class="stat-value">${groups.length}</div>
        </div>
      </div>

      <div class="analytics-charts-grid">
        <div class="chart-card chart-card-md">
          <h4>Spending by Category</h4>
          <div class="chart-wrap"><canvas id="cat-pie-chart"></canvas></div>
        </div>
        <div class="chart-card chart-card-md">
          <h4>My Spend by Group</h4>
          <div class="chart-wrap"><canvas id="group-bar-chart"></canvas></div>
        </div>
        <div class="chart-card chart-card-full">
          <h4>My Spending Timeline</h4>
          <div class="chart-wrap chart-wrap-tall"><canvas id="timeline-line-chart"></canvas></div>
        </div>
      </div>
    `);

        this.renderPie('cat-pie-chart', cats);
        this.renderGroupBar('group-bar-chart', groups);
        this.renderLine('timeline-line-chart', [{ label: 'My Spending', data: timeline, color: '#14b8a6' }]);
    },

    // ── Mode 2: Group Detail ──────────────────────────────────────────────────
    async loadGroupDetail(groupId, qs) {
        const groupName = this.groups.find(g => g.id == groupId)?.name || `Group ${groupId}`;

        const [cats, members, timeline] = await Promise.all([
            API.get(`/analytics/group/${groupId}/categories?${qs}`),
            API.get(`/analytics/group/${groupId}/members?${qs}`),
            API.get(`/analytics/group/${groupId}/timeline?${qs}`),
        ]);

        const totalSpend = timeline.reduce((s, t) => s + (t.total || 0), 0);

        this.setLayout(`
      <div class="analytics-summary-row">
        <div class="analytics-stat-card">
          <div class="stat-label">Total Group Spend</div>
          <div class="stat-value">${App.currency(totalSpend)}</div>
        </div>
        <div class="analytics-stat-card">
          <div class="stat-label">Members Active</div>
          <div class="stat-value">${members.length}</div>
        </div>
        <div class="analytics-stat-card">
          <div class="stat-label">Categories Used</div>
          <div class="stat-value">${cats.length}</div>
        </div>
      </div>

      <div class="analytics-charts-grid">
        <div class="chart-card chart-card-md">
          <h4>Category Breakdown</h4>
          <div class="chart-wrap"><canvas id="cat-pie-chart"></canvas></div>
        </div>
        <div class="chart-card chart-card-md">
          <h4>Who Paid Most</h4>
          <div class="chart-wrap"><canvas id="member-bar-chart"></canvas></div>
        </div>
        <div class="chart-card chart-card-full">
          <h4>${this.esc(groupName)} — Spending Over Time</h4>
          <div class="chart-wrap chart-wrap-tall"><canvas id="timeline-line-chart"></canvas></div>
        </div>
      </div>
    `);

        this.renderPie('cat-pie-chart', cats);
        this.renderMemberBar('member-bar-chart', members);
        this.renderLine('timeline-line-chart', [{
            label: groupName,
            data: timeline,
            color: '#6366f1',
        }]);
    },

    // ── Mode 3: All Groups ────────────────────────────────────────────────────
    async loadAllGroups(qs) {
        const [summary, cats, timelines] = await Promise.all([
            API.get(`/analytics/groups/summary?${qs}`),
            API.get(`/analytics/groups/categories?${qs}`),
            API.get(`/analytics/groups/timelines?${qs}`),
        ]);

        const totalSpend = summary.reduce((s, g) => s + (g.total || 0), 0);

        this.setLayout(`
      <div class="analytics-summary-row">
        <div class="analytics-stat-card">
          <div class="stat-label">Total All Groups</div>
          <div class="stat-value">${App.currency(totalSpend)}</div>
        </div>
        <div class="analytics-stat-card">
          <div class="stat-label">Active Groups</div>
          <div class="stat-value">${summary.length}</div>
        </div>
        <div class="analytics-stat-card">
          <div class="stat-label">Categories</div>
          <div class="stat-value">${cats.length}</div>
        </div>
      </div>

      <div class="analytics-charts-grid">
        <div class="chart-card chart-card-md">
          <h4>Spend by Group</h4>
          <div class="chart-wrap"><canvas id="groups-bar-chart"></canvas></div>
        </div>
        <div class="chart-card chart-card-md">
          <h4>Category Breakdown (All Groups)</h4>
          <div class="chart-wrap"><canvas id="cat-pie-chart"></canvas></div>
        </div>
        <div class="chart-card chart-card-full">
          <h4>Spending Timeline by Group</h4>
          <div class="chart-wrap chart-wrap-tall"><canvas id="timeline-line-chart"></canvas></div>
        </div>
      </div>
    `);

        // Group bar
        this.renderGroupBar('groups-bar-chart', summary.map(g => ({
            group_name: g.group_name, total: g.total
        })));

        // Category pie
        this.renderPie('cat-pie-chart', cats);

        // Multi-line: one series per group
        const PALETTE = ['#14b8a6', '#6366f1', '#f97316', '#ec4899', '#3b82f6', '#a855f7', '#10b981', '#06b6d4'];
        const groupIds = [...new Set(timelines.map(t => t.group_id))];
        const months = [...new Set(timelines.map(t => t.month))].sort();

        const series = groupIds.map((gid, i) => {
            const gName = timelines.find(t => t.group_id === gid)?.group_name || `Group ${gid}`;
            const data = months.map(m => {
                const found = timelines.find(t => t.group_id === gid && t.month === m);
                return found ? { month: m, total: found.total } : { month: m, total: 0 };
            });
            return { label: gName, data, color: PALETTE[i % PALETTE.length] };
        });

        this.renderLine('timeline-line-chart', series);
    },

    // ── Chart renderers ───────────────────────────────────────────────────────
    renderPie(canvasId, data) {
        this.destroyChart(canvasId);
        const ctx = document.getElementById(canvasId)?.getContext('2d');
        if (!ctx || !data.length) return;

        this.instances[canvasId] = new Chart(ctx, {
            type: 'doughnut',
            data: {
                labels: data.map(d => d.name || 'Other'),
                datasets: [{
                    data: data.map(d => Math.round((d.total || 0) * 100) / 100),
                    backgroundColor: data.map(d => (d.color || '#64748b') + 'cc'),
                    borderColor: data.map(d => d.color || '#64748b'),
                    borderWidth: 2,
                }],
            },
            options: {
                responsive: true,
                maintainAspectRatio: true,
                plugins: {
                    legend: { position: 'right', labels: { color: '#94a3b8', font: { size: 12 } } },
                    tooltip: {
                        callbacks: {
                            label: (ctx) => ` ${App.currency(ctx.parsed)}`,
                        },
                    },
                },
            },
        });
    },

    renderGroupBar(canvasId, data) {
        this.destroyChart(canvasId);
        const ctx = document.getElementById(canvasId)?.getContext('2d');
        if (!ctx || !data.length) return;

        const PALETTE = ['#14b8a6', '#6366f1', '#f97316', '#ec4899', '#3b82f6', '#a855f7'];

        this.instances[canvasId] = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: data.map(d => d.group_name),
                datasets: [{
                    label: 'Spent',
                    data: data.map(d => Math.round((d.total || 0) * 100) / 100),
                    backgroundColor: data.map((_, i) => PALETTE[i % PALETTE.length] + 'bb'),
                    borderColor: data.map((_, i) => PALETTE[i % PALETTE.length]),
                    borderWidth: 2,
                    borderRadius: 8,
                }],
            },
            options: {
                responsive: true,
                maintainAspectRatio: true,
                plugins: {
                    legend: { display: false },
                    tooltip: { callbacks: { label: (ctx) => ` ${App.currency(ctx.parsed.y)}` } },
                },
                scales: {
                    x: { ticks: { color: '#94a3b8' }, grid: { color: 'rgba(255,255,255,0.05)' } },
                    y: {
                        ticks: { color: '#94a3b8', callback: v => App.currency(v) },
                        grid: { color: 'rgba(255,255,255,0.05)' },
                    },
                },
            },
        });
    },

    renderMemberBar(canvasId, data) {
        this.destroyChart(canvasId);
        const ctx = document.getElementById(canvasId)?.getContext('2d');
        if (!ctx || !data.length) return;

        this.instances[canvasId] = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: data.map(d => d.name),
                datasets: [{
                    label: 'Total Paid',
                    data: data.map(d => Math.round((d.total_paid || 0) * 100) / 100),
                    backgroundColor: data.map(d => (d.avatar_color || '#14b8a6') + 'bb'),
                    borderColor: data.map(d => d.avatar_color || '#14b8a6'),
                    borderWidth: 2,
                    borderRadius: 8,
                }],
            },
            options: {
                indexAxis: 'y',
                responsive: true,
                maintainAspectRatio: true,
                plugins: {
                    legend: { display: false },
                    tooltip: { callbacks: { label: (ctx) => ` ${App.currency(ctx.parsed.x)}` } },
                },
                scales: {
                    x: {
                        ticks: { color: '#94a3b8', callback: v => App.currency(v) },
                        grid: { color: 'rgba(255,255,255,0.05)' },
                    },
                    y: { ticks: { color: '#94a3b8' }, grid: { color: 'rgba(255,255,255,0.05)' } },
                },
            },
        });
    },

    renderLine(canvasId, series) {
        this.destroyChart(canvasId);
        const ctx = document.getElementById(canvasId)?.getContext('2d');
        if (!ctx || !series.length) return;

        // Collect all months across all series
        const allMonths = [...new Set(series.flatMap(s => s.data.map(d => d.month)))].sort();

        const datasets = series.map(s => ({
            label: s.label,
            data: allMonths.map(m => {
                const found = s.data.find(d => d.month === m);
                return found ? Math.round((found.total || 0) * 100) / 100 : 0;
            }),
            borderColor: s.color,
            backgroundColor: s.color + '22',
            tension: 0.4,
            fill: series.length === 1,
            pointBackgroundColor: s.color,
            pointRadius: 4,
        }));

        this.instances[canvasId] = new Chart(ctx, {
            type: 'line',
            data: { labels: allMonths.map(m => this.fmtMonth(m)), datasets },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        display: series.length > 1,
                        labels: { color: '#94a3b8', font: { size: 12 } },
                    },
                    tooltip: { callbacks: { label: (ctx) => ` ${App.currency(ctx.parsed.y)}` } },
                },
                scales: {
                    x: { ticks: { color: '#94a3b8' }, grid: { color: 'rgba(255,255,255,0.05)' } },
                    y: {
                        ticks: { color: '#94a3b8', callback: v => App.currency(v) },
                        grid: { color: 'rgba(255,255,255,0.05)' },
                    },
                },
            },
        });
    },

    // ── Helpers ───────────────────────────────────────────────────────────────
    destroyChart(id) {
        if (this.instances[id]) {
            this.instances[id].destroy();
            delete this.instances[id];
        }
    },

    setLayout(html) {
        const body = document.getElementById('analytics-body');
        if (body) body.innerHTML = html;
        // Destroy old charts if any canvas was replaced
        for (const id of Object.keys(this.instances)) {
            if (!document.getElementById(id)) delete this.instances[id];
        }
    },

    showLoading(show) {
        const body = document.getElementById('analytics-body');
        if (show && body) {
            body.innerHTML = `
        <div style="text-align:center;padding:3rem;color:var(--text-muted)">
          <div class="spinner" style="margin:0 auto 1rem"></div>
          Loading analytics…
        </div>`;
        }
    },

    fmtMonth(ym) {
        if (!ym) return '';
        const [y, m] = ym.split('-');
        const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        return `${names[parseInt(m) - 1]} ${y}`;
    },

    esc(str) {
        const d = document.createElement('div');
        d.textContent = str || '';
        return d.innerHTML;
    },
};
