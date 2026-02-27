// Auth page logic + Google OAuth token handler + invite token handler
const Auth = {
    async init() {
        // Handle Google OAuth redirect token
        const urlParams = new URLSearchParams(window.location.search);
        const oauthToken = urlParams.get('oauth_token');
        const oauthError = urlParams.get('error');

        if (oauthToken) {
            API.setToken(oauthToken);
            window.history.replaceState({}, document.title, '/');
            // App.init will handle the rest
            return;
        }
        if (oauthError) {
            document.getElementById('auth-error').textContent =
                oauthError === 'oauth_not_configured' ? 'Google Sign-In is not configured on this server.' :
                    'Google Sign-In failed. Please try again or use email/password.';
        }

        // Handle invite token in URL path (e.g., /invite/xxx)
        const path = window.location.pathname;
        if (path.startsWith('/invite/')) {
            const token = path.split('/invite/')[1];
            if (token) {
                localStorage.setItem('pendingInviteToken', token);
                window.history.replaceState({}, document.title, '/');
            }
        }

        // Check if Google OAuth is configured
        try {
            const status = await API.get('/oauth/status');
            if (status.googleEnabled) {
                document.getElementById('google-login-btn-wrap').classList.remove('hidden');
                document.getElementById('google-register-btn-wrap').classList.remove('hidden');
            }
        } catch (e) { }

        this.bindForms();
    },

    bindForms() {
        // Toggle between login and register
        document.getElementById('show-register').addEventListener('click', (e) => {
            e.preventDefault();
            document.getElementById('login-form').classList.remove('active');
            document.getElementById('register-form').classList.add('active');
            document.getElementById('auth-error').textContent = '';
        });

        document.getElementById('show-login').addEventListener('click', (e) => {
            e.preventDefault();
            document.getElementById('register-form').classList.remove('active');
            document.getElementById('login-form').classList.add('active');
            document.getElementById('auth-error').textContent = '';
        });

        // Login
        document.getElementById('login-form').addEventListener('submit', async (e) => {
            e.preventDefault();
            const email = document.getElementById('login-email').value.trim();
            const password = document.getElementById('login-password').value;
            document.getElementById('auth-error').textContent = '';
            try {
                const data = await API.post('/auth/login', { email, password });
                API.setToken(data.token);
                App.currentUser = { id: data.id, name: data.name, email: data.email, avatar_color: data.avatar_color };
                App.categories = await API.get('/expenses/categories');
                App.showApp();
                await this.handlePendingInvite();
                App.navigate('dashboard');
            } catch (err) {
                document.getElementById('auth-error').textContent = err.message || 'Login failed';
            }
        });

        // Register
        document.getElementById('register-form').addEventListener('submit', async (e) => {
            e.preventDefault();
            const name = document.getElementById('register-name').value.trim();
            const email = document.getElementById('register-email').value.trim();
            const password = document.getElementById('register-password').value;
            document.getElementById('auth-error').textContent = '';
            try {
                const data = await API.post('/auth/register', { name, email, password });
                API.setToken(data.token);
                App.currentUser = { id: data.id, name: data.name, email: data.email, avatar_color: data.avatar_color };
                App.categories = await API.get('/expenses/categories');
                App.showApp();
                await this.handlePendingInvite();
                App.navigate('dashboard');
            } catch (err) {
                document.getElementById('auth-error').textContent = err.message || 'Registration failed';
            }
        });
    },

    async handlePendingInvite() {
        const token = localStorage.getItem('pendingInviteToken');
        if (!token) return;
        localStorage.removeItem('pendingInviteToken');
        try {
            const result = await API.post('/invitations/accept', { token });
            if (result.group) {
                App.toast(`Joined group "${result.group.name}"! 🎉`);
            }
        } catch (err) {
            App.toast(err.message || 'Could not accept invitation', 'error');
        }
    },
};

document.addEventListener('DOMContentLoaded', () => Auth.init());
