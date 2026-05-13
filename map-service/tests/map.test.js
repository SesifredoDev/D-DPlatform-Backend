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

    test('should sync the player token control mode from the host', (done) => {
        const roomId = 'test-room-token-control';
        const initialState = { tokens: [], playersCanControlAllPlayerTokens: false, version: 0 };
        redisData.set(`room:${roomId}`, JSON.stringify(initialState));

        hostSocket = createSocket();
        playerSocket = createSocket();

        hostSocket.on('connect', () => {
            hostSocket.emit('host-session', { roomId });

            playerSocket.on('connect', () => {
                playerSocket.emit('join-session', { roomId, character: { ownerId: 'player-1' } });

                playerSocket.on('remote-action', (payload) => {
                    if (payload.action === 'player-token-control-change') {
                        const state = JSON.parse(redisData.get(`room:${roomId}`));
                        expect(payload.data.enabled).toBe(true);
                        expect(state.playersCanControlAllPlayerTokens).toBe(true);
                        done();
                    }
                });

                setTimeout(() => {
                    hostSocket.emit('sync-action', {
                        roomId,
                        action: 'player-token-control-change',
                        data: { enabled: true }
                    });
                }, 100);
            });
        });
    });

    test('should reject moving another player token when shared control is disabled', (done) => {
        const roomId = 'test-room-own-token-only';
        const initialState = {
            tokens: [{ id: 't1', ownerId: 'player-1', isPlayer: true, x: 0, y: 0 }],
            playersCanControlAllPlayerTokens: false,
            version: 0
        };
        redisData.set(`room:${roomId}`, JSON.stringify(initialState));
        redisData.set(`room:${roomId}:host`, 'host-socket');

        playerSocket = createSocket();
        let receivedMove = false;

        playerSocket.on('remote-action', (payload) => {
            if (payload.action === 'token-move') receivedMove = true;
        });

        playerSocket.on('connect', () => {
            playerSocket.emit('join-session', { roomId, character: { ownerId: 'player-2' } });
        });

        playerSocket.on('map-update', () => {
            playerSocket.emit('sync-action', {
                roomId,
                action: 'token-move',
                data: { id: 't1', x: 100, y: 100 }
            });

            setTimeout(() => {
                const state = JSON.parse(redisData.get(`room:${roomId}`));
                expect(receivedMove).toBe(false);
                expect(state.tokens[0].x).toBe(0);
                expect(state.version).toBe(0);
                done();
            }, 100);
        });
    });

    test('should allow moving another player token when shared control is enabled', (done) => {
        const roomId = 'test-room-any-player-token';
        const initialState = {
            tokens: [{ id: 't1', ownerId: 'player-1', isPlayer: true, x: 0, y: 0 }],
            playersCanControlAllPlayerTokens: true,
            version: 0
        };
        redisData.set(`room:${roomId}`, JSON.stringify(initialState));

        hostSocket = createSocket();
        playerSocket = createSocket();
        let hostReady = false;
        let playerJoined = false;

        const joinPlayer = () => {
            if (!hostReady || playerJoined || !playerSocket.connected) return;
            playerJoined = true;
            playerSocket.emit('join-session', { roomId, character: { ownerId: 'player-2' } });
        };

        hostSocket.on('host-action-request', (payload) => {
            expect(payload.action).toBe('token-move');
            const pendingState = JSON.parse(redisData.get(`room:${roomId}`));
            expect(pendingState.tokens[0].x).toBe(0);
            hostSocket.emit('sync-action', {
                roomId,
                action: payload.action,
                data: payload.data
            });
        });

        hostSocket.on('connect', () => {
            hostSocket.emit('host-session', { roomId });
        });

        hostSocket.on('map-update', () => {
            hostReady = true;
            joinPlayer();
        });

        playerSocket.on('connect', joinPlayer);

        playerSocket.on('map-update', () => {
            playerSocket.emit('sync-action', {
                roomId,
                action: 'token-move',
                data: { id: 't1', x: 100, y: 100 }
            });
        });

        playerSocket.on('remote-action', (payload) => {
            if (payload.action === 'token-move') {
                const state = JSON.parse(redisData.get(`room:${roomId}`));
                expect(payload.data.id).toBe('t1');
                expect(state.tokens[0].x).toBe(100);
                done();
            }
        });
    });

    test('should sync expanded grid settings', (done) => {
        const roomId = 'test-room-grid-settings';
        const initialState = { tokens: [], gridSize: 50, version: 0 };
        redisData.set(`room:${roomId}`, JSON.stringify(initialState));

        hostSocket = createSocket();
        playerSocket = createSocket();

        hostSocket.on('connect', () => {
            hostSocket.emit('host-session', { roomId });

            playerSocket.on('connect', () => {
                playerSocket.emit('join-session', { roomId, character: { ownerId: 'player-1' } });

                playerSocket.on('remote-action', (payload) => {
                    if (payload.action === 'grid-settings-change') {
                        const state = JSON.parse(redisData.get(`room:${roomId}`));
                        expect(payload.data).toEqual({
                            size: 64,
                            color: '#ff00aa',
                            thickness: 2.5,
                            type: 'hex'
                        });
                        expect(state.gridSize).toBe(64);
                        expect(state.gridColor).toBe('#ff00aa');
                        expect(state.gridThickness).toBe(2.5);
                        expect(state.gridType).toBe('hex');
                        done();
                    }
                });

                setTimeout(() => {
                    hostSocket.emit('sync-action', {
                        roomId,
                        action: 'grid-settings-change',
                        data: {
                            size: 64,
                            color: '#ff00aa',
                            thickness: 2.5,
                            type: 'hex'
                        }
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

    test('should close the session and disconnect players when host explicitly stops hosting', (done) => {
        const roomId = 'test-room-stop';
        const initialState = { tokens: [], walls: [], gridSize: 50 };
        let receivedSessionEnded = false;
        let completed = false;

        const finish = (error) => {
            if (completed) return;
            completed = true;
            done(error);
        };

        hostSocket = createSocket();
        playerSocket = createSocket();

        playerSocket.on('session-ended', () => {
            receivedSessionEnded = true;
        });

        playerSocket.on('disconnect', () => {
            try {
                expect(receivedSessionEnded).toBe(true);
                expect(redisData.has(`room:${roomId}`)).toBe(false);
                expect(redisData.has(`room:${roomId}:host`)).toBe(false);
                finish();
            } catch (error) {
                finish(error);
            }
        });

        hostSocket.on('connect', () => {
            hostSocket.emit('host-session', { roomId, initialState });
            setTimeout(() => {
                if (playerSocket.connected) {
                    playerSocket.emit('join-session', { roomId });
                } else {
                    playerSocket.once('connect', () => playerSocket.emit('join-session', { roomId }));
                }
            }, 50);
        });

        playerSocket.on('map-update', () => {
            hostSocket.emit('stop-hosting', roomId);
        });
    });

    test('should not close the session when host disconnects accidentally', (done) => {
        const roomId = 'test-room-host-disconnect';
        const initialState = { tokens: [], walls: [], gridSize: 50 };
        let receivedSessionEnded = false;
        let completed = false;

        const finish = (error) => {
            if (completed) return;
            completed = true;
            done(error);
        };

        hostSocket = createSocket();
        playerSocket = createSocket();

        playerSocket.on('session-ended', () => {
            receivedSessionEnded = true;
        });

        playerSocket.on('host-disconnected', () => {
            setTimeout(() => {
                try {
                    expect(receivedSessionEnded).toBe(false);
                    expect(playerSocket.connected).toBe(true);
                    finish();
                } catch (error) {
                    finish(error);
                }
            }, 100);
        });

        hostSocket.on('connect', () => {
            hostSocket.emit('host-session', { roomId, initialState });
            setTimeout(() => {
                if (playerSocket.connected) {
                    playerSocket.emit('join-session', { roomId });
                } else {
                    playerSocket.once('connect', () => playerSocket.emit('join-session', { roomId }));
                }
            }, 50);
        });

        playerSocket.on('map-update', () => {
            hostSocket.disconnect();
        });
    });
});
