// src/growth/growth.metrics.service.js
//
// Aggregation Layer — computes merchant-level Growth Advisor metrics
// from PosOrder, Visit, and Consumer data.
//
// All queries use the last 30 days by default.

"use strict";

/**
 * Compute Growth Advisor metrics for a merchant.
 *
 * @param {object} prisma
 * @param {{ merchantId: number, storeId?: number, startDate?: Date, endDate?: Date }} ctx
 * @returns {Promise<GrowthMetrics>}
 */
async function getMerchantGrowthMetrics(prisma, { merchantId, storeId, startDate, endDate }) {
  const now = endDate || new Date();
  const since = startDate || new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const storeFilter = storeId ? { storeId } : {};

  const [
    topProducts,
    revenueByHour,
    aovData,
    visitData,
    consumerVisitCounts,
    firstVisitData,
  ] = await Promise.all([
    // Top products by revenue
    computeTopProducts(prisma, { merchantId, since, ...storeFilter }),

    // Revenue by hour of day
    computeRevenueByHour(prisma, { merchantId, since, ...storeFilter }),

    // AOV
    prisma.posOrder.aggregate({
      where: { merchantId, ...storeFilter, createdAt: { gte: since, lte: now }, totalAmount: { not: null } },
      _avg: { totalAmount: true },
      _sum: { totalAmount: true },
      _count: true,
    }),

    // Total visits
    prisma.visit.count({
      where: { merchantId, ...storeFilter, createdAt: { gte: since, lte: now }, consumerId: { not: null } },
    }),

    // Visit counts by consumer (for repeat rate)
    prisma.visit.groupBy({
      by: ["consumerId"],
      where: { merchantId, ...storeFilter, consumerId: { not: null }, createdAt: { gte: since, lte: now } },
      _count: true,
    }),

    // First-to-second visit conversion
    computeFirstToSecondRate(prisma, { merchantId, since, now, ...storeFilter }),
  ]);

  const totalConsumers = consumerVisitCounts.length;
  const repeatConsumers = consumerVisitCounts.filter((v) => v._count >= 2).length;
  const repeatRate = totalConsumers > 0 ? Math.round((repeatConsumers / totalConsumers) * 100) / 100 : null;

  // Visit frequency: average days between visits for repeat consumers
  let visitFrequencyDays = null;
  if (repeatConsumers > 0) {
    const repeatIds = consumerVisitCounts.filter((v) => v._count >= 2).map((v) => v.consumerId);
    visitFrequencyDays = await computeVisitFrequency(prisma, { merchantId, since, now, consumerIds: repeatIds, ...storeFilter });
  }

  const daySpan = Math.max(1, Math.ceil((now.getTime() - since.getTime()) / (1000 * 60 * 60 * 24)));

  return {
    period: { start: since.toISOString(), end: now.toISOString(), days: daySpan },
    topProducts,
    revenueByHour,
    aov: aovData._avg.totalAmount ? Math.round(aovData._avg.totalAmount) : null,
    totalRevenue: aovData._sum.totalAmount || 0,
    totalOrders: aovData._count,
    totalVisits: visitData,
    uniqueConsumers: totalConsumers,
    repeatConsumers,
    repeatRate,
    visitFrequencyDays,
    firstToSecondVisitRate: firstVisitData,
  };
}

// ── Internal helpers ──────────────────────────────────────────

async function computeTopProducts(prisma, { merchantId, since, storeId }) {
  const where = { posOrder: { merchantId, createdAt: { gte: since }, ...(storeId ? { storeId } : {}) } };

  const items = await prisma.posOrderItem.groupBy({
    by: ["itemName"],
    where,
    _sum: { totalPrice: true },
    _count: true,
    orderBy: { _sum: { totalPrice: "desc" } },
    take: 10,
  });

  const totalRev = items.reduce((sum, i) => sum + (i._sum.totalPrice || 0), 0);

  return items
    .filter((i) => i.itemName)
    .map((i) => ({
      name: i.itemName,
      revenue: i._sum.totalPrice || 0,
      orders: i._count,
      pctOfRevenue: totalRev > 0 ? Math.round(((i._sum.totalPrice || 0) / totalRev) * 100) : 0,
    }));
}

async function computeRevenueByHour(prisma, { merchantId, since, storeId }) {
  const orders = await prisma.posOrder.findMany({
    where: { merchantId, createdAt: { gte: since }, totalAmount: { not: null }, ...(storeId ? { storeId } : {}) },
    select: { createdAt: true, totalAmount: true },
  });

  const byHour = Array.from({ length: 24 }, (_, h) => ({ hour: h, revenue: 0, orders: 0 }));
  for (const o of orders) {
    const h = o.createdAt.getUTCHours();
    byHour[h].revenue += o.totalAmount || 0;
    byHour[h].orders += 1;
  }

  return byHour;
}

async function computeFirstToSecondRate(prisma, { merchantId, since, now, storeId }) {
  // Consumers whose first-ever visit was in this period
  const newConsumers = await prisma.visit.groupBy({
    by: ["consumerId"],
    where: { merchantId, consumerId: { not: null }, ...(storeId ? { storeId } : {}) },
    _min: { createdAt: true },
  });

  const firstTimers = newConsumers.filter(
    (c) => c._min.createdAt >= since && c._min.createdAt <= now
  );

  if (firstTimers.length === 0) return null;

  // Of those, how many came back?
  const firstTimerIds = firstTimers.map((c) => c.consumerId);
  const returnVisits = await prisma.visit.groupBy({
    by: ["consumerId"],
    where: {
      merchantId,
      consumerId: { in: firstTimerIds },
      ...(storeId ? { storeId } : {}),
    },
    _count: true,
  });

  const returned = returnVisits.filter((v) => v._count >= 2).length;
  return Math.round((returned / firstTimers.length) * 100) / 100;
}

