// src/consumer/consumer.wallet.routes.js
//
// Consumer wallet — earned entitlements + summary + redemption
//   GET  /me/summary                  — stat counts for wallet chips
//   GET  /me/wallet                   — list entitlements with reward context
//   GET  /me/wallet/:id               — single entitlement detail
//   POST /me/wallet/:id/redeem-request — initiate redemption, generate token

"use strict";

const express = require("express");
const { prisma } = require("../db/prisma");
const { sendError, handlePrismaError } = require("../utils/errors");
const { requireConsumerJwt } = require("../middleware/auth");
const { writeEventLog } = require("../eventlog/eventlog");
const { getGiftCardBalance } = require("../pos/pos.giftcard");
const { decrypt } = require("../utils/encrypt");

const router = express.Router();

// Resolve human-readable reward description from a Promotion row
function rewardLabel(promotion) {
  switch (promotion.rewardType) {
    case "free_item":
      return `Free item (SKU: ${promotion.rewardSku})`;
    case "discount_pct":
      return `${promotion.rewardValue}% off`;
    case "discount_fixed": {
      const dollars = (promotion.rewardValue / 100).toFixed(2);
      return `$${dollars} off`;
    }
    case "custom":
      return promotion.rewardNote || "Reward";
    default:
      return "Reward";
  }
}

// ──────────────────────────────────────────────
// GET /me/wallet
// ──────────────────────────────────────────────
router.get("/me/wallet", requireConsumerJwt, async (req, res) => {
  try {
    const { status = "active" } = req.query;
    const allowedStatuses = ["active", "redeemed", "expired", "revoked", "all"];
    if (!allowedStatuses.includes(status)) {
      return sendError(res, 400, "VALIDATION_ERROR", "Invalid status filter");
    }

    const where = { consumerId: req.consumerId };
    if (status !== "all") where.status = status;

    const entitlements = await prisma.entitlement.findMany({
      where,
      orderBy: { createdAt: "desc" },
    });

    // Resolve merchant names
    const merchantIds = [...new Set(entitlements.map(e => e.merchantId))];
    const merchants = merchantIds.length
      ? await prisma.merchant.findMany({
          where: { id: { in: merchantIds } },
          select: { id: true, name: true },
        })
      : [];
    const merchantMap = Object.fromEntries(merchants.map(m => [m.id, m.name]));

    // Resolve promotion details for reward-type entitlements
    const rewardSourceIds = entitlements
      .filter(e => e.type === "reward")
      .map(e => e.sourceId);

    let redemptionMap = {};
    if (rewardSourceIds.length) {
      const redemptions = await prisma.promoRedemption.findMany({
        where: { id: { in: rewardSourceIds } },
        select: {
          id: true,
          grantedAt: true,
          promotion: {
            select: {
              id: true,
              name: true,
              rewardType: true,
              rewardValue: true,
              rewardSku: true,
              rewardNote: true,
            },
          },
        },
      });
      redemptionMap = Object.fromEntries(redemptions.map(r => [r.id, r]));
    }

    const wallet = entitlements.map(e => {
      const base = {
        id: e.id,
        type: e.type,
        status: e.status,
        merchantId: e.merchantId,
        merchantName: merchantMap[e.merchantId] || "Unknown merchant",
        validFrom: e.validFrom,
        expiresAt: e.expiresAt,
        redeemedAt: e.redeemedAt,
        createdAt: e.createdAt,
      };

      if (e.type === "reward") {
        const redemption = redemptionMap[e.sourceId];
        base.promotion = redemption
          ? {
              id: redemption.promotion.id,
              name: redemption.promotion.name,
              rewardLabel: rewardLabel(redemption.promotion),
              rewardType: redemption.promotion.rewardType,
              rewardValue: redemption.promotion.rewardValue,
              rewardSku: redemption.promotion.rewardSku,
              rewardNote: redemption.promotion.rewardNote,
              grantedAt: redemption.grantedAt,
            }
          : null;
      }

      if (e.metadataJson) base.metadata = e.metadataJson;

      return base;
    });

    return res.json({ wallet, total: wallet.length });
  } catch (err) {
    return handlePrismaError(err, res);
  }
});

