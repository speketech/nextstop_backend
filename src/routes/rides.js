'use strict';

const express = require('express');
const { body, param, validationResult } = require('express-validator');
const { v4: uuidv4 } = require('uuid');
const router  = express.Router();

const { authenticate, authorize } = require('../middleware/auth');
const { calculateFareBreakdown, estimateFare } = require('../services/fareService');
const db     = require('../config/database');
const logger = require('../config/logger');

// ─── State machine: valid transitions ────────────────────────────────────────
const VALID_TRANSITIONS = {
  REQUESTED:   ['NEGOTIATING', 'ACCEPTED', 'CANCELLED'],
  NEGOTIATING: ['ACCEPTED', 'CANCELLED'],
  ACCEPTED:    ['ARRIVED', 'CANCELLED'],
  ARRIVED:     ['IN_PROGRESS'],
  IN_PROGRESS: ['COMPLETED'],
};

function canTransition(current, next) {
  return VALID_TRANSITIONS[current]?.includes(next) ?? false;
}

// ─── POST /api/rides ──────────────────────────────────────────────────────────
/** Create a new ride (Initiator) */
router.post(
  '/',
  authenticate,
  authorize('PASSENGER'),
  [
    body('pickupAddress').notEmpty(),
    body('pickupLat').isFloat({ min: -90, max: 90 }),
    body('pickupLng').isFloat({ min: -180, max: 180 }),
    body('dropoffAddress').notEmpty(),
    body('dropoffLat').isFloat({ min: -90, max: 90 }),
    body('dropoffLng').isFloat({ min: -180, max: 180 }),
    body('rideType').isIn(['SOLO', 'RIDESHARE']),
    body('maxJoiners').optional().isInt({ min: 0, max: 3 }),
    body('womenOnly').optional().isBoolean(),
    body('baseFare').isFloat({ min: 500 }).withMessage('Minimum fare is ₦500'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(422).json({ success: false, errors: errors.array() });
    }

    const {
      pickupAddress, pickupLat, pickupLng,
      dropoffAddress, dropoffLat, dropoffLng,
      rideType, maxJoiners = 0, womenOnly = false, baseFare,
    } = req.body;

    const rideId = uuidv4();

    try {
      await db('rides').insert({
        id:              rideId,
        initiator_id:    req.user.id,
        pickup_address:  pickupAddress,
        pickup_lat:      pickupLat,
        pickup_lng:      pickupLng,
        dropoff_address: dropoffAddress,
        dropoff_lat:     dropoffLat,
        dropoff_lng:     dropoffLng,
        ride_type:       rideType,
        max_joiners:     rideType === 'RIDESHARE' ? maxJoiners : 0,
        women_only:      womenOnly,
        base_fare:       baseFare,
        status:          'REQUESTED',
      });

      // Pre-compute fare breakdown for response
      const breakdown = calculateFareBreakdown(baseFare, 0);

      res.status(201).json({
        success: true,
        data: { rideId, status: 'REQUESTED', fareBreakdown: breakdown },
      });
    } catch (err) {
      logger.error('[Rides] Create failed', { error: err.message });
      res.status(500).json({ success: false, message: 'Failed to create ride' });
    }
  }
);

// ─── GET /api/rides/available ─────────────────────────────────────────────────
/** Joiner discovers available RIDESHARE rides near them */
router.get('/available', authenticate, authorize('PASSENGER'), async (req, res) => {
  const { lat, lng, radius = 5 } = req.query; // radius in km

  try {
    // Haversine approximation via MySQL
    const rides = await db.raw(`
      SELECT
        r.id, r.pickup_address, r.dropoff_address,
        r.pickup_lat, r.pickup_lng,
        r.base_fare, r.max_joiners, r.women_only,
        r.status, r.created_at,
        u.full_name AS initiator_name, u.job_title, u.company, u.avatar_url,
        (
          SELECT COUNT(*) FROM ride_joiners rj
          WHERE rj.ride_id = r.id AND rj.status = 'ACCEPTED'
        ) AS current_joiners,
        (6371 * ACOS(
          COS(RADIANS(?)) * COS(RADIANS(r.pickup_lat)) *
          COS(RADIANS(r.pickup_lng) - RADIANS(?)) +
          SIN(RADIANS(?)) * SIN(RADIANS(r.pickup_lat))
        )) AS distance_km
      FROM rides r
      JOIN users u ON u.id = r.initiator_id
      WHERE r.ride_type = 'RIDESHARE'
        AND r.status IN ('REQUESTED', 'NEGOTIATING')
        AND (? = 0 OR r.women_only = FALSE OR r.women_only = ?)
      HAVING distance_km < ?
      ORDER BY distance_km ASC
      LIMIT 20
    `, [lat, lng, lat, 0, req.user.women_only_pref ? 1 : 0, Number(radius)]);

    res.json({ success: true, data: rides[0] });
  } catch (err) {
    logger.error('[Rides] Available query failed', { error: err.message });
    res.status(500).json({ success: false, message: 'Failed to fetch rides' });
  }
});

