// test/conditional-promotion.test.js — Conditional promotion type + multiplier

"use strict";

const {
  applyMultiplier,
  isWithinTimeWindow,
} = require("../src/pos/pos.precedence.engine");

// ── isWithinTimeWindow ──────────────────────────────────────

describe("isWithinTimeWindow", () => {
  test("matches when day and hour are within range", () => {
    // Tuesday 3pm
    const timestamp = new Date("2026-04-21T15:30:00"); // Tuesday
    const condition = { activeDays: ["tue"], activeStartHour: 14, activeEndHour: 17 };
    expect(isWithinTimeWindow(timestamp, condition)).toBe(true);
  });

  test("rejects when day doesn't match", () => {
    // Monday 3pm
    const timestamp = new Date("2026-04-20T15:30:00"); // Monday
    const condition = { activeDays: ["tue", "wed"], activeStartHour: 14, activeEndHour: 17 };
    expect(isWithinTimeWindow(timestamp, condition)).toBe(false);
  });

  test("rejects when hour is before window", () => {
    const timestamp = new Date("2026-04-21T13:30:00"); // Tuesday 1:30pm
    const condition = { activeDays: ["tue"], activeStartHour: 14, activeEndHour: 17 };
    expect(isWithinTimeWindow(timestamp, condition)).toBe(false);
  });

  test("rejects when hour is at or after window end", () => {
    const timestamp = new Date("2026-04-21T17:00:00"); // Tuesday 5pm (end of window)
    const condition = { activeDays: ["tue"], activeStartHour: 14, activeEndHour: 17 };
    expect(isWithinTimeWindow(timestamp, condition)).toBe(false);
  });

  test("matches when no day restriction (all days)", () => {
    const timestamp = new Date("2026-04-23T15:30:00"); // Thursday
    const condition = { activeDays: null, activeStartHour: 14, activeEndHour: 17 };
    expect(isWithinTimeWindow(timestamp, condition)).toBe(true);
  });

  test("matches when no hour restriction", () => {
    const timestamp = new Date("2026-04-21T08:00:00"); // Tuesday 8am
    const condition = { activeDays: ["tue"], activeStartHour: null, activeEndHour: null };
    expect(isWithinTimeWindow(timestamp, condition)).toBe(true);
  });

  test("handles overnight window (22-6)", () => {
    const lateNight = new Date("2026-04-21T23:30:00");
    const earlyMorning = new Date("2026-04-22T04:00:00");
    const midDay = new Date("2026-04-21T12:00:00");
    const condition = { activeDays: null, activeStartHour: 22, activeEndHour: 6 };

    expect(isWithinTimeWindow(lateNight, condition)).toBe(true);
    expect(isWithinTimeWindow(earlyMorning, condition)).toBe(true);
    expect(isWithinTimeWindow(midDay, condition)).toBe(false);
  });

  test("matches multiple days", () => {
    const tuesday = new Date("2026-04-21T15:00:00");
    const thursday = new Date("2026-04-23T15:00:00");
    const wednesday = new Date("2026-04-22T15:00:00");
    const condition = { activeDays: ["tue", "thu"], activeStartHour: 14, activeEndHour: 17 };

    expect(isWithinTimeWindow(tuesday, condition)).toBe(true);
    expect(isWithinTimeWindow(thursday, condition)).toBe(true);
    expect(isWithinTimeWindow(wednesday, condition)).toBe(false);
  });
});

// ── applyMultiplier ─────────────────────────────────────────

