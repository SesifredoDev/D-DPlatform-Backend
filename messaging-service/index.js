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

// Map to store userId to socketId mapping
const userSocketMap = new Map();

async function start() {
    try {
        await subscriber.connect();
        console.log('Connected to Redis Sub/Pub');

        await subscriber.subscribe('CHAT_MESSAGES', (message) => {
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
                            console.log(`Whisper sent to sender ${authorId} (socket: ${senderSocketId})`);
                        } else {
                            console.warn(`Sender ${authorId} not found in userSocketMap for whisper.`);
                        }
                        if (recipientSocketId && recipientSocketId !== senderSocketId) { // Avoid double emit if sender is recipient
                            io.to(recipientSocketId).emit('new_message', data);
                            console.log(`Whisper sent to recipient ${recipientId} (socket: ${recipientSocketId})`);
                        } else if (!recipientSocketId) {
                            console.warn(`Recipient ${recipientId} not found in userSocketMap for whisper.`);
                        }
                    } else {
                        // Regular message, emit to the channel room
                        io.to(data.channelId).emit('new_message', data);
                        console.log(`Regular message emitted to channel ${data.channelId}`);
                    }
                } else if (payload.type === 'REACTION_UPDATE') {
                    // Reaction updates should still go to the whole channel
                    io.to(payload.data.channelId).emit('reaction_update', payload.data);
                }
            } catch (err) {
                console.error("Payload error:", err);
            }
        });

        await subscriber.subscribe('SERVER_UPDATES', (message) => {
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
        console.error("Redis connection failed, retrying in background...", err);
    }
}

io.on('connection', (socket) => {
    console.log("User connected to Messaging:", socket.id);

    // Retrieve userId from socket.handshake.auth (frontend needs to send this)
    const userId = socket.handshake.auth.userId;
    if (userId) {
        userSocketMap.set(userId, socket.id);
        console.log(`User ${userId} connected with socket ${socket.id}`);

        socket.on('disconnect', () => {
            userSocketMap.delete(userId);
            console.log(`User ${userId} disconnected from Messaging`);
        });
    } else {
        console.warn(`Socket ${socket.id} connected without a userId in handshake.auth.`);
    }

    socket.on('join_channel', (channelId) => {
        console.log(`Socket ${socket.id} joining channel ${channelId}`);
        socket.join(channelId);
    });

    socket.on('join_server', (serverId) => {
        console.log(`Socket ${socket.id} joining server room server:${serverId}`);
        socket.join(`server:${serverId}`);
    });

    socket.on('disconnect', () => {
        // The userSocketMap.delete(userId) is handled in the specific userId block
        console.log("User disconnected from Messaging (general handler)");
    });
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
