const io = require('socket.io')(3003, {
    path: '/map/',
    cors: { origin: true },
    transports: ['websocket'],
    pingTimeout: 60000,
    maxHttpBufferSize: 5e7
});

const { createClient } = require('redis');
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

redisClient.on('error', err => console.error('Redis Error:', err));

class RoomQueue {
    constructor() { this.queue = Promise.resolve(); }
    add(task) {
        this.queue = this.queue.then(task).catch(err => console.error('Queue Error:', err));
        return this.queue;
    }
}
const roomQueues = new Map();
const runInQueue = (roomId, task) => {
    if (!roomQueues.has(roomId)) roomQueues.set(roomId, new RoomQueue());
    return roomQueues.get(roomId).add(task);
};

async function startServer() {
    try {
        await redisClient.connect();
        console.log('Connected to Redis for Room Persistence');
    } catch (err) {
        console.error("Redis initial connection failed, retrying in background...", err);
    }

    const debug = (msg, data = '') => {
        console.log(`[${new Date().toLocaleTimeString()}] ${msg}`, data);
    };

    io.on('connection', (socket) => {
        debug(`New Connection: ${socket.id}`);

        socket.on('host-session', async ({ roomId, initialState }) => {
            debug(`HOST REQUEST for Room: ${roomId}`);
            socket.join(roomId);

            if (!redisClient.isOpen) {
                socket.emit('error', 'Server not ready: Redis connection lost.');
                return;
            }

            await redisClient.set(`room:${roomId}:host`, socket.id, { EX: 86400 });

            const existingState = await redisClient.get(`room:${roomId}`);
            if (existingState && !initialState) {
                try {
                    socket.emit('map-update', JSON.parse(existingState));
                } catch(e) {
                    console.error("Failed to parse existing state");
                }
            } else {
                const state = initialState || { tokens: [], walls: [], gridSize: 50 };
                state.version = 0;
                await redisClient.set(`room:${roomId}`, JSON.stringify(state), { EX: 86400 });
            }

            socket.to(roomId).emit('host-changed', { hostId: socket.id });
        });

        socket.on('join-session', async ({ roomId, character }) => {
            debug(`JOIN ATTEMPT: ${socket.id} for Room ${roomId}`);

            if (!redisClient.isOpen) {
                socket.emit('error', 'Server not ready: Redis connection lost.');
                return;
            }

            let stateRaw = await redisClient.get(`room:${roomId}`);
            if (stateRaw) {
                try {
                    let state = JSON.parse(stateRaw);
                    socket.join(roomId);
                    socket.emit('map-update', state);

                    const currentHost = await redisClient.get(`room:${roomId}:host`);
                    socket.emit('host-changed', { hostId: currentHost });
                } catch (e) {
                    socket.emit('error', 'Room state is corrupted.');
                }
            } else {
                socket.emit('error', 'Room does not exist yet.');
            }
        });

        // ROBUSTNESS FIX 2: Added stop-hosting and leave-session handlers
        socket.on('stop-hosting', async (roomId) => {
            await redisClient.del(`room:${roomId}:host`);
            socket.to(roomId).emit('host-disconnected');
        });

        socket.on('leave-session', async (roomId) => {
            socket.leave(roomId);
            await checkAndCleanupRoom(roomId, socket.id);
        });

        socket.on('sync-action', ({ roomId, action, data }) => {
            // Push action to the room's execution queue
            runInQueue(roomId, async () => {
                if (!redisClient.isOpen) return;

                const stateRaw = await redisClient.get(`room:${roomId}`);
                if (!stateRaw) return;

                let state;
                try {
                    state = JSON.parse(stateRaw);
                } catch (e) { return; }

                state.version = (state.version || 0) + 1;

                // Update state based on action
                switch(action) {
                    case 'token-move':
                        if (Array.isArray(state.tokens)) {
                            const token = state.tokens.find(t => t.id === data.id);
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
                        state.tokens.push({
                            id: data.options.id,
                            x: data.x,
                            y: data.y,
                            ownerId: data.options.ownerId,
                            icon: data.options.icon,
                            ...data.options
                        });
                        break;
                    case 'token-deleted':
                        if (state.tokens) {
                            state.tokens = state.tokens.filter(t => t.id === data.id);
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
                        break;
                    case 'grid-size-change':
                        state.gridSize = data.size;
                        break;
                    case 'map-load':
                        state = { ...state, ...data };
                        break;
                    case 'turn-order-sync':
                        state.turnOrder = data;
                        break;
                    case 'turn-order-add':
                        if (!state.turnOrder) {
                            state.turnOrder = { isActive: true, isConfirmed: false, entries: [], activeIndex: 0 };
                        }
                        state.turnOrder.entries.push(data);
                        if (state.turnOrder.isConfirmed) {
                            state.turnOrder.entries.sort((a, b) => b.initiative - a.initiative);
                        }
                        action = 'turn-order-sync';
                        data = state.turnOrder;
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
                        action = 'turn-order-sync';
                        data = state.turnOrder;
                        break;
                }

                await redisClient.set(`room:${roomId}`, JSON.stringify(state), { EX: 86400 });
                io.to(roomId).emit('remote-action', { action, data, version: state.version });
            });
        });

        socket.on('request-resync', async (roomId) => {
            if (!redisClient.isOpen) return;
            const stateRaw = await redisClient.get(`room:${roomId}`);
            if (stateRaw) {
                try {
                    socket.emit('map-update', JSON.parse(stateRaw));
                } catch(e) {}
            }
        });

        // ROBUSTNESS FIX 3: Use 'disconnecting' so we can see which rooms the user is still in.
        socket.on('disconnecting', async () => {
            debug(`Disconnecting: ${socket.id}`);
            for (const roomId of socket.rooms) {
                if (roomId === socket.id) continue;
                await checkAndCleanupRoom(roomId, socket.id, true);
            }
        });
    });

    // Helper to evaluate room state and clean up Redis
    async function checkAndCleanupRoom(roomId, socketId, isDisconnectingEvent = false) {
        const room = io.sockets.adapter.rooms.get(roomId);

        // If we are evaluating during a "disconnecting" event, the user is still technically in the adapter size.
        // Therefore, if size is 1, they are the last person. Otherwise, 0 means it's empty.
        const userCount = room ? room.size : 0;
        const isEmpty = isDisconnectingEvent ? userCount <= 1 : userCount === 0;

        if (isEmpty) {
            debug(`Room ${roomId} is empty. Cleaning up state.`);
            await redisClient.del(`room:${roomId}`);
            await redisClient.del(`room:${roomId}:host`);
            roomQueues.delete(roomId); // Prevent memory leak in queue map
        } else {
            // The room isn't empty, but let's check if the person leaving was the host
            const hostKey = `room:${roomId}:host`;
            const currentHostId = await redisClient.get(hostKey);

            if (currentHostId === socketId) {
                debug(`Host left room ${roomId}. Reassigning or waiting for new host.`);
                io.to(roomId).emit('host-disconnected');
                await redisClient.del(hostKey);
            }
        }
    }

    console.log('VTT Sync Server running on port 3003');
}

startServer();