describe("applyMultiplier", () => {
  test("returns 1x when no conditions", () => {
    const { multiplier } = applyMultiplier([], { transactionTime: new Date() });
    expect(multiplier).toBe(1);
  });

  test("applies time-based multiplier when within window", () => {
    const conditions = [{
      conditionType: "time",
      activeDays: ["tue"],
      activeStartHour: 14,
      activeEndHour: 17,
      bonusMultiplier: 2.0,
      bonusLabel: "Tuesday afternoon bonus",
    }];

    const { multiplier, bonusLabel } = applyMultiplier(conditions, {
      transactionTime: new Date("2026-04-21T15:30:00"), // Tuesday 3:30pm
    });

    expect(multiplier).toBe(2);
    expect(bonusLabel).toBe("Tuesday afternoon bonus");
  });

  test("returns 1x when outside time window", () => {
    const conditions = [{
      conditionType: "time",
      activeDays: ["tue"],
      activeStartHour: 14,
      activeEndHour: 17,
      bonusMultiplier: 2.0,
    }];

    const { multiplier } = applyMultiplier(conditions, {
      transactionTime: new Date("2026-04-21T10:00:00"), // Tuesday 10am (outside)
    });

    expect(multiplier).toBe(1);
  });

  test("applies lapse-based multiplier for inactive consumer", () => {
    const conditions = [{
      conditionType: "lapse",
      lapseDays: 30,
      bonusMultiplier: 2.0,
      bonusLabel: "Welcome back",
    }];

    const { multiplier, bonusLabel } = applyMultiplier(conditions, {
      transactionTime: new Date("2026-04-21"),
      lastVisitAt: new Date("2026-03-10"), // 42 days ago
    });

    expect(multiplier).toBe(2);
    expect(bonusLabel).toBe("Welcome back");
  });

  test("returns 1x for lapse when consumer visited recently", () => {
    const conditions = [{
      conditionType: "lapse",
      lapseDays: 30,
      bonusMultiplier: 2.0,
    }];

    const { multiplier } = applyMultiplier(conditions, {
      transactionTime: new Date("2026-04-21"),
      lastVisitAt: new Date("2026-04-15"), // 6 days ago
    });

    expect(multiplier).toBe(1);
  });

  test("applies lapse for first-ever visit (no lastVisitAt)", () => {
    const conditions = [{
      conditionType: "lapse",
      lapseDays: 30,
      bonusMultiplier: 2.0,
      bonusLabel: "Welcome bonus",
    }];

    const { multiplier } = applyMultiplier(conditions, {
      transactionTime: new Date("2026-04-21"),
      lastVisitAt: null,
    });

    expect(multiplier).toBe(2);
  });

  test("applies spend-based multiplier when order meets minimum", () => {
    const conditions = [{
      conditionType: "spend",
      minimumSpendCents: 1500,
      bonusMultiplier: 3.0,
      bonusLabel: "Big order bonus",
    }];

    const { multiplier } = applyMultiplier(conditions, {
      transactionTime: new Date(),
      orderTotalCents: 2000,
    });

    expect(multiplier).toBe(3);
  });

  test("returns 1x for spend when order below minimum", () => {
    const conditions = [{
      conditionType: "spend",
      minimumSpendCents: 1500,
      bonusMultiplier: 3.0,
    }];

    const { multiplier } = applyMultiplier(conditions, {
      transactionTime: new Date(),
      orderTotalCents: 800,
    });

    expect(multiplier).toBe(1);
  });

  test("takes highest multiplier when multiple conditions match (no stacking)", () => {
    const conditions = [
      { conditionType: "time", activeDays: null, activeStartHour: 0, activeEndHour: 23, bonusMultiplier: 2.0, bonusLabel: "Happy hour" },
      { conditionType: "lapse", lapseDays: 7, bonusMultiplier: 3.0, bonusLabel: "Welcome back" },
    ];

    const { multiplier, bonusLabel } = applyMultiplier(conditions, {
      transactionTime: new Date("2026-04-21T15:00:00"),
      lastVisitAt: new Date("2026-04-01"), // 20 days ago — lapse triggers
    });

    // Both match, but 3x > 2x, so 3x wins
    expect(multiplier).toBe(3);
    expect(bonusLabel).toBe("Welcome back");
  });

  test("handles null conditions gracefully", () => {
    const { multiplier } = applyMultiplier(null, { transactionTime: new Date() });
    expect(multiplier).toBe(1);
  });
});

// ── Integration: conditional promo creation via API ──────────

const request = require("supertest");
const { getApp, merchantToken, authHeader } = require("./helpers/setup");
const { prisma, resetDb, createMerchant, createUser, addMerchantUser } = require("./helpers/seed");

describe("POST /merchant/promotions (conditional)", () => {
  let app, auth, merchant;

  beforeAll(async () => {
    app = getApp();
    // Don't resetDb — other tests may have run. Just create our own merchant.
    merchant = await createMerchant({ name: "Cond Test Shop" });
    const cat = await prisma.productCategory.create({ data: { merchantId: merchant.id, name: "Drinks" } });
    const owner = await createUser({ email: "cond-owner@test.com" });
    await addMerchantUser({ merchantId: merchant.id, userId: owner.id, role: "owner" });
    auth = authHeader(merchantToken({ userId: owner.id, merchantId: merchant.id }));
  }, 10000);

  it("creates promotion with time-based condition", async () => {
    const cat = await prisma.productCategory.findFirst({ where: { merchantId: merchant.id } });

    const res = await request(app)
      .post("/merchant/promotions")
      .set(auth)
      .send({
        name: "Afternoon Double",
        mechanic: "stamps",
        threshold: 8,
        rewardType: "discount_fixed",
        rewardValue: 500,
        categoryId: cat.id,
        promotionType: "conditional",
        conditions: [{
          conditionType: "time",
          activeDays: ["tue", "wed", "thu"],
          activeStartHour: 14,
          activeEndHour: 17,
          bonusMultiplier: 2.0,
          bonusLabel: "Afternoon bonus",
        }],
      });

    expect(res.status).toBe(201);
    expect(res.body.promotion.conditions).toHaveLength(1);
    expect(res.body.promotion.conditions[0].conditionType).toBe("time");
    expect(res.body.promotion.conditions[0].bonusMultiplier).toBe(2.0);
    expect(res.body.promotion.conditions[0].activeDays).toEqual(["tue", "wed", "thu"]);
  });

  it("creates promotion with lapse-based condition", async () => {
    const cat = await prisma.productCategory.findFirst({ where: { merchantId: merchant.id } });

    const res = await request(app)
      .post("/merchant/promotions")
      .set(auth)
      .send({
        name: "Welcome Back",
        mechanic: "stamps",
        threshold: 8,
        rewardType: "discount_fixed",
        rewardValue: 300,
        categoryId: cat.id,
        promotionType: "conditional",
        conditions: [{
          conditionType: "lapse",
          lapseDays: 30,
          bonusMultiplier: 2.0,
          bonusLabel: "Welcome back bonus",
        }],
      });

    expect(res.status).toBe(201);
    expect(res.body.promotion.conditions[0].conditionType).toBe("lapse");
    expect(res.body.promotion.conditions[0].lapseDays).toBe(30);
  });
});
