'use strict';

/**
 * NextStop — Auth Routes  (v2 — docs-accurate)
 * ─────────────────────────────────────────────────────────────────────────────
 * Public endpoints:
 *   POST /api/auth/signup
 *   POST /api/auth/login
 *   POST /api/auth/refresh
 *
 * Driver KYC (all use MKT credentials — Marketplace):
 *   POST /api/auth/verify-nin       → NIN Verification API
 *   POST /api/auth/verify-licence   → Driver's License API
 *   POST /api/auth/verify-bvn       → BVN Full Details API  (placeholder)
 *   POST /api/auth/verify-bank      → Bank Account Verification API (placeholder)
 *
 * Phone OTP (MKT credentials):
 *   POST /api/auth/send-otp         → WhatsApp OTP API
 *                                     NOTE: You generate the code; ISW delivers it
 *   POST /api/auth/confirm-otp      → Local DB check (no second ISW call needed)
 * ─────────────────────────────────────────────────────────────────────────────
 */

const express  = require('express');
const bcrypt   = require('bcryptjs');
const { body, validationResult } = require('express-validator');
const { v4: uuidv4 } = require('uuid');
const router   = express.Router();

const { generateTokens, authenticate, authorize } = require('../middleware/auth');
const isw    = require('../services/interswitchService');
const db     = require('../config/database');
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
// POST /api/auth/signup
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
// POST /api/auth/login
// ═══════════════════════════════════════════════════════════════════════════════
router.post(
  '/login',
  [body('email').isEmail().normalizeEmail(), body('password').notEmpty()],
  async (req, res) => {
    if (handleValidationErrors(req, res)) return;
    const { email, password } = req.body;

    try {
      const [user] = await db('users').where({ email }).limit(1);
      // Same message for "not found" and "wrong password" — prevents user enumeration
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
          user: { id: user.id, fullName: user.full_name, email: user.email, role: user.role, ninVerified: user.nin_verified, isVerified: user.is_verified },
        },
      });
    } catch (err) {
      logger.error('[Auth] Login error', { error: err.message });
      res.status(500).json({ success: false, message: 'Login failed' });
    }
  }
);


// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/auth/refresh
// ═══════════════════════════════════════════════════════════════════════════════
router.post('/refresh', async (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken) return res.status(400).json({ success: false, message: 'refreshToken required' });

  try {
    const jwt     = require('jsonwebtoken');
    const decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET, { issuer: 'nextstop', audience: 'nextstop-app' });
    const [user]  = await db('users').where({ id: decoded.sub, refresh_token: refreshToken }).limit(1);
    if (!user) return res.status(401).json({ success: false, message: 'Invalid refresh token' });

    const tokens = generateTokens({ sub: user.id, role: user.role });
    await db('users').where({ id: user.id }).update({ refresh_token: tokens.refreshToken });
    res.json({ success: true, data: tokens });
  } catch {
    res.status(401).json({ success: false, message: 'Refresh token invalid or expired' });
  }
});


// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/auth/verify-nin   (Driver KYC — Marketplace NIN API)
// ═══════════════════════════════════════════════════════════════════════════════
/**
 * ⚠️  Uses MKT credentials (Marketplace). NOT QTB credentials.
 *
 * Flutter sends: { nin: "12345678901" }
 * Server calls:  Marketplace NIN API with MKT Bearer token
 * On success:    users.nin_verified = TRUE
 * Flutter gets:  { success: true }
 */
router.post(
  '/verify-nin',
  authenticate,
  authorize('DRIVER'),
  [body('nin').matches(/^\d{11}$/).withMessage('NIN must be exactly 11 digits')],
  async (req, res) => {
    if (handleValidationErrors(req, res)) return;

    const { nin }  = req.body;
    const userId   = req.user.id;

    // Load fresh user record to check current verification status
    const [user] = await db('users').where({ id: userId }).limit(1);
    if (user?.nin_verified) {
      return res.json({ success: true, message: 'NIN already verified', alreadyVerified: true });
    }

    try {
      const { verified, reason } = await isw.verifyDriverNIN(nin, userId);

      if (!verified) {
        return res.status(422).json({
          success: false,
          message: reason === 'NIN_NOT_FOUND'
            ? 'NIN not found in NIMC database — check the number and try again'
            : 'NIN verification failed — please try again',
        });
      }

      res.json({ success: true, message: 'NIN verified successfully' });
    } catch (err) {
      logger.error('[Auth] NIN error', { error: err.message, userId });
      res.status(500).json({ success: false, message: err.message });
    }
  }
);


// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/auth/verify-licence   (Driver KYC — Marketplace Driver's License API)
// ═══════════════════════════════════════════════════════════════════════════════
/**
 * ⚠️  Uses MKT credentials (Marketplace). NOT QTB credentials.
 * Checks FRSC (Federal Road Safety Corps) database.
 *
 * Flutter sends: { licenseNumber: "ABC123456789" }
 * Server calls:  Marketplace Driver's License API with MKT Bearer token
 * Flutter gets:  { success: true, data: { expiryDate, licenceClass } }
 */
router.post(
  '/verify-licence',
  authenticate,
  authorize('DRIVER'),
  [body('licenseNumber').notEmpty().trim().isLength({ min: 6, max: 20 })],
  async (req, res) => {
    if (handleValidationErrors(req, res)) return;

    const { licenseNumber } = req.body;
    const userId            = req.user.id;

    try {
      const { verified, reason, licenseData } = await isw.verifyDriversLicense(licenseNumber, userId);

      if (!verified) {
        return res.status(422).json({
          success: false,
          message: reason === 'LICENSE_NOT_FOUND'
            ? "Driver's licence not found — check the number and try again"
            : "Driver's licence verification failed",
        });
      }

      res.json({
        success: true,
        message: "Driver's licence verified successfully",
        data: {
          // TODO: Map to actual field names from Marketplace API Success Response tab
          expiryDate:   licenseData?.expiryDate   || null,
          licenceClass: licenseData?.licenceClass  || null,
          issuingState: licenseData?.issuingState  || null,
        },
      });
    } catch (err) {
      logger.error('[Auth] Licence error', { error: err.message, userId });
      res.status(500).json({ success: false, message: err.message });
    }
  }
);


// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/auth/send-otp   (WhatsApp OTP — Marketplace WhatsApp OTP API)
// ═══════════════════════════════════════════════════════════════════════════════
/**
 * ⚠️  Uses MKT credentials (Marketplace). NOT QTB credentials.
 *
 * KEY INSIGHT from Images 4 & 5:
 *   YOU generate the 6-digit OTP code on your server.
 *   You pass it in the request body to ISW.
 *   ISW simply DELIVERS that code to the user's WhatsApp.
 *   The OTP is valid for 5 minutes (per ISW docs, Image 4).
 *
 * This means confirming the OTP (POST /api/auth/confirm-otp) is a pure
 * local DB check — no second ISW call required.
 *
 * Flutter sends: { phoneNumber: "+2348012345678" }
 * Server does:
 *   1. Generates random 6-digit OTP
 *   2. Stores OTP in otp_store with 5-min expiry
 *   3. Calls Marketplace WhatsApp OTP API to deliver the code
 * Flutter gets: { success: true }
 *   Then shows user an OTP input field
 */
router.post(
  '/send-otp',
  authenticate,
  [
    body('phoneNumber')
      .matches(/^\+[1-9]\d{10,14}$/)
      .withMessage('Phone must be E.164 format: +2348012345678'),
  ],
  async (req, res) => {
    if (handleValidationErrors(req, res)) return;

    const { phoneNumber } = req.body;
    const userId          = req.user.id;

    try {
      const { sent } = await isw.sendWhatsAppOTP(phoneNumber, userId);

      if (!sent) {
        return res.status(502).json({ success: false, message: 'OTP delivery failed — try again' });
      }

      res.json({ success: true, message: 'OTP sent to your WhatsApp — valid for 5 minutes' });
    } catch (err) {
      logger.error('[Auth] OTP send error', { error: err.message, userId });
      res.status(500).json({ success: false, message: err.message });
    }
  }
);


// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/auth/confirm-otp   (Local DB check — no ISW call needed)
// ═══════════════════════════════════════════════════════════════════════════════
/**
 * Because WE generated the OTP (and stored it in otp_store), validation
 * is a simple local database comparison — ISW doesn't need to be contacted again.
 *
 * Flutter sends: { code: "123456" }
 * Server does:   Look up otp_store where user_id matches, code matches, not expired
 * On success:    users.is_verified = TRUE, otp row marked used
 * Flutter gets:  { success: true }
 */
