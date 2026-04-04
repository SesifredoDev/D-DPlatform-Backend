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

            // Store who is the current host
            await redisClient.set(`room:${roomId}:host`, socket.id, { EX: 86400 });

            const existingState = await redisClient.get(`room:${roomId}`);
            if (existingState && !initialState) {
                // If there's already state and host didn't provide new initial state (re-hosting)
                socket.emit('map-update', JSON.parse(existingState));
            } else {
                const state = initialState || { tokens: [], walls: [], gridSize: 50 };
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
                let state = JSON.parse(stateRaw);
                socket.join(roomId);
                socket.emit('map-update', state);
                
                const currentHost = await redisClient.get(`room:${roomId}:host`);
                socket.emit('host-changed', { hostId: currentHost });
            } else {
                // If room doesn't exist, we still let them join the socket room
                // but they won't get a map-update until a host starts it.
                socket.join(roomId);
                socket.emit('error', 'Room does not exist yet.');
            }
        });

        socket.on('sync-action', async ({ roomId, action, data }) => {
            if (!redisClient.isOpen) return;

            const stateRaw = await redisClient.get(`room:${roomId}`);
            if (!stateRaw) return;

            let state = JSON.parse(stateRaw);

            // Update state based on action
            switch(action) {
                case 'token-move':
                    const token = state.tokens?.find(t => t.id === data.id);
                    if (token) { token.x = data.x; token.y = data.y; }
                    break;
                case 'wall-added':
                    state.walls.push(data.points);
                    break;
                case 'wall-deleted':
                    state.walls = state.walls.filter(w => JSON.stringify(w) !== JSON.stringify(data.points));
                    break;
                case 'map-change':
                    state.mapUrl = data.url;
                    state.gridSize = data.gridSize || state.gridSize;
                    break;
                case 'token-added':
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
                    state.tokens = state.tokens.filter(t => t.id !== data.id);
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
            }

            await redisClient.set(`room:${roomId}`, JSON.stringify(state), { EX: 86400 });
            socket.to(roomId).emit('remote-action', { action, data });
        });

        socket.on('disconnect', async () => {
            debug(`Disconnected: ${socket.id}`);
            // Check all rooms this socket was in
            const rooms = Array.from(socket.rooms);
            for (const roomId of rooms) {
                if (roomId === socket.id) continue;
                
                const hostKey = `room:${roomId}:host`;
                const currentHostId = await redisClient.get(hostKey);
                
                if (currentHostId === socket.id) {
                    debug(`Host disconnected from room ${roomId}`);
                    // Notify others that host is gone
                    socket.to(roomId).emit('host-disconnected');
                    // We don't delete the host key immediately, or maybe we do to trigger election
                    await redisClient.del(hostKey);
                }
            }
        });
    });

    console.log('VTT Sync Server running on port 3003');
}

startServer();