// ──────────────────────────────────────────────
// GET /me/wallet/giftcards
// Consumer's gift cards with live balances from Square.
// Must be registered BEFORE /me/wallet/:id to avoid param capture.
// ──────────────────────────────────────────────
router.get("/me/wallet/giftcards", requireConsumerJwt, async (req, res) => {
  try {
    const giftCards = await prisma.consumerGiftCard.findMany({
      where: { consumerId: req.consumerId, active: true },
      include: {
        posConnection: {
          select: { id: true, merchantId: true, accessTokenEnc: true, posType: true, status: true },
        },
      },
    });

    if (!giftCards.length) return res.json({ giftCards: [] });

    // Resolve merchant names
    const merchantIds = [...new Set(giftCards.map(gc => gc.posConnection.merchantId))];
    const merchants = await prisma.merchant.findMany({
      where: { id: { in: merchantIds } },
      select: { id: true, name: true },
    });
    const merchantMap = Object.fromEntries(merchants.map(m => [m.id, m.name]));

    // Query Square for live balances
    const results = await Promise.all(giftCards.map(async (gc) => {
      const conn = gc.posConnection;
      const merchantId = conn.merchantId;
      let balanceCents = null;
      let currency = "USD";

      if (conn.status === "active" && conn.accessTokenEnc) {
        try {
          const accessToken = decrypt(conn.accessTokenEnc);
          const balance = await getGiftCardBalance(accessToken, gc.squareGiftCardId);
          if (balance) {
            balanceCents = balance.balanceCents;
            currency = balance.currency;
          }
        } catch (e) {
          console.error(`[consumer.wallet] gift card balance error: gc=${gc.id}:`, e?.message || String(e));
        }
      }

      return {
        id: gc.id,
        merchantId,
        merchantName: merchantMap[merchantId] || "Unknown merchant",
        ganLast4: (gc.squareGan || "").slice(-4),
        balanceCents,
        currency,
        createdAt: gc.createdAt,
      };
    }));

    return res.json({ giftCards: results });
  } catch (err) {
    return handlePrismaError(err, res);
  }
});

// ──────────────────────────────────────────────
// POST /me/wallet/giftcards/:id/present
// Consumer taps "Use My Reward" — returns GAN for barcode display.
// Logs a PRESENTED analytics event. No backend token needed;
// the countdown timer is frontend-only UX.
// ──────────────────────────────────────────────
router.post("/me/wallet/giftcards/:id/present", requireConsumerJwt, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return sendError(res, 400, "VALIDATION_ERROR", "Invalid id");

    const gc = await prisma.consumerGiftCard.findFirst({
      where: { id, consumerId: req.consumerId, active: true },
      include: {
        posConnection: {
          select: { merchantId: true, accessTokenEnc: true, status: true },
        },
      },
    });

    if (!gc) return sendError(res, 404, "NOT_FOUND", "Gift card not found");

    // Query Square for live balance
    let balanceCents = null;
    let currency = "USD";
    if (gc.posConnection.status === "active" && gc.posConnection.accessTokenEnc) {
      try {
        const accessToken = decrypt(gc.posConnection.accessTokenEnc);
        const balance = await getGiftCardBalance(accessToken, gc.squareGiftCardId);
        if (balance) {
          balanceCents = balance.balanceCents;
          currency = balance.currency;
        }
      } catch (e) {
        console.error(`[consumer.wallet] gift card balance error on present: gc=${gc.id}:`, e?.message || String(e));
      }
    }

    if (balanceCents === 0) {
      return sendError(res, 409, "ZERO_BALANCE", "This gift card has no balance");
    }

    const ganLast4 = (gc.squareGan || "").slice(-4);

    // Log PRESENTED event for analytics
    await prisma.giftCardEvent.create({
      data: {
        giftCardId: gc.id,
        consumerId: req.consumerId,
        merchantId: gc.posConnection.merchantId,
        eventType: "PRESENTED",
        amountCents: balanceCents,
        ganLast4,
        payloadJson: { source: "consumer_app" },
      },
    });

    return res.json({
      gan: gc.squareGan,
      ganLast4,
      balanceCents,
      currency,
      merchantId: gc.posConnection.merchantId,
    });
  } catch (err) {
    return handlePrismaError(err, res);
  }
});