router.post(
  '/confirm-otp',
  authenticate,
  [body('code').matches(/^\d{6}$/).withMessage('OTP must be 6 digits')],
  async (req, res) => {
    if (handleValidationErrors(req, res)) return;

    const { code } = req.body;
    const userId   = req.user.id;

    try {
      const [otpRecord] = await db('otp_store')
        .where({ user_id: userId, code, used: false, purpose: 'PHONE_VERIFY' })
        .where('expires_at', '>', new Date())
        .limit(1);

      if (!otpRecord) {
        return res.status(422).json({ success: false, message: 'Invalid or expired OTP' });
      }

      // Mark OTP as used and verify user atomically
      await db.transaction(async trx => {
        await trx('otp_store').where({ id: otpRecord.id }).update({ used: true });
        await trx('users').where({ id: userId }).update({ is_verified: true, updated_at: new Date() });
      });

      res.json({ success: true, message: 'Phone number verified successfully' });
    } catch (err) {
      logger.error('[Auth] OTP confirm error', { error: err.message, userId });
      res.status(500).json({ success: false, message: 'OTP confirmation failed' });
    }
  }
);


// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/auth/verify-bvn   (Placeholder — BVN Full Details API)
// ═══════════════════════════════════════════════════════════════════════════════
/**
 * TODO:
 *   1. Subscribe to "BVN Full Details API" in your NextStop Marketplace project
 *   2. Open API → Endpoints tab → read exact request structure
 *   3. Implement the route body — isw.verifyBVN() is already stubbed
 *   4. Update MKT_BVN_URL in .env if the URL from docs differs
 *
 * ⚠️  Uses MKT credentials (Marketplace). NOT QTB credentials.
 */
router.post(
  '/verify-bvn',
  authenticate,
  authorize('DRIVER'),
  [body('bvn').matches(/^\d{11}$/).withMessage('BVN must be exactly 11 digits')],
  async (req, res) => {
    if (handleValidationErrors(req, res)) return;

    const { bvn }  = req.body;
    const userId   = req.user.id;

    try {
      const { verified, bvnData } = await isw.verifyBVN(bvn, userId);

      if (!verified) {
        return res.status(422).json({ success: false, message: 'BVN verification failed — check number and try again' });
      }

      res.json({
        success: true,
        message: 'BVN verified successfully',
        data: {
          // TODO: Map actual field names from BVN API Success Response tab
          firstName:   bvnData?.firstName   || null,
          lastName:    bvnData?.lastName    || null,
          dateOfBirth: bvnData?.dateOfBirth || null,
        },
      });
    } catch (err) {
      logger.error('[Auth] BVN error', { error: err.message, userId });
      res.status(500).json({ success: false, message: err.message });
    }
  }
);


// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/auth/verify-bank   (Placeholder — Bank Account Verification API)
// ═══════════════════════════════════════════════════════════════════════════════
/**
 * Use case: Verify a driver's payout bank account before first settlement.
 *
 * TODO:
 *   1. Subscribe to "Bank Account Verification API" in NextStop Marketplace project
 *   2. Open API → Endpoints tab → read exact request structure and field names
 *   3. Implement the route body — isw.verifyBankAccount() is already stubbed
 *   4. Update MKT_BANK_VERIFY_URL in .env if the URL differs
 *
 * ⚠️  Uses MKT credentials (Marketplace). NOT QTB credentials.
 */
router.post(
  '/verify-bank',
  authenticate,
  authorize('DRIVER'),
  [
    body('accountNumber').isLength({ min: 10, max: 10 }).withMessage('Account number must be 10 digits'),
    body('bankCode').notEmpty().withMessage('Bank code required'),
  ],
  async (req, res) => {
    if (handleValidationErrors(req, res)) return;

    const { accountNumber, bankCode } = req.body;
    const userId                      = req.user.id;

    try {
      const { verified, accountName } = await isw.verifyBankAccount(accountNumber, bankCode, userId);

      if (!verified) {
        return res.status(422).json({ success: false, message: 'Bank account could not be verified — check details and try again' });
      }

      res.json({
        success: true,
        message: 'Bank account verified',
        data: { accountName },   // show driver the resolved account name for confirmation
      });
    } catch (err) {
      logger.error('[Auth] Bank verify error', { error: err.message, userId });
      res.status(500).json({ success: false, message: err.message });
    }
  }
);


module.exports = router;
