/**
 * consumer.checkin.routes.js — Consumer presence detection + reward pre-fetch.
 *
 * POST /consumer/checkin      — Record check-in, return reward status
 * GET  /consumer/stores/nearby — Location-aware store list
 *
 * Check-in is presence detection only — does NOT create a visit or stamp.
 * The consumer app calls this on geofence entry or manual check-in button.
 */

"use strict";

const express = require("express");
const { prisma } = require("../db/prisma");
const { sendError } = require("../utils/errors");
const { requireConsumerJwt } = require("../middleware/auth");

const router = express.Router();

const CHECKIN_DEDUP_HOURS = 2; // suppress duplicate check-ins within this window

// ──────────────────────────────────────────────
// POST /consumer/checkin
// Body: { storeId, triggeredBy: "geofence" | "manual" | "qr" }
// ──────────────────────────────────────────────
router.post("/consumer/checkin", requireConsumerJwt, async (req, res) => {
  try {
    const consumerId = req.consumerId;
    const { storeId, triggeredBy } = req.body || {};

    if (!storeId) return sendError(res, 400, "VALIDATION_ERROR", "storeId is required");
    if (!["geofence", "manual", "qr"].includes(triggeredBy)) {
      return sendError(res, 400, "VALIDATION_ERROR", "triggeredBy must be geofence, manual, or qr");
    }

    // Validate store exists
    const store = await prisma.store.findUnique({
      where: { id: storeId },
      select: { id: true, name: true, merchantId: true, merchant: { select: { name: true } } },
    });
    if (!store) return sendError(res, 404, "NOT_FOUND", "Store not found");

    const merchantId = store.merchantId;

    // Dedup: skip if consumer checked in at this store within CHECKIN_DEDUP_HOURS
    const dedupCutoff = new Date(Date.now() - CHECKIN_DEDUP_HOURS * 60 * 60 * 1000);
    const recentCheckin = await prisma.consumerCheckin.findFirst({
      where: { consumerId, storeId, createdAt: { gt: dedupCutoff } },
      select: { id: true },
    });
    if (recentCheckin) {
      // Still return reward status — just don't create a new checkin record
      const rewardStatus = await getRewardStatus(consumerId, merchantId);
      return res.json({
        storeName: store.name,
        merchantName: store.merchant.name,
        duplicate: true,
        ...rewardStatus,
      });
    }

    // Fetch reward status
    const rewardStatus = await getRewardStatus(consumerId, merchantId);

    // Create check-in record
    const checkin = await prisma.consumerCheckin.create({
      data: {
        consumerId,
        storeId,
        merchantId,
        triggeredBy,
        hadPendingReward: rewardStatus.pendingRewards.length > 0,
      },
    });

    console.log(JSON.stringify({
      pvHook: "consumer.checkin",
      ts: new Date().toISOString(),
      tc: "TC-CHECKIN-01",
      sev: "info",
      consumerId,
      storeId,
      merchantId,
      triggeredBy,
      hadPendingReward: rewardStatus.pendingRewards.length > 0,
      checkinId: checkin.id,
    }));

    return res.json({
      storeName: store.name,
      merchantName: store.merchant.name,
      checkinId: checkin.id,
      ...rewardStatus,
    });
  } catch (err) {
    console.error("[consumer.checkin] error:", err);
    return sendError(res, 500, "SERVER_ERROR", "Check-in failed");
  }
});

