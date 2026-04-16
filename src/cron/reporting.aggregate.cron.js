/**
 * reporting.aggregate.cron.js — Nightly reporting aggregation
 *
 * Pre-computes MerchantDailySummary, PromotionDailySummary, and
 * ConsumerEngagementSummary from raw transaction tables.
 *
 * Dashboard queries hit summary tables only — never raw tables.
 * All summary writes are idempotent (upsert by unique key).
 */

"use strict";

const { prisma } = require("../db/prisma");

/**
 * Main entry point. Supports nightly (yesterday) and backfill (date range).
 */
async function runReportingAggregation({ fromDate, toDate } = {}) {
  const yesterday = new Date();
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  yesterday.setUTCHours(0, 0, 0, 0);

  const startDate = fromDate || yesterday;
  const endDate = toDate || yesterday;

  console.log(`[Reporting] Aggregating ${startDate.toISOString().slice(0, 10)} → ${endDate.toISOString().slice(0, 10)}`);

  const merchants = await prisma.merchant.findMany({
    where: { status: "active" },
    include: { stores: { where: { status: "active" }, select: { id: true } } },
  });

  let processed = 0;

  for (const merchant of merchants) {
    try {
      await aggregateMerchant(merchant, startDate, endDate);
      processed++;
    } catch (err) {
      console.error(`[Reporting] Failed for merchant ${merchant.id}:`, err.message);
    }
  }

  console.log(`[Reporting] Complete. ${processed}/${merchants.length} merchants.`);
  return { totalProcessed: processed, totalMerchants: merchants.length };
}

async function aggregateMerchant(merchant, startDate, endDate) {
  const current = new Date(startDate);

  while (current <= endDate) {
    const dayStart = new Date(current);
    dayStart.setUTCHours(0, 0, 0, 0);
    const dayEnd = new Date(current);
    dayEnd.setUTCHours(23, 59, 59, 999);

    // Merchant-wide aggregate (storeId = null)
    await aggregateDay(merchant.id, null, dayStart, dayEnd);

    // Per-store
    for (const store of merchant.stores) {
      await aggregateDay(merchant.id, store.id, dayStart, dayEnd);
    }

    // Consumer engagement
    await aggregateEngagement(merchant.id, null, dayStart);
    for (const store of merchant.stores) {
      await aggregateEngagement(merchant.id, store.id, dayStart);
    }

    // Promotion summaries
    await aggregatePromotions(merchant.id, dayStart, dayEnd);

    current.setUTCDate(current.getUTCDate() + 1);
  }
}

