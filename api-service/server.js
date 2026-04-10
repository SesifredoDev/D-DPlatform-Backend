const path = require('path');
const envFile = process.env.NODE_ENV === 'production' ? '.env.development.production' : '.env.development.development';
require('dotenv').config({ path: path.resolve(process.cwd(), envFile) });

const mongoose = require('mongoose');
const http = require('http');
const app = require('./app');

const server = http.createServer(app);

// Robust MongoDB Connection Options
const mongooseOptions = {
    serverSelectionTimeoutMS: 30000, // Wait 30s before failing
    socketTimeoutMS: 45000,          // Close sockets after 45s of inactivity
    family: 4                        // Use IPv4, skip trying IPv6 (common cause of EAI_AGAIN)
};

// Connect to MongoDB
mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/your_db', mongooseOptions)
    .then(() => console.log(`Connected to MongoDB (${process.env.NODE_ENV || 'development'})`))
    .catch(err => console.error('MongoDB connection error:', err));

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0',() => {
    console.log(`API Service running on port ${PORT} in ${process.env.NODE_ENV || 'development'} mode`);
});


let worker;
const gracefulShutdown = () => {
    console.log('Shutting down gracefully...');
    server.close(() => {
        console.log('HTTP server closed.');
        // Close Mediasoup workers
        if (worker) worker.close();
        process.exit(0);
    });
};

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);