// ──────────────────────────────────────────────
// GET /me/wallet/:id
// ──────────────────────────────────────────────
router.get("/me/wallet/:id", requireConsumerJwt, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return sendError(res, 400, "VALIDATION_ERROR", "Invalid id");

    const entitlement = await prisma.entitlement.findFirst({
      where: { id, consumerId: req.consumerId },
    });
    if (!entitlement) return sendError(res, 404, "NOT_FOUND", "Entitlement not found");

    const merchant = await prisma.merchant.findUnique({
      where: { id: entitlement.merchantId },
      select: { id: true, name: true },
    });

    let promotion = null;
    if (entitlement.type === "reward") {
      const redemption = await prisma.promoRedemption.findUnique({
        where: { id: entitlement.sourceId },
        select: {
          id: true,
          grantedAt: true,
          grantedByStoreId: true,
          promotion: {
            select: {
              id: true,
              name: true,
              description: true,
              rewardType: true,
              rewardValue: true,
              rewardSku: true,
              rewardNote: true,
            },
          },
        },
      });
      if (redemption) {
        promotion = {
          ...redemption.promotion,
          rewardLabel: rewardLabel(redemption.promotion),
          grantedAt: redemption.grantedAt,
          grantedByStoreId: redemption.grantedByStoreId,
        };
      }
    }

    return res.json({
      entitlement: {
        id: entitlement.id,
        type: entitlement.type,
        status: entitlement.status,
        merchantId: entitlement.merchantId,
        merchantName: merchant?.name || "Unknown merchant",
        validFrom: entitlement.validFrom,
        expiresAt: entitlement.expiresAt,
        redeemedAt: entitlement.redeemedAt,
        createdAt: entitlement.createdAt,
        metadata: entitlement.metadataJson || null,
        promotion,
      },
    });
  } catch (err) {
    return handlePrismaError(err, res);
  }
});

// ──────────────────────────────────────────────
// POST /me/wallet/:id/redeem-request
// Consumer initiates a redemption. Generates a short token on the linked
// PromoRedemption for the POS associate to confirm.
// ──────────────────────────────────────────────
router.post("/me/wallet/:id/redeem-request", requireConsumerJwt, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return sendError(res, 400, "VALIDATION_ERROR", "Invalid id");

    const entitlement = await prisma.entitlement.findFirst({
      where: { id, consumerId: req.consumerId },
    });
    if (!entitlement) return sendError(res, 404, "NOT_FOUND", "Entitlement not found");
    if (entitlement.status !== "active")
      return sendError(res, 409, "NOT_REDEEMABLE", "This reward is not active");
    if (entitlement.type !== "reward")
      return sendError(res, 409, "NOT_SUPPORTED", "Only reward entitlements can be redeemed this way");

    // Find the linked PromoRedemption
    const redemption = await prisma.promoRedemption.findUnique({
      where: { id: entitlement.sourceId },
    });
    if (!redemption)
      return sendError(res, 500, "DATA_ERROR", "Reward record not found");

    // Generate 6-char alphanumeric token (uppercase, no ambiguous chars)
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    const token = Array.from({ length: 6 }, () =>
      chars[Math.floor(Math.random() * chars.length)]
    ).join("");

    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    await prisma.promoRedemption.update({
      where: { id: redemption.id },
      data: { redemptionToken: token, redemptionTokenExpiresAt: expiresAt },
    });

    writeEventLog(prisma, {
      eventType: "reward.redeem_requested",
      merchantId: redemption.merchantId,
      storeId: redemption.grantedByStoreId || 0,
      consumerId: req.consumerId,
      entitlementId: id,
      source: "consumer_app",
      outcome: "token_issued",
      payloadJson: { token, expiresAt },
    });

    return res.json({
      ok: true,
      token,
      expiresAt,
      entitlementId: id,
    });
  } catch (err) {
    return handlePrismaError(err, res);
  }
});

// ──────────────────────────────────────────────
// GET /me/summary
// One-shot counts for wallet stat chips.
// ──────────────────────────────────────────────
router.get("/me/summary", requireConsumerJwt, async (req, res) => {
  try {
    const [
      rewardsReady,
      rewardsRedeemed,
      programsJoined,
    ] = await Promise.all([
      // Active entitlements = rewards earned, not yet redeemed
      prisma.entitlement.count({
        where: { consumerId: req.consumerId, status: "active" },
      }),
      // Redeemed entitlements
      prisma.entitlement.count({
        where: { consumerId: req.consumerId, status: "redeemed" },
      }),
      // Programs the consumer has joined (has a progress row)
      prisma.consumerPromoProgress.count({
        where: { consumerId: req.consumerId },
      }),
    ]);

    return res.json({ rewardsReady, rewardsRedeemed, programsJoined });
  } catch (err) {
    return handlePrismaError(err, res);
  }
});

module.exports = router;
