jest.mock('redis', () => ({
    createClient: jest.fn().mockReturnValue({
        on: jest.fn(),
        connect: jest.fn().mockResolvedValue(),
        publish: jest.fn().mockResolvedValue(),
        isOpen: true
    })
}));

jest.mock('../../models/Message');
jest.mock('../../models/Channel');
jest.mock('../../models/Server');
jest.mock('../../models/Roles');
jest.mock('../../models/Character');

const messageController = require('../../controllers/message.controller');
const Message = require('../../models/Message');
const Channel = require('../../models/Channel');
const Server = require('../../models/Server');
const Role = require('../../models/Roles');
const Character = require('../../models/Character');

describe('Message Controller', () => {
    let req;
    let res;

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
        it('creates and returns a message when the user can send', async () => {
            Channel.findById.mockResolvedValue({
                _id: 'channel123',
                server: 'server123',
                permissionOverwrites: []
            });
            Server.findById.mockResolvedValue({
                _id: 'server123',
                owner: { toString: () => 'user123' }
            });

            const payload = {
                _id: 'msg123',
                content: 'Hello',
                attachments: [],
                author: { _id: 'user123' }
            };
            const mockMessage = {
                populate: jest.fn().mockResolvedValue(),
                toObject: jest.fn().mockReturnValue(payload)
            };
            Message.create.mockResolvedValue(mockMessage);

            await messageController.sendMessage(req, res);

            expect(Message.create).toHaveBeenCalledWith({
                channel: 'channel123',
                server: 'server123',
                author: 'user123',
                character: null,
                content: 'Hello',
                attachments: [],
                replyTo: null,
                isWhisper: false,
                recipient: null
            });
            expect(mockMessage.populate).toHaveBeenCalled();
            expect(res.status).toHaveBeenCalledWith(201);
            expect(res.json).toHaveBeenCalledWith({
                ...payload,
                channelId: 'channel123'
            });
        });

        it('returns 403 when the user lacks SEND_MESSAGES permission', async () => {
            Channel.findById.mockResolvedValue({
                _id: 'channel123',
                server: 'server123',
                permissionOverwrites: []
            });
            Server.findById.mockResolvedValue({
                _id: 'server123',
                owner: { toString: () => 'owner123' },
                members: [{ user: { toString: () => 'user123' }, roles: [] }]
            });
            Role.find.mockResolvedValue([]);

            await messageController.sendMessage(req, res);

            expect(Message.create).not.toHaveBeenCalled();
            expect(res.status).toHaveBeenCalledWith(403);
            expect(res.json).toHaveBeenCalledWith({ message: 'Permission denied' });
        });

        it('returns 403 when the provided character does not belong to the user', async () => {
            req.body.characterId = 'char123';

            Channel.findById.mockResolvedValue({
                _id: 'channel123',
                server: 'server123',
                permissionOverwrites: []
            });
            Server.findById.mockResolvedValue({
                _id: 'server123',
                owner: { toString: () => 'user123' }
            });
            Character.findOne.mockResolvedValue(null);

            await messageController.sendMessage(req, res);

            expect(Character.findOne).toHaveBeenCalledWith({
                _id: 'char123',
                ownerId: 'user123'
            });
            expect(Message.create).not.toHaveBeenCalled();
            expect(res.status).toHaveBeenCalledWith(403);
            expect(res.json).toHaveBeenCalledWith({ message: 'Invalid character' });
        });
    });

    describe('getMessages', () => {
        const buildQueryChain = (messages) => {
            const chain = {
                sort: jest.fn().mockReturnThis(),
                limit: jest.fn().mockReturnThis(),
                populate: jest.fn().mockReturnThis(),
                lean: jest.fn().mockResolvedValue(messages)
            };

            return chain;
        };

        it('loads all messages in a whisper channel for the recipient', async () => {
            const whisperChannel = {
                _id: 'channel123',
                server: 'server123',
                type: 'whisper',
                recipient: { toString: () => 'user123' },
                permissionOverwrites: []
            };
            Channel.findById.mockResolvedValue(whisperChannel);
            Server.findById
                .mockResolvedValueOnce({
                    _id: 'server123',
                    owner: { toString: () => 'owner123' },
                    members: [{ user: { toString: () => 'user123' }, roles: [] }]
                })
                .mockResolvedValueOnce({
                    _id: 'server123',
                    owner: { toString: () => 'owner123' },
                    members: [{ user: { toString: () => 'user123' }, roles: [] }]
                });
            Role.find.mockResolvedValue([
                { permissions: { READ_MESSAGE_HISTORY: true } }
            ]);

            const messages = [
                { _id: 'msg1', content: 'old whisper', isWhisper: true, recipient: 'someone-else' },
                { _id: 'msg2', content: 'new whisper', isWhisper: true, recipient: 'user123' }
            ];
            const chain = buildQueryChain(messages);
            Message.find.mockReturnValue(chain);

            await messageController.getMessages(req, res);

            expect(Message.find).toHaveBeenCalledWith({ channel: 'channel123' });
            expect(chain.sort).toHaveBeenCalledWith({ createdAt: -1 });
            expect(chain.limit).toHaveBeenCalledWith(50);
            expect(res.json).toHaveBeenCalledWith(messages);
        });

        it('returns 403 when a non-participant requests a whisper channel history', async () => {
            const whisperChannel = {
                _id: 'channel123',
                server: 'server123',
                type: 'whisper',
                recipient: { toString: () => 'recipient456' },
                permissionOverwrites: []
            };
            Channel.findById.mockResolvedValue(whisperChannel);
            Server.findById
                .mockResolvedValueOnce({
                    _id: 'server123',
                    owner: { toString: () => 'owner123' },
                    members: [{ user: { toString: () => 'user123' }, roles: [] }]
                })
                .mockResolvedValueOnce({
                    _id: 'server123',
                    owner: { toString: () => 'owner123' },
                    members: [{ user: { toString: () => 'user123' }, roles: [] }]
                });
            Role.find.mockResolvedValue([
                { permissions: { READ_MESSAGE_HISTORY: true } }
            ]);

            await messageController.getMessages(req, res);

            expect(Message.find).not.toHaveBeenCalled();
            expect(res.status).toHaveBeenCalledWith(403);
            expect(res.json).toHaveBeenCalledWith({ message: 'Access denied' });
        });

        it('filters non-whisper channel history to public messages and the user whisper traffic', async () => {
            Channel.findById.mockResolvedValue({
                _id: 'channel123',
                server: 'server123',
                type: 'text',
                permissionOverwrites: []
            });
            Server.findById
                .mockResolvedValueOnce({
                    _id: 'server123',
                    owner: { toString: () => 'owner123' },
                    members: [{ user: { toString: () => 'user123' }, roles: [] }]
                })
                .mockResolvedValueOnce({
                    _id: 'server123',
                    owner: { toString: () => 'owner123' },
                    members: [{ user: { toString: () => 'user123' }, roles: [] }]
                });
            Role.find.mockResolvedValue([
                { permissions: { READ_MESSAGE_HISTORY: true } }
            ]);

            const chain = buildQueryChain([]);
            Message.find.mockReturnValue(chain);

            await messageController.getMessages(req, res);

            expect(Message.find).toHaveBeenCalledWith({
                channel: 'channel123',
                $or: [
                    { isWhisper: { $ne: true } },
                    { author: 'user123' },
                    { recipient: 'user123' }
                ]
            });
            expect(res.json).toHaveBeenCalledWith([]);
        });
    });

    describe('addReaction', () => {
        it('adds a new reaction when the emoji does not exist yet', async () => {
            const mockMessage = {
                _id: 'msg123',
                channel: 'channel123',
                reactions: [],
                save: jest.fn().mockResolvedValue()
            };
            Message.findById.mockResolvedValue(mockMessage);

            await messageController.addReaction(req, res);

            expect(mockMessage.reactions).toEqual([{ emoji: '😀', users: ['user123'] }]);
            expect(mockMessage.save).toHaveBeenCalled();
            expect(res.json).toHaveBeenCalledWith(mockMessage.reactions);
        });

        it('does not duplicate a user when they react with the same emoji twice', async () => {
            const mockMessage = {
                _id: 'msg123',
                channel: 'channel123',
                reactions: [{ emoji: '😀', users: ['user123'] }],
                save: jest.fn().mockResolvedValue()
            };
            Message.findById.mockResolvedValue(mockMessage);

            await messageController.addReaction(req, res);

            expect(mockMessage.reactions).toEqual([{ emoji: '😀', users: ['user123'] }]);
            expect(mockMessage.save).toHaveBeenCalled();
            expect(res.json).toHaveBeenCalledWith(mockMessage.reactions);
        });
    });
});
