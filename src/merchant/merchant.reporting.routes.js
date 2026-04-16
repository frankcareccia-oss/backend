/**
 * merchant.reporting.routes.js — Reporting dashboard API
 *
 * All queries hit pre-aggregated summary tables only.
 * Target: <50ms response time regardless of merchant volume.
 *
 * GET /merchant/reporting/dashboard  — full dashboard data in one call
 * GET /merchant/reporting/stores     — store list for selector
 * GET /merchant/reporting/promotions/:id — detailed promotion performance
 * GET /merchant/reporting/simulator/:promotionId — simulator baseline data
 * GET /merchant/reporting/simulator/new/:promotionType — new promotion simulator
 */

"use strict";

const express = require("express");
const { prisma } = require("../db/prisma");
const { sendError } = require("../utils/errors");
const { requireJwt } = require("../middleware/auth");

const router = express.Router();

// Apply JWT auth to all reporting routes
router.use("/merchant/reporting", requireJwt);

// Resolve merchantId from JWT (merchant user)
async function getMerchantId(req) {
  if (!req.userId) return null;
  const mu = await prisma.merchantUser.findFirst({
    where: { userId: req.userId, status: "active" },
    select: { merchantId: true },
  });
  return mu?.merchantId || null;
}

function daysAgo(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function yesterday() {
  return daysAgo(1);
}

function resolvePeriod(period, from, to) {
  if (period === "7d") return { from: daysAgo(7), to: yesterday(), label: "Last 7 days" };
  if (period === "90d") return { from: daysAgo(90), to: yesterday(), label: "Last 90 days" };
  if (period === "custom" && from && to) {
    return { from: new Date(from), to: new Date(to), label: `${from} to ${to}` };
  }
  return { from: daysAgo(30), to: yesterday(), label: "Last 30 days" };
}

function computeTrend(current, prior) {
  if (prior === 0 && current === 0) return { trend: "flat", trendPct: 0 };
  if (prior === 0) return { trend: "up", trendPct: 100 };
  const pct = ((current - prior) / prior) * 100;
  return {
    trend: pct > 1 ? "up" : pct < -1 ? "down" : "flat",
    trendPct: Math.round(pct * 10) / 10,
  };
}

// ──────────────────────────────────────────────
// GET /merchant/reporting/dashboard
// ──────────────────────────────────────────────
router.get("/merchant/reporting/dashboard", async (req, res) => {
  try {
    const merchantId = await getMerchantId(req);
    if (!merchantId) return sendError(res, 403, "FORBIDDEN", "Not authorized");

    const { period, from, to, storeId } = req.query;
    const p = resolvePeriod(period, from, to);
    const storeFilter = storeId && storeId !== "all" ? parseInt(storeId, 10) : null;

    // Current period data
    const current = await prisma.merchantDailySummary.findMany({
      where: {
        merchantId,
        storeId: storeFilter,
        date: { gte: p.from, lte: p.to },
      },
      orderBy: { date: "asc" },
    });

    // Prior period (same duration, immediately before)
    const durationMs = p.to.getTime() - p.from.getTime();
    const priorFrom = new Date(p.from.getTime() - durationMs);
    const priorTo = new Date(p.from.getTime() - 1);

    const prior = await prisma.merchantDailySummary.findMany({
      where: {
        merchantId,
        storeId: storeFilter,
        date: { gte: priorFrom, lte: priorTo },
      },
    });

    // Aggregate current + prior
    const sum = (arr, field) => arr.reduce((s, r) => s + (r[field] || 0), 0);
    const avg = (arr, field) => arr.length > 0 ? arr.reduce((s, r) => s + (r[field] || 0), 0) / arr.length : 0;

    const kpis = {
      totalTransactions: { value: sum(current, "totalTransactions"), ...computeTrend(sum(current, "totalTransactions"), sum(prior, "totalTransactions")) },
      attributionRate: { value: Math.round(avg(current, "attributionRate") * 100), ...computeTrend(avg(current, "attributionRate"), avg(prior, "attributionRate")) },
      activeMembers: { value: sum(current, "activeConsumers"), ...computeTrend(sum(current, "activeConsumers"), sum(prior, "activeConsumers")) },
      rewardsRedeemed: { value: sum(current, "rewardsRedeemed"), ...computeTrend(sum(current, "rewardsRedeemed"), sum(prior, "rewardsRedeemed")) },
      budgetConsumedCents: { value: sum(current, "budgetConsumedCents"), ...computeTrend(sum(current, "budgetConsumedCents"), sum(prior, "budgetConsumedCents")) },
      newEnrollments: { value: sum(current, "newEnrollments"), ...computeTrend(sum(current, "newEnrollments"), sum(prior, "newEnrollments")) },
    };

    // Time series
    const timeSeries = current.map(row => ({
      date: row.date.toISOString().slice(0, 10),
      totalTransactions: row.totalTransactions,
      attributedTransactions: row.attributedTransactions,
      attributionRate: Math.round(row.attributionRate * 100),
      newEnrollments: row.newEnrollments,
      stampsIssued: row.stampsIssued,
      rewardsRedeemed: row.rewardsRedeemed,
      redemptionValueCents: row.redemptionValueCents,
      checkins: row.checkins,
    }));

    // Consumer engagement (latest day)
    const latestEngagement = await prisma.consumerEngagementSummary.findFirst({
      where: { merchantId, storeId: storeFilter, date: { lte: p.to } },
      orderBy: { date: "desc" },
    });

    const engagement = latestEngagement ? {
      visitFrequency: {
        visitedOnce: latestEngagement.visitedOnce,
        visited2to3: latestEngagement.visited2to3,
        visited4to7: latestEngagement.visited4to7,
        visited8plus: latestEngagement.visited8plus,
      },
      stampProgress: {
        progress0to25: latestEngagement.progress0to25,
        progress25to50: latestEngagement.progress25to50,
        progress50to75: latestEngagement.progress50to75,
        progress75to100: latestEngagement.progress75to100,
        rewardReady: latestEngagement.rewardReady,
      },
      churnRisk: {
        inactiveDays30: latestEngagement.inactiveDays30,
        inactiveDays60: latestEngagement.inactiveDays60,
        inactiveDays90: latestEngagement.inactiveDays90,
      },
    } : null;

    // Store breakdown (when viewing all stores)
    let storeBreakdown = null;
    if (!storeFilter) {
      const storeRows = await prisma.merchantDailySummary.findMany({
        where: { merchantId, storeId: { not: null }, date: { gte: p.from, lte: p.to } },
      });
      const storeMap = new Map();
      for (const row of storeRows) {
        if (!storeMap.has(row.storeId)) storeMap.set(row.storeId, []);
        storeMap.get(row.storeId).push(row);
      }
      const stores = await prisma.store.findMany({ where: { merchantId }, select: { id: true, name: true } });
      const storeNameMap = new Map(stores.map(s => [s.id, s.name]));

      storeBreakdown = [...storeMap.entries()].map(([sid, rows]) => ({
        storeId: sid,
        storeName: storeNameMap.get(sid) || `Store ${sid}`,
        totalTransactions: sum(rows, "totalTransactions"),
        attributionRate: Math.round(avg(rows, "attributionRate") * 100),
        rewardsRedeemed: sum(rows, "rewardsRedeemed"),
        activeMembers: sum(rows, "activeConsumers"),
      }));
    }

    // Promotion performance
    const promoSummaries = await prisma.promotionDailySummary.findMany({
      where: { merchantId, date: { gte: p.from, lte: p.to } },
    });
    const promoMap = new Map();
    for (const row of promoSummaries) {
      if (!promoMap.has(row.promotionId)) promoMap.set(row.promotionId, []);
      promoMap.get(row.promotionId).push(row);
    }
    const promos = await prisma.promotion.findMany({
      where: { merchantId },
      select: { id: true, name: true, status: true },
    });

    const promotions = promos.map(promo => {
      const rows = promoMap.get(promo.id) || [];
      return {
        promotionId: promo.id,
        name: promo.name,
        status: promo.status,
        totalEnrolled: rows.length > 0 ? rows[rows.length - 1].totalEnrolled : 0,
        rewardsRedeemed: sum(rows, "rewardsRedeemed"),
        redemptionValueCents: sum(rows, "redemptionValueCents"),
        rewardsExpired: sum(rows, "rewardsExpired"),
      };
    });

    const storeName = storeFilter
      ? (await prisma.store.findUnique({ where: { id: storeFilter }, select: { name: true } }))?.name || "Store"
      : "All Stores";

    return res.json({
      period: { from: p.from.toISOString().slice(0, 10), to: p.to.toISOString().slice(0, 10), label: p.label },
      store: { id: storeFilter, name: storeName },
      kpis,
      timeSeries,
      engagement,
      storeBreakdown,
      promotions,
    });
  } catch (err) {
    console.error("[reporting.dashboard] error:", err);
    return sendError(res, 500, "SERVER_ERROR", "Could not load dashboard data");
  }
});

// ──────────────────────────────────────────────
// GET /merchant/reporting/stores
// ──────────────────────────────────────────────
router.get("/merchant/reporting/stores", async (req, res) => {
  try {
    const merchantId = await getMerchantId(req);
    if (!merchantId) return sendError(res, 403, "FORBIDDEN", "Not authorized");

    const stores = await prisma.store.findMany({
      where: { merchantId },
      select: { id: true, name: true, status: true },
      orderBy: { name: "asc" },
    });

    return res.json(stores);
  } catch (err) {
    return sendError(res, 500, "SERVER_ERROR", err.message);
  }
});

// ──────────────────────────────────────────────
// GET /merchant/reporting/promotions/:id
// ──────────────────────────────────────────────
router.get("/merchant/reporting/promotions/:id", async (req, res) => {
  try {
    const merchantId = await getMerchantId(req);
    if (!merchantId) return sendError(res, 403, "FORBIDDEN", "Not authorized");

    const promotionId = parseInt(req.params.id, 10);
    const { period, from, to } = req.query;
    const p = resolvePeriod(period, from, to);

    const promotion = await prisma.promotion.findFirst({
      where: { id: promotionId, merchantId },
      select: {
        id: true, name: true, threshold: true, rewardType: true, rewardValue: true,
        rewardNote: true, rewardExpiryDays: true, promotionType: true, status: true,
      },
    });
    if (!promotion) return sendError(res, 404, "NOT_FOUND", "Promotion not found");

    const rows = await prisma.promotionDailySummary.findMany({
      where: { promotionId, date: { gte: p.from, lte: p.to } },
      orderBy: { date: "asc" },
    });

    const sum = (arr, f) => arr.reduce((s, r) => s + (r[f] || 0), 0);

    return res.json({
      promotion,
      summary: {
        totalEnrolled: rows.length > 0 ? rows[rows.length - 1].totalEnrolled : 0,
        rewardsRedeemed: sum(rows, "rewardsRedeemed"),
        redemptionValueCents: sum(rows, "redemptionValueCents"),
        rewardsExpired: sum(rows, "rewardsExpired"),
      },
      timeSeries: rows.map(r => ({
        date: r.date.toISOString().slice(0, 10),
        newEnrollments: r.newEnrollments,
        rewardsRedeemed: r.rewardsRedeemed,
        redemptionValueCents: r.redemptionValueCents,
        activeParticipants: r.activeParticipants,
      })),
    });
  } catch (err) {
    return sendError(res, 500, "SERVER_ERROR", err.message);
  }
});

// ──────────────────────────────────────────────
// GET /merchant/reporting/simulator/new/:promotionType
// Simulator baseline for new (not-yet-created) promotion
// NOTE: Must be registered BEFORE :promotionId route
// ──────────────────────────────────────────────
router.get("/merchant/reporting/simulator/new/:promotionType", async (req, res) => {
  try {
    const merchantId = await getMerchantId(req);
    if (!merchantId) return sendError(res, 403, "FORBIDDEN", "Not authorized");

    const baseline = await computeBaseline(merchantId);

    return res.json({
      promotionType: req.params.promotionType,
      historical: [],
      baseline,
      lockedFields: [],
    });
  } catch (err) {
    return sendError(res, 500, "SERVER_ERROR", err.message);
  }
});

// ──────────────────────────────────────────────
// GET /merchant/reporting/simulator/:promotionId
// Simulator baseline data for existing promotion
// ──────────────────────────────────────────────
router.get("/merchant/reporting/simulator/:promotionId", async (req, res) => {
  try {
    const merchantId = await getMerchantId(req);
    if (!merchantId) return sendError(res, 403, "FORBIDDEN", "Not authorized");

    const promotionId = parseInt(req.params.promotionId, 10);

    const promotion = await prisma.promotion.findFirst({
      where: { id: promotionId, merchantId },
    });
    if (!promotion) return sendError(res, 404, "NOT_FOUND", "Promotion not found");

    const enrolledCount = await prisma.consumerPromoProgress.count({ where: { promotionId } });

    // Historical performance
    const historical = await prisma.promotionDailySummary.findMany({
      where: { promotionId },
      orderBy: { date: "asc" },
      select: { date: true, newEnrollments: true, rewardsRedeemed: true, redemptionValueCents: true, activeParticipants: true },
    });

    // Merchant baseline (last 30 days)
    const baseline = await computeBaseline(merchantId);

    // Locked fields (if consumers are enrolled, core params are locked)
    const lockedFields = enrolledCount > 0
      ? ["stampThreshold", "rewardValue"]
      : [];

    return res.json({
      promotion: {
        id: promotion.id,
        name: promotion.name,
        promotionType: promotion.promotionType,
        currentParams: {
          stampThreshold: promotion.threshold,
          rewardValueCents: promotion.rewardValue,
          rewardType: promotion.rewardType,
          expiryDays: promotion.rewardExpiryDays,
        },
        enrolledCount,
        startDate: promotion.firstActivatedAt || promotion.createdAt,
      },
      historical: historical.map(h => ({
        date: h.date.toISOString().slice(0, 10),
        newEnrollments: h.newEnrollments,
        rewardsRedeemed: h.rewardsRedeemed,
        redemptionValueCents: h.redemptionValueCents,
        activeParticipants: h.activeParticipants,
      })),
      baseline,
      lockedFields,
    });
  } catch (err) {
    return sendError(res, 500, "SERVER_ERROR", err.message);
  }
});

/**
 * Compute merchant baseline from last 30 days of summary data.
 */
async function computeBaseline(merchantId) {
  const thirtyDaysAgo = daysAgo(30);

  const summaries = await prisma.merchantDailySummary.findMany({
    where: { merchantId, storeId: null, date: { gte: thirtyDaysAgo } },
    orderBy: { date: "asc" },
  });

  const dataAgeDays = summaries.length;
  const avgDailyVisitors = dataAgeDays > 0
    ? Math.round(summaries.reduce((s, r) => s + r.totalTransactions, 0) / dataAgeDays)
    : 0;
  const attributionRate = dataAgeDays > 0
    ? summaries.reduce((s, r) => s + r.attributionRate, 0) / dataAgeDays
    : 0;

  // Average visits per consumer per month
  const engagement = await prisma.consumerEngagementSummary.findFirst({
    where: { merchantId, storeId: null },
    orderBy: { date: "desc" },
  });

  const totalActiveConsumers = engagement
    ? engagement.visitedOnce + engagement.visited2to3 + engagement.visited4to7 + engagement.visited8plus
    : 0;
  const weightedVisits = engagement
    ? (engagement.visitedOnce * 1 + engagement.visited2to3 * 2.5 + engagement.visited4to7 * 5.5 + engagement.visited8plus * 10)
    : 0;
  const avgVisitsPerConsumerPerMonth = totalActiveConsumers > 0
    ? Math.round((weightedVisits / totalActiveConsumers) * 10) / 10
    : 0;

  // Enrollment conversion rate
  const totalAttributedVisitors = summaries.reduce((s, r) => s + r.attributedTransactions, 0);
  const totalEnrollments = summaries.reduce((s, r) => s + r.newEnrollments, 0);
  const enrollmentConversionRate = totalAttributedVisitors > 0
    ? totalEnrollments / totalAttributedVisitors
    : 0;

  const currentEnrolled = await prisma.consumerPromoProgress.count({ where: { merchantId } });

  return {
    avgDailyVisitors,
    attributionRate: Math.round(attributionRate * 100) / 100,
    avgVisitsPerConsumerPerMonth,
    currentEnrolled,
    enrollmentConversionRate: Math.round(enrollmentConversionRate * 1000) / 1000,
    dataAgeDays,
  };
}

module.exports = router;