// ─── GET /api/rides/:rideId ───────────────────────────────────────────────────
router.get('/:rideId', authenticate, async (req, res) => {
  try {
    const [ride] = await db('rides AS r')
      .join('users AS u', 'u.id', 'r.initiator_id')
      .leftJoin('drivers AS d', 'd.id', 'r.driver_id')
      .leftJoin('users AS du', 'du.id', 'd.user_id')
      .leftJoin('vehicles AS v', 'v.id', 'r.vehicle_id')
      .select(
        'r.*',
        'u.full_name AS initiator_name', 'u.job_title', 'u.company', 'u.avatar_url',
        'du.full_name AS driver_name', 'du.avatar_url AS driver_avatar',
        'v.make', 'v.model', 'v.license_plate', 'v.color', 'v.seat_capacity'
      )
      .where('r.id', req.params.rideId)
      .limit(1);

    if (!ride) return res.status(404).json({ success: false, message: 'Ride not found' });

    // Load joiners
    const joiners = await db('ride_joiners AS rj')
      .join('users AS u', 'u.id', 'rj.user_id')
      .select('rj.*', 'u.full_name', 'u.job_title', 'u.company', 'u.avatar_url')
      .where('rj.ride_id', ride.id);

    res.json({ success: true, data: { ...ride, joiners } });
  } catch (err) {
    logger.error('[Rides] Get failed', { error: err.message });
    res.status(500).json({ success: false, message: 'Failed to fetch ride' });
  }
});

// ─── PATCH /api/rides/:rideId/status ─────────────────────────────────────────
/** Updates ride status — enforces the state machine */
router.patch(
  '/:rideId/status',
  authenticate,
  [body('status').isIn(['ACCEPTED', 'ARRIVED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'])],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(422).json({ success: false, errors: errors.array() });
    }

    const { rideId } = req.params;
    const { status: newStatus, cancelReason } = req.body;

    try {
      const [ride] = await db('rides').where({ id: rideId }).limit(1);
      if (!ride) return res.status(404).json({ success: false, message: 'Ride not found' });

      if (!canTransition(ride.status, newStatus)) {
        return res.status(409).json({
          success: false,
          message: `Cannot transition from ${ride.status} to ${newStatus}`,
        });
      }

      const now = new Date();
      const updatePayload = { status: newStatus, updated_at: now };

      // Set timing fields
      if (newStatus === 'ACCEPTED')    updatePayload.accepted_at   = now;
      if (newStatus === 'ARRIVED')     updatePayload.arrived_at    = now;
      if (newStatus === 'IN_PROGRESS') updatePayload.started_at    = now;
      if (newStatus === 'COMPLETED')   updatePayload.completed_at  = now;
      if (newStatus === 'CANCELLED') {
        updatePayload.cancelled_by  = req.user.role === 'DRIVER' ? 'DRIVER' : 'INITIATOR';
        updatePayload.cancel_reason = cancelReason || null;
      }

      await db('rides').where({ id: rideId }).update(updatePayload);

      // Emit via Socket.io (injected via req.app.get('io'))
      const io = req.app.get('io');
      if (io) {
        io.to(`ride:${rideId}`).emit('ride:status', { rideId, status: newStatus });
      }

      res.json({ success: true, data: { rideId, status: newStatus } });
    } catch (err) {
      logger.error('[Rides] Status update failed', { error: err.message });
      res.status(500).json({ success: false, message: 'Status update failed' });
    }
  }
);

