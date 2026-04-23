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

subscriber.on('error', (err) => {
    // Only log if not in test environment
    if (process.env.NODE_ENV !== 'test') {
        console.error('Redis Error:', err);
    }
});

// Map to store userId to socketId mapping
const userSocketMap = new Map();

async function start(redisClient = subscriber) {
    try {
        if (!redisClient.isOpen) {
            await redisClient.connect();
        }
        console.log('Connected to Redis Sub/Pub');

        await redisClient.subscribe('CHAT_MESSAGES', (message) => {
            try {
                const payload = JSON.parse(message);
                if (payload.type === 'NEW_MESSAGE') {
                    const data = payload.data;
                    const authorId = data.author?._id || data.author;
                    const recipientId = data.recipient?._id || data.recipient;

                    if (data.isWhisper && recipientId && authorId) {
                        // It's a whisper, emit only to sender and recipient
                        const senderSocketId = userSocketMap.get(authorId.toString());
                        const recipientSocketId = userSocketMap.get(recipientId.toString());

                        if (senderSocketId) {
                            io.to(senderSocketId).emit('new_message', data);
                        }
                        if (recipientSocketId && recipientSocketId !== senderSocketId) { 
                            io.to(recipientSocketId).emit('new_message', data);
                        }
                    } else {
                        // Regular message, emit to the channel room
                        io.to(data.channelId).emit('new_message', data);
                    }
                } else if (payload.type === 'REACTION_UPDATE') {
                    io.to(payload.data.channelId).emit('reaction_update', payload.data);
                }
            } catch (err) {
                console.error("Payload error:", err);
            }
        });

        await redisClient.subscribe('SERVER_UPDATES', (message) => {
            try {
                const payload = JSON.parse(message);
                if (payload.type === 'MEMBER_UPDATE') {
                    io.to(`server:${payload.serverId}`).emit('member_update', payload.data);
                } else if (payload.type === 'CHARACTER_UPDATE') {
                    io.to(`server:${payload.serverId}`).emit('character_update', payload.data);
                }
            } catch (err) {
                console.error("Server update payload error:", err);
            }
        });
    } catch (err) {
        if (process.env.NODE_ENV !== 'test') {
            console.error("Redis connection failed, retrying in background...", err);
        }
    }
}

io.on('connection', (socket) => {
    // Retrieve userId from socket.handshake.auth (frontend needs to send this)
    const userId = socket.handshake.auth.userId;
    if (userId) {
        userSocketMap.set(userId.toString(), socket.id);

        socket.on('disconnect', () => {
            userSocketMap.delete(userId.toString());
        });
    }

    socket.on('join_channel', (channelId) => {
        socket.join(channelId);
    });

    socket.on('join_server', (serverId) => {
        socket.join(`server:${serverId}`);
    });
});

const shutdown = async (signal) => {
    if (process.env.NODE_ENV !== 'test') {
        console.log(`Received ${signal}. Shutting down...`);
    }
    try {
        io.close();
        if (subscriber.isOpen) await subscriber.quit();
        return new Promise((resolve) => {
            server.close(() => {
                if (process.env.NODE_ENV !== 'test') {
                    console.log("HTTP server closed.");
                }
                resolve();
                if (require.main === module) process.exit(0);
            });
            if (require.main === module) setTimeout(() => process.exit(1), 5000);
        });
    } catch (err) {
        console.error("Error during shutdown:", err);
        if (require.main === module) process.exit(1);
    }
};

if (require.main === module) {
    server.listen(3001, '0.0.0.0', () => {
        console.log('Messaging Service listening on port 3001');
    });
    start();
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
}

module.exports = {
    server,
    io,
    subscriber,
    start,
    shutdown,
    userSocketMap
};
