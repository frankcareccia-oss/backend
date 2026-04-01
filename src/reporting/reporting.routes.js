/**
 * reporting.routes.js
 *
 * Thread R — Reporting & Audit Surfaces
 *
 * Merchant routes  (requireJwt + requireMerchantRole):
 *   GET /merchant/reports/overview        — summary stats for the merchant
 *   GET /merchant/reports/stores          — per-store breakdown
 *   GET /merchant/reports/promotions      — per-promotion funnel
 *
 * Admin routes  (requireJwt + requireAdmin):
 *   GET /admin/merchants/:merchantId/reports/overview
 *   GET /admin/merchants/:merchantId/reports/stores
 *   GET /admin/merchants/:merchantId/reports/promotions
 *   GET /admin/reports/platform           — cross-merchant rollup (pv_admin only)
 *
 * Date range is controlled by ?range=30d | 90d | all  (default: 30d)
 */

"use strict";

const express = require("express");
const { sendError, handlePrismaError } = require("../utils/errors");
const { parseIntParam } = require("../utils/helpers");
const { requireJwt, requireAdmin, requireMerchantRole } = require("../middleware/auth");
const { emitPvHook } = require("../utils/hooks");

const { prisma } = require("../db/prisma");

const router = express.Router();

// ── Date range helper ─────────────────────────────────────────────────────────

const VALID_RANGES = ["30d", "90d", "all"];

function rangeStart(range) {
  if (range === "all") return null;
  const days = range === "90d" ? 90 : 30;
  const d = new Date();
  d.setDate(d.getDate() - days);
  d.setHours(0, 0, 0, 0);
  return d;
}

function dateFilter(range) {
  const start = rangeStart(range);
  return start ? { gte: start } : undefined;
}

// ── Shared aggregation helpers ────────────────────────────────────────────────

async function fetchOverview(merchantId, range) {
  const createdAt = dateFilter(range);
  const visitWhere  = { merchantId, ...(createdAt ? { createdAt } : {}) };
  const redeemWhere = { merchantId, ...(createdAt ? { createdAt } : {}) };

  const [
    totalVisits,
    identifiedVisits,
    uniqueConsumers,
    totalRedemptions,
    activeEntitlements,
    stampsIssued,
  ] = await Promise.all([
    prisma.visit.count({ where: visitWhere }),
    prisma.visit.count({ where: { ...visitWhere, consumerId: { not: null } } }),
    prisma.visit.groupBy({
      by: ["consumerId"],
      where: { ...visitWhere, consumerId: { not: null } },
      _count: true,
    }).then(r => r.length),
    prisma.promoRedemption.count({ where: redeemWhere }),
    prisma.entitlement.count({
      where: { merchantId, status: "active" },
    }),
    // lifetimeEarned is a running total — report all-time for the merchant
    // (not range-filtered, since it's a cumulative field)
    prisma.consumerPromoProgress.aggregate({
      where: { merchantId },
      _sum: { lifetimeEarned: true },
    }).then(r => r._sum.lifetimeEarned ?? 0),
  ]);

  return {
    range,
    totalVisits,
    identifiedVisits,
    anonymousVisits: totalVisits - identifiedVisits,
    uniqueConsumers,
    totalRedemptions,
    activeEntitlements,
    stampsIssued,
  };
}

async function fetchStoreBreakdown(merchantId, range) {
  const createdAt = dateFilter(range);
  const visitWhere = { merchantId, ...(createdAt ? { createdAt } : {}) };
  const redeemWhere = { merchantId, ...(createdAt ? { createdAt } : {}) };

  // Group visits by store
  const [visitGroups, identifiedGroups, redemptionGroups, stores] = await Promise.all([
    prisma.visit.groupBy({
      by: ["storeId"],
      where: visitWhere,
      _count: { id: true },
    }),
    prisma.visit.groupBy({
      by: ["storeId"],
      where: { ...visitWhere, consumerId: { not: null } },
      _count: { id: true },
    }),
    prisma.promoRedemption.groupBy({
      by: ["grantedByStoreId"],
      where: { ...redeemWhere, grantedByStoreId: { not: null } },
      _count: { id: true },
    }),
    prisma.store.findMany({
      where: { merchantId },
      select: { id: true, name: true, status: true },
    }),
  ]);

  const visitMap      = Object.fromEntries(visitGroups.map(r => [r.storeId, r._count.id]));
  const identMap      = Object.fromEntries(identifiedGroups.map(r => [r.storeId, r._count.id]));
  const redemptionMap = Object.fromEntries(redemptionGroups.map(r => [r.grantedByStoreId, r._count.id]));

  return stores.map(s => ({
    storeId:          s.id,
    storeName:        s.name,
    storeStatus:      s.status,
    visits:           visitMap[s.id] ?? 0,
    identifiedVisits: identMap[s.id] ?? 0,
    redemptions:      redemptionMap[s.id] ?? 0,
  }));
}

