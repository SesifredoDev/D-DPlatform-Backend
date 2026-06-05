const express = require('express');
const cookieParser = require('cookie-parser');
const cors = require('cors');

const authRoutes = require('./routes/auth.routes');
const auth = require('./middleware/auth.middleware');
const userRoutes = require('./routes/user.routes');
const fileRoutes = require('./routes/files.routes');
const ddbRoutes = require('./routes/ddb.routes');
const characterRoutes = require('./routes/character.routes');
const serverRoutes = require('./routes/server.routes');
const messageRoutes = require('./routes/message.routes');
const spotifyRoutes = require('./routes/spotify.routes');
const { createLiveKitConnectionInfo } = require('./services/livekit.service');

const app = express();
app.set('trust proxy', true);

const defaultAllowedOrigins = [
    'https://d-d-platform.vercel.app',
    'https://dissertation.pchaffey.me',
    'http://localhost:4200',
    'http://localhost:4201',
    'http://127.0.0.1:4201',
    'https://ddplatform.localhost',
    'http://100.69.189.80:4200'
];

const configuredAllowedOrigins = [
    process.env.FRONTEND_URL,
    process.env.CORS_ORIGINS
]
    .filter(Boolean)
    .flatMap((value) => value.split(','))
    .map((origin) => origin.trim().replace(/\/+$/, ''))
    .filter(Boolean);

const allowedOrigins = Array.from(new Set([
    ...defaultAllowedOrigins,
    ...configuredAllowedOrigins
]));

app.use(
    cors({
        origin: function(origin, callback) {
            // Allow requests with no origin (like mobile apps or curl)
            if (!origin) return callback(null, true);
            const normalizedOrigin = origin.replace(/\/+$/, '');
            if (allowedOrigins.includes(normalizedOrigin) || allowedOrigins.includes('*')) {
                return callback(null, true);
            }
            var msg = 'The CORS policy for this site does not allow access from the specified Origin.';
            console.warn(`Blocked CORS request from origin: ${normalizedOrigin}`);
            return callback(new Error(msg), false);
        },
        credentials: true,
        methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
        allowedHeaders: [
            'Content-Type', 
            'Authorization', 
            'X-Requested-With', 
            'Accept', 
            'Origin', 
            'DNT', 
            'User-Agent', 
            'If-Modified-Since', 
            'Cache-Control', 
            'Range'
        ],
        exposedHeaders: ['Content-Range', 'X-Content-Range', 'Content-Length', 'Content-Disposition', 'Accept-Ranges'],
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

async function handleLiveKitTokenRequest(req, res) {
    try {
        const requestPayload = req.method === 'GET' ? req.query : req.body;
        const connectionInfo = await createLiveKitConnectionInfo(requestPayload, req.user.id);
        res.send(connectionInfo);
    } catch (error) {
        const statusCode = error.statusCode || 500;
        if (statusCode >= 500) {
            console.error('Error generating token:', error);
        }
        res.status(statusCode).send({
            error: statusCode >= 500 ? 'Failed to generate token' : error.message
        });
    }
}

app.post('/livekit/token', auth, handleLiveKitTokenRequest);
app.get('/livekit/token', auth, handleLiveKitTokenRequest);

module.exports = app;

