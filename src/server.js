'use strict';

require('dotenv').config();
const http = require('http');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const { Server } = require('socket.io');
const logger = require('./config/logger');
const db = require('./config/database');

const app = express();
const server = http.createServer(app);

// ─── Production CORS Configuration ──────────────────────────────────────────
const allowedOrigins = [
  'https://cynthax.onrender.com', 
  'https://cynthax.onrender.com/', // Added trailing slash for safety
  'http://localhost:5000'
];

app.use(cors({
  origin: (origin, callback) => {
    // If there's no origin (like a mobile app) or it matches our list, allow it
    if (!origin || allowedOrigins.includes(origin) || allowedOrigins.includes(`${origin}/`)) {
      callback(null, true);
    } else {
      logger.error(`CORS Blocked for origin: ${origin}`);
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true
}));

app.use(helmet({
  crossOriginResourcePolicy: false,
  contentSecurityPolicy: false, // Flutter Web often needs this disabled for CanvasKit/Fonts
}));

// ─── Body Parsing & Webhooks ─────────────────────────────────────────────────
app.use('/webhooks/interswitch', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));


// This must be here to resolve the "Cannot GET /health" error
app.get('/health', async (_req, res) => {
  try {
    await db.raw('SELECT 1'); // Check if TiDB is alive
    res.json({ 
      status: 'ok', 
      db: 'connected', 
      service: 'nextstop-api', 
      ts: new Date().toISOString() 
    });
  } catch (err) {
    res.status(503).json({ status: 'degraded', database: 'disconnected' });
  }
});

// ─── API Routes ──────────────────────────────────────────────────────────────
app.use('/api/auth', require('./routes/auth'));
app.use('/api/payments', require('./routes/payments'));
app.use('/api/rides', require('./routes/rides'));
app.use('/webhooks/interswitch', require('./routes/webhooks'));

// ─── Socket.io Setup ─────────────────────────────────────────────────────────
const io = new Server(server, {
  cors: { origin: allowedOrigins, credentials: true }
});
app.set('io', io);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  logger.info(`NextStop API Live on Port ${PORT} [Production]`);
});