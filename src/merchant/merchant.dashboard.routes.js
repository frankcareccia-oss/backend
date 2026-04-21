/**
 * merchant.dashboard.routes.js — Merchant dashboard home data
 *
 * Three-section layout:
 *   1. Last week summary (final numbers)
 *   2. This week (scheduled + in motion)
 *   3. Needs attention (alerts requiring action)
 *
 * All queries hit pre-aggregated summary tables.
 */

"use strict";

const express = require("express");
const { prisma } = require("../db/prisma");
const { sendError } = require("../utils/errors");
const { requireJwt, requireMerchantRole } = require("../middleware/auth");
const { getMerchantCapabilities } = require("./merchant.capabilities");

const router = express.Router();

// ──────────────────────────────────────────────
// GET /merchant/capabilities
// ──────────────────────────────────────────────
router.get(
  "/merchant/capabilities",
  requireJwt,
  requireMerchantRole("owner", "merchant_admin"),
  async (req, res) => {
    try {
      const merchant = await prisma.merchant.findUnique({
        where: { id: req.merchantId },
        select: { teamSetupMode: true, teamSyncEnabled: true, teamSetupComplete: true },
      });
      if (!merchant) return sendError(res, 404, "NOT_FOUND", "Merchant not found");

      const caps = getMerchantCapabilities(merchant.teamSetupMode);
      return res.json({
        ...caps,
        teamSyncEnabled: merchant.teamSyncEnabled || false,
        teamSetupComplete: merchant.teamSetupComplete || false,
      });
    } catch (err) {
      console.error("[merchant.capabilities] error:", err?.message || err);
      return sendError(res, 500, "SERVER_ERROR", "Failed to load capabilities");
    }
  }
);

function getWeekBounds(weeksAgo = 0) {
  const now = new Date();
  const dayOfWeek = now.getUTCDay(); // 0=Sun
  const mondayOffset = dayOfWeek === 0 ? 6 : dayOfWeek - 1;

  const thisMonday = new Date(now);
  thisMonday.setUTCDate(now.getUTCDate() - mondayOffset - (weeksAgo * 7));
  thisMonday.setUTCHours(0, 0, 0, 0);

  const thisSunday = new Date(thisMonday);
  thisSunday.setUTCDate(thisMonday.getUTCDate() + 6);
  thisSunday.setUTCHours(23, 59, 59, 999);

  return { from: thisMonday, to: thisSunday };
}

