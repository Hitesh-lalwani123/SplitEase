const express = require('express');
const { google } = require('googleapis');
const jwt = require('jsonwebtoken');
const { query } = require('../db/database');

const router = express.Router();

function getOAuthClient() {
    if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) return null;
    return new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET,
        process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3000/api/oauth/google/callback'
    );
}

// Redirect to Google
router.get('/google', (req, res) => {
    const oAuth2Client = getOAuthClient();
    if (!oAuth2Client) return res.redirect('/?error=oauth_not_configured');

    const authUrl = oAuth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: ['profile', 'email'],
    });
    res.redirect(authUrl);
});

// Google callback
router.get('/google/callback', async (req, res) => {
    const oAuth2Client = getOAuthClient();
    if (!oAuth2Client) return res.redirect('/?error=oauth_not_configured');

    const { code } = req.query;
    if (!code) return res.redirect('/?error=oauth_no_code');

    try {
        const { tokens } = await oAuth2Client.getToken(code);
        oAuth2Client.setCredentials(tokens);

        const oauth2 = google.oauth2({ version: 'v2', auth: oAuth2Client });
        const { data } = await oauth2.userinfo.get();
        const { id: googleId, email, name } = data;

        const colors = ['#14b8a6', '#f97316', '#3b82f6', '#a855f7', '#ec4899', '#10b981', '#6366f1', '#eab308'];
        const avatarColor = colors[Math.floor(Math.random() * colors.length)];

        let userResult = await query('SELECT * FROM users WHERE google_id = $1 OR email = $2', [googleId, email]);
        let user = userResult.rows[0];

        if (!user) {
            const result = await query(
                'INSERT INTO users (name, email, google_id, avatar_color) VALUES ($1, $2, $3, $4) RETURNING *',
                [name, email, googleId, avatarColor]
            );
            user = result.rows[0];
        } else if (!user.google_id) {
            await query('UPDATE users SET google_id = $1 WHERE id = $2', [googleId, user.id]);
        }

        const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: '30d' });
        res.redirect(`/?oauth_token=${token}`);
    } catch (err) {
        console.error('Google OAuth error:', err);
        res.redirect('/?error=oauth_failed');
    }
});

// Check if OAuth is configured
router.get('/status', (req, res) => {
    res.json({
        googleEnabled: !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
    });
});

module.exports = router;
