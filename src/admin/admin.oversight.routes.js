/**
 * admin.oversight.routes.js — PV Admin oversight dashboard API
 *
 * Platform-wide KPIs, merchant health scores, system alerts.
 * All queries hit pre-aggregated summary tables — fast responses.
 *
 * GET /admin/oversight/dashboard  — full platform overview
 * GET /admin/oversight/merchants  — merchant health grid
 * GET /admin/oversight/alerts     — active alerts
 */

"use strict";

const express = require("express");
const { prisma } = require("../db/prisma");
const { sendError } = require("../utils/errors");
const { requireJwt, requireAdmin } = require("../middleware/auth");
const { emitPvHook } = require("../utils/hooks");

const router = express.Router();

function daysAgo(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

// ──────────────────────────────────────────────
// GET /admin/oversight/dashboard
// Platform-wide KPIs
// ──────────────────────────────────────────────
router.get("/admin/oversight/dashboard", requireJwt, requireAdmin, async (req, res) => {
  try {
    const sevenDaysAgo = daysAgo(7);
    const fourteenDaysAgo = daysAgo(14);
    const thirtyDaysAgo = daysAgo(30);

    // Platform-wide summaries (storeId=null = merchant-level aggregates)
    const recentSummaries = await prisma.merchantDailySummary.findMany({
      where: { storeId: null, date: { gte: sevenDaysAgo } },
    });
    const priorSummaries = await prisma.merchantDailySummary.findMany({
      where: { storeId: null, date: { gte: fourteenDaysAgo, lt: sevenDaysAgo } },
    });

    const sum = (arr, field) => arr.reduce((s, r) => s + (r[field] || 0), 0);
    const avg = (arr, field) => arr.length > 0 ? arr.reduce((s, r) => s + (r[field] || 0), 0) / arr.length : 0;

    const trend = (cur, prev) => prev === 0 ? (cur > 0 ? 100 : 0) : Math.round(((cur - prev) / prev) * 100);

    // Platform KPIs
    const kpis = {
      totalTransactions: {
        value: sum(recentSummaries, "totalTransactions"),
        trend: trend(sum(recentSummaries, "totalTransactions"), sum(priorSummaries, "totalTransactions")),
        label: "Transactions (7d)",
      },
      attributedTransactions: {
        value: sum(recentSummaries, "attributedTransactions"),
        trend: trend(sum(recentSummaries, "attributedTransactions"), sum(priorSummaries, "attributedTransactions")),
        label: "Attributed (7d)",
      },
      platformAttributionRate: {
        value: Math.round(avg(recentSummaries, "attributionRate") * 100),
        trend: trend(avg(recentSummaries, "attributionRate"), avg(priorSummaries, "attributionRate")),
        label: "Attribution Rate",
      },
      newEnrollments: {
        value: sum(recentSummaries, "newEnrollments"),
        trend: trend(sum(recentSummaries, "newEnrollments"), sum(priorSummaries, "newEnrollments")),
        label: "New Enrollments (7d)",
      },
      rewardsRedeemed: {
        value: sum(recentSummaries, "rewardsRedeemed"),
        trend: trend(sum(recentSummaries, "rewardsRedeemed"), sum(priorSummaries, "rewardsRedeemed")),
        label: "Rewards Redeemed (7d)",
      },
      redemptionValueCents: {
        value: sum(recentSummaries, "redemptionValueCents"),
        trend: trend(sum(recentSummaries, "redemptionValueCents"), sum(priorSummaries, "redemptionValueCents")),
        label: "Redemption Value (7d)",
      },
    };

    // Merchant counts
    const [totalMerchants, activeMerchants, totalStores, totalConsumers, totalPromotions] = await Promise.all([
      prisma.merchant.count(),
      prisma.merchant.count({ where: { status: "active" } }),
      prisma.store.count({ where: { status: "active" } }),
      prisma.consumer.count(),
      prisma.promotion.count({ where: { status: "active" } }),
    ]);

    // Recent cron health
    const cronJobs = await prisma.cronJobLog.findMany({
      orderBy: { startedAt: "desc" },
      take: 10,
      select: { jobName: true, status: true, startedAt: true, durationMs: true },
    });
    const cronHealth = {
      lastRun: cronJobs[0]?.startedAt || null,
      allOk: cronJobs.slice(0, 6).every(c => c.status === "ok"),
      failedRecently: cronJobs.filter(c => c.status === "failed").length,
    };

    emitPvHook("admin.oversight.dashboard.viewed", {
      tc: "TC-ADMIN-OVERSIGHT-01", sev: "info", stable: "admin:oversight:view",
    });

    return res.json({
      kpis,
      counts: { totalMerchants, activeMerchants, totalStores, totalConsumers, totalPromotions },
      cronHealth,
    });
  } catch (err) {
    console.error("[admin.oversight] dashboard error:", err?.message || err);
    return sendError(res, 500, "SERVER_ERROR", "Failed to load oversight dashboard");
  }
});

// ──────────────────────────────────────────────
// GET /admin/oversight/merchants
// Merchant health grid — one row per merchant with key health indicators
// ──────────────────────────────────────────────
router.get("/admin/oversight/merchants", requireJwt, requireAdmin, async (req, res) => {
  try {
    const sevenDaysAgo = daysAgo(7);

    const merchants = await prisma.merchant.findMany({
      where: { status: "active" },
      select: {
        id: true, name: true, merchantType: true, isSeedMerchant: true,
        stores: { where: { status: "active" }, select: { id: true } },
        promotions: { where: { status: "active" }, select: { id: true, promotionType: true } },
        posConnections: { where: { status: "active" }, select: { posType: true } },
      },
      orderBy: { name: "asc" },
    });

    // Get recent summaries per merchant
    const summaries = await prisma.merchantDailySummary.findMany({
      where: { storeId: null, date: { gte: sevenDaysAgo } },
    });
    const summaryMap = new Map();
    for (const s of summaries) {
      if (!summaryMap.has(s.merchantId)) summaryMap.set(s.merchantId, []);
      summaryMap.get(s.merchantId).push(s);
    }

    const merchantHealth = merchants.map(m => {
      const rows = summaryMap.get(m.id) || [];
      const totalTxns = rows.reduce((s, r) => s + r.totalTransactions, 0);
      const attrRate = rows.length > 0 ? rows.reduce((s, r) => s + r.attributionRate, 0) / rows.length : 0;
      const enrollments = rows.reduce((s, r) => s + r.newEnrollments, 0);
      const redeemed = rows.reduce((s, r) => s + r.rewardsRedeemed, 0);

      // Health score: 0-100 based on data flowing, attribution, engagement
      let healthScore = 0;
      if (totalTxns > 0) healthScore += 30; // data flowing
      if (attrRate > 0.5) healthScore += 25; // good attribution
      else if (attrRate > 0.3) healthScore += 15;
      if (m.promotions.length > 0) healthScore += 20; // has active promos
      if (m.posConnections.length > 0) healthScore += 15; // POS connected
      if (enrollments > 0) healthScore += 10; // consumers enrolling

      return {
        id: m.id,
        name: m.name,
        merchantType: m.merchantType,
        isSeedMerchant: m.isSeedMerchant,
        storeCount: m.stores.length,
        activePromos: m.promotions.length,
        promoTypes: [...new Set(m.promotions.map(p => p.promotionType))],
        posTypes: m.posConnections.map(c => c.posType),
        weeklyTransactions: totalTxns,
        attributionRate: Math.round(attrRate * 100),
        weeklyEnrollments: enrollments,
        weeklyRedemptions: redeemed,
        healthScore,
      };
    });

    return res.json({ merchants: merchantHealth });
  } catch (err) {
    console.error("[admin.oversight] merchants error:", err?.message || err);
    return sendError(res, 500, "SERVER_ERROR", "Failed to load merchant health");
  }
});

// ──────────────────────────────────────────────
// GET /admin/oversight/alerts
// Active platform alerts
// ──────────────────────────────────────────────
router.get("/admin/oversight/alerts", requireJwt, requireAdmin, async (req, res) => {
  try {
    const alerts = [];
    const sevenDaysAgo = daysAgo(7);

    // 1. Merchants with zero transactions in 7 days (excludes seed merchants)
    const merchants = await prisma.merchant.findMany({
      where: { status: "active", isSeedMerchant: false },
      select: { id: true, name: true },
    });
    const recentSummaries = await prisma.merchantDailySummary.findMany({
      where: { storeId: null, date: { gte: sevenDaysAgo } },
      select: { merchantId: true, totalTransactions: true },
    });
    const txnMap = new Map();
    for (const s of recentSummaries) {
      txnMap.set(s.merchantId, (txnMap.get(s.merchantId) || 0) + s.totalTransactions);
    }
    for (const m of merchants) {
      if (!txnMap.has(m.id) || txnMap.get(m.id) === 0) {
        alerts.push({
          type: "no_transactions",
          severity: "warning",
          merchantId: m.id,
          merchantName: m.name,
          message: `${m.name} has had no transactions in the last 7 days`,
        });
      }
    }

    // 2. Failed cron jobs
    const failedCrons = await prisma.cronJobLog.findMany({
      where: { status: "failed", startedAt: { gte: sevenDaysAgo } },
      select: { jobName: true, startedAt: true, error: true },
    });
    for (const c of failedCrons) {
      alerts.push({
        type: "cron_failure",
        severity: "error",
        message: `Cron job "${c.jobName}" failed at ${c.startedAt.toISOString().slice(0, 16)}`,
        detail: c.error,
      });
    }

    // 3. Low attribution across platform
    const avgAttr = recentSummaries.length > 0
      ? recentSummaries.reduce((s, r) => s + (r.totalTransactions || 0), 0)
      : 0;
    // (This is a simplified check — could be expanded)

    // 4. Merchants with POS connection issues
    const disconnected = await prisma.posConnection.findMany({
      where: { status: { not: "active" } },
      select: { merchantId: true, posType: true, status: true },
    });
    const disconnectedMerchants = new Set();
    for (const d of disconnected) {
      if (disconnectedMerchants.has(d.merchantId)) continue;
      disconnectedMerchants.add(d.merchantId);
      const m = await prisma.merchant.findUnique({ where: { id: d.merchantId }, select: { name: true } });
      alerts.push({
        type: "pos_disconnected",
        severity: "warning",
        merchantId: d.merchantId,
        merchantName: m?.name || `Merchant ${d.merchantId}`,
        message: `${m?.name || "Merchant"} has a ${d.posType} connection in "${d.status}" state`,
      });
    }

    // Sort: errors first, then warnings
    alerts.sort((a, b) => (a.severity === "error" ? 0 : 1) - (b.severity === "error" ? 0 : 1));

    return res.json({ alerts, count: alerts.length });
  } catch (err) {
    console.error("[admin.oversight] alerts error:", err?.message || err);
    return sendError(res, 500, "SERVER_ERROR", "Failed to load alerts");
  }
});

module.exports = router;