// ─── POST /api/rides/:rideId/join ─────────────────────────────────────────────
/** Joiner requests to join a RIDESHARE ride */
router.post('/:rideId/join', authenticate, authorize('PASSENGER'), async (req, res) => {
  const { rideId } = req.params;
  const userId = req.user.id;

  try {
    const [ride] = await db('rides').where({ id: rideId }).limit(1);
    if (!ride) return res.status(404).json({ success: false, message: 'Ride not found' });
    if (ride.ride_type !== 'RIDESHARE') {
      return res.status(409).json({ success: false, message: 'This is not a rideshare ride' });
    }
    if (ride.initiator_id === userId) {
      return res.status(409).json({ success: false, message: 'You cannot join your own ride' });
    }

    // Check seat availability
    const { count } = await db('ride_joiners')
      .where({ ride_id: rideId, status: 'ACCEPTED' })
      .count('id as count')
      .first();

    if (Number(count) >= ride.max_joiners) {
      return res.status(409).json({ success: false, message: 'No seats available' });
    }

    // Calculate split fare for this joiner (based on current + 1)
    const breakdown = calculateFareBreakdown(Number(ride.base_fare), Number(count) + 1);

    const [existing] = await db('ride_joiners')
      .where({ ride_id: rideId, user_id: userId })
      .limit(1);

    if (existing) {
      return res.status(409).json({ success: false, message: 'Join request already exists' });
    }

    await db('ride_joiners').insert({
      id:         uuidv4(),
      ride_id:    rideId,
      user_id:    userId,
      status:     'PENDING',
      split_fare: breakdown.joinerPays,
    });

    // Notify Initiator via Socket.io
    const io = req.app.get('io');
    if (io) {
      io.to(`user:${ride.initiator_id}`).emit('ride:join_request', {
        rideId, userId, splitFare: breakdown.joinerPays,
      });
    }

    res.status(201).json({
      success: true,
      data: { status: 'PENDING', estimatedSplitFare: breakdown.joinerPays },
    });
  } catch (err) {
    logger.error('[Rides] Join failed', { error: err.message });
    res.status(500).json({ success: false, message: 'Join request failed' });
  }
});

// ─── PATCH /api/rides/:rideId/joiners/:joinerId ───────────────────────────────
/** Initiator accepts or declines a joiner */
router.patch(
  '/:rideId/joiners/:joinerId',
  authenticate,
  authorize('PASSENGER'),
  [body('action').isIn(['ACCEPT', 'DECLINE'])],
  async (req, res) => {
    const { rideId, joinerId } = req.params;
    const { action } = req.body;

    try {
      // Verify this user is the initiator
      const [ride] = await db('rides').where({ id: rideId, initiator_id: req.user.id }).limit(1);
      if (!ride) return res.status(403).json({ success: false, message: 'Not your ride' });

      const newStatus = action === 'ACCEPT' ? 'ACCEPTED' : 'DECLINED';

      await db('ride_joiners')
        .where({ id: joinerId, ride_id: rideId })
        .update({ status: newStatus, updated_at: new Date() });

      // Recalculate all joiner fares if accepting
      if (action === 'ACCEPT') {
        const { count } = await db('ride_joiners')
          .where({ ride_id: rideId, status: 'ACCEPTED' })
          .count('id as count')
          .first();

        const breakdown = calculateFareBreakdown(Number(ride.base_fare), Number(count));

        // Update all accepted joiners' split fare
        await db('ride_joiners')
          .where({ ride_id: rideId, status: 'ACCEPTED' })
          .update({ split_fare: breakdown.joinerPays, updated_at: new Date() });
      }

      res.json({ success: true, data: { joinerId, status: newStatus } });
    } catch (err) {
      logger.error('[Rides] Joiner action failed', { error: err.message });
      res.status(500).json({ success: false, message: 'Action failed' });
    }
  }
);

module.exports = router;
