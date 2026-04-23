const { server, io, start, shutdown, redisClient } = require('../index');
const ioClient = require('socket.io-client');

let hostSocket;
let playerSocket;
let redisData = new Map();

// Mock Redis Client
const mockRedisClient = {
    connect: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockImplementation((key, value) => {
        redisData.set(key, value);
        return Promise.resolve();
    }),
    get: jest.fn().mockImplementation((key) => {
        return Promise.resolve(redisData.get(key));
    }),
    del: jest.fn().mockImplementation((key) => {
        redisData.delete(key);
        return Promise.resolve();
    }),
    quit: jest.fn().mockResolvedValue(null),
    isOpen: true,
};

beforeAll((done) => {
    server.listen(() => {
        const port = server.address().port;
        start(mockRedisClient).then(() => {
            done();
        });
    });
});

afterAll(async () => {
    await shutdown();
});

afterEach(() => {
    if (hostSocket && hostSocket.connected) hostSocket.disconnect();
    if (playerSocket && playerSocket.connected) playerSocket.disconnect();
    redisData.clear();
    jest.clearAllMocks();
});

const createSocket = () => {
    const port = server.address().port;
    return ioClient(`http://localhost:${port}`, {
        path: '/map/',
        transports: ['websocket'],
        forceNew: true
    });
};

describe('Map Service (VTT Sync)', () => {
    test('should allow a user to host a session', (done) => {
        hostSocket = createSocket();
        const roomId = 'test-room-1';
        const initialState = { tokens: [], walls: [], gridSize: 50 };

        hostSocket.on('connect', () => {
            hostSocket.emit('host-session', { roomId, initialState });
            
            setTimeout(() => {
                expect(redisData.has(`room:${roomId}`)).toBe(true);
                expect(redisData.get(`room:${roomId}:host`)).toBe(hostSocket.id);
                done();
            }, 100);
        });
    });

    test('should allow a player to join an existing session', (done) => {
        const roomId = 'test-room-2';
        const state = JSON.stringify({ tokens: [{ id: 1, x: 10, y: 10 }], version: 1 });
        redisData.set(`room:${roomId}`, state);
        redisData.set(`room:${roomId}:host`, 'some-host-id');

        playerSocket = createSocket();
        playerSocket.on('connect', () => {
            playerSocket.emit('join-session', { roomId });

            playerSocket.on('map-update', (receivedState) => {
                expect(receivedState.version).toBe(1);
                expect(receivedState.tokens[0].id).toBe(1);
                done();
            });
        });
    });

    test('should sync actions between host and players', (done) => {
        const roomId = 'test-room-3';
        const initialState = { tokens: [{ id: 't1', x: 0, y: 0 }], version: 0 };
        redisData.set(`room:${roomId}`, JSON.stringify(initialState));

        hostSocket = createSocket();
        playerSocket = createSocket();

        // Host joins first
        hostSocket.on('connect', () => {
            hostSocket.emit('host-session', { roomId });

            // Player joins after host
            playerSocket.on('connect', () => {
                playerSocket.emit('join-session', { roomId });
                
                playerSocket.on('remote-action', (payload) => {
                    if (payload.action === 'token-move') {
                        expect(payload.data.id).toBe('t1');
                        expect(payload.data.x).toBe(100);
                        done();
                    }
                });

                // Small delay to ensure player has joined the room on server side
                setTimeout(() => {
                    hostSocket.emit('sync-action', { 
                        roomId, 
                        action: 'token-move', 
                        data: { id: 't1', x: 100, y: 100 } 
                    });
                }, 100);
            });
        });
    });

    test('should handle turn order updates', (done) => {
        const roomId = 'test-room-4';
        const initialState = { tokens: [], turnOrder: { entries: [] }, version: 0 };
        redisData.set(`room:${roomId}`, JSON.stringify(initialState));

        hostSocket = createSocket();
        hostSocket.on('connect', () => {
            // Must join room to receive the broadcast back
            hostSocket.emit('host-session', { roomId });

            hostSocket.on('remote-action', (payload) => {
                if (payload.action === 'turn-order-sync') {
                    expect(payload.data.entries[0].id).toBe('char1');
                    done();
                }
            });

            setTimeout(() => {
                hostSocket.emit('sync-action', {
                    roomId,
                    action: 'turn-order-add',
                    data: { id: 'char1', name: 'Hero', initiative: 20 }
                });
            }, 100);
        });
    });

    test('should return error if joining non-existent room', (done) => {
        playerSocket = createSocket();
        playerSocket.on('connect', () => {
            playerSocket.emit('join-session', { roomId: 'non-existent' });
            playerSocket.on('error', (msg) => {
                expect(msg).toBe('Room does not exist yet.');
                done();
            });
        });
    });
});
