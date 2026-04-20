// test/tiered-promotion.test.js — Tiered promotion type

"use strict";

const request = require("supertest");
const { getApp, merchantToken, authHeader } = require("./helpers/setup");
const { prisma, resetDb, createMerchant, createUser, addMerchantUser } = require("./helpers/seed");

let app, auth, merchant, store, category, owner;

beforeAll(async () => {
  app = getApp();
  await resetDb();

  merchant = await createMerchant({ name: "Tier Test Coffee" });
  store = await prisma.store.create({
    data: { merchantId: merchant.id, name: "Main Store", phoneRaw: "555-0001" },
  });
  category = await prisma.productCategory.create({
    data: { merchantId: merchant.id, name: "Coffee" },
  });

  owner = await createUser({ email: "tier-owner@test.com" });
  await addMerchantUser({ merchantId: merchant.id, userId: owner.id, role: "owner" });
  auth = authHeader(merchantToken({ userId: owner.id, merchantId: merchant.id }));
}, 15000);

afterAll(async () => { await prisma.$disconnect(); });

// ── Create tiered promotion ─────────────────────────────────

describe("POST /merchant/promotions (tiered)", () => {
  let tieredPromo;

  it("creates promotion with tiers", async () => {
    const res = await request(app)
      .post("/merchant/promotions")
      .set(auth)
      .send({
        name: "BLVD Rewards",
        mechanic: "stamps",
        threshold: 5, // base threshold (used for stamp promos, tiers override)
        rewardType: "discount_fixed",
        rewardValue: 200,
        categoryId: category.id,
        promotionType: "tiered",
        tiers: [
          { tierName: "Bronze", threshold: 5, rewardType: "discount_fixed", rewardValue: 200 },
          { tierName: "Silver", threshold: 15, rewardType: "discount_fixed", rewardValue: 500 },
          { tierName: "Gold", threshold: 30, rewardType: "discount_fixed", rewardValue: 1000, rewardNote: "Plus a free coffee" },
        ],
      });

    expect(res.status).toBe(201);
    expect(res.body.promotion.promotionType).toBe("tiered");
    expect(res.body.promotion.tiers).toHaveLength(3);
    expect(res.body.promotion.tiers[0].tierName).toBe("Bronze");
    expect(res.body.promotion.tiers[1].tierName).toBe("Silver");
    expect(res.body.promotion.tiers[2].tierName).toBe("Gold");
    expect(res.body.promotion.tiers[2].threshold).toBe(30);

    tieredPromo = res.body.promotion;
  });

  it("persists tiers in database", async () => {
    const tiers = await prisma.promotionTier.findMany({
      where: { promotionId: tieredPromo.id },
      orderBy: { tierLevel: "asc" },
    });

    expect(tiers).toHaveLength(3);
    expect(tiers[0].tierLevel).toBe(1);
    expect(tiers[1].tierLevel).toBe(2);
    expect(tiers[2].tierLevel).toBe(3);
    expect(tiers[2].rewardValue).toBe(1000);
    expect(tiers[2].rewardNote).toBe("Plus a free coffee");
  });

  it("returns tiers in GET list", async () => {
    // Activate first
    await prisma.promotion.update({ where: { id: tieredPromo.id }, data: { status: "active" } });

    const res = await request(app)
      .get("/merchant/promotions?status=active")
      .set(auth);

    expect(res.status).toBe(200);
    const found = res.body.promotions.find(p => p.id === tieredPromo.id);
    expect(found).toBeDefined();
    expect(found.tiers).toHaveLength(3);
    expect(found.promotionType).toBe("tiered");
  });
});

// ── Tiered accumulation logic ────────────────────────────────

