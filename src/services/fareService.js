'use strict';

/**
 * NextStop — Ride Cost-Sharing Service
 * ─────────────────────────────────────────────────────────────────────────────
 * Implements the RIDESHARE cost-splitting algorithm.
 *
 * Model:
 *  - Initiator sets the base fare for the full route.
 *  - Each accepted Joiner reduces the Initiator's net fare proportionally.
 *  - Driver always earns (base_fare × (1 - platform_fee_pct)).
 *  - Platform captures the fee from ALL passengers (Initiator + Joiners).
 *
 * Example (4-seat ride, 2 joiners):
 *  base_fare = ₦3,000, platform_fee = 15%
 *  → driver_earnings    = ₦3,000 × 0.85 = ₦2,550
 *  → total_passenger_pool = base_fare + (joiners × split_fare)
 *  → split_fare_per_joiner = base_fare / (joiners + 1)  [equal split]
 *  → initiator_pays    = ₦3,000 / 3 = ₦1,000
 *  → each_joiner_pays  = ₦1,000
 *  → total_collected   = ₦3,000 (same as base_fare — driver stays whole)
 * ─────────────────────────────────────────────────────────────────────────────
 */

const PLATFORM_FEE_PCT = Number(process.env.PLATFORM_FEE_PCT) || 0.15;

/**
 * Calculates the fare breakdown for a RIDESHARE ride.
 *
 * @param {number} baseFare         - The agreed total fare for the route (NGN)
 * @param {number} acceptedJoiners  - Number of accepted joiners (0 = SOLO)
 * @returns {Object} FareBreakdown
 */
function calculateFareBreakdown(baseFare, acceptedJoiners = 0) {
  if (baseFare <= 0) throw new Error('Base fare must be positive');
  if (acceptedJoiners < 0) throw new Error('Joiners cannot be negative');

  const totalPassengers  = acceptedJoiners + 1; // Initiator + Joiners
  const platformFee      = round2(baseFare * PLATFORM_FEE_PCT);
  const driverEarnings   = round2(baseFare - platformFee);

  // Equal split: each passenger pays baseFare / totalPassengers
  const splitFareEach    = round2(baseFare / totalPassengers);

  // Initiator pays their split share
  const initiatorPays    = splitFareEach;

  // Each joiner pays the same split fare
  const joinerPays       = splitFareEach;

  // Total collected from all passengers (may differ slightly from baseFare due to rounding)
  const totalCollected   = round2(initiatorPays + joinerPays * acceptedJoiners);

  return {
    baseFare,
    acceptedJoiners,
    totalPassengers,
    platformFeePct:  PLATFORM_FEE_PCT,
    platformFee,
    driverEarnings,
    initiatorPays,
    joinerPays,          // each joiner pays this amount
    totalCollected,
    currency: 'NGN',
  };
}

/**
 * Recalculates fares when a new joiner is added or removed mid-booking.
 * Called during the Joiner vetting phase.
 *
 * @param {number} baseFare
 * @param {number} currentJoiners
 * @param {'ADD'|'REMOVE'} action
 */
function recalculateFareOnJoinerChange(baseFare, currentJoiners, action) {
  const newJoinerCount = action === 'ADD'
    ? currentJoiners + 1
    : Math.max(0, currentJoiners - 1);

  return calculateFareBreakdown(baseFare, newJoinerCount);
}

/**
 * Validates that a proposed negotiated fare is reasonable.
 * (Within 70%–200% of the platform's estimated base fare range)
 *
 * @param {number} proposedFare
 * @param {number} estimatedFare  - Platform-estimated fare
 * @returns {{ valid: boolean, reason?: string }}
 */
function validateNegotiatedFare(proposedFare, estimatedFare) {
  const minAcceptable = estimatedFare * 0.70;
  const maxAcceptable = estimatedFare * 2.00;

  if (proposedFare < minAcceptable) {
    return { valid: false, reason: `Fare too low. Minimum is ₦${minAcceptable.toFixed(0)}` };
  }
  if (proposedFare > maxAcceptable) {
    return { valid: false, reason: `Fare too high. Maximum is ₦${maxAcceptable.toFixed(0)}` };
  }
  return { valid: true };
}

/**
 * Estimates a fare based on distance and time.
 * In production, integrate with a routing API (Google Maps Distance Matrix).
 *
 * @param {number} distanceKm
 * @param {number} estimatedMinutes
 * @returns {number} estimatedFare in NGN
 */
function estimateFare(distanceKm, estimatedMinutes) {
  const BASE_RATE_PER_KM    = 150;  // ₦150/km
  const BASE_RATE_PER_MIN   = 20;   // ₦20/min
  const MINIMUM_FARE        = 500;  // ₦500 minimum

  const distanceFare  = distanceKm * BASE_RATE_PER_KM;
  const timeFare      = estimatedMinutes * BASE_RATE_PER_MIN;
  const total         = distanceFare + timeFare;

  return Math.max(round2(total), MINIMUM_FARE);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function round2(n) {
  return Math.round(n * 100) / 100;
}

module.exports = {
  calculateFareBreakdown,
  recalculateFareOnJoinerChange,
  validateNegotiatedFare,
  estimateFare,
};
