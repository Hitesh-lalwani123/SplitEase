// App Controller — routing, auth state, navigation
const App = {
    currentUser: null,
    currentPage: 'dashboard',
    categories: [],

    async init() {
        this.bindNavigation();
        this.bindModals();

        // Handle /invite/:token path — store token and redirect to /
        const path = window.location.pathname;
        if (path.startsWith('/invite/')) {
            const token = path.split('/invite/')[1];
            if (token) localStorage.setItem('pendingInviteToken', token);
            window.history.replaceState({}, document.title, '/');
        }

        // Handle Google OAuth redirect: ?oauth_token=...
        const urlParams = new URLSearchParams(window.location.search);
        const oauthToken = urlParams.get('oauth_token');
        if (oauthToken) {
            API.setToken(oauthToken);
            window.history.replaceState({}, document.title, '/');
        }

        if (API.token) {
            try {
                this.currentUser = await API.get('/auth/me');
                this.categories = await API.get('/expenses/categories');
                this.showApp();
                // Accept any pending invite after auth
                await Invitations.acceptPendingToken();
                this.navigate('dashboard');
            } catch {
                API.setToken(null);
                this.showAuth();
            }
        } else {
            this.showAuth();
        }
    },

    showAuth() {
        document.getElementById('auth-page').classList.remove('hidden');
        document.getElementById('app').classList.add('hidden');
        document.getElementById('auth-page').style.display = 'flex';
    },

    showApp() {
        document.getElementById('auth-page').style.display = 'none';
        document.getElementById('app').classList.remove('hidden');
        this.updateUserAvatar();
    },

    updateUserAvatar() {
        const avatar = document.getElementById('user-avatar');
        if (this.currentUser) {
            const initials = this.currentUser.name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);
            avatar.textContent = initials;
            avatar.style.backgroundColor = this.currentUser.avatar_color || '#14b8a6';
        }
    },

    bindNavigation() {
        // Bottom nav
        document.querySelectorAll('.nav-item[data-page]').forEach(btn => {
            btn.addEventListener('click', () => {
                this.navigate(btn.dataset.page);
            });
        });

        // FAB button
        document.getElementById('fab-add-expense')?.addEventListener('click', () => {
            Expenses.openModal();
        });

        // Add expense buttons
        document.getElementById('add-expense-btn')?.addEventListener('click', () => {
            Expenses.openModal();
        });

        // Create group
        document.getElementById('create-group-btn')?.addEventListener('click', () => {
            this.openModal('group-modal');
        });

        // Logout
        document.getElementById('logout-btn')?.addEventListener('click', () => {
            API.setToken(null);
            this.currentUser = null;
            this.showAuth();
        });

        // Calculator
        document.getElementById('calculator-btn')?.addEventListener('click', () => {
            this.openModal('calculator-modal');
        });
    },

    navigate(page) {
        this.currentPage = page;

        // Update nav
        document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
        const navBtn = document.querySelector(`.nav-item[data-page="${page}"]`);
        if (navBtn) navBtn.classList.add('active');

        // Update pages
        document.querySelectorAll('.page-section').forEach(p => p.classList.remove('active'));
        const pageEl = document.getElementById(`${page}-page`);
        if (pageEl) pageEl.classList.add('active');

        // Load page data
        switch (page) {
            case 'dashboard': Dashboard.load(); break;
            case 'groups': Groups.load(); break;
            case 'analytics':
                // Init builds controls + loads data; subsequent visits just reload data
                if (!document.getElementById('analytics-controls')?.children.length) {
                    Charts.init();
                } else {
                    Charts.load();
                }
                break;
            case 'activity': this.loadActivity(); break;
        }
    },

    async loadActivity() {
        try {
            const expenses = await API.get('/expenses/recent');
            const list = document.getElementById('all-expenses-list');
            list.innerHTML = expenses.length
                ? expenses.map(e => Expenses.renderItem(e, true)).join('')
                : '<div class="empty-state">No expenses yet</div>';
        } catch (err) {
            console.error(err);
        }
    },

    // Modal management
    bindModals() {
        document.querySelectorAll('.modal').forEach(modal => {
            modal.querySelector('.modal-overlay')?.addEventListener('click', () => {
                this.closeModal(modal.id);
            });
            modal.querySelector('.modal-close')?.addEventListener('click', () => {
                this.closeModal(modal.id);
            });
        });
    },

    openModal(id) {
        document.getElementById(id).classList.add('active');
    },

    closeModal(id) {
        document.getElementById(id).classList.remove('active');
    },

    // Toast notifications
    toast(message, type = 'success') {
        const toast = document.getElementById('toast');
        toast.textContent = message;
        toast.className = `toast show ${type}`;
        setTimeout(() => toast.className = 'toast', 2500);
    },

    // Format currency
    currency(amount) {
        const n = Number(amount) || 0;
        return '₹' + Math.abs(n).toFixed(2);
    },

    formatDate(dateStr) {
        const d = new Date(dateStr + 'T00:00:00');
        const now = new Date();
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);

        if (d.toDateString() === now.toDateString()) return 'Today';
        if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';

        return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
    },
};

// Initialize app
document.addEventListener('DOMContentLoaded', () => App.init());