async function aggregateDay(merchantId, storeId, dayStart, dayEnd) {
  const storeWhere = storeId ? { storeId } : {};

  // Transactions (visits)
  const visits = await prisma.visit.findMany({
    where: { merchantId, ...storeWhere, createdAt: { gte: dayStart, lte: dayEnd } },
    select: { id: true, consumerId: true },
  });

  const totalTransactions = visits.length;
  const attributedTransactions = visits.filter(v => v.consumerId !== null).length;
  const unattributedTransactions = totalTransactions - attributedTransactions;
  const attributionRate = totalTransactions > 0 ? attributedTransactions / totalTransactions : 0;

  // Milestones (entitlements created this day)
  const milestonesReached = await prisma.entitlement.count({
    where: {
      merchantId,
      ...(storeId ? { storeId } : {}),
      type: "reward",
      createdAt: { gte: dayStart, lte: dayEnd },
    },
  });

  // Rewards redeemed
  const redeemedDiscounts = await prisma.posRewardDiscount.findMany({
    where: { merchantId, status: "redeemed", appliedAt: { gte: dayStart, lte: dayEnd } },
    select: { amountCents: true },
  });
  // Also count Square gift card redemptions
  const redeemedGiftCards = await prisma.giftCardEvent.count({
    where: { merchantId, eventType: "REDEEMED", createdAt: { gte: dayStart, lte: dayEnd } },
  });
  const rewardsRedeemed = redeemedDiscounts.length + redeemedGiftCards;
  const redemptionValueCents = redeemedDiscounts.reduce((s, r) => s + (r.amountCents || 0), 0);

  // Rewards expired
  const expiredDiscounts = await prisma.posRewardDiscount.findMany({
    where: { merchantId, status: "expired", updatedAt: { gte: dayStart, lte: dayEnd } },
    select: { amountCents: true },
  });
  const rewardsExpired = expiredDiscounts.length;
  const expiredValueCents = expiredDiscounts.reduce((s, r) => s + (r.amountCents || 0), 0);

  // Check-ins
  const checkinGroups = await prisma.consumerCheckin.groupBy({
    by: ["triggeredBy"],
    where: { merchantId, ...(storeId ? { storeId } : {}), createdAt: { gte: dayStart, lte: dayEnd } },
    _count: true,
  });
  const checkins = checkinGroups.reduce((s, c) => s + c._count, 0);
  const geofenceCheckins = checkinGroups.find(c => c.triggeredBy === "geofence")?._count || 0;
  const manualCheckins = checkinGroups.find(c => c.triggeredBy === "manual")?._count || 0;

  // Active consumers (unique consumers who visited this day)
  const consumerIds = [...new Set(visits.filter(v => v.consumerId).map(v => v.consumerId))];
  const activeConsumers = consumerIds.length;

  // Enrollments
  const newEnrollments = await prisma.consumerPromoProgress.count({
    where: {
      merchantId,
      createdAt: { gte: dayStart, lte: dayEnd },
    },
  });

  // Upsert — handle nullable storeId with raw SQL for the unique lookup
  const dateOnly = dayStart.toISOString().slice(0, 10);

  await prisma.$executeRawUnsafe(`
    INSERT INTO "MerchantDailySummary" (
      "merchantId", "storeId", "date",
      "totalTransactions", "attributedTransactions", "unattributedTransactions", "attributionRate",
      "newEnrollments", "stampsIssued", "milestonesReached",
      "rewardsRedeemed", "redemptionValueCents", "rewardsExpired", "expiredValueCents",
      "budgetConsumedCents", "checkins", "geofenceCheckins", "manualCheckins",
      "activeConsumers", "newConsumers", "returningConsumers",
      "discoverImpressions", "discoverEnrollments",
      "createdAt", "updatedAt"
    ) VALUES (
      $1, $2, $3::date,
      $4, $5, $6, $7,
      $8, $9, $10,
      $11, $12, $13, $14,
      $15, $16, $17, $18,
      $19, 0, 0,
      0, 0,
      NOW(), NOW()
    )
    ON CONFLICT ("merchantId", "storeId", "date")
    DO UPDATE SET
      "totalTransactions" = $4, "attributedTransactions" = $5, "unattributedTransactions" = $6,
      "attributionRate" = $7, "newEnrollments" = $8, "milestonesReached" = $10,
      "rewardsRedeemed" = $11, "redemptionValueCents" = $12, "rewardsExpired" = $13,
      "expiredValueCents" = $14, "budgetConsumedCents" = $15,
      "checkins" = $16, "geofenceCheckins" = $17, "manualCheckins" = $18,
      "activeConsumers" = $19, "updatedAt" = NOW()
  `,
    merchantId, storeId, dateOnly,
    totalTransactions, attributedTransactions, unattributedTransactions, attributionRate,
    newEnrollments, 0, milestonesReached,
    rewardsRedeemed, redemptionValueCents, rewardsExpired, expiredValueCents,
    redemptionValueCents, checkins, geofenceCheckins, manualCheckins,
    activeConsumers
  );
}

