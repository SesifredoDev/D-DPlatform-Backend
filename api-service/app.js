const express = require('express');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const { AccessToken } = require('livekit-server-sdk');

const authRoutes = require('./routes/auth.routes');
const userRoutes = require('./routes/user.routes');
const fileRoutes = require('./routes/files.routes');
const ddbRoutes = require('./routes/ddb.routes');
const characterRoutes = require('./routes/character.routes');
const serverRoutes = require('./routes/server.routes');
const messageRoutes = require('./routes/message.routes');
const spotifyRoutes = require('./routes/spotify.routes');

const app = express();

app.use(
    cors({
        origin: (origin, callback) => {
            // Allow all origins for development, or specify your frontend URL
            callback(null, true);
        },
        credentials: true,
        methods: ['GET', 'POST','PATCH', 'PUT', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization'],
    })
);

app.use(express.json());
app.use(cookieParser());

// Health check endpoint
app.get('/health', (req, res) => {
    res.status(200).send('OK');
});

// Standard API Routes
app.use('/auth', authRoutes);
app.use('/users', userRoutes);
app.use('/files', fileRoutes);
app.use('/ddb', ddbRoutes);
app.use('/server', serverRoutes);
app.use('/message', messageRoutes);
app.use('/character', characterRoutes);
app.use('/spotify', spotifyRoutes);


app.get('/livekit/token', async (req, res) => {
    try {
        const { room, identity } = req.query;
        if (!room || !identity) {
            return res.status(400).send({ error: 'room and identity are required' });
        }

        const apiKey = process.env.LIVEKIT_API_KEY || 'devkey';
        const apiSecret = process.env.LIVEKIT_API_SECRET || 'secret';

        const at = new AccessToken(apiKey, apiSecret, {
            identity: identity,
        });
        
        // Explicitly grant permission to update own metadata
        at.addGrant({ 
            roomJoin: true, 
            room: room, 
            canPublish: true, 
            canSubscribe: true,
            canUpdateOwnMetadata: true 
        });
        
        const token = await at.toJwt();

        // Securely provide ICE servers to the client
        const iceServers = [
            { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
            {
                urls: [
                    'turn:dissertation.metered.live:80',
                    'turn:dissertation.metered.live:443',
                    'turn:dissertation.metered.live:443?transport=tcp'
                ],
                username: "7b5929daae01c61791bd79e0",
                credential: "IAn4+2Vz3ViblwX3"
            }
        ];

        res.send({ 
            token: token,
            iceServers: iceServers
        });
    } catch (error) {
        console.error('Error generating token:', error);
        res.status(500).send({ error: 'Failed to generate token' });
    }
});

module.exports = app;
