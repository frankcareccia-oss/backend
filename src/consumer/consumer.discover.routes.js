/**
 * consumer.discover.routes.js — Discover nearby PV merchants
 *
 * GET  /consumer/discover           — nearby merchants with loyalty context
 * POST /consumer/promotions/enroll  — inline enrollment from Discover
 */

"use strict";

const express = require("express");
const { prisma } = require("../db/prisma");
const { sendError } = require("../utils/errors");
const { requireConsumerJwt } = require("../middleware/auth");

const router = express.Router();

/**
 * Haversine distance in meters.
 */
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ──────────────────────────────────────────────
// GET /consumer/discover?lat=...&lng=...&radiusMeters=...
// ──────────────────────────────────────────────
router.get("/consumer/discover", requireConsumerJwt, async (req, res) => {
  try {
    const consumerId = req.consumerId;
    const lat = parseFloat(req.query.lat);
    const lng = parseFloat(req.query.lng);
    const radiusMeters = parseInt(req.query.radiusMeters) || 3218; // default ~2 miles

    const browseAll = isNaN(lat) || isNaN(lng);

    // Browse All mode — no location required, show all discoverable merchants
    let stores;
    if (browseAll) {
      stores = await prisma.store.findMany({
        where: { status: "active", discoverability: true },
        select: {
          id: true, name: true, merchantId: true, latitude: true, longitude: true,
          address1: true, city: true, state: true, postal: true,
          category: true, logoUrl: true, hoursJson: true,
          merchant: { select: { id: true, name: true } },
        },
      });
    } else {
      // Bounding box pre-filter
      const degRadius = (radiusMeters / 111320) * 1.5;

      stores = await prisma.store.findMany({
        where: {
          latitude: { not: null, gte: lat - degRadius, lte: lat + degRadius },
          longitude: { not: null, gte: lng - degRadius, lte: lng + degRadius },
          status: "active",
          discoverability: true,
        },
        select: {
          id: true, name: true, merchantId: true, latitude: true, longitude: true,
          address1: true, city: true, state: true, postal: true,
          category: true, logoUrl: true, hoursJson: true,
          merchant: { select: { id: true, name: true } },
        },
      });
    }

    // Build response with loyalty context per store
    const results = [];

    // Deduplicate by merchant — show one entry per merchant (first store)
    const seenMerchants = new Set();

    for (const store of stores) {
      const dist = browseAll ? null : haversine(lat, lng, store.latitude, store.longitude);
      if (!browseAll && dist > radiusMeters) continue;

      // Consumer's enrollment + progress at this merchant
      const progress = await prisma.consumerPromoProgress.findMany({
        where: { consumerId, merchantId: store.merchantId },
        include: { promotion: { select: { id: true, name: true, description: true, threshold: true, rewardType: true, rewardValue: true, rewardNote: true, rewardSku: true, rewardExpiryDays: true, legalText: true } } },
      });

      const enrolled = progress.length > 0;
      let stampCount = null, milestone = null, stampsToNext = null, progressPercent = null, rewardReady = false;
      let pendingReward = null;

      if (enrolled) {
        const best = progress[0]; // first promo's progress
        stampCount = best.stampCount;
        milestone = best.promotion.threshold;
        stampsToNext = milestone - stampCount;
        progressPercent = milestone > 0 ? Math.round((stampCount / milestone) * 100) : 0;

        // Check pending rewards
        const pending = await prisma.posRewardDiscount.findFirst({
          where: { consumerId, merchantId: store.merchantId, status: { in: ["earned", "activated"] } },
          select: { discountName: true, amountCents: true },
        });
        if (pending) {
          rewardReady = true;
          pendingReward = { description: pending.discountName, value: pending.amountCents };
        }
        // Also check Square gift cards
        if (!pendingReward) {
          const gc = await prisma.consumerGiftCard.findFirst({
            where: { consumerId, active: true, posConnection: { merchantId: store.merchantId } },
          });
          if (gc) {
            rewardReady = true;
            pendingReward = { description: "Gift card credit available", value: null };
          }
        }
      }

      // Available promotions (for non-enrolled or all consumers)
      const availablePromos = await prisma.promotion.findMany({
        where: { merchantId: store.merchantId, status: "active" },
        select: {
          id: true, name: true, description: true, threshold: true,
          rewardType: true, rewardValue: true, rewardNote: true, rewardExpiryDays: true,
          legalText: true,
        },
      });

      let hours = null;
      try { if (store.hoursJson) hours = JSON.parse(store.hoursJson); } catch {}

      results.push({
        storeId: store.id,
        merchantId: store.merchantId,
        storeName: store.name,
        merchantName: store.merchant.name,
        category: store.category,
        logoUrl: store.logoUrl,
        address: [store.address1, store.city, store.state, store.postal].filter(Boolean).join(", "),
        latitude: store.latitude,
        longitude: store.longitude,
        distanceMeters: dist !== null ? Math.round(dist) : null,
        hours,
        consumerRelationship: {
          enrolled,
          stampCount,
          milestone,
          stampsToNext,
          progressPercent,
          pendingReward,
          rewardReady,
        },
        availablePromotions: availablePromos.map(p => ({
          promotionId: p.id,
          name: p.name,
          description: p.description,
          rewardDescription: buildRewardDesc(p),
          rewardValue: p.rewardValue,
          stampThreshold: p.threshold,
          rewardExpiryDays: p.rewardExpiryDays,
          termsSnippet: p.legalText ? p.legalText.slice(0, 200) : null,
        })),
      });
    }

    // Sort by distance
    results.sort((a, b) => a.distanceMeters - b.distanceMeters);

    console.log(JSON.stringify({
      pvHook: "consumer.discover.opened",
      ts: new Date().toISOString(),
      tc: "TC-DISCOVER-01",
      sev: "info",
      consumerId,
      lat, lng,
      radiusMeters,
      merchantsFound: results.length,
    }));

    return res.json({ merchants: results });
  } catch (err) {
    console.error("[consumer.discover] error:", err);
    return sendError(res, 500, "SERVER_ERROR", "Could not load nearby merchants");
  }
});