async function fetchPromotionBreakdown(merchantId, range) {
  const createdAt = dateFilter(range);
  const redeemWhere = { merchantId, ...(createdAt ? { createdAt } : {}) };

  const [promotions, progressRows, redemptionGroups] = await Promise.all([
    prisma.promotion.findMany({
      where: { merchantId },
      select: { id: true, name: true, status: true, rewardType: true, threshold: true,
                category: { select: { name: true } } },
    }),
    prisma.consumerPromoProgress.groupBy({
      by: ["promotionId"],
      where: { merchantId },
      _count: { consumerId: true },
      _sum:   { lifetimeEarned: true },
    }),
    prisma.promoRedemption.groupBy({
      by: ["promotionId"],
      where: redeemWhere,
      _count: { id: true },
    }),
  ]);

  const progressMap    = Object.fromEntries(progressRows.map(r => [r.promotionId, r]));
  const redemptionMap  = Object.fromEntries(redemptionGroups.map(r => [r.promotionId, r._count.id]));

  return promotions.map(p => {
    const prog = progressMap[p.id];
    return {
      promotionId:   p.id,
      promotionName: p.name,
      status:        p.status,
      rewardType:    p.rewardType,
      threshold:     p.threshold,
      categoryName:  p.category?.name ?? null,
      participants:  prog?._count?.consumerId ?? 0,
      stampsIssued:  prog?._sum?.lifetimeEarned ?? 0,
      redemptions:   redemptionMap[p.id] ?? 0,
    };
  });
}

// ── Merchant routes ───────────────────────────────────────────────────────────

router.get(
  "/merchant/reports/overview",
  requireJwt,
  requireMerchantRole("owner", "merchant_admin"),
  async (req, res) => {
    try {
      const range = VALID_RANGES.includes(req.query.range) ? req.query.range : "30d";
      const data = await fetchOverview(req.merchantId, range);
      emitPvHook("reporting.merchant.overview", {
        tc: "TC-RPT-MERCHANT-OVERVIEW-01", sev: "info", stable: "reporting:merchant:overview",
        merchantId: req.merchantId, range, actorUserId: req.userId,
      });
      return res.json(data);
    } catch (err) { return handlePrismaError(err, res); }
  }
);

router.get(
  "/merchant/reports/stores",
  requireJwt,
  requireMerchantRole("owner", "merchant_admin"),
  async (req, res) => {
    try {
      const range = VALID_RANGES.includes(req.query.range) ? req.query.range : "30d";
      const stores = await fetchStoreBreakdown(req.merchantId, range);
      emitPvHook("reporting.merchant.stores", {
        tc: "TC-RPT-MERCHANT-STORES-01", sev: "info", stable: "reporting:merchant:stores",
        merchantId: req.merchantId, range, actorUserId: req.userId,
      });
      return res.json({ range, stores });
    } catch (err) { return handlePrismaError(err, res); }
  }
);

router.get(
  "/merchant/reports/promotions",
  requireJwt,
  requireMerchantRole("owner", "merchant_admin"),
  async (req, res) => {
    try {
      const range = VALID_RANGES.includes(req.query.range) ? req.query.range : "30d";
      const promotions = await fetchPromotionBreakdown(req.merchantId, range);
      emitPvHook("reporting.merchant.promotions", {
        tc: "TC-RPT-MERCHANT-PROMOTIONS-01", sev: "info", stable: "reporting:merchant:promotions",
        merchantId: req.merchantId, range, actorUserId: req.userId,
      });
      return res.json({ range, promotions });
    } catch (err) { return handlePrismaError(err, res); }
  }
);

