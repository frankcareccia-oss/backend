/**
 * stamp.expiry.cron.js — Nightly stamp expiry enforcement
 *
 * Safety net: resets stampCount to 0 for consumers whose stamps
 * are older than the promotion's timeframeDays.
 *
 * The inline check in accumulateStamps handles real-time expiry.
 * This cron catches any that slip through (e.g., consumer never visits again).
 */

"use strict";

const { prisma } = require("../db/prisma");

async function runStampExpiry() {
  const now = new Date();

  // Find all promotions with timeframeDays set
  const promos = await prisma.promotion.findMany({
    where: { status: "active", timeframeDays: { not: null } },
    select: { id: true, timeframeDays: true },
  });

  let totalExpired = 0;

  for (const promo of promos) {
    const cutoffDate = new Date(now.getTime() - promo.timeframeDays * 24 * 60 * 60 * 1000);

    // Find progress records with stamps that are older than the cutoff
    const expired = await prisma.consumerPromoProgress.findMany({
      where: {
        promotionId: promo.id,
        stampCount: { gt: 0 },
        lastEarnedAt: { lt: cutoffDate },
      },
      select: { id: true, consumerId: true, stampCount: true },
    });

    if (expired.length === 0) continue;

    // Reset stampCount to 0 for all expired
    await prisma.consumerPromoProgress.updateMany({
      where: { id: { in: expired.map(e => e.id) } },
      data: { stampCount: 0 },
    });

    totalExpired += expired.length;
    console.log(`[stamp.expiry] promo=${promo.id}: expired ${expired.length} consumers (timeframe=${promo.timeframeDays}d)`);
  }

  return { promosChecked: promos.length, consumersExpired: totalExpired };
}

module.exports = { runStampExpiry };
