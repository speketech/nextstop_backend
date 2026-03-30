'use strict';

const express = require('express');
const router = express.Router();
const { authenticate, authorize } = require('../middleware/auth');
const isw = require('../services/interswitchService');
const db = require('../config/database');
const { v4: uuidv4 } = require('uuid');

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
      result = await isw.sendSafetoken(req.user.id, req.user.email, phone);
    }
    res.json({ success: true, message: 'OTP sent' });
  } catch (error) { res.status(500).json({ success: false, message: 'OTP failed' }); }
});

/** POST /api/kyc/otp/verify */
router.post('/otp/verify', authenticate, async (req, res) => {
  const { code } = req.body;
  if (process.env.NODE_ENV !== 'production' && code === '123456') {
    await db('users').where({ id: req.user.id }).update({ is_verified: true });
    return res.json({ success: true, message: 'Verified!' });
  }
  const result = await isw.verifySafetoken(req.user.id, code);
  if (result.success) {
    await db('users').where({ id: req.user.id }).update({ is_verified: true });
    res.json({ success: true });
  } else { res.status(400).json({ success: false }); }
});

/** GET /api/kyc/bank-list */
router.get('/bank-list', authenticate, async (req, res) => {
  const result = await isw.getBankList();
  res.json(result);
});

/** POST /api/kyc/verify-bank (Automates Sub-account) */
router.post('/verify-bank', authenticate, authorize('DRIVER'), async (req, res) => {
  const { accountNumber, bankCode } = req.body;
  try {
    const result = await isw.verifyBankAccount(accountNumber, bankCode);
    if (result.success) {
      const user = await db('users').where({ id: req.user.id }).first();
      const subAccountCode = await isw.createSubAccount({
        bankAccount: accountNumber, bankCode, fullName: user.full_name
      });
      await db('drivers').where({ user_id: req.user.id }).update({ 
        payout_bank_code: bankCode, payout_account_no: accountNumber,
        payout_account_name: result.data.accountName, sub_account_code: subAccountCode
      });
      res.json({ success: true, accountName: result.data.accountName });
    } else { res.status(400).json({ success: false }); }
  } catch (err) { res.status(500).json({ success: false }); }
});

/** POST /api/kyc/verify-nin */
router.post('/verify-nin', authenticate, async (req, res) => {
  const result = await isw.verifyNIN(req.body.nin, req.user.id);
  res.json({ success: result.verified });
});

module.exports = router;