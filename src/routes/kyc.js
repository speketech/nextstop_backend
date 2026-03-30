'use strict';

const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const { authenticate, authorize } = require('../middleware/auth');
const isw = require('../services/interswitchService');
const db = require('../config/database');
const logger = require('../config/logger');
const { v4: uuidv4 } = require('uuid');

// ── Validation Error Handler ──────────────────────────────────────────────────
function handleValidationErrors(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(422).json({ success: false, errors: errors.array() });
    return true;
  }
  return false;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1. PHONE & OTP VERIFICATION (Safetoken & WhatsApp)
// ═══════════════════════════════════════════════════════════════════════════════

/** POST /api/kyc/otp/send */
router.post('/otp/send', authenticate, async (req, res) => {
  try {
    const { phone, method = 'SMS' } = req.body;
    let result;

    if (method === 'WHATSAPP') {
      const code = Math.floor(100000 + Math.random() * 900000).toString();
      result = await isw.sendWhatsAppOTP(phone, code);
      if (result.success) {
        await db('otp_store').insert({
          id: uuidv4(), user_id: req.user.id, code,
          expires_at: new Date(Date.now() + 5 * 60000)
        });
      }
    } else {
      // Default Interswitch Safetoken
      result = await isw.sendSafetoken(req.user.id, req.user.email, phone);
    }

    res.json({ success: result.success || result.sent, message: 'OTP sent' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'OTP failed' });
  }
});

/** POST /api/kyc/otp/verify */
router.post('/otp/verify', authenticate, async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ success: false, message: 'Code required' });

  // Magic Bypass for testing
  if (process.env.NODE_ENV !== 'production' && code === '123456') {
    await db('users').where({ id: req.user.id }).update({ is_verified: true });
    return res.json({ success: true, message: 'Magic OTP accepted' });
  }

  // Check DB for WhatsApp/Internal OTP first
  const [otpRecord] = await db('otp_store')
    .where({ user_id: req.user.id, code, used: 0 })
    .andWhere('expires_at', '>', new Date()).limit(1);

  if (otpRecord) {
    await db('otp_store').where({ id: otpRecord.id }).update({ used: 1 });
    await db('users').where({ id: req.user.id }).update({ is_verified: true });
    return res.json({ success: true, message: 'OTP Verified' });
  }

  // Fallback to Interswitch Safetoken verification
  const result = await isw.verifySafetoken(req.user.id, code);
  if (result.success) {
    await db('users').where({ id: req.user.id }).update({ is_verified: true });
    res.json({ success: true, message: 'Phone verified' });
  } else {
    res.status(400).json({ success: false, message: 'Invalid OTP' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. DOCUMENT VERIFICATION (NIN, DL, BVN)
// ═══════════════════════════════════════════════════════════════════════════════

/** POST /api/kyc/verify-nin */
router.post('/verify-nin', authenticate, async (req, res) => {
  const { nin } = req.body;
  try {
    const result = await isw.verifyNIN(nin, req.user.id);
    if (result.verified) {
      await db('users').where({ id: req.user.id }).update({ nin, nin_verified: true });
      res.json({ success: true, message: 'NIN Verified' });
    } else {
      res.status(400).json({ success: false, message: 'NIN Failed' });
    }
  } catch (err) { res.status(500).json({ success: false, message: 'Service error' }); }
});

/** POST /api/kyc/verify-licence */
router.post('/verify-licence', authenticate, authorize('DRIVER'), async (req, res) => {
  const { licenseNumber } = req.body;
  try {
    const result = await isw.verifyDriversLicense(licenseNumber, req.user.id);
    if (result.verified) {
      await db('drivers').where({ user_id: req.user.id }).update({ approval_status: 'APPROVED' });
      res.json({ success: true, message: 'License Verified' });
    } else {
      res.status(400).json({ success: false, message: 'Invalid License' });
    }
  } catch (err) { res.status(500).json({ success: false, message: 'Service error' }); }
});

/** POST /api/kyc/verify-bvn */
router.post('/verify-bvn', authenticate, authorize('DRIVER'), async (req, res) => {
  const { bvn } = req.body;
  const result = await isw.verifyBVN(bvn, req.user.id);
  res.json({ success: result.verified, data: result.bvnData });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. BANKING & ADDRESS
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/bank-list', authenticate, async (req, res) => {
  const result = await isw.getBankList();
  res.json(result);
});

router.post('/verify-bank', authenticate, authorize('DRIVER'), async (req, res) => {
  const { accountNumber, bankCode } = req.body;
  const result = await isw.verifyBankAccount(accountNumber, bankCode, req.user.id);
  if (result.success || result.verified) {
    // Logic for sub-account creation can be added here as seen in auth.js
    res.json({ success: true, data: result.data || result.accountName });
  } else {
    res.status(400).json({ success: false, message: 'Bank verification failed' });
  }
});

module.exports = router;