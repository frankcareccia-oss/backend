// src/growth/promotionOutcome.baseline.js
//
// Captures a baseline snapshot when a promotion activates.
// Used for lift calculations in PromotionOutcome.

"use strict";

/**
 * Capture a baseline snapshot of the merchant's current metrics.
 * Called when a promotion transitions to active status.
 *
 * Computes from the last 30 days of data:
 * - Average order value (cents)
 * - Daily revenue (cents)
 * - Repeat rate (fraction of consumers with 2+ visits)
 * - Visit frequency (average days between visits)
 *
 * @param {object} prisma
 * @param {{ promotionId, merchantId, storeId? }} ctx
 */
async function capturePromotionBaseline(prisma, { promotionId, merchantId, storeId }) {
  try {
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const storeFilter = storeId ? { storeId } : {};

    // Average order value from PosOrder
    const aovResult = await prisma.posOrder.aggregate({
      where: {
        merchantId,
        ...storeFilter,
        createdAt: { gte: thirtyDaysAgo },
        totalAmount: { not: null },
      },
      _avg: { totalAmount: true },
      _sum: { totalAmount: true },
      _count: true,
    });

    const avgOrderValueCents = aovResult._avg.totalAmount
      ? Math.round(aovResult._avg.totalAmount)
      : null;

    // Daily revenue = total revenue / 30
    const dailyRevenueCents = aovResult._sum.totalAmount
      ? Math.round(aovResult._sum.totalAmount / 30)
      : null;

    // Repeat rate: consumers with 2+ visits / total unique consumers
    const visitCounts = await prisma.visit.groupBy({
      by: ["consumerId"],
      where: {
        merchantId,
        ...storeFilter,
        consumerId: { not: null },
        createdAt: { gte: thirtyDaysAgo },
      },
      _count: true,
    });

    const totalConsumers = visitCounts.length;
    const repeatConsumers = visitCounts.filter((v) => v._count >= 2).length;
    const repeatRate = totalConsumers > 0 ? repeatConsumers / totalConsumers : null;

    // Visit frequency: average days between visits for repeat consumers
    let visitFrequencyDays = null;
    if (repeatConsumers > 0) {
      const repeatConsumerIds = visitCounts
        .filter((v) => v._count >= 2)
        .map((v) => v.consumerId);

      // For each repeat consumer, find min and max visit dates
      const visits = await prisma.visit.findMany({
        where: {
          merchantId,
          ...storeFilter,
          consumerId: { in: repeatConsumerIds },
          createdAt: { gte: thirtyDaysAgo },
        },
        select: { consumerId: true, createdAt: true },
        orderBy: { createdAt: "asc" },
      });

      // Group by consumer and compute average gap
      const byConsumer = {};
      for (const v of visits) {
        if (!byConsumer[v.consumerId]) byConsumer[v.consumerId] = [];
        byConsumer[v.consumerId].push(v.createdAt);
      }

      let totalGapDays = 0;
      let gapCount = 0;
      for (const dates of Object.values(byConsumer)) {
        for (let i = 1; i < dates.length; i++) {
          const gap = (dates[i].getTime() - dates[i - 1].getTime()) / (1000 * 60 * 60 * 24);
          totalGapDays += gap;
          gapCount++;
        }
      }

      visitFrequencyDays = gapCount > 0 ? Math.round((totalGapDays / gapCount) * 10) / 10 : null;
    }

    await prisma.promotionBaselineSnapshot.create({
      data: {
        promotionId,
        merchantId,
        storeId: storeId || null,
        avgOrderValueCents,
        dailyRevenueCents,
        repeatRate,
        visitFrequencyDays,
      },
    });

    console.log(`[baseline] captured for promo=${promotionId} merchant=${merchantId}: AOV=${avgOrderValueCents} dailyRev=${dailyRevenueCents} repeat=${repeatRate} freq=${visitFrequencyDays}`);
  } catch (e) {
    console.error(`[baseline] capture failed for promo=${promotionId}:`, e?.message || String(e));
  }
}

module.exports = { capturePromotionBaseline };
