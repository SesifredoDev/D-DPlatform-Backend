const http = require('http');
const { Server } = require('socket.io');
const { createClient } = require('redis');

const server = http.createServer();
const io = new Server(server, {
    path: '/map/',
    cors: { origin: true },
    transports: ['websocket'],
    pingTimeout: 60000,
    maxHttpBufferSize: 5e7
});

const redisClient = createClient({
    url: process.env.REDIS_URL || 'redis://redis:6379',
    socket: {
        reconnectStrategy: (retries) => {
            if (retries > 20) {
                console.error('Redis Client: Max retries reached, giving up.');
                return new Error('Redis connection failed');
            }
            return Math.min(retries * 100, 3000);
        }
    }
});

redisClient.on('error', err => {
    if (process.env.NODE_ENV !== 'test') {
        console.error('Redis Error:', err);
    }
});

class RoomQueue {
    constructor() { this.queue = Promise.resolve(); }
    add(task) {
        this.queue = this.queue.then(task).catch(err => console.error('Queue Error:', err));
        return this.queue;
    }
}
const roomQueues = new Map();
const endingRooms = new Set();
const socketPlayers = new Map();
const runInQueue = (roomId, task) => {
    if (!roomQueues.has(roomId)) roomQueues.set(roomId, new RoomQueue());
    return roomQueues.get(roomId).add(task);
};

const debug = (msg, data = '') => {
    if (process.env.NODE_ENV !== 'test') {
        console.log(`[${new Date().toLocaleTimeString()}] ${msg}`, data);
    }
};

const normalizeRoomState = (state) => {
    const raw = {
        playersCanControlAllPlayerTokens: false,
        tokens: [],
        walls: [],
        gridSize: 50,
        gridColor: '#cccccc',
        gridThickness: 1,
        gridType: 'square',
        lightingEnabled: false,
        ...(state || {})
    };

    const gridSize = parseInt(raw.gridSize, 10);
    const gridThickness = parseFloat(raw.gridThickness);

    return {
        ...raw,
        playersCanControlAllPlayerTokens: !!raw.playersCanControlAllPlayerTokens,
        gridSize: Number.isFinite(gridSize) ? Math.max(8, gridSize) : 50,
        gridColor: raw.gridColor || '#cccccc',
        gridThickness: Number.isFinite(gridThickness) ? Math.max(0.25, gridThickness) : 1,
        gridType: raw.gridType === 'hex' ? 'hex' : 'square',
        lightingEnabled: !!raw.lightingEnabled
    };
};

const getGridSettingsPayload = (state) => ({
    size: state.gridSize,
    color: state.gridColor,
    thickness: state.gridThickness,
    type: state.gridType
});

const getCharacterOwnerId = (character) => {
    const ownerId = character?.ownerId || character?.owner?._id || character?.owner || character?.userId;
    return ownerId ? ownerId.toString() : null;
};

const EPHEMERAL_ACTIONS = new Set(['measure-sync', 'ping']);
const PLAYER_TOKEN_ACTIONS = new Set(['token-move', 'token-update', 'token-deleted']);
const PLAYER_TURN_ACTIONS = new Set(['turn-order-add', 'turn-order-remove']);

const findToken = (tokens, tokenId) => {
    if (!Array.isArray(tokens)) return null;
    return tokens.find(t => t.id?.toString() === tokenId?.toString()) || null;
};

const isPlayerToken = (token) => !!token && (token.isPlayer === true || !!token.ownerId);

const canSocketControlToken = (state, socketId, currentHostId, tokenId) => {
    if (currentHostId === socketId) return true;

    const token = findToken(state.tokens, tokenId);
    if (!isPlayerToken(token)) return false;

    const socketPlayer = socketPlayers.get(socketId);
    if (!socketPlayer) return false;
    if (state.playersCanControlAllPlayerTokens) return true;

    return !!socketPlayer?.userId && token.ownerId?.toString() === socketPlayer.userId;
};

const canSocketAddToken = (socketId, data) => {
    const socketPlayer = socketPlayers.get(socketId);
    const ownerId = data?.options?.ownerId?.toString();

    return !!socketPlayer?.userId &&
        !!ownerId &&
        ownerId === socketPlayer.userId &&
        data?.options?.isPlayer !== false;
};

