'use strict';

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const router  = express.Router();

const isw    = require('../services/interswitchService');
const db     = require('../config/database');
const logger = require('../config/logger');

/**
 * POST /webhooks/interswitch
 *
 * Handles asynchronous payment notifications from Interswitch.
 * Uses raw body (registered via express.raw) for accurate HMAC validation.
 *
 * Event types handled:
 *  - PAYMENT_SUCCESS
 *  - PAYMENT_REVERSAL
 */
router.post('/', express.raw({ type: 'application/json' }), async (req, res) => {
  const rawBody  = req.body; // Buffer — needed for HMAC
  const sigHeader = req.headers['x-interswitch-signature'];

  // ── 1. Validate HMAC Signature ───────────────────────────────────────────
  const isValidSig = isw.validateWebhookSignature(rawBody, sigHeader);
  if (!isValidSig) {
    logger.warn('[Webhook] Invalid Interswitch signature', { sig: sigHeader });
    // Return 200 to prevent ISW from retrying — log for investigation
    return res.status(200).json({ received: true });
  }

  let payload;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch {
    logger.error('[Webhook] Failed to parse payload');
    return res.status(400).json({ success: false });
  }

  const eventId   = payload.eventId || uuidv4();
  const eventType = payload.eventType || 'UNKNOWN';

  // ── 2. Idempotency — deduplicate re-delivered events ────────────────────
  const [existing] = await db('webhook_events')
    .where({ id: eventId })
    .limit(1);

  if (existing) {
    logger.info('[Webhook] Duplicate event ignored', { eventId });
    return res.status(200).json({ received: true, duplicate: true });
  }

  // ── 3. Persist event log BEFORE processing ───────────────────────────────
  await db('webhook_events').insert({
    id:         eventId,
    source:     'INTERSWITCH',
    event_type: eventType,
    payload:    JSON.stringify(payload),
    signature:  sigHeader,
    processed:  false,
  });

  // ── 4. Process based on event type ───────────────────────────────────────
  try {
    if (eventType === 'PAYMENT_SUCCESS') {
      await handlePaymentSuccess(payload);
    } else if (eventType === 'PAYMENT_REVERSAL') {
      await handlePaymentReversal(payload);
    } else {
      logger.info('[Webhook] Unhandled event type', { eventType });
    }

    // Mark as processed
    await db('webhook_events')
      .where({ id: eventId })
      .update({ processed: true, processed_at: new Date() });

  } catch (err) {
    logger.error('[Webhook] Processing error', { eventId, error: err.message });
    await db('webhook_events')
      .where({ id: eventId })
      .update({ error_message: err.message });
    // Still return 200 — we've logged it; ISW should not retry
  }

  // ISW expects a 200 acknowledgment immediately
  res.status(200).json({ received: true });
});

// ─── Handlers ────────────────────────────────────────────────────────────────

async function handlePaymentSuccess(payload) {
  const txRef = payload.transactionReference;
  if (!txRef) throw new Error('Missing transactionReference in webhook payload');

  // Re-verify server-to-server (belt AND suspenders)
  const { verified, transaction } = await isw.verifyTransaction(txRef);

  if (verified) {
    logger.info('[Webhook] Payment success confirmed', {
      txRef,
      rideId: transaction.ride_id,
      amount: transaction.amount_naira,
    });
    // Additional post-payment logic: send push notification to driver, etc.
  }
}

async function handlePaymentReversal(payload) {
  const txRef = payload.transactionReference;
  if (!txRef) throw new Error('Missing transactionReference in reversal payload');

  await db('transactions')
    .where({ tx_ref: txRef })
    .update({ status: 'REVERSED', updated_at: new Date() });

  // Fetch the transaction to get the ride
  const [tx] = await db('transactions').where({ tx_ref: txRef }).limit(1);

  if (tx) {
    logger.warn('[Webhook] Payment reversed — flagging ride', {
      txRef,
      rideId: tx.ride_id,
    });
    // Could trigger ride cancellation or driver notification here
  }
}

module.exports = router;
