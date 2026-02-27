// API Client with JWT token management
const API = {
    // Falls back to /api for local development, or uses a specific URL if configured
    BASE: window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
        ? '/api'
        : (localStorage.getItem('API_URL') || '/api'),
    token: localStorage.getItem('token'),

    setToken(token) {
        this.token = token;
        if (token) {
            localStorage.setItem('token', token);
        } else {
            localStorage.removeItem('token');
        }
    },

    async request(method, path, body = null) {
        const opts = {
            method,
            headers: { 'Content-Type': 'application/json' },
        };

        if (this.token) {
            opts.headers['Authorization'] = `Bearer ${this.token}`;
        }

        if (body) {
            opts.body = JSON.stringify(body);
        }

        const res = await fetch(this.BASE + path, opts);
        const data = await res.json();

        if (!res.ok) {
            throw new Error(data.error || 'Something went wrong');
        }

        return data;
    },

    get(path) { return this.request('GET', path); },
    post(path, body) { return this.request('POST', path, body); },
    put(path, body) { return this.request('PUT', path, body); },
    delete(path) { return this.request('DELETE', path); },
};
