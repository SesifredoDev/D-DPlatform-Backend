const path = require('path');
const mongoose = require('mongoose');
const http = require('http');
const app = require('./app');

// Load environment variables
// This will try to load .env, or you can rely on Docker-injected variables
require('dotenv').config(); 

// Support the specific naming convention if those files exist
const envFile = process.env.NODE_ENV === 'production' ? '.env.production' : '.env.development';
require('dotenv').config({ path: path.resolve(process.cwd(), envFile) });

const server = http.createServer(app);

// Robust MongoDB Connection Options
const mongooseOptions = {
    serverSelectionTimeoutMS: 30000, // Wait 30s before failing
    socketTimeoutMS: 45000,          // Close sockets after 45s of inactivity
    family: 4                        // Use IPv4
};

// Use the MONGO_URI from env, or the Atlas one if provided directly
const dbUri = process.env.MONGO_URI || 'mongodb://localhost:27017/your_db';

// Connect to MongoDB
mongoose.connect(dbUri, mongooseOptions)
    .then(() => console.log(`Connected to MongoDB`))
    .catch(err => {
        console.error('MongoDB connection error:', err);
        process.exit(1); // Exit if we can't connect to DB
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
