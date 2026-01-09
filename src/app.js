const express = require('express');
const cookieParser = require('cookie-parser');
const cors = require('cors');

const authRoutes = require('./routes/auth.routes');
const userRoutes = require('./routes/user.routes');
const fileRoutes = require('./routes/files.routes');
const ddbRoutes = require('./routes/ddb.routes');
const characterRoutes = require('./routes/character.routes');
const serverRoutes = require('./routes/server.routes');
const messageRoutes = require('./routes/message.routes');


const app = express();

app.use(
    cors({
        origin: 'http://localhost:4200',
        credentials: true,
        methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization'],
    })
);

app.use(express.json());
app.use(cookieParser());

app.use('/auth', authRoutes);
app.use('/users', userRoutes);
app.use('/files', fileRoutes );
app.use('/ddb', ddbRoutes);

app.use('/server', serverRoutes);
app.use('/message', messageRoutes )
app.use('/character', characterRoutes);

module.exports = app;
