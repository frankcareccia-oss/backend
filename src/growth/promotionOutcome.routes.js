// src/growth/promotionOutcome.routes.js
//
// Promotion Outcomes API
//   GET  /merchant/promotion-outcomes           — list outcomes for all promotions
//   GET  /merchant/promotions/:id/outcomes       — single promotion outcome
//   POST /merchant/promotion-outcomes/recompute  — trigger recompute (on-demand)

"use strict";

const express = require("express");
const { prisma } = require("../db/prisma");
const { sendError, handlePrismaError } = require("../utils/errors");
const { requireJwt, requireMerchantRole } = require("../middleware/auth");
const { computePromotionOutcome, computeAllPromotionOutcomes } = require("./promotionOutcome.aggregate");
const { draftValidationInsight, generateDeterministicInsight } = require("../utils/aiDraft");
const { checkDivergence } = require("../merchant/simulator.projections");

const router = express.Router();

// GET /merchant/promotion-outcomes
router.get(
  "/merchant/promotion-outcomes",
  requireJwt,
  requireMerchantRole("owner", "merchant_admin"),
  async (req, res) => {
    try {
      const outcomes = await prisma.promotionOutcome.findMany({
        where: { merchantId: req.merchantId },
        include: {
          promotion: { select: { id: true, name: true, status: true, mechanic: true } },
        },
        orderBy: { computedAt: "desc" },
      });

      return res.json({
        items: outcomes.map((o) => ({
          promotionId: o.promotionId,
          promotionName: o.promotion.name,
          promotionStatus: o.promotion.status,
          startDate: o.startDate,
          endDate: o.endDate,
          clips: o.clips,
          qualifiedPurchases: o.qualifiedPurchases,
          rewardsGranted: o.rewardsGranted,
          rewardsRedeemed: o.rewardsRedeemed,
          metrics: {
            redemptionRate: o.redemptionRate,
            repeatVisitLift: o.repeatVisitLift,
            aovLift: o.aovLift,
            revenueLift: o.revenueLift,
            timeSlotLift: o.timeSlotLift,
          },
          baseline: {
            aovCents: o.baselineAovCents,
            dailyRevenueCents: o.baselineRevenueCents,
          },
          computedAt: o.computedAt,
        })),
      });
    } catch (err) {
      return handlePrismaError(err, res);
    }
  }
);

// GET /merchant/promotions/:id/outcomes
router.get(
  "/merchant/promotions/:id/outcomes",
  requireJwt,
  requireMerchantRole("owner", "merchant_admin"),
  async (req, res) => {
    try {
      const promotionId = parseInt(req.params.id, 10);
      if (!promotionId) return sendError(res, 400, "VALIDATION_ERROR", "Invalid promotion id");

      // Verify promotion belongs to this merchant
      const promo = await prisma.promotion.findFirst({
        where: { id: promotionId, merchantId: req.merchantId },
        select: { id: true, name: true, status: true },
      });
      if (!promo) return sendError(res, 404, "NOT_FOUND", "Promotion not found");

      // Recompute fresh
      const outcome = await computePromotionOutcome(prisma, { promotionId });

      if (!outcome) {
        return res.json({
          promotionId,
          promotionName: promo.name,
          message: "No outcome data available yet",
        });
      }

      return res.json({
        promotionId,
        promotionName: promo.name,
        metrics: {
          redemptionRate: outcome.redemptionRate,
          repeatVisitLift: outcome.repeatVisitLift,
          aovLift: outcome.aovLift,
          revenueLift: outcome.revenueLift,
        },
        activity: {
          clips: outcome.clips,
          qualifiedPurchases: outcome.qualifiedPurchases,
          rewardsGranted: outcome.rewardsGranted,
          rewardsRedeemed: outcome.rewardsRedeemed,
        },
        baseline: {
          aovCents: outcome.baselineAovCents,
          dailyRevenueCents: outcome.baselineRevenueCents,
        },
        computedAt: outcome.computedAt,
      });
    } catch (err) {
      return handlePrismaError(err, res);
    }
  }
);