const canSocketUpdateTurnOrder = (state, socketId, action, data) => {
    if (action === 'turn-order-add') return true;

    const socketPlayer = socketPlayers.get(socketId);
    if (!socketPlayer?.userId || !state.turnOrder?.entries) return false;

    const entry = state.turnOrder.entries.find(e => e.id?.toString() === data?.id?.toString());
    return !!entry && entry.userId?.toString() === socketPlayer.userId;
};

const canSocketRequestHostAction = (state, socketId, currentHostId, action, data) => {
    if (currentHostId === socketId) return true;
    if (EPHEMERAL_ACTIONS.has(action)) return true;
    if (PLAYER_TOKEN_ACTIONS.has(action)) {
        return canSocketControlToken(state, socketId, currentHostId, data?.id);
    }
    if (action === 'token-added') {
        return canSocketAddToken(socketId, data);
    }
    if (PLAYER_TURN_ACTIONS.has(action)) {
        return canSocketUpdateTurnOrder(state, socketId, action, data);
    }

    return false;
};

async function checkAndCleanupRoom(roomId, socketId, isDisconnectingEvent = false, client = redisClient) {
    if (endingRooms.has(roomId)) return;

    const room = io.sockets.adapter.rooms.get(roomId);
    const userCount = room ? room.size : 0;
    const isEmpty = isDisconnectingEvent ? userCount <= 1 : userCount === 0;

    if (isEmpty) {
        debug(`Room ${roomId} is empty. Cleaning up state.`);
        await client.del(`room:${roomId}`);
        await client.del(`room:${roomId}:host`);
        roomQueues.delete(roomId);
    } else {
        const hostKey = `room:${roomId}:host`;
        const currentHostId = await client.get(hostKey);

        if (currentHostId === socketId) {
            debug(`Host left room ${roomId}. Reassigning or waiting for new host.`);
            io.to(roomId).emit('host-disconnected');
            await client.del(hostKey);
        }
    }
}

