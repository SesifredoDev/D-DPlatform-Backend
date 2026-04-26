const express = require('express');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const User = require('../models/User');
const RefreshToken = require('../models/RefreshToken');
const {
    generateAccessToken,
    createRefreshToken,
    getRefreshTokenTtlMs,
    rotateRefreshToken,
} = require('../services/token.service');

const router = express.Router();

function getRefreshCookieOptions() {
    const isProduction = process.env.NODE_ENV === 'production';

    return {
        httpOnly: true,
        maxAge: getRefreshTokenTtlMs(),
        sameSite: isProduction ? 'none' : 'lax',
        secure: isProduction,
        path: '/',
    };
}

/**
 * REGISTER
 */
router.post('/register', async (req, res) => {
    try {
        const { username, email, password } = req.body;

        if (!username || !email || !password) {
            return res.status(400).json({ message: 'All fields are required' });
        }

        const existingUser = await User.findOne({ email });
        if (existingUser) {
            return res.status(409).json({ message: 'Email already in use' });
        }

        const hashed = await bcrypt.hash(password, 12);
        const user = await User.create({ username, email, password: hashed });

        res.status(201).json({ id: user._id, message: 'User created successfully' });
    } catch (error) {
        console.error('Registration Error:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

/**
 * LOGIN
 */
router.post('/login', async (req, res) => {
    try {
        const { email, password } = req.body;

        const user = await User.findOne({ email });
        if (!user) return res.sendStatus(401);

        const valid = await bcrypt.compare(password, user.password);
        if (!valid) return res.sendStatus(401);

        const accessToken = generateAccessToken(user);
        const refreshToken = await createRefreshToken(user._id);

        res
            .cookie('refreshToken', refreshToken, getRefreshCookieOptions())
            .json({ accessToken });
    } catch (error) {
        console.error('Login Error:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

router.post('/refresh', async (req, res) => {
    try {
        const oldToken = req.cookies.refreshToken;
        if (!oldToken) return res.sendStatus(401);

        const oldHash = crypto
            .createHash('sha256')
            .update(oldToken)
            .digest('hex');

        const stored = await RefreshToken.findOne({ tokenHash: oldHash }).populate('user');

        if (!stored || stored.expiresAt < Date.now()) {
            if (stored) {
                await RefreshToken.deleteOne({ tokenHash: oldHash });
            }
            return res.status(403).json({ message: 'Refresh Token Aged Out' });
        }

        const newRefreshToken = await rotateRefreshToken(
            oldToken,
            stored.user._id
        );

        const accessToken = generateAccessToken(stored.user);

        res
            .cookie('refreshToken', newRefreshToken, getRefreshCookieOptions())
            .json({ accessToken });
    } catch (error) {
        console.error('Refresh Error:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

/**
 * LOGOUT
 */
router.post('/logout', async (req, res) => {
    try {
        const token = req.cookies.refreshToken;

        if (token) {
            const hash = crypto.createHash('sha256').update(token).digest('hex');
            await RefreshToken.deleteOne({ tokenHash: hash });
        }

        res.clearCookie('refreshToken', getRefreshCookieOptions()).sendStatus(204);
    } catch (error) {
        console.error('Logout Error:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

module.exports = router;
