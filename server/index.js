require('dotenv').config();
const http = require('http');
const express = require('express');
const cors = require('cors');
const path = require('path');
const jwt = require('jsonwebtoken');
const { Server } = require('socket.io');

const { initializeDatabase } = require('./db/migrate');
const { setIO } = require('./socketInstance');
const authRoutes = require('./routes/auth');
const groupRoutes = require('./routes/groups');
const expenseRoutes = require('./routes/expenses');
const settlementRoutes = require('./routes/settlements');
const analyticsRoutes = require('./routes/analytics');
const oauthRoutes = require('./routes/oauth');
const invitationRoutes = require('./routes/invitations');
const healthRoute = require('./routes/health');

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
app.use('/health-check', healthRoute);

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

// ─── HTTP server + Socket.IO ─────────────────────────────────────────────────
const server = http.createServer(app);

const io = new Server(server, {
    cors: { origin: '*', methods: ['GET', 'POST'] },
    transports: ['websocket', 'polling'],
});

// JWT auth middleware for Socket.IO
io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error('Authentication required'));
    try {
        const payload = jwt.verify(token, process.env.JWT_SECRET);
        socket.userId = payload.userId;
        next();
    } catch {
        next(new Error('Invalid token'));
    }
});

io.on('connection', (socket) => {
    console.log(`[socket] user ${socket.userId} connected`);

    // Client sends this after navigating to a group page
    socket.on('join-group', (groupId) => {
        const room = `group:${groupId}`;
        // Leave all other group rooms first so we only broadcast to the right group
        [...socket.rooms].forEach(r => { if (r.startsWith('group:') && r !== room) socket.leave(r); });
        socket.join(room);
        console.log(`[socket] user ${socket.userId} joined ${room}`);
    });

    socket.on('leave-group', (groupId) => {
        socket.leave(`group:${groupId}`);
    });

    socket.on('disconnect', () => {
        console.log(`[socket] user ${socket.userId} disconnected`);
    });
});

// Store io globally so workers can emit events
setIO(io);

// ─── Start server ─────────────────────────────────────────────────────────────
(async () => {
    try {
        await initializeDatabase();

        // Start the expense worker in-process (single-process mode)
        // Worker gracefully handles Redis unavailability — logs warning and skips socket/email
        require('./workers/expenseWorker');

        server.listen(PORT, () => {
            console.log(`✅ SplitEase running at http://localhost:${PORT}`);
            console.log(`🔌 Socket.IO ready`);
        });
    } catch (err) {
        console.error('❌ Failed to initialize database:', err.message);
        process.exit(1);
    }
})();
