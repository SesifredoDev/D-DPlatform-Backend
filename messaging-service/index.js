const { Server } = require('socket.io');
const redis = require('redis');
const http = require('http');

const server = http.createServer();
const io = new Server(server, {
    cors: {
        origin: true, // Let Nginx handle the specific origin security
        credentials: true
    },
    transports: ['websocket', 'polling'] // Allow both for better compatibility
});

// Use internal Docker network service name 'redis'
const subscriber = redis.createClient({ url: process.env.REDIS_URL || 'redis://redis:6379' });


subscriber.on('error', (err) => console.error('Redis Error:', err));

async function start() {
    await subscriber.connect();
    console.log('Connected to Redis Sub/Pub');

    // Subscribe to the channel the API service publishes to [cite: 1]
    await subscriber.subscribe('CHAT_MESSAGES', (message) => {
        try {
            const payload = JSON.parse(message);
            // Broadcast only to users joined in the specific channel room [cite: 1]
            io.to(payload.channelId).emit('new_message', payload);
        } catch (err) {
            console.error("Payload error:", err);
        }
    });

    io.on('connection', (socket) => {
        console.log("User connected:", socket.id);

        socket.on('join_channel', (channelId) => {
            console.log(`Socket ${socket.id} joining room ${channelId}`);
            socket.join(channelId);
        });

        socket.on('disconnect', () => console.log("User disconnected"));
    });

    server.listen(3001, '0.0.0.0', () => {
        console.log('Messaging Service listening on port 3001');
    });
}

start();

const shutdown = async (signal) => {
    console.log(`Received ${signal}. Shutting down...`);

    try {
        // 1. Stop accepting new socket connections
        io.close();

        // 2. Disconnect from Redis (Crucial!)
        if (subscriber.isOpen) {
            await subscriber.quit();
            console.log("Redis client disconnected");
        }

        // 3. Close the HTTP server
        server.close(() => {
            console.log("HTTP server closed.");
            process.exit(0);
        });

        // Force exit if server.close hangs (e.g., due to keep-alive connections)
        setTimeout(() => process.exit(1), 5000);
    } catch (err) {
        console.error("Error during shutdown:", err);
        process.exit(1);
    }
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));