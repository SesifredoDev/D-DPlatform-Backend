require('dotenv').config();
const mongoose = require('mongoose');
const http = require('http');
const { Server } = require('socket.io');
const mediasoup = require('mediasoup');
const app = require('./app');

const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: 'http://localhost:4200', credentials: true }
});

app.set('socketio', io);

let worker;
const rooms = new Map();
const mediaCodecs = [
    { kind: 'audio', mimeType: 'audio/opus', clockRate: 48000, channels: 2 },
    { kind: 'video', mimeType: 'video/VP8', clockRate: 90000 }
];

(async () => {
    worker = await mediasoup.createWorker({
        rtcMinPort: 2000,
        rtcMaxPort: 3000
    });
})();

io.on('connection', (socket) => {
    console.log('Connected:', socket.id);

    socket.on('getRouterRtpCapabilities', async (channelId, callback) => {
        try {
            if (!rooms.has(channelId)) {
                const router = await worker.createRouter({ mediaCodecs });
                rooms.set(channelId, {
                    router,
                    transports: new Map(),
                    producers: new Map(),
                    consumers: new Map()
                });
            }
            const room = rooms.get(channelId);
            socket.join(`voice_${channelId}`);

            // Note: We don't loop here anymore to prevent the crash and race conditions.
            // The client will call 'getProducers' once its transports are ready.
            callback(room.router.rtpCapabilities);
        } catch (err) {
            callback({ error: err.message });
        }
    });

    socket.on('getProducers', (channelId, callback) => {
        const room = rooms.get(channelId);
        if (!room) return callback([]);

        const producerIds = [];
        for (const [id, producer] of room.producers.entries()) {
            if (producer.appData.socketId !== socket.id) {
                producerIds.push(id);
            }
        }
        callback(producerIds);
    });

    socket.on('createWebRtcTransport', async ({ channelId, direction }, callback) => {
        const room = rooms.get(channelId);
        const transport = await room.router.createWebRtcTransport({
            listenIps: [{ ip: '0.0.0.0', announcedIp: '127.0.0.1' }],
            enableUdp: true,
            enableTcp: true,
            preferUdp: true
        });

        if (!room.transports.has(socket.id)) room.transports.set(socket.id, {});
        room.transports.get(socket.id)[direction] = transport;

        callback({ params: {
                id: transport.id, iceParameters: transport.iceParameters,
                iceCandidates: transport.iceCandidates, dtlsParameters: transport.dtlsParameters
            }});
    });

    socket.on('transport-connect', async ({ channelId, direction, dtlsParameters }, callback) => {
        const transport = rooms.get(channelId)?.transports.get(socket.id)?.[direction];
        if (transport) await transport.connect({ dtlsParameters });
        callback();
    });

    socket.on('transport-produce', async ({ channelId, kind, rtpParameters }, callback) => {
        const room = rooms.get(channelId);
        const transport = room?.transports.get(socket.id)?.send;
        if (!transport) return;

        const producer = await transport.produce({
            kind,
            rtpParameters,
            appData: { socketId: socket.id }
        });

        room.producers.set(producer.id, producer);
        socket.to(`voice_${channelId}`).emit('new-producer', { producerId: producer.id });
        callback({ id: producer.id });
    });

    socket.on('consume', async ({ channelId, rtpCapabilities, remoteProducerId }, callback) => {
        const room = rooms.get(channelId);
        const transport = room?.transports.get(socket.id)?.recv;
        const producer = room?.producers.get(remoteProducerId);

        if (!room.router.canConsume({ producerId: remoteProducerId, rtpCapabilities })) {
            return callback({ error: 'Cannot consume' });
        }

        const consumer = await transport.consume({ producerId: remoteProducerId, rtpCapabilities, paused: true });
        room.consumers.set(consumer.id, consumer);

        callback({
            id: consumer.id,
            producerId: remoteProducerId,
            kind: consumer.kind,
            rtpParameters: consumer.rtpParameters,
            remoteSocketId: producer.appData.socketId // Send socketId so client can group tracks
        });
    });

    socket.on('resume-consumer', async ({ channelId, consumerId }) => {
        const consumer = rooms.get(channelId)?.consumers.get(consumerId);
        if (consumer) await consumer.resume();
    });

    socket.on('disconnect', () => {
        rooms.forEach((room, channelId) => {
            const transports = room.transports.get(socket.id);
            if (transports) {
                Object.values(transports).forEach(t => t.close());
                room.transports.delete(socket.id);
            }
            for (const [id, p] of room.producers.entries()) {
                if (p.appData.socketId === socket.id) {
                    p.close();
                    room.producers.delete(id);
                    io.to(`voice_${channelId}`).emit('producer-closed', { producerId: id });
                }
            }
        });
    });
});

mongoose.connect(process.env.MONGO_URI).then(() => {
    server.listen(process.env.PORT, () => console.log(`Server running on ${process.env.PORT}`));
});