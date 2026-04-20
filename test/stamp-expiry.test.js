// test/stamp-expiry.test.js — Stamp expiry enforcement

"use strict";

const { prisma, createMerchant } = require("./helpers/seed");
const { runStampExpiry } = require("../src/cron/stamp.expiry.cron");

let merchant, promo30d, promoNoExpiry, consumer;

beforeAll(async () => {
  merchant = await createMerchant({ name: `StampExpiry Test ${Date.now()}` });
  const cat = await prisma.productCategory.create({ data: { merchantId: merchant.id, name: "Test" } });

  // Promo with 30-day timeframe
  promo30d = await prisma.promotion.create({
    data: {
      merchantId: merchant.id, name: "30 Day Stamps", mechanic: "stamps",
      threshold: 8, rewardType: "discount_fixed", rewardValue: 500,
      status: "active", timeframeDays: 30, categoryId: cat.id,
    },
  });

  // Promo without expiry
  promoNoExpiry = await prisma.promotion.create({
    data: {
      merchantId: merchant.id, name: "No Expiry", mechanic: "stamps",
      threshold: 8, rewardType: "discount_fixed", rewardValue: 500,
      status: "active", timeframeDays: null, categoryId: cat.id,
    },
  });

  consumer = await prisma.consumer.create({
    data: { phoneE164: `+1408555${Date.now().toString().slice(-4)}`, firstName: "Expiry" },
  });
}, 15000);

afterAll(async () => { await prisma.$disconnect(); });

describe("Nightly stamp expiry cron", () => {
  test("expires stamps older than timeframeDays", async () => {
    // Create progress with old stamps
    await prisma.consumerPromoProgress.create({
      data: {
        consumerId: consumer.id, promotionId: promo30d.id, merchantId: merchant.id,
        stampCount: 5, lifetimeEarned: 5,
        lastEarnedAt: new Date(Date.now() - 45 * 86400000), // 45 days ago — expired
      },
    });

    const result = await runStampExpiry();
    expect(result.consumersExpired).toBeGreaterThanOrEqual(1);

    const progress = await prisma.consumerPromoProgress.findUnique({
      where: { consumerId_promotionId: { consumerId: consumer.id, promotionId: promo30d.id } },
    });
    expect(progress.stampCount).toBe(0); // reset
    expect(progress.lifetimeEarned).toBe(5); // preserved
  });

  test("does NOT expire stamps within timeframe", async () => {
    // Update to recent stamps
    await prisma.consumerPromoProgress.update({
      where: { consumerId_promotionId: { consumerId: consumer.id, promotionId: promo30d.id } },
      data: { stampCount: 3, lastEarnedAt: new Date(Date.now() - 5 * 86400000) }, // 5 days ago
    });

    await runStampExpiry();

    const progress = await prisma.consumerPromoProgress.findUnique({
      where: { consumerId_promotionId: { consumerId: consumer.id, promotionId: promo30d.id } },
    });
    expect(progress.stampCount).toBe(3); // NOT reset
  });

  test("does NOT expire stamps on promos without timeframeDays", async () => {
    await prisma.consumerPromoProgress.create({
      data: {
        consumerId: consumer.id, promotionId: promoNoExpiry.id, merchantId: merchant.id,
        stampCount: 7, lifetimeEarned: 7,
        lastEarnedAt: new Date(Date.now() - 90 * 86400000), // 90 days ago
      },
    });

    await runStampExpiry();

    const progress = await prisma.consumerPromoProgress.findUnique({
      where: { consumerId_promotionId: { consumerId: consumer.id, promotionId: promoNoExpiry.id } },
    });
    expect(progress.stampCount).toBe(7); // NOT reset — no timeframe
  });

  test("preserves lifetimeEarned when expiring stamps", async () => {
    // Set up expired stamps again
    await prisma.consumerPromoProgress.update({
      where: { consumerId_promotionId: { consumerId: consumer.id, promotionId: promo30d.id } },
      data: { stampCount: 4, lastEarnedAt: new Date(Date.now() - 35 * 86400000) },
    });

    await runStampExpiry();

    const progress = await prisma.consumerPromoProgress.findUnique({
      where: { consumerId_promotionId: { consumerId: consumer.id, promotionId: promo30d.id } },
    });
    expect(progress.stampCount).toBe(0);
    expect(progress.lifetimeEarned).toBe(5); // never decrements
  });
});

describe("Inline stamp expiry in accumulateStamps", () => {
  test("resets expired stamps before accumulating new one", async () => {
    const { accumulateStamps } = require("../src/pos/pos.stamps");

    // Deactivate other promos to avoid precedence interference
    await prisma.promotion.updateMany({ where: { merchantId: merchant.id }, data: { status: "draft" } });
    await prisma.promotion.update({ where: { id: promo30d.id }, data: { status: "active" } });

    // Set up expired stamps
    await prisma.consumerPromoProgress.upsert({
      where: { consumerId_promotionId: { consumerId: consumer.id, promotionId: promo30d.id } },
      create: {
        consumerId: consumer.id, promotionId: promo30d.id, merchantId: merchant.id,
        stampCount: 6, lifetimeEarned: 6,
        lastEarnedAt: new Date(Date.now() - 35 * 86400000), // expired
      },
      update: {
        stampCount: 6,
        lastEarnedAt: new Date(Date.now() - 35 * 86400000),
      },
    });

    // Accumulate should reset first, then add 1
    const results = await accumulateStamps(prisma, {
      consumerId: consumer.id, merchantId: merchant.id,
      storeId: null, visitId: null, posType: "square",
    });

    expect(results.length).toBe(1);
    expect(results[0].stampCount).toBe(1); // reset to 0, then +1 = 1
  });
});
