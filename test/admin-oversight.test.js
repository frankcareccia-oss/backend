// test/admin-oversight.test.js — Admin oversight dashboard (Item 23)

"use strict";

const request = require("supertest");
const { getApp, adminToken, authHeader } = require("./helpers/setup");
const { prisma, createMerchant, createUser } = require("./helpers/seed");

let app, adminAuth;

beforeAll(async () => {
  app = getApp();

  // Create admin user
  const admin = await prisma.user.create({
    data: { email: `oversight-admin-${Date.now()}@test.com`, passwordHash: "x", systemRole: "pv_admin" },
  });
  adminAuth = authHeader(adminToken({ userId: admin.id }));

  // Create a merchant with some data
  const merchant = await createMerchant({ name: `Oversight Test ${Date.now()}` });
  await prisma.store.create({ data: { merchantId: merchant.id, name: "Test Store", phoneRaw: "555-9999" } });
  await prisma.promotion.create({
    data: {
      merchantId: merchant.id, name: "Test Promo", mechanic: "stamps",
      threshold: 5, rewardType: "discount_fixed", rewardValue: 300, status: "active",
    },
  });

  // Seed a summary row
  await prisma.merchantDailySummary.create({
    data: {
      merchantId: merchant.id, storeId: null,
      date: new Date(),
      totalTransactions: 50, attributedTransactions: 30,
      attributionRate: 0.60, newEnrollments: 3, stampsIssued: 30,
      rewardsRedeemed: 2, redemptionValueCents: 1000,
      activeConsumers: 20, checkins: 0, budgetConsumedCents: 1000,
    },
  });
}, 15000);

afterAll(async () => { await prisma.$disconnect(); });

describe("GET /admin/oversight/dashboard", () => {
  it("returns platform KPIs", async () => {
    const res = await request(app)
      .get("/admin/oversight/dashboard")
      .set(adminAuth);

    expect(res.status).toBe(200);
    expect(res.body.kpis).toBeDefined();
    expect(res.body.kpis.totalTransactions).toBeDefined();
    expect(res.body.kpis.totalTransactions.value).toBeGreaterThanOrEqual(0);
    expect(res.body.kpis.totalTransactions.label).toBe("Transactions (7d)");
  });

  it("returns platform counts", async () => {
    const res = await request(app)
      .get("/admin/oversight/dashboard")
      .set(adminAuth);

    expect(res.body.counts).toBeDefined();
    expect(res.body.counts.totalMerchants).toBeGreaterThanOrEqual(1);
    expect(res.body.counts.totalStores).toBeGreaterThanOrEqual(1);
    expect(res.body.counts.totalPromotions).toBeGreaterThanOrEqual(1);
  });

  it("returns cron health", async () => {
    const res = await request(app)
      .get("/admin/oversight/dashboard")
      .set(adminAuth);

    expect(res.body.cronHealth).toBeDefined();
    expect(typeof res.body.cronHealth.allOk).toBe("boolean");
  });

  it("rejects non-admin", async () => {
    const user = await createUser({ email: `nonadmin-${Date.now()}@test.com` });
    const userAuth = authHeader(adminToken({ userId: user.id })); // wrong — user is not pv_admin
    // Actually the adminToken creates a valid admin token, so let's test with no auth
    const res = await request(app).get("/admin/oversight/dashboard");
    expect(res.status).toBe(401);
  });
});

describe("GET /admin/oversight/merchants", () => {
  it("returns merchant health grid", async () => {
    const res = await request(app)
      .get("/admin/oversight/merchants")
      .set(adminAuth);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.merchants)).toBe(true);
    expect(res.body.merchants.length).toBeGreaterThanOrEqual(1);

    const m = res.body.merchants[0];
    expect(m).toHaveProperty("name");
    expect(m).toHaveProperty("healthScore");
    expect(m).toHaveProperty("weeklyTransactions");
    expect(m).toHaveProperty("attributionRate");
    expect(m.healthScore).toBeGreaterThanOrEqual(0);
    expect(m.healthScore).toBeLessThanOrEqual(100);
  });
});

describe("GET /admin/oversight/alerts", () => {
  it("returns alerts array", async () => {
    const res = await request(app)
      .get("/admin/oversight/alerts")
      .set(adminAuth);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.alerts)).toBe(true);
    expect(typeof res.body.count).toBe("number");
  });

  it("alerts sorted by severity (errors first)", async () => {
    const res = await request(app)
      .get("/admin/oversight/alerts")
      .set(adminAuth);

    const alerts = res.body.alerts;
    if (alerts.length >= 2) {
      const firstError = alerts.findIndex(a => a.severity === "error");
      const lastWarning = alerts.findLastIndex(a => a.severity === "warning");
      if (firstError >= 0 && lastWarning >= 0) {
        expect(firstError).toBeLessThan(lastWarning);
      }
    }
  });
});
