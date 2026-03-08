const express = require('express');

const router = express.Router();
// ping
router.get('/', (req, res) => {
    try {
        res.status(200).json({
            status: "ok",
            message: "pong",
            timestamp: new Date()
        });
    } catch (err) {
        console.error('Me error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

module.exports = router;
