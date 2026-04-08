// src/growth/growth.routes.js
//
// Growth Advisor API
//   GET /merchant/growth-advisor — returns summary, metrics, insights, recommendations

"use strict";

const express = require("express");
const { prisma } = require("../db/prisma");
const { sendError, handlePrismaError } = require("../utils/errors");
const { requireJwt, requireMerchantRole } = require("../middleware/auth");
const { getMerchantGrowthMetrics } = require("./growth.metrics.service");
const { detectGrowthPatterns } = require("./growth.patterns");
const { buildGrowthRecommendations } = require("./growth.recommendations");
const { buildGrowthSummary } = require("./growth.summary");

const router = express.Router();

// GET /merchant/growth-advisor
router.get(
  "/merchant/growth-advisor",
  requireJwt,
  requireMerchantRole("owner", "merchant_admin"),
  async (req, res) => {
    try {
      const merchantId = req.merchantId;
      const storeId = req.query.storeId ? parseInt(req.query.storeId, 10) : undefined;

      // Step 1: Aggregate metrics
      const metrics = await getMerchantGrowthMetrics(prisma, { merchantId, storeId });

      // Step 2: Detect patterns
      const patterns = detectGrowthPatterns(metrics);

      // Step 3: Build recommendations
      const recommendations = buildGrowthRecommendations(metrics, patterns);

      // Step 4: Compose summary
      const summary = buildGrowthSummary(metrics, patterns, recommendations);

      // Build insights from patterns (human-readable)
      const insights = patterns
        .filter((p) => p.type !== "insufficient_data")
        .map((p) => patternToInsight(p, metrics));

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

/**
 * Convert a pattern object to a human-readable insight string.
 */
function patternToInsight(pattern, metrics) {
  switch (pattern.type) {
    case "low_repeat":
      return `Repeat rate is ${Math.round(pattern.detail.repeatRate * 100)}% — below the ${Math.round(pattern.detail.threshold * 100)}% target.`;

    case "slow_afternoon":
      return `Afternoon revenue is only ${pattern.detail.ratio}% of morning revenue — a significant gap.`;

    case "low_aov":
      return `Average order value is $${(metrics.aov / 100).toFixed(2)} — below the $${(pattern.detail.threshold / 100).toFixed(2)} target.`;

    case "high_concentration": {
      const names = pattern.detail.topProducts?.join(", ");
      return `Top 3 products (${names}) generate ${pattern.detail.top3Pct}% of revenue.`;
    }

    case "low_first_to_second":
      return `Only ${Math.round(pattern.detail.rate * 100)}% of first-time visitors return — below the ${Math.round(pattern.detail.threshold * 100)}% target.`;

    default:
      return null;
  }
}

module.exports = router;
