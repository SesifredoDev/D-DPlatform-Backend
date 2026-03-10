require('dotenv').config();
const http = require('http');
const { Server } = require('socket.io');
const mediasoup = require('mediasoup');
const axios = require('axios');
const jwt = require('jsonwebtoken');

const userMetadata = new Map();
const rooms = new Map();

const server = http.createServer();

const io = new Server(server, {
    path: '/video/',
    cors: {
        origin: true,
        methods: ['GET', 'POST'],
        credentials: true
    }
});

let worker;

const mediaCodecs = [
    {
        kind: 'audio',
        mimeType: 'audio/opus',
        clockRate: 48000,
        channels: 2
    },
    {
        kind: 'video',
        mimeType: 'video/H264',
        clockRate: 90000,
        parameters: {
            'packetization-mode': 1,
            // Changed from 42e01f to 4d001f (Main Profile)
            'profile-level-id': '4d001f',
            'level-asymmetry-allowed': 1
        },
        rtcpFeedback: [
            { type: 'goog-remb' },
            { type: 'transport-cc' },
            { type: 'ccm', parameter: 'fir' },
            { type: 'nack' },
            { type: 'nack', parameter: 'pli' }
        ]
    }
];

(async () => {
    worker = await mediasoup.createWorker({
        rtcMinPort: Number(process.env.RTC_MIN_PORT),
        rtcMaxPort: Number(process.env.RTC_MAX_PORT)
    });

    console.log(`[DEBUG] Mediasoup Worker started (PID: ${worker.pid})`);
})();

function getOrCreateRoom(channelId) {
    if (!rooms.has(channelId)) {
        rooms.set(channelId, {
            router: null,
            transports: new Map(),
            producers: new Map(),
            consumers: new Map()
        });
    }

    return rooms.get(channelId);
}

io.use((socket, next) => {
    const token =
        socket.handshake.auth.token ||
        socket.handshake.headers['authorization'];

    if (!token) return next(new Error('Authentication error'));

    try {
        const cleanToken = token.replace('Bearer ', '');
        const decoded = jwt.verify(cleanToken, process.env.JWT_ACCESS_SECRET);
        socket.decoded = decoded;
        next();
    } catch (err) {
        next(new Error('Authentication error'));
    }
});