async function start(client = redisClient) {
    try {
        if (!client.isOpen) {
            await client.connect();
        }
        debug('Connected to Redis for Room Persistence');
    } catch (err) {
        if (process.env.NODE_ENV !== 'test') {
            console.error("Redis initial connection failed, retrying in background...", err);
        }
    }

    io.on('connection', (socket) => {
        debug(`New Connection: ${socket.id}`);

        socket.on('host-session', async ({ roomId, initialState }) => {
            debug(`HOST REQUEST for Room: ${roomId}`);
            socket.join(roomId);
            socketPlayers.set(socket.id, { roomId, userId: null });

            if (!client.isOpen) {
                socket.emit('error', 'Server not ready: Redis connection lost.');
                return;
            }

            await client.set(`room:${roomId}:host`, socket.id, { EX: 86400 });

            const existingStateRaw = await client.get(`room:${roomId}`);
            let existingVersion = 0;

            if (existingStateRaw) {
                try {
                    existingVersion = normalizeRoomState(JSON.parse(existingStateRaw)).version || 0;
                } catch(e) {
                    console.error("Failed to parse existing state");
                }
            }

            if (initialState) {
                const state = normalizeRoomState(initialState);
                state.version = existingVersion + 1;
                await client.set(`room:${roomId}`, JSON.stringify(state), { EX: 86400 });
                io.to(roomId).emit('map-update', state);
            } else if (existingStateRaw) {
                try {
                    socket.emit('map-update', normalizeRoomState(JSON.parse(existingStateRaw)));
                } catch(e) {
                    console.error("Failed to parse existing state");
                }
            } else {
                const state = normalizeRoomState(null);
                state.version = 0;
                await client.set(`room:${roomId}`, JSON.stringify(state), { EX: 86400 });
                socket.emit('map-update', state);
            }

            io.to(roomId).emit('host-changed', { hostId: socket.id });
        });

        socket.on('join-session', async ({ roomId, character }) => {
            debug(`JOIN ATTEMPT: ${socket.id} for Room ${roomId}`);
            socketPlayers.set(socket.id, { roomId, userId: getCharacterOwnerId(character) });

            if (!client.isOpen) {
                socket.emit('error', 'Server not ready: Redis connection lost.');
                return;
            }

            let stateRaw = await client.get(`room:${roomId}`);
            if (stateRaw) {
                try {
                    let state = normalizeRoomState(JSON.parse(stateRaw));
                    socket.join(roomId);
                    socket.emit('map-update', state);

                    const currentHost = await client.get(`room:${roomId}:host`);
                    socket.emit('host-changed', { hostId: currentHost });
                } catch (e) {
                    socket.emit('error', 'Room state is corrupted.');
                }
            } else {
                socket.emit('error', 'Room does not exist yet.');
            }
        });

        socket.on('stop-hosting', async (roomId, ack) => {
            if (!client.isOpen) {
                if (typeof ack === 'function') ack({ ok: false });
                return;
            }

            endingRooms.add(roomId);

            try {
                await client.del(`room:${roomId}`);
                await client.del(`room:${roomId}:host`);
                roomQueues.delete(roomId);

                io.to(roomId).except(socket.id).emit('session-ended');
                setTimeout(() => {
                    io.in(roomId).except(socket.id).disconnectSockets(true);
                    endingRooms.delete(roomId);
                }, 250);

                if (typeof ack === 'function') ack({ ok: true });
            } catch (error) {
                endingRooms.delete(roomId);
                if (typeof ack === 'function') ack({ ok: false });
                console.error('Failed to stop VTT hosting:', error);
            }
        });

        socket.on('leave-session', async (roomId) => {
            socket.leave(roomId);
            socketPlayers.delete(socket.id);
            await checkAndCleanupRoom(roomId, socket.id, false, client);
        });

        socket.on('sync-action', ({ roomId, action, data }, ack) => {
            runInQueue(roomId, async () => {
                const respond = (payload) => {
                    if (typeof ack === 'function') ack(payload);
                };

                if (!client.isOpen) {
                    respond({ ok: false, reason: 'server-not-ready' });
                    return;
                }

                const stateRaw = await client.get(`room:${roomId}`);
                if (!stateRaw) {
                    respond({ ok: false, reason: 'room-not-found' });
                    return;
                }

                let state;
                try {
                    state = normalizeRoomState(JSON.parse(stateRaw));
                } catch (e) {
                    respond({ ok: false, reason: 'corrupt-state' });
                    return;
                }

                const currentHostId = await client.get(`room:${roomId}:host`);

                if (EPHEMERAL_ACTIONS.has(action)) {
                    socket.to(roomId).emit('remote-action', {
                        action,
                        data,
                        sourceId: socket.id
                    });
                    respond({ ok: true, ephemeral: true });
                    return;
                }

                if (!currentHostId) {
                    io.to(roomId).emit('host-disconnected');
                    respond({ ok: false, reason: 'host-missing' });
                    return;
                }

                if (!canSocketRequestHostAction(state, socket.id, currentHostId, action, data)) {
                    respond({ ok: false, reason: 'forbidden' });
                    return;
                }

                if (currentHostId !== socket.id) {
                    const hostSocket = io.sockets.sockets.get(currentHostId);
                    if (!hostSocket) {
                        await client.del(`room:${roomId}:host`);
                        io.to(roomId).emit('host-disconnected');
                        respond({ ok: false, reason: 'host-missing' });
                        return;
                    }

                    hostSocket.emit('host-action-request', {
                        roomId,
                        action,
                        data,
                        requesterId: socket.id
                    });
                    respond({ ok: true, queued: true });
                    return;
                }

                state.version = (state.version || 0) + 1;
                let outgoingAction = action;
                let outgoingData = data;

                switch(action) {
                    case 'token-move':
                        if (Array.isArray(state.tokens)) {
                            const token = findToken(state.tokens, data.id);
                            if (token) { token.x = data.x; token.y = data.y; }
                        }
                        break;
                    case 'wall-added':
                        if (!state.walls) state.walls = [];
                        state.walls.push(data.points);
                        break;
                    case 'wall-deleted':
                        if (state.walls) {
                            state.walls = state.walls.filter(w => JSON.stringify(w) !== JSON.stringify(data.points));
                        }
                        break;
                    case 'map-change':
                        state.mapUrl = data.url;
                        state.gridSize = data.gridSize || state.gridSize;
                        break;
                    case 'token-added':
                        if (!state.tokens) state.tokens = [];
                        if (!findToken(state.tokens, data.options.id)) {
                            state.tokens.push({
                                id: data.options.id,
                                x: data.x,
                                y: data.y,
                                ownerId: data.options.ownerId,
                                icon: data.options.icon,
                                ...data.options
                            });
                        }
                        break;
                    case 'token-deleted':
                        if (state.tokens) {
                            state.tokens = state.tokens.filter(t => t.id !== data.id);
                        }
                        break;
                    case 'token-update':
                        if (state.tokens) {
                            const idx = state.tokens.findIndex(t => t.id === data.id);
                            if (idx !== -1) {
                                state.tokens[idx] = { ...state.tokens[idx], ...data.options };
                            }
                        }
                        break;
                    case 'lighting-toggle':
                        state.lightingEnabled = data.visible;
                        outgoingData = { visible: !!state.lightingEnabled };
                        break;
                    case 'grid-size-change':
                        state = normalizeRoomState({ ...state, gridSize: data?.size });
                        outgoingData = { size: state.gridSize };
                        break;
                    case 'grid-settings-change':
                        state = normalizeRoomState({
                            ...state,
                            gridSize: data?.size,
                            gridColor: data?.color,
                            gridThickness: data?.thickness,
                            gridType: data?.type
                        });
                        outgoingData = getGridSettingsPayload(state);
                        break;
                    case 'player-token-control-change':
                        state.playersCanControlAllPlayerTokens = !!data?.enabled;
                        outgoingData = { enabled: state.playersCanControlAllPlayerTokens };
                        break;
                    case 'map-load':
                        const mapLoadVersion = state.version;
                        state = normalizeRoomState({ ...state, ...(data || {}) });
                        state.version = mapLoadVersion;
                        outgoingData = state;
                        break;
                    case 'turn-order-sync':
                        state.turnOrder = data;
                        outgoingData = state.turnOrder;
                        break;
                    case 'turn-order-add':
                        if (!state.turnOrder) {
                            state.turnOrder = { isActive: true, isConfirmed: false, entries: [], activeIndex: 0 };
                        }
                        state.turnOrder.entries.push(data);
                        if (state.turnOrder.isConfirmed) {
                            state.turnOrder.entries.sort((a, b) => b.initiative - a.initiative);
                        }
                        outgoingAction = 'turn-order-sync';
                        outgoingData = state.turnOrder;
                        break;
                    case 'turn-order-remove':
                        if (state.turnOrder && state.turnOrder.entries) {
                            state.turnOrder.entries = state.turnOrder.entries.filter(e => e.id !== data.id);
                            if (state.turnOrder.activeIndex >= state.turnOrder.entries.length && state.turnOrder.entries.length > 0) {
                                state.turnOrder.activeIndex = state.turnOrder.entries.length - 1;
                            } else if (state.turnOrder.entries.length === 0) {
                                state.turnOrder.activeIndex = 0;
                            }
                        }
                        outgoingAction = 'turn-order-sync';
                        outgoingData = state.turnOrder;
                        break;
                }

                await client.set(`room:${roomId}`, JSON.stringify(state), { EX: 86400 });
                io.to(roomId).emit('remote-action', {
                    action: outgoingAction,
                    data: outgoingData,
                    version: state.version,
                    sourceId: socket.id
                });
                respond({ ok: true, version: state.version });
            });
        });

        socket.on('request-resync', async (roomId) => {
            if (!client.isOpen) return;
            const stateRaw = await client.get(`room:${roomId}`);
            if (stateRaw) {
                try {
                    socket.emit('map-update', normalizeRoomState(JSON.parse(stateRaw)));
                } catch(e) {}
            }
        });

        socket.on('disconnecting', async () => {
            debug(`Disconnecting: ${socket.id}`);
            socketPlayers.delete(socket.id);
            for (const roomId of socket.rooms) {
                if (roomId === socket.id) continue;
                await checkAndCleanupRoom(roomId, socket.id, true, client);
            }
        });
    });
}

const shutdown = async () => {
    return new Promise((resolve) => {
        io.close(() => {
            if (redisClient.isOpen) {
                redisClient.quit().then(() => {
                    server.close(() => {
                        resolve();
                    });
                });
            } else {
                server.close(() => {
                    resolve();
                });
            }
        });
    });
};

if (require.main === module) {
    const PORT = process.env.PORT || 3003;
    server.listen(PORT, '0.0.0.0', () => {
        console.log(`VTT Sync Server running on port ${PORT}`);
    });
    start();
}

module.exports = {
    server,
    io,
    redisClient,
    start,
    shutdown
};