// POST /merchant/promotion-outcomes/recompute
router.post(
  "/merchant/promotion-outcomes/recompute",
  requireJwt,
  requireMerchantRole("owner", "merchant_admin"),
  async (req, res) => {
    try {
      await computeAllPromotionOutcomes(prisma);
      return res.json({ ok: true, message: "Outcomes recomputed" });
    } catch (err) {
      return handlePrismaError(err, res);
    }
  }
);

// GET /merchant/promotions/:promotionId/validation
// Returns projected vs actual comparison + AI insight for a promotion
router.get(
  "/merchant/promotions/:promotionId/validation",
  requireJwt,
  requireMerchantRole("owner", "merchant_admin"),
  async (req, res) => {
    try {
      const promotionId = parseInt(req.params.promotionId, 10);
      if (!promotionId) return sendError(res, 400, "VALIDATION_ERROR", "Invalid promotionId");

      const promotion = await prisma.promotion.findFirst({
        where: { id: promotionId, merchantId: req.merchantId },
        select: { id: true, name: true, objective: true, firstActivatedAt: true, merchant: { select: { name: true } } },
      });
      if (!promotion) return sendError(res, 404, "NOT_FOUND", "Promotion not found");

      // Get outcome data
      const outcome = await prisma.promotionOutcome.findFirst({
        where: { promotionId },
        orderBy: { computedAt: "desc" },
      });

      if (!outcome || !outcome.durationDays || outcome.durationDays < 14) {
        const daysActive = promotion.firstActivatedAt
          ? Math.ceil((Date.now() - new Date(promotion.firstActivatedAt).getTime()) / (1000 * 60 * 60 * 24))
          : 0;
        return res.json({
          ready: false,
          daysActive,
          daysNeeded: Math.max(0, 14 - daysActive),
          message: `Need ${Math.max(0, 14 - daysActive)} more days of data for validation.`,
        });
      }

      // Check divergence
      const divergence = checkDivergence(
        outcome.costProjectedCents || outcome.revenueProjectedCents,
        outcome.costActualCents || outcome.revenueActualCents
      );

      // Generate insight
      let insight = null;
      if (divergence) {
        try {
          insight = await draftValidationInsight({
            merchantName: promotion.merchant.name,
            promotionName: promotion.name,
            objective: outcome.objective,
            projectedValue: outcome.primaryMetricProjected,
            actualValue: outcome.primaryMetricActual,
            divergencePct: divergence.divergencePct,
            attributionRate: outcome.attributionRateAvg,
            durationDays: outcome.durationDays,
            direction: divergence.direction,
          });
        } catch {
          insight = generateDeterministicInsight({
            promotionName: promotion.name,
            divergencePct: divergence.divergencePct,
            direction: divergence.direction,
            attributionRate: outcome.attributionRateAvg,
            durationDays: outcome.durationDays,
          });
        }
      }

      return res.json({
        ready: true,
        outcome: {
          objective: outcome.objective,
          durationDays: outcome.durationDays,
          primaryMetricProjected: outcome.primaryMetricProjected,
          primaryMetricActual: outcome.primaryMetricActual,
          revenueProjectedCents: outcome.revenueProjectedCents,
          revenueActualCents: outcome.revenueActualCents,
          costProjectedCents: outcome.costProjectedCents,
          costActualCents: outcome.costActualCents,
          enrollmentProjected: outcome.enrollmentProjected,
          enrollmentActual: outcome.enrollmentActual,
          attributionRateAvg: outcome.attributionRateAvg,
          redemptionRate: outcome.redemptionRate,
          aovLift: outcome.aovLift,
          repeatVisitLift: outcome.repeatVisitLift,
        },
        divergence,
        insight,
      });
    } catch (err) {
      return handlePrismaError(err, res);
    }
  }
);

module.exports = router;
