// src/consumer/consumer.wallet.routes.js
//
// Consumer wallet — earned entitlements
//   GET /me/wallet              — list active entitlements with reward context
//   GET /me/wallet/:id          — single entitlement detail

"use strict";

const express = require("express");
const { prisma } = require("../db/prisma");
const { sendError, handlePrismaError } = require("../utils/errors");
const { requireConsumerJwt } = require("../middleware/auth");

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

module.exports = router;