describe("Tiered stamp accumulation", () => {
  let tieredPromo, consumer;

  beforeAll(async () => {
    // Deactivate any other promos at this merchant to avoid precedence interference
    await prisma.promotion.updateMany({ where: { merchantId: merchant.id }, data: { status: "draft" } });

    // Create an active tiered promo
    tieredPromo = await prisma.promotion.create({
      data: {
        merchantId: merchant.id, name: "Tier Accum Test", mechanic: "stamps",
        threshold: 5, repeatable: true, rewardType: "discount_fixed",
        rewardValue: 200, status: "active", promotionType: "tiered",
        categoryId: category.id,
        tiers: {
          create: [
            { tierName: "Bronze", tierLevel: 1, threshold: 5, rewardType: "discount_fixed", rewardValue: 200 },
            { tierName: "Silver", tierLevel: 2, threshold: 10, rewardType: "discount_fixed", rewardValue: 500 },
            { tierName: "Gold", tierLevel: 3, threshold: 20, rewardType: "discount_fixed", rewardValue: 1000 },
          ],
        },
      },
      include: { tiers: true },
    });

    consumer = await prisma.consumer.create({
      data: { phoneE164: "+14085559999", firstName: "Tier", lastName: "Tester" },
    });
  });

  it("accumulates stamps toward tier threshold", async () => {
    const { accumulateStamps } = require("../src/pos/pos.stamps");

    // Accumulate 4 stamps — no tier crossed yet
    for (let i = 0; i < 4; i++) {
      await accumulateStamps(prisma, {
        consumerId: consumer.id, merchantId: merchant.id,
        storeId: store.id, visitId: null, posType: "square",
      });
    }

    const progress = await prisma.consumerPromoProgress.findUnique({
      where: { consumerId_promotionId: { consumerId: consumer.id, promotionId: tieredPromo.id } },
    });

    expect(progress).toBeDefined();
    expect(progress.stampCount).toBe(4);
    expect(progress.lifetimeEarned).toBe(4);
    expect(progress.currentTierLevel).toBe(0); // not yet Bronze
  });

  it("crosses Bronze tier at 5 visits and grants reward", async () => {
    const { accumulateStamps } = require("../src/pos/pos.stamps");

    const results = await accumulateStamps(prisma, {
      consumerId: consumer.id, merchantId: merchant.id,
      storeId: store.id, visitId: null, posType: "square",
    });

    expect(results[0].milestoneEarned).toBe(true);
    expect(results[0].tierCrossed).toEqual({ name: "Bronze", level: 1 });

    const progress = await prisma.consumerPromoProgress.findUnique({
      where: { consumerId_promotionId: { consumerId: consumer.id, promotionId: tieredPromo.id } },
    });

    expect(progress.currentTierLevel).toBe(1);
    expect(progress.lifetimeEarned).toBe(5);
    // Tiered doesn't reset stampCount
    expect(progress.stampCount).toBe(5);

    // Verify entitlement was created
    const entitlements = await prisma.entitlement.findMany({
      where: { consumerId: consumer.id, merchantId: merchant.id, type: "reward" },
    });
    expect(entitlements.length).toBeGreaterThanOrEqual(1);
    const latest = entitlements[entitlements.length - 1];
    expect(latest.metadataJson.tierName).toBe("Bronze");
  });

  it("does NOT reset stampCount for tiered promos (unlike stamp cards)", async () => {
    const progress = await prisma.consumerPromoProgress.findUnique({
      where: { consumerId_promotionId: { consumerId: consumer.id, promotionId: tieredPromo.id } },
    });

    // stampCount should still be 5, not reset to 0
    expect(progress.stampCount).toBe(5);
  });

  it("tier level is permanent — never decreases", async () => {
    const progress = await prisma.consumerPromoProgress.findUnique({
      where: { consumerId_promotionId: { consumerId: consumer.id, promotionId: tieredPromo.id } },
    });

    expect(progress.currentTierLevel).toBe(1); // Bronze, permanent
  });

  it("continues accumulating toward Silver", async () => {
    const { accumulateStamps } = require("../src/pos/pos.stamps");

    // 5 more stamps to reach 10 (Silver threshold)
    for (let i = 0; i < 5; i++) {
      await accumulateStamps(prisma, {
        consumerId: consumer.id, merchantId: merchant.id,
        storeId: store.id, visitId: null, posType: "square",
      });
    }

    const progress = await prisma.consumerPromoProgress.findUnique({
      where: { consumerId_promotionId: { consumerId: consumer.id, promotionId: tieredPromo.id } },
    });

    expect(progress.currentTierLevel).toBe(2); // Silver
    expect(progress.lifetimeEarned).toBe(10);
  });
});

// ── Precedence engine with tiered ────────────────────────────

describe("Precedence engine with tiered promos", () => {
  it("selects tiered promo when closer to milestone", () => {
    const { selectWinningPromotion } = require("../src/pos/pos.precedence.engine");

    const stampPromo = {
      id: 1, promotionId: 100, stampCount: 2, lifetimeEarned: 2,
      promotion: { id: 100, threshold: 8, rewardValue: 500, promotionType: "stamp", timeframeDays: null },
    };
    const tieredPromo = {
      id: 2, promotionId: 200, stampCount: 4, lifetimeEarned: 4,
      promotion: { id: 200, threshold: 5, rewardValue: 200, promotionType: "tiered", timeframeDays: null },
    };

    const { winner, reason } = selectWinningPromotion([stampPromo, tieredPromo]);
    expect(reason).toBe("closest_to_milestone");
    expect(winner.promotionId).toBe(200); // 4/5 = 80% vs 2/8 = 25%
  });
});