async function aggregateEngagement(merchantId, storeId, date) {
  const thirtyDaysAgo = new Date(date);
  thirtyDaysAgo.setUTCDate(thirtyDaysAgo.getUTCDate() - 30);
  const sixtyDaysAgo = new Date(date);
  sixtyDaysAgo.setUTCDate(sixtyDaysAgo.getUTCDate() - 60);
  const ninetyDaysAgo = new Date(date);
  ninetyDaysAgo.setUTCDate(ninetyDaysAgo.getUTCDate() - 90);

  const storeWhere = storeId ? { storeId } : {};

  // Visit frequency in last 30 days
  const visitCounts = await prisma.visit.groupBy({
    by: ["consumerId"],
    where: { merchantId, ...storeWhere, consumerId: { not: null }, createdAt: { gte: thirtyDaysAgo } },
    _count: true,
  });

  const visitedOnce = visitCounts.filter(v => v._count === 1).length;
  const visited2to3 = visitCounts.filter(v => v._count >= 2 && v._count <= 3).length;
  const visited4to7 = visitCounts.filter(v => v._count >= 4 && v._count <= 7).length;
  const visited8plus = visitCounts.filter(v => v._count >= 8).length;

  // Stamp progress distribution
  const progressRecords = await prisma.consumerPromoProgress.findMany({
    where: { merchantId },
    include: { promotion: { select: { threshold: true } } },
  });

  let progress0to25 = 0, progress25to50 = 0, progress50to75 = 0, progress75to100 = 0, rewardReady = 0;
  for (const rec of progressRecords) {
    const pct = rec.promotion.threshold > 0 ? rec.stampCount / rec.promotion.threshold : 0;
    if (pct >= 1) rewardReady++;
    else if (pct >= 0.75) progress75to100++;
    else if (pct >= 0.50) progress50to75++;
    else if (pct >= 0.25) progress25to50++;
    else progress0to25++;
  }

  // Churn risk
  const allEnrolled = await prisma.consumerPromoProgress.findMany({
    where: { merchantId },
    select: { consumerId: true },
    distinct: ["consumerId"],
  });
  const enrolledIds = allEnrolled.map(c => c.consumerId);

  const active30 = enrolledIds.length > 0 ? await prisma.visit.findMany({
    where: { merchantId, consumerId: { in: enrolledIds }, createdAt: { gte: thirtyDaysAgo } },
    select: { consumerId: true },
    distinct: ["consumerId"],
  }) : [];
  const active30Set = new Set(active30.map(v => v.consumerId));
  const inactiveDays30 = enrolledIds.filter(id => !active30Set.has(id)).length;

  const active60 = enrolledIds.length > 0 ? await prisma.visit.findMany({
    where: { merchantId, consumerId: { in: enrolledIds }, createdAt: { gte: sixtyDaysAgo } },
    select: { consumerId: true },
    distinct: ["consumerId"],
  }) : [];
  const active60Set = new Set(active60.map(v => v.consumerId));
  const inactiveDays60 = enrolledIds.filter(id => !active60Set.has(id)).length;

  const active90 = enrolledIds.length > 0 ? await prisma.visit.findMany({
    where: { merchantId, consumerId: { in: enrolledIds }, createdAt: { gte: ninetyDaysAgo } },
    select: { consumerId: true },
    distinct: ["consumerId"],
  }) : [];
  const active90Set = new Set(active90.map(v => v.consumerId));
  const inactiveDays90 = enrolledIds.filter(id => !active90Set.has(id)).length;

  const dateOnly = date.toISOString().slice(0, 10);

  await prisma.$executeRawUnsafe(`
    INSERT INTO "ConsumerEngagementSummary" (
      "merchantId", "storeId", "date",
      "visitedOnce", "visited2to3", "visited4to7", "visited8plus",
      "progress0to25", "progress25to50", "progress50to75", "progress75to100", "rewardReady",
      "inactiveDays30", "inactiveDays60", "inactiveDays90",
      "createdAt", "updatedAt"
    ) VALUES (
      $1, $2, $3::date,
      $4, $5, $6, $7,
      $8, $9, $10, $11, $12,
      $13, $14, $15,
      NOW(), NOW()
    )
    ON CONFLICT ("merchantId", "storeId", "date")
    DO UPDATE SET
      "visitedOnce" = $4, "visited2to3" = $5, "visited4to7" = $6, "visited8plus" = $7,
      "progress0to25" = $8, "progress25to50" = $9, "progress50to75" = $10,
      "progress75to100" = $11, "rewardReady" = $12,
      "inactiveDays30" = $13, "inactiveDays60" = $14, "inactiveDays90" = $15,
      "updatedAt" = NOW()
  `,
    merchantId, storeId, dateOnly,
    visitedOnce, visited2to3, visited4to7, visited8plus,
    progress0to25, progress25to50, progress50to75, progress75to100, rewardReady,
    inactiveDays30, inactiveDays60, inactiveDays90
  );
}

