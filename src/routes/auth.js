'use strict';

/**
 * NextStop — Auth Routes (Consolidated)
 * ─────────────────────────────────────────────────────────────────────────────
 * Handled here: Signup, Login, Token Refresh, and Profile Fetching.
 * KYC and Verification logic have been moved to kyc.js.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const express = require('express');
const bcrypt = require('bcryptjs');
const { body, validationResult } = require('express-validator');
const { v4: uuidv4 } = require('uuid');
const jwt = require('jsonwebtoken');
const router = express.Router();

const { generateTokens, authenticate } = require('../middleware/auth');
const db = require('../config/database');
const logger = require('../config/logger');

// ── Validation error handler ──────────────────────────────────────────────────
function handleValidationErrors(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(422).json({ success: false, errors: errors.array() });
    return true;
  }
  return false;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1. POST /api/auth/signup
// ═══════════════════════════════════════════════════════════════════════════════
router.post(
  '/signup',
  [
    body('email').isEmail().normalizeEmail(),
    body('phone').matches(/^\+?[0-9]{10,15}$/).withMessage('Valid phone required'),
    body('password').isLength({ min: 8 }),
    body('fullName').notEmpty().trim(),
    body('role').isIn(['PASSENGER', 'DRIVER']),
  ],
  async (req, res) => {
    if (handleValidationErrors(req, res)) return;
    const { email, phone, password, fullName, role } = req.body;

    try {
      const [existing] = await db('users').where({ email }).orWhere({ phone }).limit(1);
      if (existing) {
        const field = existing.email === email ? 'email' : 'phone';
        return res.status(409).json({ success: false, message: `This ${field} is already registered` });
      }

      const password_hash = await bcrypt.hash(password, 12);
      const userId = uuidv4();

      await db.transaction(async trx => {
        await trx('users').insert({ id: userId, email, phone, password_hash, full_name: fullName, role });
        if (role === 'DRIVER') {
          await trx('drivers').insert({ id: uuidv4(), user_id: userId });
        }
      });

      const tokens = generateTokens({ sub: userId, role });
      await db('users').where({ id: userId }).update({ refresh_token: tokens.refreshToken });

      res.status(201).json({ success: true, data: tokens });
    } catch (err) {
      logger.error('[Auth] Signup error', { error: err.message });
      res.status(500).json({ success: false, message: 'Registration failed' });
    }
  }
);

// ═══════════════════════════════════════════════════════════════════════════════
// 2. POST /api/auth/login
// ═══════════════════════════════════════════════════════════════════════════════
router.post(
  '/login',
  [body('email').isEmail().normalizeEmail(), body('password').notEmpty()],
  async (req, res) => {
    if (handleValidationErrors(req, res)) return;
    const { email, password } = req.body;

    try {
      const [user] = await db('users').where({ email }).limit(1);
      if (!user || !(await bcrypt.compare(password, user.password_hash))) {
        return res.status(401).json({ success: false, message: 'Invalid email or password' });
      }
      if (!user.is_active) {
        return res.status(403).json({ success: false, message: 'Account suspended' });
      }

      const tokens = generateTokens({ sub: user.id, role: user.role });
      await db('users').where({ id: user.id }).update({ refresh_token: tokens.refreshToken, last_login_at: new Date() });

      res.json({
        success: true,
        data: {
          ...tokens,
          user: { 
            id: user.id, 
            fullName: user.full_name, 
            email: user.email, 
            role: user.role, 
            ninVerified: !!user.nin_verified, 
            isVerified: !!user.is_verified 
          },
        },
      });
    } catch (err) {
      logger.error('[Auth] Login error', { error: err.message });
      res.status(500).json({ success: false, message: 'Login failed' });
    }
  }
);

// ═══════════════════════════════════════════════════════════════════════════════
// 3. POST /api/auth/refresh
// ═══════════════════════════════════════════════════════════════════════════════
router.post('/refresh', async (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken) {
    return res.status(401).json({ success: false, message: 'Refresh token required' });
  }

  try {
    const decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET, {
      issuer: 'nextstop',
      audience: 'nextstop-app',
    });

    const [user] = await db('users').where({ id: decoded.sub, is_active: 1 }).limit(1);
    if (!user) {
      return res.status(401).json({ success: false, message: 'User account inactive' });
    }

    const tokens = generateTokens({ sub: user.id, role: user.role });
    await db('users').where({ id: user.id }).update({ refresh_token: tokens.refreshToken });

    res.json({ success: true, data: tokens });
  } catch (err) {
    return res.status(401).json({ success: false, message: 'Invalid refresh token' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. GET /api/auth/me (FIX FOR FLUTTER 404 ERROR)
// ═══════════════════════════════════════════════════════════════════════════════
router.get('/me', authenticate, async (req, res) => {
  try {
    // req.user.id is populated by the 'authenticate' middleware
    const [user] = await db('users')
      .where({ id: req.user.id })
      .select('id', 'email', 'full_name', 'role', 'nin_verified', 'is_verified')
      .limit(1);

    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    res.json({
      success: true,
      data: {
        id: user.id,
        fullName: user.full_name,
        email: user.email,
        role: user.role,
        ninVerified: !!user.nin_verified,
        isVerified: !!user.is_verified
      }
    });
  } catch (err) {
    logger.error('[Auth] Profile fetch error', { error: err.message });
    res.status(500).json({ success: false, message: 'Failed to fetch user profile' });
  }
});

module.exports = router;