// src/growth/growth.routes.js
//
// Growth Advisor API
//   GET /merchant/growth-advisor — returns summary, metrics, insights, recommendations

"use strict";

const express = require("express");
const { prisma } = require("../db/prisma");
const { sendError, handlePrismaError } = require("../utils/errors");
const { requireJwt, requireMerchantRole } = require("../middleware/auth");
const { getMerchantGrowthMetrics, enrichWithV2Metrics } = require("./growth.metrics.service");
const { detectGrowthPatterns } = require("./growth.patterns");
const { selectPlaybooks } = require("./growth.playbooks");
const { buildGrowthSummary } = require("./growth.summary");
const { draftGrowthSummary } = require("../utils/aiDraft");
const { canAccess, upgradeRoute } = require("../utils/feature.gate");

const router = express.Router();

// GET /merchant/growth-advisor
router.get(
  "/merchant/growth-advisor",
  requireJwt,
  requireMerchantRole("owner", "merchant_admin"),
  async (req, res) => {
    try {
      const merchantId = req.merchantId;

      // Feature gate: Growth Advisor is Value-Added only
      const merchant = await prisma.merchant.findUnique({
        where: { id: merchantId },
        select: { id: true, planTier: true, acquisitionPath: true },
      });
      const gate = canAccess(merchant, "growth_advisor");
      if (!gate.allowed) {
        return sendError(res, 403, "UPGRADE_REQUIRED", "Growth Advisor requires the Value-Added plan", { upgrade: upgradeRoute(merchant) });
      }
      const storeId = req.query.storeId ? parseInt(req.query.storeId, 10) : undefined;

      // Step 1: Aggregate metrics + v2 enrichment
      const baseMetrics = await getMerchantGrowthMetrics(prisma, { merchantId, storeId });
      const metrics = await enrichWithV2Metrics(prisma, baseMetrics, { merchantId });

      // Step 2: Detect patterns (v1 + v2)
      const patterns = detectGrowthPatterns(metrics);

      // Step 3: Select and personalize playbooks
      const recommendations = selectPlaybooks(patterns, metrics);

      // Build insights from playbook output
      const insights = recommendations
        .filter((r) => r.playbookId !== "starter_playbook")
        .map((r) => r.insight);

      // Step 4: Compose summary — AI enhanced with deterministic fallback
      const deterministicSummary = buildGrowthSummary(metrics, patterns, recommendations);
      const aiSummary = await draftGrowthSummary({ metrics, insights, recommendations });
      const summary = aiSummary || deterministicSummary;

      return res.json({
        summary,
        metrics: {
          period: metrics.period,
          aov: metrics.aov,
          totalRevenue: metrics.totalRevenue,
          totalOrders: metrics.totalOrders,
          totalVisits: metrics.totalVisits,
          uniqueConsumers: metrics.uniqueConsumers,
          repeatRate: metrics.repeatRate,
          visitFrequencyDays: metrics.visitFrequencyDays,
          firstToSecondVisitRate: metrics.firstToSecondVisitRate,
        },
        insights,
        recommendations,
      });
    } catch (err) {
      return handlePrismaError(err, res);
    }
  }
);

module.exports = router;
