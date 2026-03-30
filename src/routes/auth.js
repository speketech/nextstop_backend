'use strict';

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

// 1. POST /api/auth/signup
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

            // Improved: Returning the userId so Flutter doesn't have an empty ID
            res.status(201).json({ success: true, data: { ...tokens, userId } });
        } catch (err) {
            logger.error('[Auth] Signup error', { error: err.message });
            res.status(500).json({ success: false, message: 'Registration failed' });
        }
    }
);

// 2. POST /api/auth/login
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

            const tokens = generateTokens({ sub: user.id, role: user.role });
            await db('users').where({ id: user.id }).update({ refresh_token: tokens.refreshToken, last_login_at: new Date() });

            res.json({
                success: true,
                data: {
                    ...tokens,
                    user: {
                        id: user.id, fullName: user.full_name, email: user.email,
                        role: user.role, ninVerified: !!user.nin_verified, isVerified: !!user.is_verified
                    },
                },
            });
        } catch (err) {
            res.status(500).json({ success: false, message: 'Login failed' });
        }
    }
);

// 3. GET /api/auth/me (Supports RealAuthRepository.getCurrentUser)
router.get('/me', authenticate, async (req, res) => {
    try {
        const [user] = await db('users')
            .where({ id: req.user.id })
            .select('id', 'email', 'full_name', 'role', 'nin_verified', 'is_verified')
            .limit(1);

        if (!user) return res.status(404).json({ success: false, message: 'User not found' });

        res.json({
            success: true,
            data: {
                id: user.id, fullName: user.full_name, email: user.email,
                role: user.role, ninVerified: !!user.nin_verified, isVerified: !!user.is_verified
            }
        });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Profile fetch failed' });
    }
});

// 4. POST /api/auth/logout (Supports RealAuthRepository.logout)
router.post('/logout', authenticate, async (req, res) => {
    try {
        await db('users').where({ id: req.user.id }).update({ refresh_token: null });
        res.json({ success: true, message: 'Logged out successfully' });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Logout failed' });
    }
});

// 5. POST /api/auth/update-profile (Supports RealAuthRepository.updateProfile)
router.post('/update-profile', authenticate, async (req, res) => {
    try {
        const { fullName, phone } = req.body;
        await db('users').where({ id: req.user.id }).update({
            full_name: fullName,
            phone: phone,
            updated_at: new Date()
        });

        const updatedUser = await db('users').where({ id: req.user.id }).first();
        res.json({
            success: true,
            data: {
                id: updatedUser.id, fullName: updatedUser.full_name,
                email: updatedUser.email, role: updatedUser.role
            }
        });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Update failed' });
    }
});

module.exports = router;