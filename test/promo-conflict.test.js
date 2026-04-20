// test/promo-conflict.test.js — Promotion conflict detection

"use strict";

const { detectConflicts, calculateScopeOverlap } = require("../src/promo/promo.conflict");
const { prisma, createMerchant } = require("./helpers/seed");

let merchant;

beforeAll(async () => {
  merchant = await createMerchant({ name: `Conflict Test ${Date.now()}` });
  const cat = await prisma.productCategory.create({ data: { merchantId: merchant.id, name: "Coffee" } });

  // Create an active stamp promo (merchant-wide)
  await prisma.promotion.create({
    data: {
      merchantId: merchant.id, name: "Coffee Stamps", mechanic: "stamps",
      threshold: 8, rewardType: "discount_fixed", rewardValue: 500,
      status: "active", promotionType: "stamp", categoryId: cat.id,
    },
  });

  // Create an active conditional promo
  await prisma.promotion.create({
    data: {
      merchantId: merchant.id, name: "Afternoon Bonus", mechanic: "stamps",
      threshold: 8, rewardType: "discount_fixed", rewardValue: 300,
      status: "active", promotionType: "conditional", categoryId: cat.id,
    },
  });
}, 10000);

afterAll(async () => { await prisma.$disconnect(); });

// ── Scope overlap ────────────────────────────────────────────

describe("calculateScopeOverlap", () => {
  test("both merchant-wide = full overlap", () => {
    expect(calculateScopeOverlap({ storeId: null }, { storeId: null })).toBe("full");
  });

  test("same store = full overlap", () => {
    expect(calculateScopeOverlap({ storeId: 1 }, { storeId: 1 })).toBe("full");
  });

  test("different stores = no overlap", () => {
    expect(calculateScopeOverlap({ storeId: 1 }, { storeId: 2 })).toBe("none");
  });

  test("one merchant-wide + one store-specific = partial", () => {
    expect(calculateScopeOverlap({ storeId: null }, { storeId: 1 })).toBe("partial");
    expect(calculateScopeOverlap({ storeId: 1 }, { storeId: null })).toBe("partial");
  });
});

// ── Conflict detection ───────────────────────────────────────

describe("detectConflicts", () => {
  test("detects same-mechanic full overlap (new stamp vs existing stamp)", async () => {
    const conflicts = await detectConflicts({
      merchantId: merchant.id,
      promotionType: "stamp",
      storeId: null,
    }, "draft");

    const sameType = conflicts.find(c => c.type === "same_mechanic_full");
    expect(sameType).toBeDefined();
    expect(sameType.severity).toBe("warning");
    expect(sameType.existingPromo.name).toBe("Coffee Stamps");
    expect(sameType.explanation).toContain("precedence engine");
  });

  test("detects conditional as complementary (informational, not warning)", async () => {
    const conflicts = await detectConflicts({
      merchantId: merchant.id,
      promotionType: "stamp",
      storeId: null,
    }, "draft");

    const conditional = conflicts.find(c => c.type === "conditional_modifier");
    expect(conditional).toBeDefined();
    expect(conditional.severity).toBe("informational");
    expect(conditional.explanation).toContain("don't compete");
  });

  test("excludes self from conflict check", async () => {
    const existing = await prisma.promotion.findFirst({
      where: { merchantId: merchant.id, name: "Coffee Stamps" },
    });

    const conflicts = await detectConflicts({
      id: existing.id,
      merchantId: merchant.id,
      promotionType: "stamp",
      storeId: null,
    }, "activation");

    // Should not flag itself
    const selfConflict = conflicts.find(c => c.existingPromo?.id === existing.id);
    expect(selfConflict).toBeUndefined();
  });

  test("no conflicts when store-specific promo doesn't overlap", async () => {
    const store1 = await prisma.store.create({
      data: { merchantId: merchant.id, name: "Store A", phoneRaw: "555-0001" },
    });
    const store2 = await prisma.store.create({
      data: { merchantId: merchant.id, name: "Store B", phoneRaw: "555-0002" },
    });

    // Create a store-specific active promo
    await prisma.promotion.create({
      data: {
        merchantId: merchant.id, name: "Store A Only", mechanic: "stamps",
        threshold: 5, rewardType: "discount_fixed", rewardValue: 200,
        status: "active", promotionType: "stamp", storeId: store1.id,
      },
    });

    // Check conflicts for a different store
    const conflicts = await detectConflicts({
      merchantId: merchant.id,
      promotionType: "stamp",
      storeId: store2.id,
    }, "draft");

    // Should not include Store A promo (different store = no overlap)
    const storeAConflict = conflicts.find(c => c.existingPromo?.name === "Store A Only");
    expect(storeAConflict).toBeUndefined();
  });

  test("referral promos never conflict", async () => {
    await prisma.promotion.create({
      data: {
        merchantId: merchant.id, name: "Refer a Friend", mechanic: "stamps",
        threshold: 1, rewardType: "discount_fixed", rewardValue: 300,
        status: "active", promotionType: "referral",
      },
    });

    const conflicts = await detectConflicts({
      merchantId: merchant.id,
      promotionType: "stamp",
      storeId: null,
    }, "draft");

    const referralConflict = conflicts.find(c => c.existingPromo?.name === "Refer a Friend");
    expect(referralConflict).toBeUndefined();
  });

  test("returns empty array when no active promos exist", async () => {
    const emptyMerchant = await createMerchant({ name: `Empty ${Date.now()}` });
    const conflicts = await detectConflicts({
      merchantId: emptyMerchant.id,
      promotionType: "stamp",
      storeId: null,
    });
    expect(conflicts).toEqual([]);
  });
});

// ── API integration ──────────────────────────────────────────

const request = require("supertest");
const { getApp, merchantToken, authHeader } = require("./helpers/setup");
const { createUser, addMerchantUser } = require("./helpers/seed");

describe("POST /merchant/promotions — returns conflicts", () => {
  let app, auth;

  beforeAll(async () => {
    app = getApp();
    const owner = await createUser({ email: `conflict-api-${Date.now()}@test.com` });
    await addMerchantUser({ merchantId: merchant.id, userId: owner.id, role: "owner" });
    auth = authHeader(merchantToken({ userId: owner.id, merchantId: merchant.id }));
  });

  test("creation returns conflicts array when overlapping promos exist", async () => {
    const cat = await prisma.productCategory.findFirst({ where: { merchantId: merchant.id } });

    const res = await request(app)
      .post("/merchant/promotions")
      .set(auth)
      .send({
        name: "Another Stamp Card",
        mechanic: "stamps",
        threshold: 10,
        rewardType: "discount_fixed",
        rewardValue: 300,
        categoryId: cat.id,
        promotionType: "stamp",
      });

    expect(res.status).toBe(201);
    expect(res.body.conflicts).toBeDefined();
    expect(res.body.conflicts.length).toBeGreaterThan(0);
    expect(res.body.conflicts[0].type).toContain("same_mechanic");
  });

  test("GET /merchant/promotions/:id/conflicts returns pre-check", async () => {
    const promo = await prisma.promotion.findFirst({
      where: { merchantId: merchant.id, name: "Another Stamp Card" },
    });

    const res = await request(app)
      .get(`/merchant/promotions/${promo.id}/conflicts`)
      .set(auth);

    expect(res.status).toBe(200);
    expect(res.body.conflicts).toBeDefined();
    expect(typeof res.body.count).toBe("number");
  });
});
