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

const allowedOrigins = [
    'https://d-d-platform.vercel.app',
    'http://localhost:4200',
    '*'
];

app.use(
    cors({
        origin: function(origin, callback) {
            // Allow requests with no origin (like mobile apps or curl)
            if (!origin) return callback(null, true);
            if (allowedOrigins.indexOf(origin) === -1) {
                var msg = 'The CORS policy for this site does not allow access from the specified Origin.';
                return callback(new Error(msg), false);
            }
            return callback(null, true);
        },
        credentials: true,
        methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept'],
    })
);

// Increase limit for JSON and URL-encoded bodies
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
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
        const apiSecret = process.env.LIVEKIT_API_SECRET || 'superlongsecuresecretkeyatleast32chars!!';

        const at = new AccessToken(apiKey, apiSecret, {
            identity: identity,
        });
        
        at.addGrant({ 
            roomJoin: true, 
            room: room, 
            canPublish: true, 
            canSubscribe: true,
            canUpdateOwnMetadata: true 
        });
        
        const token = await at.toJwt();

        const iceServers = [
            { urls: 'stun:stun.relay.metered.ca:80' },
            {
                urls: [
                    'turn:global.relay.metered.ca:80',
                    'turn:global.relay.metered.ca:80?transport=tcp',
                    'turn:global.relay.metered.ca:443',
                    'turns:global.relay.metered.ca:443?transport=tcp'
                ],
                username: process.env.METERED_USERNAME,
                credential: process.env.METERED_CREDENTIAL
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
