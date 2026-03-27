'use strict';

/**
 * NextStop — Auth Routes  (v2 — docs-accurate)
 * ─────────────────────────────────────────────────────────────────────────────
 * Public endpoints:
 *   POST /api/auth/signup
 *   POST /api/auth/login
 *   POST /api/auth/refresh
 * ─────────────────────────────────────────────────────────────────────────────
 */

const express  = require('express');
const bcrypt   = require('bcryptjs');
const { body, validationResult } = require('express-validator');
const { v4: uuidv4 } = require('uuid');
const jwt = require('jsonwebtoken');
const router   = express.Router();

const { generateTokens, authenticate } = require('../middleware/auth');
const db     = require('../config/database');
const logger = require('../config/logger');
const isw    = require('../services/interswitchService');

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


// ─── Token Refresh Route ──────────────────────────────────────────────────────
router.post('/refresh', async (req, res) => {
  const { refreshToken } = req.body;

  if (!refreshToken) {
    return res.status(401).json({ success: false, message: 'Refresh token required' });
  }

  try {
    // 1. Verify the refresh token
    const decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET, {
      issuer: 'nextstop',
      audience: 'nextstop-app',
    });

    // 2. Check if user still exists/is active
    const [user] = await db('users').where({ id: decoded.sub, is_active: 1 }).limit(1);
    if (!user) {
      return res.status(401).json({ success: false, message: 'User account inactive' });
    }

    // 3. Generate a fresh pair of tokens
    const payload = { sub: user.id, role: user.role };
    const tokens = generateTokens(payload);

    // Rotate the refresh token in DB for token family security
    await db('users').where({ id: user.id }).update({ refresh_token: tokens.refreshToken });

    res.json({ success: true, data: tokens });
  } catch (err) {
    return res.status(401).json({ success: false, message: 'Invalid refresh token. Please log in again.' });
  }
});


// ═══════════════════════════════════════════════════════════════════════════════
// KYC VERIFICATION ROUTES (Docs-Accurate)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * POST /api/auth/verify-nin
 * Verifies National Identity Number
 */
router.post('/verify-nin', authenticate, async (req, res) => {
  try {
    const { nin } = req.body;
    if (!nin) {
      return res.status(400).json({ success: false, message: 'NIN is required' });
    }

    const result = await isw.verifyNIN(nin);
    
    if (result.verified) {
      // Save verification status to users table
      await db('users')
        .where({ id: req.user.id })
        .update({ 
          nin: nin,
          nin_verified: true,
          updated_at: new Date()
        });
      
      res.json({ success: true, message: 'NIN Verified' });
    } else {
      res.status(400).json({ success: false, message: result.reason || 'Invalid NIN' });
    }
  } catch (error) {
    logger.error('[Auth] NIN verification error', { error: error.message, userId: req.user.id });
    res.status(500).json({ success: false, message: 'Server error during NIN verification' });
  }
});

/**
 * POST /api/auth/verify-dl
 * Verifies Driver's License
 */
