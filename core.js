const express = require('express');
const path = require('path');

let app;

try {
    const cors = require('cors');
    const mongoose = require('mongoose');
    const dotenv = require('dotenv');

    dotenv.config();

    app = express();

    app.use(cors({
        origin: function (origin, callback) {
            const allowedOrigins = [
                'https://inkless.minderfly.com',
                'http://localhost:3000',
                'http://localhost:5173',
                'https://inkless-fyp.vercel.app',
                'https://inklesslms.com',
                'https://www.inklesslms.com'
            ];
            if (!origin || allowedOrigins.indexOf(origin) !== -1) {
                callback(null, true);
            } else {
                console.log("CORS Blocked for origin:", origin);
                callback(new Error('Not allowed by CORS'));
            }
        },
        methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization', 'x-auth-token', 'Accept'],
        credentials: true
    }));
    app.use(express.json());

    mongoose.set('strictQuery', false);
    mongoose.set('bufferCommands', false);

    app.locals.dbConnected = false;
    app.locals.dbError = null;

    const mongoURI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/inkless';
    const mongoOptions = {
        serverSelectionTimeoutMS: 3000,
        socketTimeoutMS: 5000,
        family: 4
    };

    const updateDbStatus = (connected, error = null) => {
        app.locals.dbConnected = connected;
        app.locals.dbError = error;
    };

    const connectToMongo = async () => {
        if (!mongoURI) {
            updateDbStatus(false, new Error('MONGO_URI is not defined.'));
            console.error('FATAL ERROR: MONGO_URI is not defined.');
            return;
        }

        try {
            await mongoose.connect(mongoURI, mongoOptions);
            updateDbStatus(true);
            console.log('MongoDB connected');
        } catch (err) {
            updateDbStatus(false, err);
            console.error('MongoDB connection error:', err.message);
        }
    };

    connectToMongo();

    app.use((req, res, next) => {
        if (req.path === '/health' || req.path === '/' || req.path.startsWith('/uploads')) {
            return next();
        }

        if (req.path.startsWith('/api/') && !app.locals.dbConnected && mongoose.connection.readyState !== 1) {
            return res.status(503).json({
                error: 'Database unavailable',
                message: 'MongoDB is not reachable. Start MongoDB or provide a valid MONGO_URI.'
            });
        }

        next();
    });

    // Routes
    app.use('/api/auth', require('./routes/auth'));
    app.use('/api/classes', require('./routes/classes'));
    app.use('/api/quizzes', require('./routes/quizzes'));
    app.use('/api/assignments', require('./routes/assignments'));
    app.use('/api/submissions', require('./routes/submissions'));
    app.use('/api/lab-tasks', require('./routes/labTasks'));
    app.use('/api/lab-submissions', require('./routes/labSubmissions'));
    app.use('/api/notifications', require('./routes/notifications'));
    // Serve uploaded files — two locations:
    // 1. Old flat folder: server/uploads/ (assignments, lab submissions)
    // 2. New nested: server/public/uploads/ (student submissions)
    app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
    app.use('/uploads', express.static(path.join(__dirname, 'public/uploads')));

    // Basic Route
    app.get('/', (req, res) => {
        res.send('Inkless API is running');
    });

    app.get('/health', (req, res) => {
        res.json({
            status: 'ok',
            mongo: {
                connected: app.locals.dbConnected,
                readyState: mongoose.connection.readyState,
                error: app.locals.dbError ? app.locals.dbError.message : null
            }
        });
    });

    if (require.main === module) {
        const PORT = process.env.PORT || 5015;
        app.listen(PORT, () => {
            console.log(`Server is running on port ${PORT}`);
        });
    }
} catch (err) {
    console.error("Initialization error:", err);
    // If initialization fails, create a dummy app that returns the error
    app = express();
    app.use((req, res) => {
        res.status(500).json({
            error: "Server Initialization Error",
            message: err.message,
            stack: err.stack,
            note: "This error was caught by the startup error boundary. It usually means a module failed to load."
        });
    });
}

module.exports = app;
