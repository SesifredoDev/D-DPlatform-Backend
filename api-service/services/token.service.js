const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const RefreshToken = require('../models/RefreshToken');

function getRefreshTokenTtlMs() {
    const ttlDays = Number(process.env.REFRESH_TOKEN_TTL_DAYS);

    if (!Number.isFinite(ttlDays) || ttlDays <= 0) {
        throw new Error('REFRESH_TOKEN_TTL_DAYS must be a positive number');
    }

    return ttlDays * 24 * 60 * 60 * 1000;
}

function generateAccessToken(user) {
    return jwt.sign(
        {
            sub: user._id.toString(),
            email: user.email,
            username: user.username,
        },
        process.env.JWT_ACCESS_SECRET,
        { expiresIn: process.env.ACCESS_TOKEN_EXPIRY }
    );
}
async function createRefreshToken(userId) {
    const token = generateRefreshToken();
    const hash = crypto.createHash('sha256').update(token).digest('hex');

    await RefreshToken.create({
        user: userId,
        tokenHash: hash,
        expiresAt: new Date(Date.now() + getRefreshTokenTtlMs()),
    });

    return token;
}

function generateRefreshToken() {
    return crypto.randomBytes(64).toString('hex');
}

async function rotateRefreshToken(oldToken, userId) {
    const oldHash = crypto.createHash('sha256').update(oldToken).digest('hex');

    // Invalidate old token
    await RefreshToken.deleteOne({ tokenHash: oldHash });

    // Create new token
    const newToken = generateRefreshToken();
    const newHash = crypto.createHash('sha256').update(newToken).digest('hex');

    await RefreshToken.create({
        user: userId,
        tokenHash: newHash,
        expiresAt: new Date(Date.now() + getRefreshTokenTtlMs()),
    });

    return newToken;
}

module.exports = {
    generateAccessToken,
    generateRefreshToken,
    createRefreshToken,
    getRefreshTokenTtlMs,
    rotateRefreshToken,
};
