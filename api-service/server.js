require('dotenv').config();
const mongoose = require('mongoose');
const http = require('http');
const app = require('./app');

const server = http.createServer(app);

// Connect to MongoDB
mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/your_db')
    .then(() => console.log('Connected to MongoDB'))
    .catch(err => console.error('MongoDB connection error:', err));

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0',() => {
    console.log(`API Service running on port ${PORT}`);
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