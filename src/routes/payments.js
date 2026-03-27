'use strict';

const express = require('express');
const { body, param, validationResult } = require('express-validator');
const { v4: uuidv4 } = require('uuid');
const router  = express.Router();

const { authenticate }    = require('../middleware/auth');
const isw                 = require('../services/interswitchService');
const { calculateFareBreakdown } = require('../services/fareService');
const db                  = require('../config/database');
const logger              = require('../config/logger');

// ─── POST /api/payments/initiate ─────────────────────────────────────────────
/**
 * Initiates a payment session for a ride.
 * Flutter calls this → receives a paymentUrl to open in WebView.
 */
router.post(
  '/initiate',
  authenticate,
  [
    body('rideId').isUUID().withMessage('Valid rideId required'),
    body('payerType').isIn(['INITIATOR', 'JOINER']).withMessage('Invalid payerType'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(422).json({ success: false, errors: errors.array() });
    }

    const { rideId, payerType } = req.body;
    const userId = req.user.id;

    try {
      // 1. Load ride & compute fare for this payer
      const [ride] = await db('rides').where({ id: rideId }).limit(1);
      if (!ride) return res.status(404).json({ success: false, message: 'Ride not found' });

      let amountNaira;
      if (payerType === 'INITIATOR') {
        // Count accepted joiners to compute initiator's split
        const joiners = await db('ride_joiners')
          .where({ ride_id: rideId, status: 'ACCEPTED' })
          .count('id as count')
          .first();
        const breakdown = calculateFareBreakdown(Number(ride.base_fare), Number(joiners.count));
        amountNaira = breakdown.initiatorPays;
      } else {
        // Joiner pays the split fare stored on their joiner record
        const [joiner] = await db('ride_joiners')
          .where({ ride_id: rideId, user_id: userId, status: 'ACCEPTED' })
          .limit(1);
        if (!joiner) {
          return res.status(403).json({ success: false, message: 'Joiner record not found or not accepted' });
        }
        amountNaira = Number(joiner.split_fare);
      }

      // 2. Check for existing pending transaction (idempotency)
      const [existingTx] = await db('transactions')
        .where({ ride_id: rideId, payer_id: userId, status: 'PENDING' })
        .orderBy('created_at', 'desc')
        .limit(1);

      if (existingTx) {
        return res.json({
          success: true,
          data: { txRef: existingTx.tx_ref, paymentUrl: existingTx.payment_url, amountNaira },
        });
      }

      // 3. Fetch driver's sub-account for split settlement (Avoid NGN 0 issue)
      const [driver] = await db('drivers')
        .where({ id: ride.driver_id })
        .select('sub_account_code')
        .limit(1);

      const splits = [];
      if (driver && driver.sub_account_code) {
        splits.push({
          subAccountCode: driver.sub_account_code,
          splitPercentage: 85.0 // Driver gets 85% cut automatically
        });
      }

      // 4. Initiate with Interswitch
      const user = await db('users').where({ id: userId }).first();
      const { txRef, paymentUrl } = await isw.initiatePayment({
        rideId,
        payerId:       userId,
        payerType,
        amountNaira,
        customerEmail: user.email,
        customerName:  user.full_name,
        splits
      });

      // 4. Store payment URL for reference
      await db('transactions').where({ tx_ref: txRef }).update({ payment_url: paymentUrl });

      res.json({ success: true, data: { txRef, paymentUrl, amountNaira } });
    } catch (err) {
      logger.error('[Payment] Initiate failed', { error: err.message, userId, rideId });
      res.status(500).json({ success: false, message: 'Payment initiation failed' });
    }
  }
);

// ─── POST /api/payments/verify ───────────────────────────────────────────────
/**
 * Called by Flutter after returning from Webpay redirect.
 * NEVER trust Flutter's success status — always re-verify server-side.
 */
router.post(
  '/verify',
  authenticate,
  [body('txRef').notEmpty().withMessage('txRef required')],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(422).json({ success: false, errors: errors.array() });
    }

    const { txRef } = req.body;

    try {
      const { verified, transaction } = await isw.verifyTransaction(txRef);

      res.json({
        success: true,
        data: {
          verified,
          status: transaction.status,
          amountNaira: transaction.amount_naira,
          rideId: transaction.ride_id,
        },
      });
    } catch (err) {
      logger.error('[Payment] Verify failed', { error: err.message, txRef });
      res.status(500).json({ success: false, message: 'Payment verification failed' });
    }
  }
);

module.exports = router;