router.post('/verify-dl', authenticate, async (req, res) => {
  try {
    const { licenseNumber } = req.body;
    if (!licenseNumber) {
      return res.status(400).json({ success: false, message: 'License number is required' });
    }

    const result = await isw.verifyDriversLicense(licenseNumber);
    
    if (result.verified) {
      // Update the drivers table based on schema (approval_status)
      await db('drivers')
        .where({ user_id: req.user.id })
        .update({ 
          approval_status: 'APPROVED',
          updated_at: new Date()
        });
      
      res.json({ success: true, message: 'Driver License Verified and Account Approved!' });
    } else {
      res.status(400).json({ success: false, message: result.message || 'Invalid License' });
    }
  } catch (error) {
    logger.error('[Auth] DL verification error', { error: error.message, userId: req.user.id });
    res.status(500).json({ success: false, message: 'Server error during DL verification' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// OTP VERIFICATION ROUTES (Safetoken)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * POST /api/auth/send-otp
 * Triggers Safetoken OTP delivery
 */
router.post('/send-otp', authenticate, async (req, res) => {
  try {
    const { email, phone } = req.body;
    
    // Calls Interswitch to generate and text/email the user
    // tokenId is the user's ID for statless verification
    const result = await isw.sendSafetoken(req.user.id, email, phone);
    
    if (result.success) {
      res.json({ success: true, message: 'OTP sent successfully' });
    } else {
      res.status(400).json({ success: false, message: result.message });
    }
  } catch (error) {
    logger.error('[Auth] send-otp error', { error: error.message, userId: req.user.id });
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

/**
 * POST /api/auth/verify-otp
 * Validates OTP with Magic OTP bypass for testing
 */
router.post('/verify-otp', authenticate, async (req, res) => {
  try {
    const { code } = req.body; 
    
    if (!code) {
      return res.status(400).json({ success: false, message: 'OTP code is required' });
    }

    // 🛑 THE MAGIC OTP BYPASS (Only works if NOT in live production)
    if (process.env.NODE_ENV !== 'production' && code === '123456') {
      await db('users').where({ id: req.user.id }).update({ is_verified: true, updated_at: new Date() });
      return res.json({ success: true, message: 'Magic OTP accepted! Phone verified.' });
    }

    // 🟢 The Real Interswitch Flow
    const result = await isw.verifySafetoken(req.user.id, code);

    if (result.success) {
      await db('users')
        .where({ id: req.user.id })
        .update({ is_verified: true, updated_at: new Date() });

      res.json({ success: true, message: 'Phone verified successfully!' });
    } else {
      res.status(400).json({ success: false, message: result.message || 'Invalid or expired OTP' });
    }
  } catch (error) {
    logger.error('[Auth] verify-otp error', { error: error.message, userId: req.user.id });
    res.status(500).json({ success: false, message: 'Verification failed' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// BANK ACCOUNT VERIFICATION ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/auth/bank-list
 * Flutter uses this to populate a Dropdown menu of Nigerian banks
 */
router.get('/bank-list', authenticate, async (req, res) => {
  try {
    const result = await isw.getBankList();
    if (result.success) {
      res.json({ success: true, data: result.data });
    } else {
      res.status(500).json({ success: false, message: result.message });
    }
  } catch (error) {
    logger.error('[Auth] bank-list error', { error: error.message });
    res.status(500).json({ success: false, message: 'Server error fetching banks' });
  }
});

/**
 * POST /api/auth/verify-bank
 * Verify Bank Account & Save to Driver Profile
 */
router.post('/verify-bank', authenticate, async (req, res) => {
  try {
    const { accountNumber, bankCode } = req.body;
    
    if (!accountNumber || !bankCode) {
      return res.status(400).json({ success: false, message: 'Account number and bank code required' });
    }

    // Sandbox test trap: Use accountNumber "1000000000" and bankCode "058"
    const result = await isw.verifyBankAccount(accountNumber, bankCode);

    if (result.success) {
      // 🚀 AUTOMATION: Onboard driver as a sub-account for split settlements
      const user = await db('users').where({ id: req.user.id }).first();
      
      let subAccountCode = null;
      try {
        subAccountCode = await isw.createSubAccount({
          bankAccount: accountNumber,
          bankCode,
          fullName: user.full_name
        });
      } catch (onboardingErr) {
        logger.error('[Auth] Sub-account onboarding failed', { userId: req.user.id, error: onboardingErr.message });
        // We continue anyway, but the driver won't get automated splits until fixed manually
      }

      // Update the drivers table with bank details and sub-account code
      await db('drivers')
        .where({ user_id: req.user.id })
        .update({ 
          payout_bank_code: bankCode,
          payout_account_no: accountNumber,
          payout_account_name: result.data.accountName,
          sub_account_code: subAccountCode,
          updated_at: new Date()
        });

      res.json({ 
        success: true, 
        message: 'Bank account verified ' + (subAccountCode ? 'and payout sub-account created' : 'but sub-account creation failed'),
        accountName: result.data.accountName,
        subAccountCode: subAccountCode 
      });
    } else {
      res.status(400).json({ success: false, message: result.message });
    }
  } catch (error) {
    logger.error('[Auth] verify-bank error', { error: error.message, userId: req.user.id });
    res.status(500).json({ success: false, message: 'Server error during bank verification' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// PHYSICAL ADDRESS VERIFICATION ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * POST /api/auth/verify-address/submit
 * Submit Address for Verification (with Magic Bypass)
 */
router.post('/verify-address/submit', authenticate, async (req, res) => {
  try {
    const addressData = req.body; 

    // 🛑 THE MAGIC BYPASS FOR LOCAL TESTING
    if (process.env.NODE_ENV !== 'production' && addressData.street === 'Magic Street') {
      // Instantly approve them in the database for testing purposes
      await db('drivers')
        .where({ user_id: req.user.id })
        .update({ 
          address_verification_ref: 'MAGIC_REF_123',
          updated_at: new Date()
        });

      return res.json({ 
        success: true, 
        message: 'Magic Address bypassed and verified!',
        reference: 'MAGIC_REF_123'
      });
    }

    // The Real Interswitch Flow
    const result = await isw.submitAddressVerification(addressData);

    if (result.success) {
      // Save the reference ID to the driver's profile
      await db('drivers')
        .where({ user_id: req.user.id })
        .update({ 
          address_verification_ref: result.reference,
          updated_at: new Date()
        });

      res.json({ 
        success: true, 
        message: 'Address submitted for verification',
        reference: result.reference
      });
    } else {
      res.status(400).json({ success: false, message: result.message });
    }
  } catch (error) {
    logger.error('[Auth] address-submit error', { error: error.message, userId: req.user.id });
    res.status(500).json({ success: false, message: 'Server error during address submission' });
  }
});

/**
 * GET /api/auth/verify-address/status
 * Check Address Verification Status
 */
router.get('/verify-address/status', authenticate, async (req, res) => {
  try {
    const { reference } = req.query; 
    
    if (!reference) {
       return res.status(400).json({ success: false, message: 'Reference ID is required' });
    }

    const result = await isw.checkAddressStatus(reference);

    if (result.success) {
      res.json({ success: true, data: result.data });
      // Logic for updating DB on 'Verified' status can go here
    } else {
      res.status(400).json({ success: false, message: result.message });
    }
  } catch (error) {
    logger.error('[Auth] address-status error', { error: error.message, userId: req.user.id });
    res.status(500).json({ success: false, message: 'Server error checking address status' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// WHATSAPP OTP ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * POST /api/auth/send-whatsapp-otp
 * Trigger WhatsApp OTP delivery and store code in DB
 */
router.post('/send-whatsapp-otp', authenticate, async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) {
      return res.status(400).json({ success: false, message: 'Phone number required' });
    }
    
    // Generate a random 6-digit code
    const generatedCode = Math.floor(100000 + Math.random() * 900000).toString();

    const result = await isw.sendWhatsAppOTP(phone, generatedCode);
    
    if (result.success) {
      // Save code to database with a 5-minute expiry
      await db('otp_store').insert({
        id: uuidv4(),
        user_id: req.user.id,
        purpose: 'PHONE_VERIFY',
        code: generatedCode,
        expires_at: new Date(Date.now() + 5 * 60000) 
      });

      res.json({ success: true, message: 'OTP sent to WhatsApp' });
    } else {
      res.status(400).json({ success: false, message: result.message });
    }
  } catch (error) {
    logger.error('[Auth] whatsapp-otp error', { error: error.message, userId: req.user.id });
    res.status(500).json({ success: false, message: 'Server error sending WhatsApp OTP' });
  }
});


module.exports = router;
