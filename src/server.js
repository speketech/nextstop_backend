'use strict';

require('dotenv').config();
const http = require('http');
const express = require('express');
const cors = require('cors');
const { Server } = require('socket.io');
const logger = require('./config/logger');
const db = require('./config/database');

const app = express();
const server = http.createServer(app);

// ── CORS & Security ─────────────────────────────────────────────────────────
app.use(cors({ origin: 'https://cynthax.onrender.com', credentials: true }));

// ── Body Parsing & Webhooks ─────────────────────────────────────────────────
// Raw parser MUST come before JSON parser for HMAC signature checks
app.use('/webhooks/interswitch', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));

// ── API Routes ──────────────────────────────────────────────────────────────
app.get('/health', async (_req, res) => {
  try {
    await db.raw('SELECT 1');
    res.json({ status: 'ok', db: 'connected', ts: new Date().toISOString() });
  } catch (err) { res.status(503).json({ status: 'degraded' }); }
});

app.use('/api/auth', require('./routes/auth'));
app.use('/api/kyc', require('./routes/kyc')); // 🚀 MOUNTED
app.use('/api/payments', require('./routes/payments'));
app.use('/api/rides', require('./routes/rides'));
app.use('/webhooks/interswitch', require('./routes/webhooks'));

// ── Socket.io Setup ─────────────────────────────────────────────────────────
const io = new Server(server, { cors: { origin: 'https://cynthax.onrender.com' } });
app.set('io', io);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => logger.info(`NextStop API Live on Port ${PORT}`));