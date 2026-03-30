const io = require('socket.io')(3003, {
    path: '/map/',
    cors: { origin: true },
    transports: ['websocket'],
    pingTimeout: 60000,
    maxHttpBufferSize: 5e7 // Add this: Allows payloads up to 50MB
});

const { createClient } = require('redis');
// Uses the REDIS_URL from your .env or the container name
const redisClient = createClient({ url: process.env.REDIS_URL || 'redis://redis:6379' });

redisClient.on('error', err => console.error('Redis Error:', err));

async function startServer() {
    await redisClient.connect();
    console.log('Connected to Redis for Room Persistence');

    const debug = (msg, data = '') => {
        console.log(`[${new Date().toLocaleTimeString()}] ${msg}`, data);
    };

    io.on('connection', (socket) => {
        debug(`New Connection: ${socket.id}`);

        // DM Hosts the session
        socket.on('host-session', async ({ roomId, initialState }) => {
            debug(`!!! RECEIVED HOST REQUEST for Room: ${roomId}`); // Add this
            socket.join(roomId);

            const state = initialState || { tokens: [], walls: [], gridSize: 50 };
            await redisClient.set(`room:${roomId}`, JSON.stringify(state), { EX: 86400 });

            const check = await redisClient.exists(`room:${roomId}`);
            debug(`Room ${roomId} live in Redis: ${check === 1}`);
        });

        socket.on('join-session', async ({ roomId, character }) => {
            debug(`JOIN ATTEMPT: ${socket.id} for Room ${roomId}`);

            let stateRaw = await redisClient.get(`room:${roomId}`);
            if (stateRaw) {
                let state = JSON.parse(stateRaw);

                if (!state.players) state.players = {};

                await redisClient.set(`room:${roomId}`, JSON.stringify(state), { EX: 86400 });

                socket.join(roomId);
                socket.emit('map-update', state);

                // Notify others that a specific player joined
                socket.to(roomId).emit('player-joined', state.players[socket.id]);
            }
        });

        // index.js additions/modifications
        socket.on('sync-action', async ({ roomId, action, data }) => {
            const stateRaw = await redisClient.get(`room:${roomId}`);
            if (!stateRaw) return;

            if (!socket.rooms.has(roomId)) {
                socket.join(roomId);
            }

            if (action === 'measure-sync') {
                socket.to(roomId).emit('remote-action', { action, data });
                return;
            }

            let state = JSON.parse(stateRaw);

            switch(action) {
                case 'token-move':
                    const token = state.tokens?.find(t => t.id === data.id);
                    if (token) { token.x = data.x; token.y = data.y; }
                    break;

                case 'wall-added':
                    state.walls.push(data.points);
                    break;

                case 'wall-deleted':
                    // Simple filter: assuming data.points is passed to identify the wall
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
                        ownerId: data.options.ownerId, // Persist owner
                        icon: data.options.icon,       // Persist image URL
                        ...data.options
                    });
                    break;

                case 'token-deleted':
                    state.tokens = state.tokens.filter(t => t.id !== data.id);
                    break;

                case 'lighting-toggle':
                    state.lightingEnabled = data.visible; // Add this to your state object
                    break;


                case 'grid-size-change':
                    state.gridSize = data.size;
                    break;

                case 'map-load':
                    // Completely overwrite the room state with the new map's config
                    state.mapUrl = data.mapUrl || null;
                    state.gridSize = data.gridSize || 50;
                    state.tokens = data.tokens || [];
                    state.walls = data.walls || [];
                    break;



            }

            await redisClient.set(`room:${roomId}`, JSON.stringify(state), { EX: 86400 });
            // Broadcast to everyone ELSE in the room
            socket.to(roomId).emit('remote-action', { action, data });
        });

        socket.on('disconnect', (reason) => {
            debug(`Disconnected: ${socket.id}. Reason: ${reason}`);
        });
    });

    console.log('VTT Sync Server running on port 3003');
}

startServer();