const express = require('express');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const RefreshToken = require('../models/RefreshToken');
const {
    generateAccessToken,
    createRefreshToken,
    rotateRefreshToken,
} = require('../services/token.service');

const router = express.Router();

/**
 * REGISTER
 */
router.post('/register', async (req, res) => {
    const { username, email, password } = req.body;

    const hashed = await bcrypt.hash(password, 12);
    const user = await User.create({ username, email, password: hashed });

    res.status(201).json({ id: user._id });
});

/**
 * LOGIN
 */
router.post('/login', async (req, res) => {
    const { email, password } = req.body;

    const user = await User.findOne({ email });
    if (!user) return res.sendStatus(401);

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.sendStatus(401);

    const accessToken = generateAccessToken(user);
    const refreshToken = await createRefreshToken(user._id);

    res
        .cookie('refreshToken', refreshToken, {
            httpOnly: true,
            sameSite: 'lax',
            secure: false,
        })
        .json({ accessToken, refreshToken });
});
router.post('/refresh', async (req, res) => {
    const oldToken = req.cookies.refreshToken;
    console.log(req.cookies)
    if (!oldToken) return res.sendStatus(401);

    const oldHash = crypto
        .createHash('sha256')
        .update(oldToken)
        .digest('hex');

    const stored = await RefreshToken.findOne({ tokenHash: oldHash }).populate('user');

    if (!stored || stored.expiresAt < Date.now()) {
        await RefreshToken.deleteOne({ tokenHash: oldHash });
        return res.send({"code":403,  "message":"Refresh Token Aged Out"});
    }

    const newRefreshToken = await rotateRefreshToken(
        oldToken,
        stored.user._id
    );

    const accessToken = generateAccessToken(stored.user);

    res
        .cookie('refreshToken', newRefreshToken, {
            httpOnly: true,
            sameSite: 'lax',
            secure: false,
        })
        .json({ accessToken });
});

/**
 * LOGOUT
 */
router.post('/logout', async (req, res) => {
    const token = req.cookies.refreshToken;

    if (token) {
        const hash = crypto.createHash('sha256').update(token).digest('hex');
        await RefreshToken.deleteOne({ tokenHash: hash });
    }

    res.clearCookie('refreshToken').sendStatus(204);
});

module.exports = router;
