// test/bundle-promotion.test.js — Bundle promotion type (Item 20d)

"use strict";

const request = require("supertest");
const { getApp, merchantToken, authHeader } = require("./helpers/setup");
const { prisma, createMerchant, createUser, addMerchantUser } = require("./helpers/seed");
const { processBundleItems } = require("../src/promo/promo.bundle");

let app, auth, merchant, consumer, bundlePromo;

beforeAll(async () => {
  app = getApp();
  merchant = await createMerchant({ name: `Bundle Test ${Date.now()}` });
  const cat = await prisma.productCategory.create({ data: { merchantId: merchant.id, name: "Combo" } });

  const owner = await createUser({ email: `bundle-owner-${Date.now()}@test.com` });
  await addMerchantUser({ merchantId: merchant.id, userId: owner.id, role: "owner" });
  auth = authHeader(merchantToken({ userId: owner.id, merchantId: merchant.id }));

  consumer = await prisma.consumer.create({
    data: { phoneE164: `+1408555${Date.now().toString().slice(-4)}`, firstName: "Bundle" },
  });

  // Create bundle promo with definition
  bundlePromo = await prisma.promotion.create({
    data: {
      merchantId: merchant.id, name: "Morning Combo", mechanic: "stamps",
      threshold: 1, rewardType: "discount_fixed", rewardValue: 250,
      status: "active", promotionType: "bundle", categoryId: cat.id,
      bundleDefinition: {
        create: {
          items: [
            { sku: "LATTE", name: "Latte", quantity: 1 },
            { sku: "MUFFIN", name: "Blueberry Muffin", quantity: 1 },
            { sku: "JUICE", name: "Orange Juice", quantity: 1 },
          ],
          bundlePriceCents: 1200,
          savingsCents: 350,
          validityDays: 30,
        },
      },
    },
    include: { bundleDefinition: true },
  });
}, 15000);

afterAll(async () => { await prisma.$disconnect(); });

// ── API: Create bundle promo ─────────────────────────────────

describe("POST /merchant/promotions (bundle)", () => {
  it("creates bundle promo with definition", async () => {
    const cat = await prisma.productCategory.findFirst({ where: { merchantId: merchant.id } });

    const res = await request(app)
      .post("/merchant/promotions")
      .set(auth)
      .send({
        name: "Afternoon Combo",
        mechanic: "stamps",
        threshold: 1,
        rewardType: "discount_fixed",
        rewardValue: 200,
        categoryId: cat.id,
        promotionType: "bundle",
        bundleDefinition: {
          items: [
            { name: "Drip Coffee", quantity: 1 },
            { name: "Croissant", quantity: 1 },
          ],
          bundlePriceCents: 850,
          savingsCents: 200,
          validityDays: 14,
        },
      });

    expect(res.status).toBe(201);
    expect(res.body.promotion.promotionType).toBe("bundle");
    expect(res.body.promotion.bundleDefinition).toBeDefined();
    expect(res.body.promotion.bundleDefinition.items).toHaveLength(2);
    expect(res.body.promotion.bundleDefinition.bundlePriceCents).toBe(850);
    expect(res.body.promotion.bundleDefinition.savingsCents).toBe(200);
  });
});

// ── Item matching logic ──────────────────────────────────────

describe("processBundleItems", () => {
  it("checks off matching items from order", async () => {
    const results = await processBundleItems({
      consumerId: consumer.id,
      merchantId: merchant.id,
      orderItems: [
        { itemName: "Latte" },
        { itemName: "Blueberry Muffin" },
      ],
    });

    expect(results).toHaveLength(1);
    expect(results[0].promotionId).toBe(bundlePromo.id);
    expect(results[0].newlyChecked).toHaveLength(2);
    expect(results[0].completed).toBe(false); // 2 of 3, not complete yet
    expect(results[0].checkedItems).toContain("LATTE");
    expect(results[0].checkedItems).toContain("MUFFIN");
  });

  it("completes bundle when last item purchased", async () => {
    const results = await processBundleItems({
      consumerId: consumer.id,
      merchantId: merchant.id,
      orderItems: [
        { itemName: "Orange Juice" },
      ],
    });

    expect(results).toHaveLength(1);
    expect(results[0].completed).toBe(true);
    expect(results[0].checkedItems).toHaveLength(3);

    // Verify progress record
    const progress = await prisma.bundleProgress.findUnique({
      where: { consumerId_promotionId: { consumerId: consumer.id, promotionId: bundlePromo.id } },
    });
    expect(progress.complete).toBe(true);
    expect(progress.completedAt).toBeDefined();
  });

  it("grants entitlement on bundle completion", async () => {
    const entitlements = await prisma.entitlement.findMany({
      where: { consumerId: consumer.id, merchantId: merchant.id, type: "reward" },
    });
    const bundleReward = entitlements.find(e => e.metadataJson?.bundleComplete === true);
    expect(bundleReward).toBeDefined();
    expect(bundleReward.metadataJson.displayLabel).toContain("Bundle complete");
  });

  it("skips already-completed bundles", async () => {
    const results = await processBundleItems({
      consumerId: consumer.id,
      merchantId: merchant.id,
      orderItems: [{ itemName: "Latte" }],
    });

    // Bundle already complete — should not process
    expect(results).toHaveLength(0);
  });

  it("does not match items not in bundle", async () => {
    // New consumer for clean slate
    const consumer2 = await prisma.consumer.create({
      data: { phoneE164: `+1408666${Date.now().toString().slice(-4)}`, firstName: "NoMatch" },
    });

    const results = await processBundleItems({
      consumerId: consumer2.id,
      merchantId: merchant.id,
      orderItems: [
        { itemName: "Espresso" }, // not in bundle
        { itemName: "Bagel" },    // not in bundle
      ],
    });

    // No items matched — but progress record created (empty)
    if (results.length > 0) {
      expect(results[0].newlyChecked).toHaveLength(0);
    }
  });

  it("matches by fuzzy name (contains)", async () => {
    const consumer3 = await prisma.consumer.create({
      data: { phoneE164: `+1408777${Date.now().toString().slice(-4)}`, firstName: "Fuzzy" },
    });

    const results = await processBundleItems({
      consumerId: consumer3.id,
      merchantId: merchant.id,
      orderItems: [
        { itemName: "Vanilla Latte (12oz)" }, // contains "latte"
      ],
    });

    expect(results).toHaveLength(1);
    expect(results[0].newlyChecked).toHaveLength(1);
    expect(results[0].checkedItems).toContain("LATTE");
  });
});

// ── Validity window ──────────────────────────────────────────

describe("Bundle validity window", () => {
  it("resets progress when validity expires", async () => {
    const consumer4 = await prisma.consumer.create({
      data: { phoneE164: `+1408888${Date.now().toString().slice(-4)}`, firstName: "Expired" },
    });

    // Create expired progress
    await prisma.bundleProgress.create({
      data: {
        consumerId: consumer4.id, promotionId: bundlePromo.id, merchantId: merchant.id,
        checkedItems: ["LATTE"],
        startedAt: new Date(Date.now() - 45 * 86400000), // 45 days ago — expired (30 day window)
      },
    });

    const results = await processBundleItems({
      consumerId: consumer4.id,
      merchantId: merchant.id,
      orderItems: [{ itemName: "Muffin" }],
    });

    // Progress should have been reset, then muffin matched
    expect(results).toHaveLength(1);
    expect(results[0].checkedItems).not.toContain("LATTE"); // old latte cleared
    expect(results[0].checkedItems).toContain("MUFFIN");
  });
});
