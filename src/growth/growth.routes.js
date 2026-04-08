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
const { selectPlaybooks } = require("./growth.playbooks");
const { buildGrowthSummary } = require("./growth.summary");
const { draftGrowthSummary } = require("../utils/aiDraft");

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
