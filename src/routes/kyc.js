const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const { authenticate, authorize } = require('../middleware/auth');
const isw = require('../services/interswitchService');
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

// 1. Trigger WhatsApp OTP
router.post(
  '/send-otp',
  authenticate,
  [
    body('phone').matches(/^\+?[0-9]{10,15}$/).withMessage('Valid phone required'),
  ],
  async (req, res) => {
    if (handleValidationErrors(req, res)) return;
    try {
      const { phone } = req.body;
      const result = await isw.sendWhatsAppOTP(phone, req.user.id);
      res.json({ success: result.sent, message: 'OTP sent via WhatsApp' });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  }
);

// 2. Verify the OTP entered by the user
router.post(
  '/verify-otp',
  authenticate,
  [
    body('code').matches(/^\d{6}$/).withMessage('OTP must be 6 digits'),
  ],
  async (req, res) => {
    if (handleValidationErrors(req, res)) return;
    try {
      const { code } = req.body;
      // Find unexpired, unused OTP in our database
      const [otpRecord] = await db('otp_store')
        .where({ user_id: req.user.id, code: code, used: 0 })
        .andWhere('expires_at', '>', new Date())
        .limit(1);

      if (!otpRecord) {
        return res.status(400).json({ success: false, message: 'Invalid or expired OTP' });
      }

      // Mark as used and update user verification status
      await db('otp_store').where({ id: otpRecord.id }).update({ used: 1 });
      await db('users').where({ id: req.user.id }).update({ is_verified: 1 });

      res.json({ success: true, message: 'Phone verified successfully' });
    } catch (error) {
      res.status(500).json({ success: false, message: 'Verification failed' });
    }
  }
);

// 3. Verify NIN securely via Interswitch
router.post(
  '/verify-nin',
  authenticate,
  [
    body('nin').matches(/^\d{11}$/).withMessage('NIN must be exactly 11 digits'),
  ],
  async (req, res) => {
    if (handleValidationErrors(req, res)) return;
    try {
      const { nin } = req.body;
      const result = await isw.verifyDriverNIN(nin, req.user.id);
      
      if (result.verified) {
        res.json({ success: true, message: 'NIN Verified! "Verified" badge unlocked.' });
      } else {
        res.status(400).json({ success: false, message: 'NIN Verification failed' });
      }
    } catch (error) {
      res.status(500).json({ success: false, message: 'Service unavailable' });
    }
  }
);

// 4. Verify Driver's Licence
router.post(
  '/verify-licence',
  authenticate,
  authorize('DRIVER'),
  [body('licenseNumber').notEmpty().trim().isLength({ min: 6, max: 20 })],
  async (req, res) => {
    if (handleValidationErrors(req, res)) return;
    const { licenseNumber } = req.body;
    try {
      const { verified, reason, licenseData } = await isw.verifyDriversLicense(licenseNumber, req.user.id);
      if (!verified) {
        return res.status(422).json({
          success: false,
          message: reason === 'LICENSE_NOT_FOUND' ? "Driver's licence not found" : "Verification failed",
        });
      }
      res.json({ success: true, data: licenseData });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  }
);

// 5. Verify BVN
router.post(
  '/verify-bvn',
  authenticate,
  authorize('DRIVER'),
  [body('bvn').matches(/^\d{11}$/).withMessage('BVN must be 11 digits')],
  async (req, res) => {
    if (handleValidationErrors(req, res)) return;
    const { bvn } = req.body;
    try {
      const { verified, bvnData } = await isw.verifyBVN(bvn, req.user.id);
      if (!verified) return res.status(422).json({ success: false, message: 'BVN verification failed' });
      res.json({ success: true, data: bvnData });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  }
);

// 6. Verify Bank Account
router.post(
  '/verify-bank',
  authenticate,
  authorize('DRIVER'),
  [
    body('accountNumber').isLength({ min: 10, max: 10 }),
    body('bankCode').notEmpty(),
  ],
  async (req, res) => {
    if (handleValidationErrors(req, res)) return;
    const { accountNumber, bankCode } = req.body;
    try {
      const { verified, accountName } = await isw.verifyBankAccount(accountNumber, bankCode, req.user.id);
      if (!verified) return res.status(422).json({ success: false, message: 'Bank verify failed' });
      res.json({ success: true, data: { accountName } });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  }
);

module.exports = router;
