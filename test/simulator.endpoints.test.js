// test/simulator.endpoints.test.js — Simulator API endpoints + promo description

"use strict";

const request = require("supertest");
const { getApp, merchantToken, adminToken, authHeader } = require("./helpers/setup");
const { prisma, resetDb, createMerchant, createUser, addMerchantUser } = require("./helpers/seed");

let app, merchAuth, adminAuth, merchant, store, promo, owner;

beforeAll(async () => {
  app = getApp();
  await resetDb();

  merchant = await createMerchant({ name: "Sim Test Coffee" });
  await prisma.merchant.update({
    where: { id: merchant.id },
    data: { merchantType: "coffee_shop", avgTransactionValueCents: 750 },
  });

  store = await prisma.store.create({
    data: { merchantId: merchant.id, name: "Downtown Roastery", phoneRaw: "555-1001" },
  });

  // Create a category for promotions
  const cat = await prisma.productCategory.create({
    data: { merchantId: merchant.id, name: "Coffee" },
  });

  promo = await prisma.promotion.create({
    data: {
      merchantId: merchant.id, name: "Coffee Stamps", mechanic: "stamps",
      threshold: 8, repeatable: true, rewardType: "discount_fixed",
      rewardValue: 500, status: "active", objective: "bring-back",
      categoryId: cat.id,
    },
  });

  owner = await createUser({ email: "sim-owner@test.com" });
  await addMerchantUser({ merchantId: merchant.id, userId: owner.id, role: "owner" });
  merchAuth = authHeader(merchantToken({ userId: owner.id, merchantId: merchant.id }));

  const admin = await prisma.user.create({
    data: { email: "sim-admin@test.com", passwordHash: "x", systemRole: "pv_admin" },
  });
  adminAuth = authHeader(adminToken({ userId: admin.id }));

  // Seed some summary data for baseline
  await prisma.merchantDailySummary.create({
    data: {
      merchantId: merchant.id, storeId: null,
      date: new Date("2026-04-10"),
      totalTransactions: 80, attributedTransactions: 48,
      attributionRate: 0.60, newEnrollments: 5, stampsIssued: 48,
      rewardsRedeemed: 3, redemptionValueCents: 1500,
      activeConsumers: 30, checkins: 0, budgetConsumedCents: 1500,
    },
  });
}, 15000);

afterAll(async () => { await prisma.$disconnect(); });

// ── Simulator baseline endpoint ─────────────────────────────

describe("GET /merchant/reporting/simulator/new/:type", () => {
  it("returns baseline with objectives metadata", async () => {
    const res = await request(app)
      .get("/merchant/reporting/simulator/new/stamp?objective=bring-back")
      .set(merchAuth);

    expect(res.status).toBe(200);
    expect(res.body.baseline).toBeDefined();
    expect(res.body.objectives).toBeDefined();
    expect(res.body.objectives["bring-back"]).toBeDefined();
    expect(res.body.objectives["bring-back"].label).toContain("back");
    expect(res.body.merchantType).toBe("coffee_shop");
  });

  it("includes avgTransactionValueCents in baseline", async () => {
    const res = await request(app)
      .get("/merchant/reporting/simulator/new/stamp")
      .set(merchAuth);

    expect(res.body.baseline.avgTransactionValueCents).toBe(750);
  });

  it("returns 403 without auth", async () => {
    const res = await request(app).get("/merchant/reporting/simulator/new/stamp");
    expect(res.status).toBe(401);
  });
});

describe("GET /merchant/reporting/simulator/:promotionId", () => {
  it("returns projection and validation for existing promo", async () => {
    const res = await request(app)
      .get(`/merchant/reporting/simulator/${promo.id}`)
      .set(merchAuth);

    expect(res.status).toBe(200);
    expect(res.body.promotion).toBeDefined();
    expect(res.body.promotion.objective).toBe("bring-back");
    expect(res.body.projection).toBeDefined();
    expect(res.body.projection.objective).toBe("bring-back");
    expect(res.body.projection.dataSufficiency).toBeDefined();
    expect(res.body.projection.netRevenueCents).toBeDefined();
    expect(res.body.baseline).toBeDefined();
  });

  it("returns 404 for non-existent promo", async () => {
    const res = await request(app)
      .get("/merchant/reporting/simulator/99999")
      .set(merchAuth);

    expect(res.status).toBe(404);
  });

  it("allows objective override via query param", async () => {
    const res = await request(app)
      .get(`/merchant/reporting/simulator/${promo.id}?objective=fill-slow`)
      .set(merchAuth);

    expect(res.status).toBe(200);
    // Should use query param objective, not the promo's saved one
    expect(res.body.projection.objective).toBe("fill-slow");
  });
});

// ── AOV endpoint ─────────────────────────────────────────────

