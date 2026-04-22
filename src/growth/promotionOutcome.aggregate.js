// src/growth/promotionOutcome.aggregate.js
//
// Async aggregation — computes PromotionOutcome from PromotionEvent + baseline.
// Populates learning loop fields (projected vs actual) for the simulator.
// Called on-demand or by cron. Never in the POS hot path.

"use strict";

const { projectByObjective } = require("../merchant/simulator.projections");

/**
 * Compute and upsert PromotionOutcome for a single promotion.
 *
 * @param {object} prisma
 * @param {{ promotionId: number }} ctx
 */
async function computePromotionOutcome(prisma, { promotionId }) {
  const promotion = await prisma.promotion.findUnique({
    where: { id: promotionId },
    select: { id: true, merchantId: true, startAt: true, endAt: true, firstActivatedAt: true, status: true },
  });
  if (!promotion) return null;

  const startDate = promotion.firstActivatedAt || promotion.startAt || promotion.createdAt;
  const endDate = promotion.endAt || new Date();

  // Load baseline
  const baseline = await prisma.promotionBaselineSnapshot.findFirst({
    where: { promotionId },
    orderBy: { capturedAt: "desc" },
  });

  // Count events by type
  const eventCounts = await prisma.promotionEvent.groupBy({
    by: ["eventType"],
    where: { promotionId },
    _count: true,
  });

  const countMap = {};
  for (const e of eventCounts) {
    countMap[e.eventType] = e._count;
  }

  const clips = countMap["clip"] || 0;
  const qualifiedPurchases = countMap["qualify"] || 0;
  const rewardsGranted = countMap["grant"] || 0;
  const rewardsRedeemed = countMap["redeem"] || 0;

  // Redemption rate
  const redemptionRate = clips > 0 ? Math.round((rewardsRedeemed / clips) * 100) / 100 : null;

  // AOV lift: compare promo-period AOV to baseline
  let aovLift = null;
  if (baseline?.avgOrderValueCents) {
    const promoOrders = await prisma.posOrder.aggregate({
      where: {
        merchantId: promotion.merchantId,
        createdAt: { gte: startDate, lte: endDate },
        totalAmount: { not: null },
      },
      _avg: { totalAmount: true },
    });
    const promoAov = promoOrders._avg.totalAmount;
    if (promoAov) {
      aovLift = Math.round(((promoAov - baseline.avgOrderValueCents) / baseline.avgOrderValueCents) * 100) / 100;
    }
  }

  // Repeat visit lift: compare promo-period repeat rate to baseline
  let repeatVisitLift = null;
  if (baseline?.repeatRate !== null && baseline?.repeatRate !== undefined) {
    const visitCounts = await prisma.visit.groupBy({
      by: ["consumerId"],
      where: {
        merchantId: promotion.merchantId,
        consumerId: { not: null },
        createdAt: { gte: startDate, lte: endDate },
      },
      _count: true,
    });
    const total = visitCounts.length;
    const repeats = visitCounts.filter((v) => v._count >= 2).length;
    const promoRepeatRate = total > 0 ? repeats / total : 0;

    if (baseline.repeatRate > 0) {
      repeatVisitLift = Math.round(((promoRepeatRate - baseline.repeatRate) / baseline.repeatRate) * 100) / 100;
    }
  }

  // Revenue lift: compare promo-period daily revenue to baseline
  let revenueLift = null;
  if (baseline?.dailyRevenueCents) {
    const promoRevenue = await prisma.posOrder.aggregate({
      where: {
        merchantId: promotion.merchantId,
        createdAt: { gte: startDate, lte: endDate },
        totalAmount: { not: null },
      },
      _sum: { totalAmount: true },
    });
    const daySpan = Math.max(1, Math.ceil((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24)));
    const promoDailyRev = (promoRevenue._sum.totalAmount || 0) / daySpan;

    if (baseline.dailyRevenueCents > 0) {
      revenueLift = Math.round(((promoDailyRev - baseline.dailyRevenueCents) / baseline.dailyRevenueCents) * 100) / 100;
    }
  }

  // ── Learning loop: projected vs actual via simulator engine ──
  let learningLoop = {};
  try {
    const promo = await prisma.promotion.findUnique({
      where: { id: promotionId },
      select: {
        objective: true, threshold: true, rewardValue: true,
        promotionType: true, rewardType: true,
        merchant: { select: { merchantType: true, avgTransactionValueCents: true } },
      },
    });

    const objective = promo?.objective || "bring-back";
    const daySpan = Math.max(1, Math.ceil((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24)));

    // Build baseline for projection
    const summaries = await prisma.merchantDailySummary.findMany({
      where: { merchantId: promotion.merchantId, storeId: null },
      orderBy: { date: "desc" },
      take: 30,
    });
    const dataAgeDays = summaries.length;
    const avgDailyVisitors = dataAgeDays > 0
      ? Math.round(summaries.reduce((s, r) => s + r.totalTransactions, 0) / dataAgeDays) : 0;
    const attributionRate = dataAgeDays > 0
      ? summaries.reduce((s, r) => s + r.attributionRate, 0) / dataAgeDays : 0;

    const enrolled = await prisma.consumerPromoProgress.count({ where: { promotionId } });

    const projBaseline = {
      avgDailyVisitors,
      attributionRate,
      avgVisitsPerConsumerPerMonth: 2.5,
      currentEnrolled: enrolled,
      enrollmentConversionRate: 0.15,
      avgTransactionValueCents: promo?.merchant?.avgTransactionValueCents || 0,
      dataAgeDays,
    };

    const params = {
      stampThreshold: promo?.threshold || 8,
      rewardValueCents: promo?.rewardValue || 500,
      promotionType: promo?.promotionType || "stamp",
    };

    const projection = projectByObjective(objective, projBaseline, params, promo?.merchant?.merchantType);

    // Actual metrics from summary data during promo period
    const promoSummaries = await prisma.promotionDailySummary.findMany({
      where: { promotionId, date: { gte: startDate, lte: endDate } },
    });
    const actualRedemptionValue = promoSummaries.reduce((s, r) => s + (r.redemptionValueCents || 0), 0);
    const actualEnrollments = promoSummaries.reduce((s, r) => s + (r.newEnrollments || 0), 0);

    // Scale projected monthly values to the actual duration
    const monthFraction = daySpan / 30;

    learningLoop = {
      objective,
      primaryMetricProjected: parseFloat(projection.projectedValue) || null,
      primaryMetricActual: null, // Objective-specific — set below
      revenueProjectedCents: Math.round((projection.projectedMonthlyRevenueCents || 0) * monthFraction),
      revenueActualCents: actualRedemptionValue > 0 ? Math.round(actualRedemptionValue * 2.5) : null, // rough revenue proxy
      costProjectedCents: Math.round((projection.projectedMonthlyCostCents || 0) * monthFraction),
      costActualCents: actualRedemptionValue,
      enrollmentProjected: Math.round((enrolled * 0.15) * monthFraction), // projected new enrollments
      enrollmentActual: actualEnrollments,
      attributionRateAvg: Math.round(attributionRate * 100) / 100,
      durationDays: daySpan,
    };
  } catch (e) {
    console.error(`[outcome.aggregate] learning loop error promo=${promotionId}:`, e?.message || String(e));
  }

  // Upsert outcome
  const existing = await prisma.promotionOutcome.findFirst({
    where: { promotionId },
    select: { id: true },
  });

  const data = {
    promotionId,
    merchantId: promotion.merchantId,
    startDate,
    endDate: promotion.endAt || null,
    clips,
    qualifiedPurchases,
    rewardsGranted,
    rewardsRedeemed,
    redemptionRate,
    aovLift,
    repeatVisitLift,
    revenueLift,
    baselineAovCents: baseline?.avgOrderValueCents || null,
    baselineVisits: baseline?.repeatRate !== null ? baseline?.repeatRate : null,
    baselineRevenueCents: baseline?.dailyRevenueCents || null,
    ...learningLoop,
    computedAt: new Date(),
  };

  if (existing) {
    await prisma.promotionOutcome.update({ where: { id: existing.id }, data });
  } else {
    await prisma.promotionOutcome.create({ data });
  }

  console.log(`[outcome.aggregate] promo=${promotionId}: clips=${clips} granted=${rewardsGranted} redeemed=${rewardsRedeemed} redemptionRate=${redemptionRate} aovLift=${aovLift} revenueLift=${revenueLift}`);
  return data;
}

/**
 * Recompute outcomes for all active/recently-ended promotions.
 * Suitable for a cron job.
 *
 * @param {object} prisma
 */
async function computeAllPromotionOutcomes(prisma) {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const promotions = await prisma.promotion.findMany({
    where: {
      OR: [
        { status: "active" },
        { status: "suspended", endAt: { gte: thirtyDaysAgo } },
      ],
      firstActivatedAt: { not: null },
    },
    select: { id: true },
  });

  console.log(`[outcome.aggregate] computing outcomes for ${promotions.length} promotions`);

  for (const promo of promotions) {
    await computePromotionOutcome(prisma, { promotionId: promo.id });
  }
}

module.exports = { computePromotionOutcome, computeAllPromotionOutcomes };