function fmtDate(d) {
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

// ──────────────────────────────────────────────
// GET /merchant/dashboard/home
// ──────────────────────────────────────────────
router.get(
  "/merchant/dashboard/home",
  requireJwt,
  requireMerchantRole("owner", "merchant_admin"),
  async (req, res) => {
    try {
      const merchantId = req.merchantId;
      const lastWeek = getWeekBounds(1);
      const priorWeek = getWeekBounds(2);
      const thisWeek = getWeekBounds(0);
      const now = new Date();

      // ── Section 1: Last Week Summary ──────────────────

      const lastWeekSummaries = await prisma.merchantDailySummary.findMany({
        where: { merchantId, storeId: null, date: { gte: lastWeek.from, lte: lastWeek.to } },
      });
      const priorWeekSummaries = await prisma.merchantDailySummary.findMany({
        where: { merchantId, storeId: null, date: { gte: priorWeek.from, lte: priorWeek.to } },
      });

      const sum = (arr, f) => arr.reduce((s, r) => s + (r[f] || 0), 0);
      const trend = (cur, prev) => prev === 0 ? (cur > 0 ? 100 : 0) : Math.round(((cur - prev) / prev) * 100);

      const lastWeekKpis = {
        transactions: { value: sum(lastWeekSummaries, "totalTransactions"), trend: trend(sum(lastWeekSummaries, "totalTransactions"), sum(priorWeekSummaries, "totalTransactions")) },
        phoneCaptures: { value: sum(lastWeekSummaries, "attributedTransactions"), rate: lastWeekSummaries.length > 0 ? Math.round((sum(lastWeekSummaries, "attributedTransactions") / Math.max(1, sum(lastWeekSummaries, "totalTransactions"))) * 100) : 0 },
        stampsEarned: { value: sum(lastWeekSummaries, "stampsIssued"), trend: trend(sum(lastWeekSummaries, "stampsIssued"), sum(priorWeekSummaries, "stampsIssued")) },
        newMembers: { value: sum(lastWeekSummaries, "newEnrollments"), change: sum(lastWeekSummaries, "newEnrollments") - sum(priorWeekSummaries, "newEnrollments") },
      };

      // Capture rate by store
      const storeSummaries = await prisma.merchantDailySummary.findMany({
        where: { merchantId, storeId: { not: null }, date: { gte: lastWeek.from, lte: lastWeek.to } },
      });
      const storeMap = new Map();
      for (const s of storeSummaries) {
        if (!storeMap.has(s.storeId)) storeMap.set(s.storeId, []);
        storeMap.get(s.storeId).push(s);
      }
      const stores = await prisma.store.findMany({
        where: { merchantId, status: "active" },
        select: { id: true, name: true },
      });
      const storeNameMap = new Map(stores.map(s => [s.id, s.name]));

      const captureByStore = [...storeMap.entries()].map(([storeId, rows]) => ({
        storeId,
        storeName: storeNameMap.get(storeId) || `Store ${storeId}`,
        transactions: sum(rows, "totalTransactions"),
        attributed: sum(rows, "attributedTransactions"),
        captureRate: sum(rows, "totalTransactions") > 0
          ? Math.round((sum(rows, "attributedTransactions") / sum(rows, "totalTransactions")) * 100) : 0,
      }));

      // Reward pipeline
      const promoSummaries = await prisma.promotionDailySummary.findMany({
        where: { merchantId, date: { gte: lastWeek.from, lte: lastWeek.to } },
      });
      const rewardPipeline = {
        stampsTowardMilestone: sum(lastWeekSummaries, "stampsIssued"),
        milestonesReached: sum(promoSummaries, "rewardsRedeemed") + sum(lastWeekSummaries, "newEnrollments"),
        rewardsRedeemed: sum(lastWeekSummaries, "rewardsRedeemed"),
        totalEnrolled: await prisma.consumerPromoProgress.count({ where: { merchantId } }),
      };

      const lastWeekSection = {
        period: { from: lastWeek.from.toISOString().slice(0, 10), to: lastWeek.to.toISOString().slice(0, 10), label: `${fmtDate(lastWeek.from)}–${fmtDate(lastWeek.to)}` },
        kpis: lastWeekKpis,
        captureByStore,
        rewardPipeline,
      };

      // ── Section 2: This Week ──────────────────────────

      // Promotions going live this week
      const goingLive = await prisma.promotion.findMany({
        where: { merchantId, startAt: { gte: thisWeek.from, lte: thisWeek.to } },
        select: { id: true, name: true, startAt: true, status: true },
      });

      // Rewards expiring within 7 days
      const expiringRewards = await prisma.entitlement.findMany({
        where: {
          merchantId, type: "reward", status: "active",
          expiresAt: { gte: now, lte: new Date(now.getTime() + 7 * 86400000) },
        },
        select: { id: true, expiresAt: true, metadataJson: true },
      });

      // Active promotions
      const activePromos = await prisma.promotion.findMany({
        where: { merchantId, status: { in: ["active", "staged", "draft"] } },
        select: {
          id: true, name: true, status: true, promotionType: true, storeId: true,
          _count: { select: { progress: true } },
        },
        orderBy: { status: "asc" },
      });

      // Rewards ready at counter
      const rewardsReady = await prisma.entitlement.count({
        where: { merchantId, type: "reward", status: "active" },
      });
      const rewardsExpiring14d = await prisma.entitlement.count({
        where: {
          merchantId, type: "reward", status: "active",
          expiresAt: { gte: now, lte: new Date(now.getTime() + 14 * 86400000) },
        },
      });

      const thisWeekSection = {
        period: { from: thisWeek.from.toISOString().slice(0, 10), to: thisWeek.to.toISOString().slice(0, 10), label: `${fmtDate(thisWeek.from)}–${fmtDate(thisWeek.to)}` },
        events: {
          goingLive: goingLive.map(p => ({ id: p.id, name: p.name, date: p.startAt?.toISOString().slice(0, 10), status: p.status })),
          expiringRewards: { count: expiringRewards.length },
        },
        promotions: activePromos.map(p => ({
          id: p.id, name: p.name, status: p.status, promotionType: p.promotionType,
          storeId: p.storeId, enrolledCount: p._count.progress,
        })),
        rewardsPipeline: {
          ready: rewardsReady,
          expiring14d: rewardsExpiring14d,
        },
      };

      // ── Section 3: Needs Attention ────────────────────

      const alerts = [];

      // Attribution declining
      const thisWeekSummaries = await prisma.merchantDailySummary.findMany({
        where: { merchantId, storeId: null, date: { gte: thisWeek.from } },
      });
      const avgAttrThisWeek = thisWeekSummaries.length > 0
        ? thisWeekSummaries.reduce((s, r) => s + r.attributionRate, 0) / thisWeekSummaries.length : null;
      const avgAttrLastWeek = lastWeekSummaries.length > 0
        ? lastWeekSummaries.reduce((s, r) => s + r.attributionRate, 0) / lastWeekSummaries.length : null;

      if (avgAttrThisWeek != null && avgAttrLastWeek != null && avgAttrThisWeek < avgAttrLastWeek * 0.90) {
        // Check per-store for specific callout
        for (const store of captureByStore) {
          if (store.captureRate < 50) {
            alerts.push({
              severity: "watch",
              title: `${store.storeName} capture rate at ${store.captureRate}%`,
              description: `Phone capture is below 50% at this location. A quick team reminder about asking for phone numbers can turn this around.`,
              action: { label: "View details", to: `/merchant/reports` },
            });
          }
        }
      }

      // Stamps expiring soon
      const expiringStamps = await prisma.consumerPromoProgress.count({
        where: {
          merchantId, stampCount: { gt: 0 },
          lastEarnedAt: { lt: new Date(now.getTime() - 23 * 86400000) }, // within 7 days of 30-day expiry
          promotion: { timeframeDays: { not: null } },
        },
      });
      if (expiringStamps > 0) {
        alerts.push({
          severity: "watch",
          title: `${expiringStamps} members have stamps expiring soon`,
          description: `These customers are close to losing progress they've already earned. Consider a reminder or a bonus stamp offer.`,
          action: { label: "View members", to: `/merchant/promotions` },
        });
      }

      // Unactivated rewards
      const unactivated = await prisma.entitlement.count({
        where: { merchantId, type: "reward", status: "active" },
      });
      if (unactivated > 3) {
        alerts.push({
          severity: "action",
          title: `${unactivated} customers haven't used their rewards`,
          description: `These customers earned a reward but haven't redeemed it yet. They may not know it's waiting — a notification could help.`,
          action: { label: "View rewards", to: `/merchant/promotions` },
        });
      }

      // Promotions launching soon
      const launchingSoon = await prisma.promotion.findMany({
        where: {
          merchantId, status: "staged",
          startAt: { gte: now, lte: new Date(now.getTime() + 3 * 86400000) },
        },
        select: { id: true, name: true, startAt: true },
      });
      for (const p of launchingSoon) {
        const daysUntil = Math.ceil((new Date(p.startAt).getTime() - now.getTime()) / 86400000);
        alerts.push({
          severity: "info",
          title: `${p.name} launches in ${daysUntil} day${daysUntil === 1 ? "" : "s"}`,
          description: `Review the consumer description, terms, and settings before it goes live.`,
          action: { label: "Review promotion", to: `/merchant/promotions` },
        });
      }

      // Sort: critical > watch > action > info
      const severityOrder = { critical: 0, billing: 0, watch: 1, action: 2, info: 3 };
      alerts.sort((a, b) => (severityOrder[a.severity] || 9) - (severityOrder[b.severity] || 9));

      return res.json({
        lastWeek: lastWeekSection,
        thisWeek: thisWeekSection,
        alerts: { items: alerts, count: alerts.length },
      });
    } catch (err) {
      console.error("[merchant.dashboard] error:", err?.message || err);
      return sendError(res, 500, "SERVER_ERROR", "Failed to load dashboard");
    }
  }
);

module.exports = router;
