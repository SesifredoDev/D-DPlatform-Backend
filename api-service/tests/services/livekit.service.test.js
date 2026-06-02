const mockAddGrant = jest.fn();
const mockToJwt = jest.fn();

jest.mock('livekit-server-sdk', () => ({
    AccessToken: jest.fn().mockImplementation((apiKey, apiSecret, options) => ({
        apiKey,
        apiSecret,
        options,
        addGrant: mockAddGrant,
        toJwt: mockToJwt
    }))
}));

jest.mock('axios');
jest.mock('../../models/Channel');
jest.mock('../../models/Server');
jest.mock('../../controllers/channel.controller', () => ({
    canJoinCallChannel: jest.fn()
}));

const axios = require('axios');
const { AccessToken } = require('livekit-server-sdk');
const Channel = require('../../models/Channel');
const Server = require('../../models/Server');
const { canJoinCallChannel } = require('../../controllers/channel.controller');
const { createLiveKitConnectionInfo, normalizeTokenRequest } = require('../../services/livekit.service');

describe('livekit.service', () => {
    const userId = '507f1f77bcf86cd799439011';
    const channelId = '507f1f77bcf86cd799439012';
    const serverId = '507f1f77bcf86cd799439013';
    const identity = `${userId}:desktop-device`;

    beforeEach(() => {
        jest.clearAllMocks();
        mockToJwt.mockResolvedValue('signed-livekit-token');
        axios.get.mockResolvedValue({
            data: [{ urls: 'turn:example.test:443', username: 'user', credential: 'pass' }]
        });
    });

    it('normalizes legacy room query requests', () => {
        expect(normalizeTokenRequest({ room: channelId, identity })).toEqual({ channelId, identity });
    });

    it('rejects identities that do not belong to the authenticated user', async () => {
        await expect(createLiveKitConnectionInfo({
            channelId,
            identity: '507f1f77bcf86cd799439099:desktop-device'
        }, userId)).rejects.toMatchObject({
            statusCode: 403,
            message: 'Invalid call identity'
        });

        expect(Channel.findById).not.toHaveBeenCalled();
    });

    it('rejects non-call channels before issuing a token', async () => {
        Channel.findById.mockResolvedValue({ _id: channelId, server: serverId, type: 'text' });

        await expect(createLiveKitConnectionInfo({ channelId, identity }, userId)).rejects.toMatchObject({
            statusCode: 404,
            message: 'Call channel not found'
        });

        expect(AccessToken).not.toHaveBeenCalled();
    });

    it('checks channel join permissions before issuing a token', async () => {
        const channel = { _id: channelId, server: serverId, type: 'call' };
        const server = {
            _id: serverId,
            members: [{ user: userId, roles: [] }]
        };

        Channel.findById.mockResolvedValue(channel);
        Server.findById.mockResolvedValue(server);
        canJoinCallChannel.mockResolvedValue(false);

        await expect(createLiveKitConnectionInfo({ channelId, identity }, userId)).rejects.toMatchObject({
            statusCode: 403,
            message: 'You do not have permission to join this call'
        });

        expect(canJoinCallChannel).toHaveBeenCalledWith(server, server.members[0], channel);
        expect(AccessToken).not.toHaveBeenCalled();
    });

    it('issues a room-scoped LiveKit token for authorized members', async () => {
        const channel = { _id: channelId, server: serverId, type: 'call' };
        const server = {
            _id: serverId,
            members: [{ user: userId, roles: [] }]
        };

        Channel.findById.mockResolvedValue(channel);
        Server.findById.mockResolvedValue(server);
        canJoinCallChannel.mockResolvedValue(true);

        const result = await createLiveKitConnectionInfo({ channelId, identity }, userId);

        expect(AccessToken).toHaveBeenCalledWith(
            expect.any(String),
            expect.any(String),
            { identity }
        );
        expect(mockAddGrant).toHaveBeenCalledWith({
            roomJoin: true,
            room: channelId,
            canPublish: true,
            canSubscribe: true,
            canUpdateOwnMetadata: true
        });
        expect(result).toEqual({
            token: 'signed-livekit-token',
            iceServers: [{ urls: 'turn:example.test:443', username: 'user', credential: 'pass' }]
        });
    });
});
