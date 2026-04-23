const { server, io, start, shutdown, userSocketMap } = require('../index');
const ioClient = require('socket.io-client');
const http = require('http');

let clientSocket;
let redisCallbacks = {};

// Mock Redis Client
const mockRedisClient = {
    connect: jest.fn().mockResolvedValue(null),
    subscribe: jest.fn().mockImplementation((channel, callback) => {
        redisCallbacks[channel] = callback;
        return Promise.resolve();
    }),
    isOpen: true,
};

beforeAll((done) => {
    // Start server on a random port for testing
    server.listen(() => {
        const port = server.address().port;
        start(mockRedisClient).then(() => {
            done();
        });
    });
});

afterAll(async () => {
    await shutdown('TEST');
});

beforeEach((done) => {
    const port = server.address().port;
    clientSocket = ioClient(`http://localhost:${port}`, {
        path: '/socket.io/',
        auth: { userId: 'user123' },
        forceNew: true
    });
    clientSocket.on('connect', done);
});

afterEach(() => {
    if (clientSocket.connected) {
        clientSocket.disconnect();
    }
    userSocketMap.clear();
    // Do NOT clear redisCallbacks here because start() only runs once in beforeAll
});

describe('Messaging Service', () => {
    test('should map userId to socketId on connection', () => {
        expect(userSocketMap.has('user123')).toBe(true);
        expect(userSocketMap.get('user123')).toBe(clientSocket.id);
    });

    test('should join channel room', (done) => {
        const channelId = 'channel_A';
        clientSocket.emit('join_channel', channelId);
        
        setTimeout(() => {
            const socket = io.sockets.sockets.get(clientSocket.id);
            expect(socket.rooms.has(channelId)).toBe(true);
            done();
        }, 100);
    });

    test('should join server room', (done) => {
        const serverId = 'server_B';
        clientSocket.emit('join_server', serverId);
        
        setTimeout(() => {
            const socket = io.sockets.sockets.get(clientSocket.id);
            expect(socket.rooms.has(`server:${serverId}`)).toBe(true);
            done();
        }, 100);
    });

    test('should broadcast message to channel', (done) => {
        const channelId = 'channel_A';
        const messageData = { channelId, text: 'Hello', author: 'user123' };
        
        clientSocket.emit('join_channel', channelId);

        clientSocket.on('new_message', (data) => {
            expect(data.text).toBe('Hello');
            expect(data.channelId).toBe(channelId);
            done();
        });

        setTimeout(() => {
            const payload = JSON.stringify({
                type: 'NEW_MESSAGE',
                data: messageData
            });
            if (redisCallbacks['CHAT_MESSAGES']) {
                redisCallbacks['CHAT_MESSAGES'](payload);
            } else {
                done(new Error('CHAT_MESSAGES callback not registered'));
            }
        }, 100);
    });

    test('should handle whispers correctly', (done) => {
        const recipientId = 'recipient456';
        const whisperData = { 
            text: 'Secret', 
            author: 'user123', 
            recipient: recipientId,
            isWhisper: true 
        };

        const ioToSpy = jest.spyOn(io, 'to');
        userSocketMap.set(recipientId, 'recipient-socket-id');

        const payload = JSON.stringify({
            type: 'NEW_MESSAGE',
            data: whisperData
        });
        
        if (redisCallbacks['CHAT_MESSAGES']) {
            redisCallbacks['CHAT_MESSAGES'](payload);
            expect(ioToSpy).toHaveBeenCalledWith(clientSocket.id); // Sender
            expect(ioToSpy).toHaveBeenCalledWith('recipient-socket-id'); // Recipient
            ioToSpy.mockRestore();
            done();
        } else {
            ioToSpy.mockRestore();
            done(new Error('CHAT_MESSAGES callback not registered'));
        }
    });

    test('should broadcast server updates', (done) => {
        const serverId = 'server_B';
        clientSocket.emit('join_server', serverId);

        clientSocket.on('member_update', (data) => {
            expect(data.userId).toBe('user456');
            done();
        });

        setTimeout(() => {
            const payload = JSON.stringify({
                type: 'MEMBER_UPDATE',
                serverId: serverId,
                data: { userId: 'user456' }
            });
            if (redisCallbacks['SERVER_UPDATES']) {
                redisCallbacks['SERVER_UPDATES'](payload);
            } else {
                done(new Error('SERVER_UPDATES callback not registered'));
            }
        }, 100);
    });

    test('should remove userId from map on disconnect', (done) => {
        expect(userSocketMap.has('user123')).toBe(true);
        clientSocket.disconnect();
        
        setTimeout(() => {
            expect(userSocketMap.has('user123')).toBe(false);
            done();
        }, 100);
    });
});