async function computeVisitFrequency(prisma, { merchantId, since, now, consumerIds, storeId }) {
  const visits = await prisma.visit.findMany({
    where: {
      merchantId,
      consumerId: { in: consumerIds },
      createdAt: { gte: since, lte: now },
      ...(storeId ? { storeId } : {}),
    },
    select: { consumerId: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });

  const byConsumer = {};
  for (const v of visits) {
    if (!byConsumer[v.consumerId]) byConsumer[v.consumerId] = [];
    byConsumer[v.consumerId].push(v.createdAt);
  }

  let totalGap = 0;
  let gapCount = 0;
  for (const dates of Object.values(byConsumer)) {
    for (let i = 1; i < dates.length; i++) {
      totalGap += (dates[i].getTime() - dates[i - 1].getTime()) / (1000 * 60 * 60 * 24);
      gapCount++;
    }
  }

  return gapCount > 0 ? Math.round((totalGap / gapCount) * 10) / 10 : null;
}

/**
 * Enrich base metrics with v2 data for advanced pattern detection.
 * Uses pre-aggregated summary tables — fast.
 */
async function enrichWithV2Metrics(prisma, baseMetrics, { merchantId }) {
  try {
    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 86400000);
    const fourteenDaysAgo = new Date(now.getTime() - 14 * 86400000);

    // Attribution trend: last 7d vs prior 7d
    const [recentSummaries, priorSummaries] = await Promise.all([
      prisma.merchantDailySummary.findMany({
        where: { merchantId, storeId: null, date: { gte: sevenDaysAgo } },
      }),
      prisma.merchantDailySummary.findMany({
        where: { merchantId, storeId: null, date: { gte: fourteenDaysAgo, lt: sevenDaysAgo } },
      }),
    ]);

    const avgAttr = (rows) => rows.length > 0 ? rows.reduce((s, r) => s + r.attributionRate, 0) / rows.length : null;
    const recentAttr = avgAttr(recentSummaries);
    const priorAttr = avgAttr(priorSummaries);
    if (recentAttr != null && priorAttr != null) {
      baseMetrics.attributionTrend = { current: recentAttr, prior: priorAttr };
    }

    // Revenue week-over-week
    const sumRevenue = (rows) => rows.reduce((s, r) => s + (r.totalTransactions || 0), 0);
    const recentRev = sumRevenue(recentSummaries);
    const priorRev = sumRevenue(priorSummaries);
    if (priorRev > 0) {
      baseMetrics.revenueWeekOverWeek = { current: recentRev, prior: priorRev };
    }

    // Promo stall rate: consumers enrolled but not progressing (stampCount unchanged for 14+ days)
    const allProgress = await prisma.consumerPromoProgress.findMany({
      where: { merchantId, stampCount: { gt: 0 } },
      select: { lastEarnedAt: true, stampCount: true, promotion: { select: { name: true, threshold: true } } },
    });
    if (allProgress.length > 0) {
      const stalled = allProgress.filter(p => p.lastEarnedAt && (now.getTime() - new Date(p.lastEarnedAt).getTime()) > 14 * 86400000);
      baseMetrics.promoStallRate = stalled.length / allProgress.length;
      if (stalled.length > 0) {
        baseMetrics.stalledPromoName = stalled[0].promotion?.name || null;
      }
    }

    // Tier bottleneck: check if consumers cluster at a tier level
    const tieredPromos = await prisma.promotion.findMany({
      where: { merchantId, promotionType: "tiered", status: "active" },
      include: { tiers: { orderBy: { tierLevel: "asc" } } },
    });
    for (const tp of tieredPromos) {
      if (tp.tiers.length < 2) continue;
      const progress = await prisma.consumerPromoProgress.findMany({
        where: { promotionId: tp.id, currentTierLevel: { gt: 0 } },
        select: { currentTierLevel: true },
      });
      if (progress.length < 5) continue;

      // Count per tier
      const tierCounts = {};
      for (const p of progress) tierCounts[p.currentTierLevel] = (tierCounts[p.currentTierLevel] || 0) + 1;

      // Find bottleneck: tier with most consumers where next tier has significantly fewer
      for (let i = 0; i < tp.tiers.length - 1; i++) {
        const currentTier = tp.tiers[i];
        const nextTier = tp.tiers[i + 1];
        const atCurrent = tierCounts[currentTier.tierLevel] || 0;
        const atNext = tierCounts[nextTier.tierLevel] || 0;
        if (atCurrent > 3 && atNext < atCurrent * 0.3) {
          baseMetrics.tierBottleneck = {
            promoName: tp.name,
            tierName: currentTier.tierName,
            nextTierName: nextTier.tierName,
            countAtTier: atCurrent,
            countAtNext: atNext,
            nextThreshold: nextTier.threshold,
          };
          break;
        }
      }
    }

    // Referral opportunity check
    const hasReferral = await prisma.promotion.findFirst({
      where: { merchantId, promotionType: "referral", status: "active" },
    });
    baseMetrics.hasReferralPromo = !!hasReferral;

  } catch (e) {
    console.error("[growth.metrics] v2 enrichment error:", e?.message || String(e));
  }

  return baseMetrics;
}

module.exports = { getMerchantGrowthMetrics, enrichWithV2Metrics };
