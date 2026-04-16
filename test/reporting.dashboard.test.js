// test/reporting.dashboard.test.js — Reporting aggregation + dashboard API

"use strict";

const request = require("supertest");
const { getApp, merchantToken, authHeader } = require("./helpers/setup");
const { prisma, resetDb, createMerchant, createUser, addMerchantUser } = require("./helpers/seed");

let app, auth, merchant, store, promo;

beforeAll(async () => {
  app = getApp();
  await resetDb();

  merchant = await createMerchant({ name: "Dashboard Test Shop" });
  store = await prisma.store.create({
    data: { merchantId: merchant.id, name: "Dash Store", phoneRaw: "555-0001" },
  });
  promo = await prisma.promotion.create({
    data: {
      merchantId: merchant.id, name: "Dash Promo", mechanic: "stamps",
      threshold: 5, repeatable: true, rewardType: "discount_fixed",
      rewardValue: 300, status: "active",
    },
  });

  const owner = await createUser({ email: "dash-owner@test.com" });
  await addMerchantUser({ merchantId: merchant.id, userId: owner.id, role: "owner" });
  auth = authHeader(merchantToken({ userId: owner.id, merchantId: merchant.id }));

  // Seed visits
  const consumer = await prisma.consumer.create({
    data: { phoneE164: "+14085554444", firstName: "Dash", lastName: "Tester" },
  });
  for (let i = 0; i < 5; i++) {
    await prisma.visit.create({
      data: {
        merchantId: merchant.id, storeId: store.id,
        consumerId: i < 3 ? consumer.id : null,
        source: "manual",
        createdAt: new Date("2026-04-15T12:00:00Z"),
      },
    });
  }

  // Run aggregation
  const { runReportingAggregation } = require("../src/cron/reporting.aggregate.cron");
  await runReportingAggregation({ fromDate: new Date("2026-04-15"), toDate: new Date("2026-04-15") });
}, 15000);

afterAll(async () => { await prisma.$disconnect(); });

describe("Reporting Aggregation", () => {
  it("computes correct attribution rate", async () => {
    const row = await prisma.merchantDailySummary.findFirst({
      where: { merchantId: merchant.id, storeId: null },
    });
    expect(row).toBeDefined();
    expect(row.totalTransactions).toBe(5);
    expect(row.attributedTransactions).toBe(3);
    expect(row.attributionRate).toBeCloseTo(0.6, 1);
  });

  it("creates per-store row", async () => {
    const row = await prisma.merchantDailySummary.findFirst({
      where: { merchantId: merchant.id, storeId: store.id },
    });
    expect(row).toBeDefined();
    expect(row.totalTransactions).toBe(5);
  });

  it("is idempotent — row count stable across runs", async () => {
    const countBefore = await prisma.merchantDailySummary.count({
      where: { merchantId: merchant.id },
    });
    const { runReportingAggregation } = require("../src/cron/reporting.aggregate.cron");
    await runReportingAggregation({ fromDate: new Date("2026-04-15"), toDate: new Date("2026-04-15") });
    const countAfter = await prisma.merchantDailySummary.count({
      where: { merchantId: merchant.id },
    });
    expect(countAfter).toBe(countBefore);
  });
});

describe("Dashboard API", () => {
  it("returns KPIs with trends", async () => {
    const res = await request(app).get("/merchant/reporting/dashboard?period=30d").set(auth);
    expect(res.status).toBe(200);
    expect(res.body.kpis.totalTransactions.value).toBeGreaterThanOrEqual(0);
    expect(res.body.kpis.totalTransactions.trend).toBeDefined();
    expect(res.body.kpis.attributionRate).toBeDefined();
  });

  it("returns time series", async () => {
    const res = await request(app).get("/merchant/reporting/dashboard?period=30d").set(auth);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.timeSeries)).toBe(true);
  });

  it("returns promotions", async () => {
    const res = await request(app).get("/merchant/reporting/dashboard?period=30d").set(auth);
    expect(res.status).toBe(200);
    expect(res.body.promotions.length).toBeGreaterThanOrEqual(1);
    expect(res.body.promotions[0].name).toBe("Dash Promo");
  });

  it("returns store list", async () => {
    const res = await request(app).get("/merchant/reporting/stores").set(auth);
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThanOrEqual(1);
  });

  it("returns simulator baseline", async () => {
    const res = await request(app).get(`/merchant/reporting/simulator/${promo.id}`).set(auth);
    expect(res.status).toBe(200);
    expect(res.body.baseline.dataAgeDays).toBeDefined();
    expect(res.body.promotion.name).toBe("Dash Promo");
  });

  it("returns new promo simulator with empty history", async () => {
    const res = await request(app).get("/merchant/reporting/simulator/new/stamp").set(auth);
    expect(res.status).toBe(200);
    expect(res.body.historical).toEqual([]);
    expect(res.body.lockedFields).toEqual([]);
  });

  it("rejects unauthenticated", async () => {
    const res = await request(app).get("/merchant/reporting/dashboard");
    expect(res.status).toBe(401);
  });
});
