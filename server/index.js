require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const { initializeDatabase } = require('./db/migrate');
const authRoutes = require('./routes/auth');
const groupRoutes = require('./routes/groups');
const expenseRoutes = require('./routes/expenses');
const settlementRoutes = require('./routes/settlements');
const analyticsRoutes = require('./routes/analytics');
const oauthRoutes = require('./routes/oauth');
const invitationRoutes = require('./routes/invitations');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Serve static frontend
app.use(express.static(path.join(__dirname, '..', 'public')));

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/groups', groupRoutes);
app.use('/api/expenses', expenseRoutes);
app.use('/api/settlements', settlementRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/oauth', oauthRoutes);
app.use('/api/invitations', invitationRoutes);

// SPA fallback — serve index.html for all non-API routes (including /invite/:token)
app.get('*', (req, res) => {
    if (!req.path.startsWith('/api')) {
        res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
    }
});

// Error handling
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    res.status(500).json({ error: 'Internal server error' });
});

// Initialize DB first, then start server
(async () => {
    try {
        await initializeDatabase();
        app.listen(PORT, () => {
            console.log(`✅ SplitEase running at http://localhost:${PORT}`);
        });
    } catch (err) {
        console.error('❌ Failed to initialize database:', err.message);
        process.exit(1);
    }
})();
