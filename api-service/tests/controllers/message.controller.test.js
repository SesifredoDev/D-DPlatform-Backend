const messageController = require('../../controllers/message.controller');
const Message = require('../../models/Message');
const Channel = require('../../models/Channel');
const Server = require('../../models/Server');
const Role = require('../../models/Roles');

jest.mock('../../models/Message');
jest.mock('../../models/Channel');
jest.mock('../../models/Server');
jest.mock('../../models/Roles');
jest.mock('../../models/Character');
jest.mock('redis', () => ({
    createClient: jest.fn().mockReturnValue({
        on: jest.fn(),
        connect: jest.fn().mockResolvedValue(),
        publish: jest.fn().mockResolvedValue(),
        isOpen: true
    })
}));

describe('Message Controller', () => {
    let req, res;

    beforeEach(() => {
        req = {
            user: { id: 'user123' },
            params: { channelId: 'channel123', messageId: 'msg123' },
            body: { content: 'Hello', emoji: '😀' },
            protocol: 'http',
            get: jest.fn().mockReturnValue('localhost')
        };
        res = {
            status: jest.fn().mockReturnThis(),
            json: jest.fn().mockReturnThis()
        };
        jest.clearAllMocks();
    });

    describe('sendMessage', () => {
        it('should send a message if user has permission', async () => {
            Channel.findById.mockResolvedValue({ _id: 'channel123', server: 'server123', permissionOverwrites: [] });
            Server.findById.mockResolvedValue({ _id: 'server123', owner: 'user123' });
            
            const mockMessage = {
                populate: jest.fn().mockReturnThis(),
                toObject: jest.fn().mockReturnValue({ content: 'Hello' })
            };
            Message.create.mockResolvedValue(mockMessage);

            await messageController.sendMessage(req, res);

            expect(Message.create).toHaveBeenCalled();
            expect(res.status).toHaveBeenCalledWith(201);
        });

        it('should return 403 if user lacks permission', async () => {
            Channel.findById.mockResolvedValue({ _id: 'channel123', server: 'server123', permissionOverwrites: [] });
            Server.findById.mockResolvedValue({ 
                _id: 'server123', 
                owner: 'otherUser',
                members: [{ user: 'user123', roles: [] }]
            });
            Role.find.mockResolvedValue([]);

            await messageController.sendMessage(req, res);

            expect(res.status).toHaveBeenCalledWith(403);
        });
    });

    describe('addReaction', () => {
        it('should add a reaction to a message', async () => {
            const mockMessage = {
                _id: 'msg123',
                reactions: [],
                save: jest.fn().mockResolvedValue()
            };
            Message.findById.mockResolvedValue(mockMessage);

            await messageController.addReaction(req, res);

            expect(mockMessage.reactions).toHaveLength(1);
            expect(mockMessage.save).toHaveBeenCalled();
            expect(res.json).toHaveBeenCalled();
        });
    });
});