// ──────────────────────────────────────────────
// GET /consumer/stores/nearby?lat=...&lng=...&radiusMeters=...
// Returns stores near the consumer's location with reward status
// ──────────────────────────────────────────────
router.get("/consumer/stores/nearby", requireConsumerJwt, async (req, res) => {
  try {
    const consumerId = req.consumerId;
    const lat = parseFloat(req.query.lat);
    const lng = parseFloat(req.query.lng);
    const radiusMeters = parseInt(req.query.radiusMeters) || 500;

    if (isNaN(lat) || isNaN(lng)) {
      return sendError(res, 400, "VALIDATION_ERROR", "lat and lng are required");
    }

    // Find stores with coordinates, within a bounding box (fast pre-filter)
    // ~0.009 degrees ≈ 1km at equator. Generous bounding box, then filter by real distance.
    const degreeRadius = (radiusMeters / 111320) * 1.5; // 1.5x safety margin

    const stores = await prisma.store.findMany({
      where: {
        latitude: { not: null, gte: lat - degreeRadius, lte: lat + degreeRadius },
        longitude: { not: null, gte: lng - degreeRadius, lte: lng + degreeRadius },
        status: "active",
      },
      select: {
        id: true,
        name: true,
        merchantId: true,
        latitude: true,
        longitude: true,
        geofenceRadiusMeters: true,
        merchant: { select: { name: true } },
      },
    });

    // Calculate actual distance and filter by store's geofence radius or requested radius
    const nearby = [];
    for (const store of stores) {
      const distance = haversineDistance(lat, lng, store.latitude, store.longitude);
      const effectiveRadius = Math.max(store.geofenceRadiusMeters, radiusMeters);
      if (distance <= effectiveRadius) {
        // Check if consumer has active promotions at this merchant
        const promoCount = await prisma.promotion.count({
          where: { merchantId: store.merchantId, status: "active" },
        });

        // Check for pending rewards
        const pendingCount = await prisma.posRewardDiscount.count({
          where: { consumerId, merchantId: store.merchantId, status: { in: ["earned", "activated", "pending"] } },
        });
        const giftCardCount = await prisma.consumerGiftCard.count({
          where: { consumerId, active: true },
        });

        nearby.push({
          storeId: store.id,
          storeName: store.name,
          merchantName: store.merchant.name,
          merchantId: store.merchantId,
          distance: Math.round(distance),
          hasActivePromo: promoCount > 0,
          hasPendingReward: pendingCount > 0 || giftCardCount > 0,
        });
      }
    }

    // Sort by distance
    nearby.sort((a, b) => a.distance - b.distance);

    return res.json({ stores: nearby });
  } catch (err) {
    console.error("[consumer.stores.nearby] error:", err);
    return sendError(res, 500, "SERVER_ERROR", "Could not fetch nearby stores");
  }
});

// ── Helpers ──

/**
 * Get the consumer's current reward status at a merchant.
 * POS-agnostic — returns unified pendingRewards array.
 */
async function getRewardStatus(consumerId, merchantId) {
  // Stamp progress
  const progress = await prisma.consumerPromoProgress.findMany({
    where: { consumerId, merchantId },
    include: { promotion: { select: { name: true, threshold: true, rewardType: true, rewardValue: true, rewardNote: true } } },
  });

  const programs = progress.map(p => ({
    name: p.promotion.name,
    stampCount: p.stampCount,
    threshold: p.promotion.threshold,
    stampsToNext: p.promotion.threshold - p.stampCount,
  }));

  // Pending rewards — Clover (PosRewardDiscount)
  const cloverRewards = await prisma.posRewardDiscount.findMany({
    where: { consumerId, merchantId, status: { in: ["earned", "activated", "pending"] } },
    select: { id: true, discountName: true, amountCents: true, percentage: true, status: true, rewardType: true, expiresAt: true },
  });

  // Pending rewards — Square (ConsumerGiftCard with balance)
  // Note: we don't have live balance here (would need Square API call).
  // Just check if active gift card exists.
  const squareGiftCards = await prisma.consumerGiftCard.findMany({
    where: { consumerId, active: true },
    include: { posConnection: { select: { merchantId: true } } },
  });
  const squareRewards = squareGiftCards
    .filter(gc => gc.posConnection.merchantId === merchantId)
    .map(gc => ({
      id: gc.id,
      description: "Gift card credit available",
      value: null, // live balance requires Square API — returned at present time
      type: "giftcard",
      status: "earned",
      activatable: true,
      expiresAt: gc.expiresAt,
    }));

  const pendingRewards = [
    ...cloverRewards.map(r => ({
      id: r.id,
      description: r.discountName,
      value: r.amountCents,
      percentage: r.percentage,
      type: "discount",
      status: r.status,
      activatable: r.status === "earned",
      expiresAt: r.expiresAt,
    })),
    ...squareRewards,
  ];

  return { programs, pendingRewards };
}

/**
 * Haversine distance between two lat/lng points in meters.
 */
function haversineDistance(lat1, lon1, lat2, lon2) {
  const R = 6371000; // Earth radius in meters
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

module.exports = router;
