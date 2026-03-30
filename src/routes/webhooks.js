'use strict';

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const router  = express.Router();
const isw    = require('../services/interswitchService');
const db     = require('../config/database');
const logger = require('../config/logger');

/**
 * POST /webhooks/interswitch
 * Handles real-time payment notifications.
 */
router.post('/', async (req, res) => {
  const rawBody  = req.body; // Buffer provided by server.js
  const sigHeader = req.headers['x-interswitch-signature'];

  // 1. Signature check using QTB_WEBHOOK_SECRET
  const isValidSig = isw.validateWebhookSignature(sigHeader, rawBody);
  if (!isValidSig) {
    logger.warn('[Webhook] Invalid Interswitch signature');
    return res.status(200).json({ received: true, error: 'Invalid Signature' });
  }

  let payload;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch (err) {
    return res.status(200).json({ received: true, error: 'Parse Failed' });
  }

  const eventId   = payload.eventId || uuidv4();
  const eventType = payload.eventType || 'UNKNOWN';

  // 2. Idempotency Check
  const [existing] = await db('webhook_events').where({ id: eventId }).limit(1);
  if (existing) return res.status(200).json({ received: true, duplicate: true });

  // 3. Process Success Event
  if (eventType === 'PAYMENT_SUCCESS' || eventType === 'Transaction.Success') {
    const txRef = payload.transactionReference;
    const { verified, transaction } = await isw.verifyTransaction(txRef);
    if (verified && transaction.payer_type === 'INITIATOR') {
      await db('rides').where({ id: transaction.ride_id }).update({ status: 'ACCEPTED', accepted_at: new Date() });
    }
  }

  res.status(200).json({ received: true });
});

module.exports = router;