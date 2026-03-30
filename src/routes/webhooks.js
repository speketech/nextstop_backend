'use strict';

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const router  = express.Router();

const isw    = require('../services/interswitchService');
const db     = require('../config/database');
const logger = require('../config/logger');

/**
 * POST /webhooks/interswitch
 * * Handles real-time payment notifications from Interswitch.
 * Note: express.raw() is already handled in server.js for this path.
 */
router.post('/', async (req, res) => {
  const rawBody  = req.body; // Buffer provided by express.raw
  const sigHeader = req.headers['x-interswitch-signature'];

  // ── 1. Validate HMAC Signature ───────────────────────────────────────────
  // Uses QTB_WEBHOOK_SECRET from your Render environment
  const isValidSig = isw.validateWebhookSignature(sigHeader, rawBody);
  
  if (!isValidSig) {
    logger.warn('[Webhook] Invalid Interswitch signature', { sig: sigHeader });
    // Always return 200 to Interswitch to acknowledge receipt and prevent retries
    return res.status(200).json({ received: true, error: 'Invalid Signature' });
  }

  let payload;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch (err) {
    logger.error('[Webhook] Failed to parse JSON payload');
    return res.status(200).json({ received: true, error: 'Parse Failed' });
  }

  const eventId   = payload.eventId || uuidv4();
  const eventType = payload.eventType || 'UNKNOWN';

  // ── 2. Idempotency Check ──────────────────────────────────────────────────
  // Prevents processing the same notification twice
  const [existing] = await db('webhook_events').where({ id: eventId }).limit(1);
  if (existing) {
    logger.info('[Webhook] Duplicate event ignored', { eventId });
    return res.status(200).json({ received: true, duplicate: true });
  }

  // ── 3. Initial Log ───────────────────────────────────────────────────────
  await db('webhook_events').insert({
    id:         eventId,
    source:     'INTERSWITCH',
    event_type: eventType,
    payload:    JSON.stringify(payload),
    signature:  sigHeader,
    processed:  false,
  });

  // ── 4. Process the Event ─────────────────────────────────────────────────
  try {
    if (eventType === 'PAYMENT_SUCCESS' || eventType === 'Transaction.Success') {
      await handlePaymentSuccess(payload, req.app);
    } else if (eventType === 'PAYMENT_REVERSAL') {
      await handlePaymentReversal(payload);
    } else {
      logger.info('[Webhook] Unhandled event type', { eventType });
    }

    await db('webhook_events')
      .where({ id: eventId })
      .update({ processed: true, processed_at: new Date() });

  } catch (err) {
    logger.error('[Webhook] Processing error', { eventId, error: err.message });
    await db('webhook_events')
      .where({ id: eventId })
      .update({ error_message: err.message });
  }

  // Interswitch requires a 200 OK to stop sending the notification
  res.status(200).json({ received: true });
});

// ─── Handlers ────────────────────────────────────────────────────────────────

/**
 * Advances the ride state and notifies the UI when payment is confirmed
 */
async function handlePaymentSuccess(payload, app) {
  const txRef = payload.transactionReference;
  if (!txRef) throw new Error('Missing transactionReference in webhook');

  // Verify server-to-server for final confirmation
  const { verified, transaction } = await isw.verifyTransaction(txRef);

  if (verified) {
    const rideId = transaction.ride_id;
    const payerType = transaction.payer_type;

    // Advance Ride Status if the Initiator pays
    if (payerType === 'INITIATOR') {
      await db('rides')
        .where({ id: rideId, status: 'REQUESTED' })
        .update({ status: 'ACCEPTED', accepted_at: new Date() });
    }

    // Emit Socket event for real-time UI update
    const io = app.get('io');
    if (io) {
      io.to(`ride:${rideId}`).emit('ride:status', { 
        rideId, 
        status: (payerType === 'INITIATOR') ? 'ACCEPTED' : 'JOINER_PAID' 
      });
    }
    
    logger.info('[Webhook] Payment success processed', { txRef, rideId });
  }
}

/**
 * Flags transactions that were reversed by the bank or gateway
 */
async function handlePaymentReversal(payload) {
  const txRef = payload.transactionReference;
  if (!txRef) throw new Error('Missing transactionReference in reversal');

  await db('transactions')
    .where({ tx_ref: txRef })
    .update({ status: 'REVERSED', updated_at: new Date() });

  logger.warn('[Webhook] Transaction REVERSED', { txRef });
}

module.exports = router;