io.on('connection', (socket) => {
    console.log(`[DEBUG] Client connected: ${socket.id}`);

    /*
    --------------------------------
    GET ROUTER RTP CAPABILITIES
    --------------------------------
    */

    socket.on('getRouterRtpCapabilities', async (channelId, callback) => {
        const room = getOrCreateRoom(channelId);

        if (!room.router) room.router = await worker.createRouter({ mediaCodecs });

        socket.join(`voice_${channelId}`); // ✅ Make sure this happens here

        if (typeof callback === 'function') callback(room.router.rtpCapabilities);
    });

    /*
    --------------------------------
    CREATE TRANSPORT
    --------------------------------
    */

    socket.on('createWebRtcTransport', async ({ channelId, direction }, callback) => {
        try {

            const room = getOrCreateRoom(channelId);

            const transport = await room.router.createWebRtcTransport({
                listenIps: [{ ip: '0.0.0.0', announcedIp: process.env.ANNOUNCED_IP }],
                enableUdp: true,
                enableTcp: true,
                preferUdp: true,
                initialAvailableOutgoingBitrate: 1000000, // Start at 1Mbps
            });

            if (!room.transports.has(socket.id))
                room.transports.set(socket.id, {});

            room.transports.get(socket.id)[direction] = transport;

            callback({
                params: {
                    id: transport.id,
                    iceParameters: transport.iceParameters,
                    iceCandidates: transport.iceCandidates,
                    dtlsParameters: transport.dtlsParameters
                }
            });

        } catch (err) {
            console.error(err);
            callback({ error: err.message });
        }
    });

    /*
    --------------------------------
    CONNECT TRANSPORT
    --------------------------------
    */

    socket.on('transport-connect', async ({ channelId, direction, dtlsParameters }, callback) => {

        const room = rooms.get(channelId);
        const transport = room?.transports.get(socket.id)?.[direction];

        if (!transport)
            return callback({ error: 'Transport not found' });

        await transport.connect({ dtlsParameters });

        callback();
    });

    /*
    --------------------------------
    PRODUCE MEDIA
    --------------------------------
    */

    socket.on('transport-produce', async ({ channelId, kind, rtpParameters }, callback) => {

        try {

            const room = rooms.get(channelId);

            const transport = room?.transports.get(socket.id)?.send;

            if (!transport)
                return callback({ error: 'Send transport missing' });

            const producer = await transport.produce({
                kind,
                rtpParameters,
                appData: { socketId: socket.id }
            });

            room.producers.set(producer.id, producer);

            socket.to(`voice_${channelId}`).emit('new-producer', {
                producerId: producer.id
            });

            callback({ id: producer.id });

        } catch (err) {
            console.error(err);
            callback({ error: err.message });
        }
    });

    /*
    --------------------------------
    CONSUME
    --------------------------------
    */

    socket.on('consume', async ({ channelId, remoteProducerId, rtpCapabilities }, callback) => {

        try {

            const room = rooms.get(channelId);
            const transport = room?.transports.get(socket.id)?.recv;
            const producer = room?.producers.get(remoteProducerId);

            if (!room || !transport || !producer)
                return callback({ error: 'Missing components' });

            if (!room.router.canConsume({
                producerId: remoteProducerId,
                rtpCapabilities
            }))
                return callback({ error: 'Cannot consume' });

            const consumer = await transport.consume({
                producerId: remoteProducerId,
                rtpCapabilities,
                paused: true
            });

            if (consumer.kind === 'video') {
                await consumer.setPreferredLayers({ spatialLayer: 2, temporalLayer: 2 });
            }

            room.consumers.set(consumer.id, consumer);

            callback({
                id: consumer.id,
                producerId: remoteProducerId,
                kind: consumer.kind,
                rtpParameters: consumer.rtpParameters,
                remoteSocketId: producer.appData.socketId,
                userData: userMetadata.get(producer.appData.socketId) || {}
            });

        } catch (err) {
            console.error(err);
            callback({ error: err.message });
        }
    });

    /*
    --------------------------------
    RESUME CONSUMER
    --------------------------------
    */

    socket.on('resume-consumer', async ({ consumerId }) => {
        for (const room of rooms.values()) {
            const consumer = room.consumers.get(consumerId);
            if (consumer) {
                await consumer.resume();
                break;
            }
        }
    });

    /*
    --------------------------------
    GET PRODUCERS
    --------------------------------
    */

    socket.on('getProducers', (channelId, callback) => {

        const room = rooms.get(channelId);

        if (!room)
            return callback([]);

        const producerIds = Array.from(room.producers.values())
            .filter(p => p.appData.socketId !== socket.id)
            .map(p => p.id);

        callback(producerIds);
    });

    /*
    --------------------------------
    USER METADATA
    --------------------------------
    */

    socket.on('update-user-data', ({ channelId, data }) => {

        userMetadata.set(socket.id, data);

        socket.to(`voice_${channelId}`).emit('peer-updated', {
            socketId: socket.id,
            data
        });
    });

    /*
    --------------------------------
    LEAVE ROOM
    --------------------------------
    */

    socket.on('leave-room', ({ channelId }) => {

        const room = rooms.get(channelId);
        if (!room) return;

        const transports = room.transports.get(socket.id);

        if (transports) {
            Object.values(transports).forEach(t => t.close());
            room.transports.delete(socket.id);
        }

        for (const [id, producer] of room.producers.entries()) {

            if (producer.appData.socketId === socket.id) {

                producer.close();
                room.producers.delete(id);

                socket.to(`voice_${channelId}`).emit('producer-closed', {
                    producerId: id
                });
            }
        }

        socket.leave(`voice_${channelId}`);
    });

    /*
    --------------------------------
    DISCONNECT
    --------------------------------
    */

    socket.on('disconnect', () => {

        console.log(`[DEBUG] Client disconnected: ${socket.id}`);

        userMetadata.delete(socket.id);

        for (const room of rooms.values()) {

            const transports = room.transports.get(socket.id);

            if (transports) {
                Object.values(transports).forEach(t => t.close());
                room.transports.delete(socket.id);
            }

            for (const [id, producer] of room.producers.entries()) {

                if (producer.appData.socketId === socket.id) {

                    producer.close();
                    room.producers.delete(id);

                    io.emit('producer-closed', {
                        producerId: id
                    });
                }
            }
        }
    });
});

const PORT = process.env.VIDEO_SERVICE_PORT || 3002;

server.listen(PORT, '0.0.0.0', () =>
    console.log(`[INFO] Video service running on port ${PORT}`)
);