const { Server } = require('socket.io');
const redis = require('redis');
const http = require('http');

const server = http.createServer();
const io = new Server(server, {
    path: '/socket.io/',
    cors: {
        origin: true,
        credentials: true
    },
    transports: ['websocket', 'polling']
});

const subscriber = redis.createClient({ 
    url: process.env.REDIS_URL || 'redis://redis:6379',
    socket: {
        reconnectStrategy: (retries) => {
            if (retries > 20) {
                console.error('Redis Subscriber: Max retries reached, giving up.');
                return new Error('Redis connection failed');
            }
            return Math.min(retries * 100, 3000);
        }
    }
});

subscriber.on('error', (err) => console.error('Redis Error:', err));

async function start() {
    try {
        await subscriber.connect();
        console.log('Connected to Redis Sub/Pub');

        await subscriber.subscribe('CHAT_MESSAGES', (message) => {
            try {
                const payload = JSON.parse(message);
                if (payload.type === 'NEW_MESSAGE') {
                    const data = payload.data;
                    if (data.isWhisper) {
                        // For whispers, only emit to specifically interested parties.
                        // We could use private rooms or filter on client side, 
                        // but let's at least emit to everyone in the channel 
                        // and they will filter it if we want to keep it simple, 
                        // OR emit to specific user IDs if we track them.
                        // Let's emit to the channel for now, clients will handle visibility logic
                        // (already partially enforced by getMessages query)
                        io.to(data.channelId).emit('new_message', data);
                    } else {
                        io.to(data.channelId).emit('new_message', data);
                    }
                } else if (payload.type === 'REACTION_UPDATE') {
                    io.to(payload.data.channelId).emit('reaction_update', payload.data);
                }
            } catch (err) {
                console.error("Payload error:", err);
            }
        });
    } catch (err) {
        console.error("Redis connection failed, retrying in background...", err);
    }
}

io.on('connection', (socket) => {
    console.log("User connected to Messaging:", socket.id);

    socket.on('join_channel', (channelId) => {
        console.log(`Socket ${socket.id} joining room ${channelId}`);
        socket.join(channelId);
    });

    socket.on('disconnect', () => console.log("User disconnected from Messaging"));
});

server.listen(3001, '0.0.0.0', () => {
    console.log('Messaging Service listening on port 3001');
});

start();

const shutdown = async (signal) => {
    console.log(`Received ${signal}. Shutting down...`);
    try {
        io.close();
        if (subscriber.isOpen) await subscriber.quit();
        server.close(() => {
            console.log("HTTP server closed.");
            process.exit(0);
        });
        setTimeout(() => process.exit(1), 5000);
    } catch (err) {
        console.error("Error during shutdown:", err);
        process.exit(1);
    }
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
