'use strict';

require('dotenv').config();

const http        = require('http');
const express     = require('express');
const helmet      = require('helmet');
const cors        = require('cors');
const compression = require('compression');
const morgan      = require('morgan');
const rateLimit   = require('express-rate-limit');
const { Server }  = require('socket.io');

const logger   = require('./config/logger');
const db       = require('./config/database');
const { authenticate } = require('./middleware/auth');

// ─── Routes ──────────────────────────────────────────────────────────────────
const authRoutes     = require('./routes/auth');
const rideRoutes     = require('./routes/rides');
const paymentRoutes  = require('./routes/payments');
const webhookRoutes  = require('./routes/webhooks');

const app    = express();
const server = http.createServer(app);

// ─── Security Middleware ──────────────────────────────────────────────────────
app.use(helmet());
app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  methods: ['GET', 'POST', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// ─── Rate Limiting ────────────────────────────────────────────────────────────
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20, // Stricter on auth endpoints
  message: { success: false, message: 'Too many requests, please try again later.' },
});

app.use(globalLimiter);

// ─── Body Parsing ─────────────────────────────────────────────────────────────
// Webhook route uses raw body — must be registered BEFORE json middleware
app.use('/webhooks/interswitch', (req, res, next) => {
  express.raw({ type: 'application/json' })(req, res, next);
});
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));
app.use(compression());

// ─── Logging ─────────────────────────────────────────────────────────────────
if (process.env.NODE_ENV !== 'test') {
  app.use(morgan('combined', { stream: { write: msg => logger.info(msg.trim()) } }));
}

// ─── Health Check ─────────────────────────────────────────────────────────────
app.get('/health', async (_req, res) => {
  try {
    await db.raw('SELECT 1');
    res.json({ status: 'ok', service: 'nextstop-api', ts: new Date().toISOString() });
  } catch {
    res.status(503).json({ status: 'degraded', detail: 'Database unreachable' });
  }
});

// ─── API Routes ───────────────────────────────────────────────────────────────
app.use('/api/auth',        authLimiter, authRoutes);
app.use('/api/rides',       rideRoutes);
app.use('/api/payments',    paymentRoutes);
app.use('/webhooks/interswitch', webhookRoutes);

// ─── 404 Handler ──────────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ success: false, message: 'Endpoint not found' });
});

// ─── Global Error Handler ─────────────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  logger.error('[Server] Unhandled error', { error: err.message, stack: err.stack });
  res.status(500).json({ success: false, message: 'Internal server error' });
});

// ─── Socket.io (Real-time) ────────────────────────────────────────────────────
const io = new Server(server, {
  cors: { origin: process.env.FRONTEND_URL || '*' },
  transports: ['websocket', 'polling'],
});

// Authenticate socket connections via JWT
io.use(async (socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) return next(new Error('Authentication required'));

  try {
    const jwt     = require('jsonwebtoken');
    const decoded = jwt.verify(token, process.env.JWT_ACCESS_SECRET, {
      issuer: 'nextstop', audience: 'nextstop-app',
    });
    socket.userId = decoded.sub;
    socket.role   = decoded.role;
    next();
  } catch {
    next(new Error('Invalid token'));
  }
});

io.on('connection', socket => {
  logger.debug('[Socket] Client connected', { userId: socket.userId });

  // Each user joins a private room for direct notifications
  socket.join(`user:${socket.userId}`);

  // Driver location broadcasting
  socket.on('driver:location', async ({ lat, lng }) => {
    if (socket.role !== 'DRIVER') return;
    await db('drivers')
      .where({ user_id: socket.userId })
      .update({ current_lat: lat, current_lng: lng, last_location_at: new Date() });

    // Broadcast to all rooms this driver is part of (active rides)
    socket.rooms.forEach(room => {
      if (room.startsWith('ride:')) {
        socket.to(room).emit('driver:location', { lat, lng });
      }
    });
  });

  // Join a ride room (for real-time updates)
  socket.on('ride:join_room', ({ rideId }) => {
    socket.join(`ride:${rideId}`);
    logger.debug('[Socket] Joined ride room', { userId: socket.userId, rideId });
  });

  socket.on('disconnect', () => {
    logger.debug('[Socket] Client disconnected', { userId: socket.userId });
  });
});

// Make io accessible to route handlers
app.set('io', io);

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  logger.info(`NextStop API listening on port ${PORT} [${process.env.NODE_ENV}]`);
});

module.exports = { app, server };