describe("PATCH /merchant/reporting/simulator/aov", () => {
  it("saves average transaction value", async () => {
    const res = await request(app)
      .patch("/merchant/reporting/simulator/aov")
      .set(merchAuth)
      .send({ avgTransactionValueCents: 850 });

    expect(res.status).toBe(200);
    expect(res.body.avgTransactionValueCents).toBe(850);

    // Verify persisted
    const m = await prisma.merchant.findUnique({ where: { id: merchant.id } });
    expect(m.avgTransactionValueCents).toBe(850);
  });

  it("rejects values below $1", async () => {
    const res = await request(app)
      .patch("/merchant/reporting/simulator/aov")
      .set(merchAuth)
      .send({ avgTransactionValueCents: 50 });

    expect(res.status).toBe(400);
  });

  it("rejects values above $1000", async () => {
    const res = await request(app)
      .patch("/merchant/reporting/simulator/aov")
      .set(merchAuth)
      .send({ avgTransactionValueCents: 200000 });

    expect(res.status).toBe(400);
  });
});

// ── Promotion creation with new fields ───────────────────────

describe("POST /merchant/promotions (objective + dates)", () => {
  it("creates promotion with objective and dates", async () => {
    const cat = await prisma.productCategory.findFirst({ where: { merchantId: merchant.id } });

    const res = await request(app)
      .post("/merchant/promotions")
      .set(merchAuth)
      .send({
        name: "Growth Studio Promo",
        mechanic: "stamps",
        threshold: 10,
        rewardType: "discount_fixed",
        rewardValue: 300,
        categoryId: cat.id,
        objective: "grow-base",
        startAt: "2026-05-01",
        endAt: "2026-08-01",
        rewardExpiryDays: 60,
      });

    expect(res.status).toBe(201);
    expect(res.body.promotion.status).toBe("draft");

    // Verify fields persisted
    const created = await prisma.promotion.findUnique({ where: { id: res.body.promotion.id } });
    expect(created.objective).toBe("grow-base");
    expect(created.rewardExpiryDays).toBe(60);
    expect(created.startAt).toBeDefined();
    expect(created.endAt).toBeDefined();
  });

  it("creates promotion without objective (null)", async () => {
    const cat = await prisma.productCategory.findFirst({ where: { merchantId: merchant.id } });

    const res = await request(app)
      .post("/merchant/promotions")
      .set(merchAuth)
      .send({
        name: "No Objective Promo",
        mechanic: "stamps",
        threshold: 5,
        rewardType: "custom",
        rewardNote: "Free upgrade",
        categoryId: cat.id,
      });

    expect(res.status).toBe(201);
    const created = await prisma.promotion.findUnique({ where: { id: res.body.promotion.id } });
    expect(created.objective).toBeNull();
  });
});

// ── Stores list for scope dropdown ───────────────────────────

describe("GET /merchant/stores (for scope dropdown)", () => {
  it("returns stores as { items: [...] }", async () => {
    const res = await request(app)
      .get("/merchant/stores")
      .set(merchAuth);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(res.body.items.length).toBeGreaterThanOrEqual(1);
    expect(res.body.items[0].name).toBe("Downtown Roastery");
  });

  it("rejects pv_admin with 403", async () => {
    const res = await request(app)
      .get("/merchant/stores")
      .set(adminAuth);

    expect(res.status).toBe(403);
  });
});

// ── Promotion description generation ─────────────────────────

describe("POST /merchant/promotions/generate-description", () => {
  // Skip if ANTHROPIC_API_KEY not set (CI without key)
  const hasKey = !!process.env.ANTHROPIC_API_KEY;

  it("requires name field", async () => {
    const res = await request(app)
      .post("/merchant/promotions/generate-description")
      .set(merchAuth)
      .send({});

    expect(res.status).toBe(400);
  });

  (hasKey ? it : it.skip)("generates two versions for stamp promo", async () => {
    const res = await request(app)
      .post("/merchant/promotions/generate-description")
      .set(merchAuth)
      .send({
        name: "Coffee Stamps",
        categoryName: "Coffee",
        promotionType: "stamp",
        threshold: 8,
        rewardType: "discount_fixed",
        rewardValue: 500,
      });

    expect(res.status).toBe(200);
    expect(res.body.versionA).toBeDefined();
    expect(res.body.versionA.length).toBeGreaterThan(20);
    // versionB may be empty if AI didn't return valid JSON, but versionA should always work
  }, 15000);

  it("returns 401 without auth", async () => {
    const res = await request(app)
      .post("/merchant/promotions/generate-description")
      .send({ name: "Test" });

    expect(res.status).toBe(401);
  });
});

// ── Dashboard with projection data ──────────────────────────

describe("GET /merchant/reporting/dashboard", () => {
  it("returns KPIs and time series from summary data", async () => {
    const res = await request(app)
      .get("/merchant/reporting/dashboard?period=30d")
      .set(merchAuth);

    expect(res.status).toBe(200);
    expect(res.body.kpis).toBeDefined();
    expect(res.body.timeSeries).toBeDefined();
    expect(res.body.period).toBeDefined();
  });
});
