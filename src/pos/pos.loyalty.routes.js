// src/pos/pos.loyalty.routes.js
//
// POS-side loyalty redemption endpoints
//   GET  /pos/loyalty/pending          — list pending reward redemption requests for this merchant
//   POST /pos/loyalty/grant-by-token   — associate confirms a consumer reward redemption

"use strict";

const express = require("express");
const { prisma } = require("../db/prisma");
const { sendError, handlePrismaError } = require("../utils/errors");
const { writeEventLog } = require("../eventlog/eventlog");
const { recordPromotionEvent } = require("../growth/promotionOutcome.events");

const router = express.Router();

// ──────────────────────────────────────────────
// GET /pos/loyalty/pending
// Lists active redemption requests (unexpired tokens) for the POS merchant.
// Used by the no-scanner flow: associate sees what's pending and taps Grant.
// ──────────────────────────────────────────────
router.get("/pos/loyalty/pending", async (req, res) => {
  try {
    const { requireAuth, prisma: db, sendError: se } = res.locals;
    const p = db || prisma;
    const err = se || sendError;

    // merchantId comes from POS session (set by requireAuth / requirePosContext)
    const merchantId = req.merchantId || req.posContext?.merchantId;
    if (!merchantId) return err(res, 403, "FORBIDDEN", "No POS context");

    const now = new Date();
    const pending = await p.promoRedemption.findMany({
      where: {
        merchantId,
        redemptionToken: { not: null },
        redemptionTokenExpiresAt: { gt: now },
      },
      select: {
        id: true,
        redemptionToken: true,
        redemptionTokenExpiresAt: true,
        promotionId: true,
        consumerId: true,
        promotion: { select: { name: true, rewardType: true, rewardNote: true, rewardSku: true, rewardValue: true } },
        consumer: { select: { id: true, firstName: true, lastName: true, phoneE164: true } },
        progress: { select: { id: true } },
      },
      orderBy: { redemptionTokenExpiresAt: "asc" },
    });

    // Find the linked active Entitlement for each
    const entitlements = pending.length
      ? await p.entitlement.findMany({
          where: {
            sourceId: { in: pending.map(r => r.id) },
            status: "active",
            type: "reward",
          },
          select: { id: true, sourceId: true },
        })
      : [];
    const entitlementMap = Object.fromEntries(entitlements.map(e => [e.sourceId, e.id]));

    return res.json({
      pending: pending.map(r => ({
        redemptionId: r.id,
        token: r.redemptionToken,
        expiresAt: r.redemptionTokenExpiresAt,
        entitlementId: entitlementMap[r.id] || null,
        promotion: r.promotion,
        consumer: {
          id: r.consumer.id,
          name: [r.consumer.firstName, r.consumer.lastName].filter(Boolean).join(" ") || null,
          phone: r.consumer.phoneE164,
        },
      })),
    });
  } catch (err) {
    return handlePrismaError(err, res);
  }
});

// ──────────────────────────────────────────────
// POST /pos/loyalty/grant-by-token
// Body: { token }
// POS associate confirms delivery of the reward.
// Marks Entitlement as redeemed.
// ──────────────────────────────────────────────
router.post("/pos/loyalty/grant-by-token", async (req, res) => {
  try {
    const { token } = req.body || {};
    if (!token || typeof token !== "string")
      return sendError(res, 400, "VALIDATION_ERROR", "token is required");

    const now = new Date();
    const redemption = await prisma.promoRedemption.findFirst({
      where: {
        redemptionToken: token.toUpperCase().trim(),
        redemptionTokenExpiresAt: { gt: now },
      },
    });

    if (!redemption)
      return sendError(res, 404, "NOT_FOUND", "Invalid or expired code");

    // Find the active entitlement linked to this redemption
    const entitlement = await prisma.entitlement.findFirst({
      where: { sourceId: redemption.id, status: "active", type: "reward" },
    });

    if (!entitlement)
      return sendError(res, 409, "ALREADY_REDEEMED", "This reward has already been redeemed");

    // Optionally verify merchantId matches POS context
    const merchantId = req.merchantId || req.posContext?.merchantId;
    if (merchantId && redemption.merchantId !== merchantId)
      return sendError(res, 403, "FORBIDDEN", "This reward does not belong to your merchant");

    // Mark entitlement redeemed + clear token
    const [updatedEntitlement] = await prisma.$transaction([
      prisma.entitlement.update({
        where: { id: entitlement.id },
        data: { status: "redeemed", redeemedAt: now },
      }),
      prisma.promoRedemption.update({
        where: { id: redemption.id },
        data: { redemptionToken: null, redemptionTokenExpiresAt: null },
      }),
    ]);

    writeEventLog(prisma, {
      eventType: "reward.granted",
      merchantId: redemption.merchantId,
      storeId: redemption.grantedByStoreId || 0,
      consumerId: redemption.consumerId,
      entitlementId: updatedEntitlement.id,
      source: "pos_app",
      outcome: "redeemed",
      payloadJson: { token: token.toUpperCase().trim(), redeemedAt: updatedEntitlement.redeemedAt },
    });

    // Growth Advisor — record redemption event
    recordPromotionEvent(prisma, {
      promotionId: redemption.promotionId,
      merchantId: redemption.merchantId,
      storeId: redemption.grantedByStoreId || null,
      consumerId: redemption.consumerId,
      eventType: "redeem",
    });

    return res.json({
      ok: true,
      entitlementId: updatedEntitlement.id,
      redeemedAt: updatedEntitlement.redeemedAt,
    });
  } catch (err) {
    return handlePrismaError(err, res);
  }
});

module.exports = router;
