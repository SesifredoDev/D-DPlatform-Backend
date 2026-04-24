const path = require('path');
const mongoose = require('mongoose');
const http = require('http');

require('dotenv').config();
const envFile = process.env.NODE_ENV === 'production' ? '.env.production' : '.env.development';
require('dotenv').config({ path: path.resolve(process.cwd(), envFile) });

const app = require('./app');

const server = http.createServer(app);

const mongooseOptions = {
    serverSelectionTimeoutMS: 30000,
    socketTimeoutMS: 45000,
    family: 4
};

const dbUri = process.env.MONGO_URI || 'mongodb://localhost:27017/your_db';

mongoose.connect(dbUri, mongooseOptions)
    .then(() => console.log(`Connected to MongoDB`))
    .catch(err => {
        console.error('MongoDB connection error:', err);
        process.exit(1);
    });

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`API Service running on port ${PORT} in ${process.env.NODE_ENV || 'development'} mode`);
});

let worker;
const gracefulShutdown = () => {
    console.log('Shutting down gracefully...');
    server.close(() => {
        console.log('HTTP server closed.');
        if (worker) worker.close();
        process.exit(0);
    });
};

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);