// ── Admin merchant-scoped routes ──────────────────────────────────────────────

router.get(
  "/admin/merchants/:merchantId/reports/overview",
  requireJwt,
  requireAdmin,
  async (req, res) => {
    try {
      const merchantId = parseIntParam(req.params.merchantId);
      if (!merchantId) return sendError(res, 400, "VALIDATION_ERROR", "Invalid merchantId");
      const range = VALID_RANGES.includes(req.query.range) ? req.query.range : "30d";
      const data = await fetchOverview(merchantId, range);
      return res.json(data);
    } catch (err) { return handlePrismaError(err, res); }
  }
);

router.get(
  "/admin/merchants/:merchantId/reports/stores",
  requireJwt,
  requireAdmin,
  async (req, res) => {
    try {
      const merchantId = parseIntParam(req.params.merchantId);
      if (!merchantId) return sendError(res, 400, "VALIDATION_ERROR", "Invalid merchantId");
      const range = VALID_RANGES.includes(req.query.range) ? req.query.range : "30d";
      const stores = await fetchStoreBreakdown(merchantId, range);
      return res.json({ range, stores });
    } catch (err) { return handlePrismaError(err, res); }
  }
);

router.get(
  "/admin/merchants/:merchantId/reports/promotions",
  requireJwt,
  requireAdmin,
  async (req, res) => {
    try {
      const merchantId = parseIntParam(req.params.merchantId);
      if (!merchantId) return sendError(res, 400, "VALIDATION_ERROR", "Invalid merchantId");
      const range = VALID_RANGES.includes(req.query.range) ? req.query.range : "30d";
      const promotions = await fetchPromotionBreakdown(merchantId, range);
      return res.json({ range, promotions });
    } catch (err) { return handlePrismaError(err, res); }
  }
);

// ── Admin platform rollup ─────────────────────────────────────────────────────

router.get(
  "/admin/reports/platform",
  requireJwt,
  requireAdmin,
  async (req, res) => {
    try {
      const range = VALID_RANGES.includes(req.query.range) ? req.query.range : "30d";
      const createdAt = dateFilter(range);
      const visitWhere  = createdAt ? { createdAt } : {};
      const redeemWhere = createdAt ? { createdAt } : {};

      const [
        totalMerchants,
        activeMerchants,
        totalStores,
        activeStores,
        totalVisits,
        identifiedVisits,
        totalRedemptions,
        activeEntitlements,
        topMerchants,
      ] = await Promise.all([
        prisma.merchant.count(),
        prisma.merchant.count({ where: { status: "active" } }),
        prisma.store.count(),
        prisma.store.count({ where: { status: "active" } }),
        prisma.visit.count({ where: visitWhere }),
        prisma.visit.count({ where: { ...visitWhere, consumerId: { not: null } } }),
        prisma.promoRedemption.count({ where: redeemWhere }),
        prisma.entitlement.count({ where: { status: "active" } }),
        // Top 10 merchants by visit count in range
        prisma.visit.groupBy({
          by: ["merchantId"],
          where: visitWhere,
          _count: { id: true },
          orderBy: { _count: { id: "desc" } },
          take: 10,
        }),
      ]);

      // Resolve merchant names for top merchants
      const merchantIds = topMerchants.map(r => r.merchantId);
      const merchantNames = merchantIds.length
        ? await prisma.merchant.findMany({
            where: { id: { in: merchantIds } },
            select: { id: true, name: true },
          })
        : [];
      const nameMap = Object.fromEntries(merchantNames.map(m => [m.id, m.name]));

      return res.json({
        range,
        merchants: { total: totalMerchants, active: activeMerchants },
        stores:    { total: totalStores,    active: activeStores },
        visits:    { total: totalVisits, identified: identifiedVisits, anonymous: totalVisits - identifiedVisits },
        redemptions: totalRedemptions,
        activeEntitlements,
        topMerchantsByVisits: topMerchants.map(r => ({
          merchantId: r.merchantId,
          merchantName: nameMap[r.merchantId] ?? `Merchant ${r.merchantId}`,
          visits: r._count.id,
        })),
      });
    } catch (err) { return handlePrismaError(err, res); }
  }
);

module.exports = router;