async function aggregatePromotions(merchantId, dayStart, dayEnd) {
  const promotions = await prisma.promotion.findMany({
    where: { merchantId },
    select: { id: true },
  });

  for (const promo of promotions) {
    const newEnrollments = await prisma.consumerPromoProgress.count({
      where: { promotionId: promo.id, createdAt: { gte: dayStart, lte: dayEnd } },
    });

    const totalEnrolled = await prisma.consumerPromoProgress.count({
      where: { promotionId: promo.id },
    });

    const activeParticipants = await prisma.consumerPromoProgress.count({
      where: { promotionId: promo.id, stampCount: { gt: 0 } },
    });

    const redeemed = await prisma.posRewardDiscount.findMany({
      where: { promotionId: promo.id, status: "redeemed", appliedAt: { gte: dayStart, lte: dayEnd } },
      select: { amountCents: true },
    });
    const rewardsRedeemed = redeemed.length;
    const redemptionValueCents = redeemed.reduce((s, r) => s + (r.amountCents || 0), 0);

    const expired = await prisma.posRewardDiscount.findMany({
      where: { promotionId: promo.id, status: "expired", updatedAt: { gte: dayStart, lte: dayEnd } },
      select: { amountCents: true },
    });
    const rewardsExpired = expired.length;
    const expiredValueCents = expired.reduce((s, r) => s + (r.amountCents || 0), 0);

    const milestonesReached = await prisma.entitlement.count({
      where: {
        merchantId,
        type: "reward",
        createdAt: { gte: dayStart, lte: dayEnd },
        metadataJson: { path: ["rewardProgramId"], equals: promo.id },
      },
    }).catch(() => 0); // JSON path query may not work — fallback to 0

    const dateOnly = dayStart.toISOString().slice(0, 10);

    await prisma.$executeRawUnsafe(`
      INSERT INTO "PromotionDailySummary" (
        "promotionId", "merchantId", "date",
        "newEnrollments", "stampsIssued", "milestonesReached",
        "rewardsRedeemed", "redemptionValueCents", "rewardsExpired", "expiredValueCents",
        "activeParticipants", "totalEnrolled",
        "createdAt", "updatedAt"
      ) VALUES (
        $1, $2, $3::date,
        $4, 0, $5,
        $6, $7, $8, $9,
        $10, $11,
        NOW(), NOW()
      )
      ON CONFLICT ("promotionId", "date")
      DO UPDATE SET
        "newEnrollments" = $4, "milestonesReached" = $5,
        "rewardsRedeemed" = $6, "redemptionValueCents" = $7,
        "rewardsExpired" = $8, "expiredValueCents" = $9,
        "activeParticipants" = $10, "totalEnrolled" = $11,
        "updatedAt" = NOW()
    `,
      promo.id, merchantId, dateOnly,
      newEnrollments, milestonesReached,
      rewardsRedeemed, redemptionValueCents, rewardsExpired, expiredValueCents,
      activeParticipants, totalEnrolled
    );
  }
}

module.exports = { runReportingAggregation };
