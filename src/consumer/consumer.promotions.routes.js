// src/consumer/consumer.promotions.routes.js
//
// Consumer promotion catalog + personal progress
//   GET /me/promotions            — active promotions (all merchants or filtered)
//   GET /me/promotions/:id        — single promotion detail with progress

"use strict";

const express = require("express");
const { prisma } = require("../db/prisma");
const { sendError, handlePrismaError } = require("../utils/errors");
const { requireConsumerJwt } = require("../middleware/auth");

const router = express.Router();

function rewardLabel(p) {
  switch (p.rewardType) {
    case "free_item":    return `Free item (${p.rewardSku})`;
    case "discount_pct":   return `${p.rewardValue}% off`;
    case "discount_fixed": return `$${(p.rewardValue / 100).toFixed(2)} off`;
    case "custom":         return p.rewardNote || "Reward";
    default:               return "Reward";
  }
}

function progressSummary(progress, threshold) {
  if (!progress) return null;
  const stamps = progress.stampCount;
  const needed = threshold - (stamps % threshold || threshold);
  return {
    stampCount: stamps,
    lifetimeEarned: progress.lifetimeEarned,
    milestonesAvailable: progress.milestonesAvailable,
    stampsToNextReward: needed,
    lastEarnedAt: progress.lastEarnedAt,
  };
}

// ──────────────────────────────────────────────
// GET /me/promotions
// Query: ?merchantId=   (optional, int)
// ──────────────────────────────────────────────
router.get("/me/promotions", requireConsumerJwt, async (req, res) => {
  try {
    const { merchantId: merchantIdRaw } = req.query;
    const merchantId = merchantIdRaw ? parseInt(merchantIdRaw, 10) : null;
    if (merchantIdRaw && !merchantId) {
      return sendError(res, 400, "VALIDATION_ERROR", "Invalid merchantId");
    }

    const promoWhere = { status: "active" };
    if (merchantId) promoWhere.merchantId = merchantId;

    // Also exclude promotions outside their active window
    const now = new Date();
    promoWhere.OR = [
      { startAt: null },
      { startAt: { lte: now } },
    ];
    // endAt check — exclude ended promos
    // Prisma doesn't support NOT(endAt < now) cleanly; filter in JS below

    const promotions = await prisma.promotion.findMany({
      where: promoWhere,
      orderBy: [{ merchantId: "asc" }, { name: "asc" }],
      select: {
        id: true,
        merchantId: true,
        name: true,
        description: true,
        mechanic: true,
        threshold: true,
        earnPerUnit: true,
        timeframeDays: true,
        rewardType: true,
        rewardValue: true,
        rewardSku: true,
        rewardNote: true,
        startAt: true,
        endAt: true,
        category: {
          select: { id: true, name: true, categoryType: true },
        },
        merchant: {
          select: { id: true, name: true },
        },
      },
    });

    // Filter out expired (endAt in the past)
    const live = promotions.filter(p => !p.endAt || p.endAt > now);

    // Fetch this consumer's progress for all returned promotions
    const promoIds = live.map(p => p.id);
    const progressRows = promoIds.length
      ? await prisma.consumerPromoProgress.findMany({
          where: { consumerId: req.consumerId, promotionId: { in: promoIds } },
        })
      : [];
    const progressMap = Object.fromEntries(progressRows.map(r => [r.promotionId, r]));

    const result = live.map(p => ({
      id: p.id,
      merchantId: p.merchantId,
      merchantName: p.merchant.name,
      name: p.name,
      description: p.description,
      mechanic: p.mechanic,
      threshold: p.threshold,
      earnPerUnit: p.earnPerUnit,
      timeframeDays: p.timeframeDays,
      rewardLabel: rewardLabel(p),
      rewardType: p.rewardType,
      category: p.category
        ? { id: p.category.id, name: p.category.name, isVisit: p.category.categoryType === "visit" }
        : null,
      startAt: p.startAt,
      endAt: p.endAt,
      progress: progressSummary(progressMap[p.id], p.threshold),
    }));

    return res.json({ promotions: result, total: result.length });
  } catch (err) {
    return handlePrismaError(err, res);
  }
});

// ──────────────────────────────────────────────
// GET /me/promotions/:id
// ──────────────────────────────────────────────
router.get("/me/promotions/:id", requireConsumerJwt, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return sendError(res, 400, "VALIDATION_ERROR", "Invalid id");

    const p = await prisma.promotion.findFirst({
      where: { id, status: "active" },
      select: {
        id: true,
        merchantId: true,
        name: true,
        description: true,
        mechanic: true,
        threshold: true,
        earnPerUnit: true,
        timeframeDays: true,
        rewardType: true,
        rewardValue: true,
        rewardSku: true,
        rewardNote: true,
        startAt: true,
        endAt: true,
        category: { select: { id: true, name: true, categoryType: true } },
        merchant: { select: { id: true, name: true } },
      },
    });

    if (!p) return sendError(res, 404, "NOT_FOUND", "Promotion not found");

    const progress = await prisma.consumerPromoProgress.findUnique({
      where: { consumerId_promotionId: { consumerId: req.consumerId, promotionId: id } },
    });

    return res.json({
      promotion: {
        id: p.id,
        merchantId: p.merchantId,
        merchantName: p.merchant.name,
        name: p.name,
        description: p.description,
        mechanic: p.mechanic,
        threshold: p.threshold,
        earnPerUnit: p.earnPerUnit,
        timeframeDays: p.timeframeDays,
        rewardLabel: rewardLabel(p),
        rewardType: p.rewardType,
        rewardValue: p.rewardValue,
        rewardSku: p.rewardSku,
        rewardNote: p.rewardNote,
        category: p.category
          ? { id: p.category.id, name: p.category.name, isVisit: p.category.categoryType === "visit" }
          : null,
        startAt: p.startAt,
        endAt: p.endAt,
        progress: progressSummary(progress, p.threshold),
      },
    });
  } catch (err) {
    return handlePrismaError(err, res);
  }
});

module.exports = router;
