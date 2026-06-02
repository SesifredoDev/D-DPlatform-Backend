const axios = require('axios');
const mongoose = require('mongoose');
const { AccessToken } = require('livekit-server-sdk');

const Channel = require('../models/Channel');
const Server = require('../models/Server');
const { canJoinCallChannel } = require('../controllers/channel.controller');
const { resolveId } = require('../utils/permissions');

function createHttpError(statusCode, message) {
    const error = new Error(message);
    error.statusCode = statusCode;
    return error;
}

function getFirstString(value) {
    const rawValue = Array.isArray(value) ? value[0] : value;
    return typeof rawValue === 'string' ? rawValue.trim() : '';
}

function normalizeTokenRequest(input = {}) {
    return {
        channelId: getFirstString(input.channelId || input.room),
        identity: getFirstString(input.identity)
    };
}

function assertIdentityBelongsToUser(identity, userId) {
    const userIdText = String(userId || '');
    if (!userIdText || (identity !== userIdText && !identity.startsWith(`${userIdText}:`))) {
        throw createHttpError(403, 'Invalid call identity');
    }
}

async function getTurnIceServers() {
    try {
        const meteredApiKey = process.env.METERED_SECRET_KEY || '1186d9c786f96006023c36e08c6e19cb5886';
        const response = await axios.get(`https://dissertation.metered.live/api/v1/turn/credentials?apiKey=${meteredApiKey}`);
        return response.data;
    } catch (meteredError) {
        console.error('Failed to fetch Metered credentials, using fallbacks:', meteredError.message);
        return [
            { urls: 'stun:stun.relay.metered.ca:80' },
            {
                urls: [
                    'turn:global.relay.metered.ca:80',
                    'turn:global.relay.metered.ca:80?transport=tcp',
                    'turn:global.relay.metered.ca:443',
                    'turns:global.relay.metered.ca:443?transport=tcp'
                ],
                username: process.env.METERED_USERNAME,
                credential: process.env.METERED_CREDENTIAL
            }
        ];
    }
}

async function createLiveKitConnectionInfo(rawRequest, userId) {
    const { channelId, identity } = normalizeTokenRequest(rawRequest);

    if (!channelId || !identity) {
        throw createHttpError(400, 'channelId and identity are required');
    }

    if (!mongoose.isValidObjectId(channelId)) {
        throw createHttpError(400, 'Invalid channelId');
    }

    assertIdentityBelongsToUser(identity, userId);

    const channel = await Channel.findById(channelId);
    if (!channel || channel.type !== 'call') {
        throw createHttpError(404, 'Call channel not found');
    }

    const server = await Server.findById(channel.server);
    if (!server) {
        throw createHttpError(404, 'Server not found');
    }

    const member = (server.members || []).find(m => resolveId(m.user) === String(userId));
    if (!member || !(await canJoinCallChannel(server, member, channel))) {
        throw createHttpError(403, 'You do not have permission to join this call');
    }

    const apiKey = process.env.LIVEKIT_API_KEY || 'devkey';
    const apiSecret = process.env.LIVEKIT_API_SECRET || 'superlongsecuresecretkeyatleast32chars!!';

    const accessToken = new AccessToken(apiKey, apiSecret, { identity });
    accessToken.addGrant({
        roomJoin: true,
        room: channelId,
        canPublish: true,
        canSubscribe: true,
        canUpdateOwnMetadata: true
    });

    return {
        token: await accessToken.toJwt(),
        iceServers: await getTurnIceServers()
    };
}

module.exports = {
    createLiveKitConnectionInfo,
    normalizeTokenRequest
};
