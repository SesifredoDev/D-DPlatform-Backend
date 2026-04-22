const channelController = require('../../controllers/channel.controller');
const Server = require('../../models/Server');
const Channel = require('../../models/Channel');
const { hasPermission } = require('../../utils/permissions');

jest.mock('../../models/Server');
jest.mock('../../models/Channel');
jest.mock('../../models/Roles');
jest.mock('../../utils/permissions');

describe('Channel Controller', () => {
    let req, res;

    beforeEach(() => {
        req = {
            user: { id: 'user123' },
            params: { serverId: 'server123', channelId: 'channel123' },
            body: { name: 'new-channel', type: 'text' }
        };
        res = {
            status: jest.fn().mockReturnThis(),
            json: jest.fn().mockReturnThis()
        };
        jest.clearAllMocks();
    });

    describe('createChannel', () => {
        it('should create a channel if user has permissions', async () => {
            const mockServer = {
                _id: 'server123',
                members: [{ user: 'user123' }]
            };
            Server.findById.mockResolvedValue(mockServer);
            hasPermission.mockResolvedValue(true);
            Channel.countDocuments.mockResolvedValue(0);
            Channel.create.mockResolvedValue({ name: 'new-channel', position: 0 });

            await channelController.createChannel(req, res);

            expect(Channel.create).toHaveBeenCalled();
            expect(res.status).toHaveBeenCalledWith(201);
            expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ name: 'new-channel' }));
        });

        it('should return 403 if user lacks permissions', async () => {
            Server.findById.mockResolvedValue({
                members: [{ user: 'user123' }]
            });
            hasPermission.mockResolvedValue(false);

            await channelController.createChannel(req, res);

            expect(res.status).toHaveBeenCalledWith(403);
        });

        it('should return 404 if server not found', async () => {
            Server.findById.mockResolvedValue(null);

            await channelController.createChannel(req, res);

            expect(res.status).toHaveBeenCalledWith(404);
        });
    });

    describe('deleteChannel', () => {
        it('should delete channel if user has permission', async () => {
            Server.findById.mockResolvedValue({
                members: [{ user: 'user123' }]
            });
            hasPermission.mockResolvedValue(true);
            Channel.deleteOne.mockResolvedValue({ deletedCount: 1 });

            await channelController.deleteChannel(req, res);

            expect(Channel.deleteOne).toHaveBeenCalled();
            expect(res.json).toHaveBeenCalledWith({ message: "Channel deleted" });
        });

        it('should return 404 if channel not found during deletion', async () => {
            Server.findById.mockResolvedValue({
                members: [{ user: 'user123' }]
            });
            hasPermission.mockResolvedValue(true);
            Channel.deleteOne.mockResolvedValue({ deletedCount: 0 });

            await channelController.deleteChannel(req, res);

            expect(res.status).toHaveBeenCalledWith(404);
        });
    });
});