// ──────────────────────────────────────────────
// POST /consumer/promotions/enroll
// Body: { promotionId, triggeredBy?: "discover" | "app" }
// ──────────────────────────────────────────────
router.post("/consumer/promotions/enroll", requireConsumerJwt, async (req, res) => {
  try {
    const consumerId = req.consumerId;
    const { promotionId, triggeredBy } = req.body || {};

    if (!promotionId) return sendError(res, 400, "VALIDATION_ERROR", "promotionId is required");

    const promo = await prisma.promotion.findUnique({
      where: { id: promotionId },
      select: {
        id: true, name: true, description: true, merchantId: true,
        threshold: true, status: true, rewardType: true, rewardValue: true,
        rewardNote: true, rewardExpiryDays: true, legalText: true,
      },
    });

    if (!promo) return sendError(res, 404, "NOT_FOUND", "Promotion not found");
    if (promo.status !== "active") return sendError(res, 400, "INVALID_STATE", "Promotion is not active");

    // Check duplicate enrollment
    const existing = await prisma.consumerPromoProgress.findUnique({
      where: { consumerId_promotionId: { consumerId, promotionId } },
    });
    if (existing) return sendError(res, 409, "ALREADY_ENROLLED", "Already enrolled in this promotion");

    // Create enrollment
    const progress = await prisma.consumerPromoProgress.create({
      data: {
        consumerId,
        promotionId,
        merchantId: promo.merchantId,
        stampCount: 0,
        lifetimeEarned: 0,
        lastEarnedAt: new Date(),
      },
    });

    console.log(JSON.stringify({
      pvHook: "consumer.enrolled",
      ts: new Date().toISOString(),
      tc: "TC-DISCOVER-02",
      sev: "info",
      consumerId,
      promotionId,
      merchantId: promo.merchantId,
      triggeredBy: triggeredBy || "app",
      rewardFaceValue: promo.rewardValue,
    }));

    return res.json({
      enrolled: true,
      stampCount: 0,
      milestone: promo.threshold,
      promotionName: promo.name,
      rewardDescription: buildRewardDesc(promo),
    });
  } catch (err) {
    console.error("[consumer.enroll] error:", err);
    return sendError(res, 500, "SERVER_ERROR", "Enrollment failed");
  }
});

function buildRewardDesc(promo) {
  if (promo.rewardType === "discount_fixed" && promo.rewardValue) {
    return `$${(promo.rewardValue / 100).toFixed(2)} off after ${promo.threshold} visits`;
  }
  if (promo.rewardType === "discount_pct" && promo.rewardValue) {
    return `${promo.rewardValue}% off after ${promo.threshold} visits`;
  }
  if (promo.rewardType === "free_item") {
    return `Free item after ${promo.threshold} visits`;
  }
  if (promo.rewardNote) return promo.rewardNote;
  return `Reward after ${promo.threshold} visits`;
}

module.exports = router;
