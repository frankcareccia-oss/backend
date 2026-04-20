// test/growth-advisor-v2.test.js — Growth Advisor v2 patterns + recommendations

"use strict";

const { detectGrowthPatterns } = require("../src/growth/growth.patterns");
const { buildGrowthRecommendations } = require("../src/growth/growth.recommendations");

// ── V2 Pattern Detection ─────────────────────────────────────

describe("V2 patterns", () => {
  const baseMetrics = {
    totalOrders: 100,
    aov: 850,
    repeatRate: 0.35,
    firstToSecondVisitRate: 0.30,
    topProducts: [{ name: "Latte", revenue: 5000, orders: 50, pctOfRevenue: 40 }],
    revenueByHour: Array.from({ length: 24 }, () => ({ revenue: 100, orders: 5 })),
  };

  test("detects declining attribution", () => {
    const patterns = detectGrowthPatterns({
      ...baseMetrics,
      attributionTrend: { current: 0.42, prior: 0.65 },
    });
    const found = patterns.find(p => p.type === "attribution_declining");
    expect(found).toBeDefined();
    expect(found.detail.current).toBe(42);
    expect(found.detail.dropPct).toBeGreaterThan(30);
  });

  test("does NOT flag attribution when stable", () => {
    const patterns = detectGrowthPatterns({
      ...baseMetrics,
      attributionTrend: { current: 0.70, prior: 0.72 },
    });
    expect(patterns.find(p => p.type === "attribution_declining")).toBeUndefined();
  });

  test("detects promo stalling", () => {
    const patterns = detectGrowthPatterns({
      ...baseMetrics,
      promoStallRate: 0.75,
      stalledPromoName: "Coffee Stamps",
    });
    const found = patterns.find(p => p.type === "promo_stalling");
    expect(found).toBeDefined();
    expect(found.detail.stallRate).toBe(75);
    expect(found.detail.promoName).toBe("Coffee Stamps");
  });

  test("detects tier bottleneck", () => {
    const patterns = detectGrowthPatterns({
      ...baseMetrics,
      tierBottleneck: {
        promoName: "VIP Club",
        tierName: "Silver",
        nextTierName: "Gold",
        countAtTier: 20,
        countAtNext: 3,
        nextThreshold: 30,
      },
    });
    const found = patterns.find(p => p.type === "tier_bottleneck");
    expect(found).toBeDefined();
    expect(found.detail.tierName).toBe("Silver");
  });

  test("detects referral opportunity", () => {
    const patterns = detectGrowthPatterns({
      ...baseMetrics,
      repeatRate: 0.55,
      hasReferralPromo: false,
    });
    const found = patterns.find(p => p.type === "referral_opportunity");
    expect(found).toBeDefined();
    expect(found.detail.repeatRate).toBe(55);
  });

  test("does NOT suggest referral when already has one", () => {
    const patterns = detectGrowthPatterns({
      ...baseMetrics,
      repeatRate: 0.55,
      hasReferralPromo: true,
    });
    expect(patterns.find(p => p.type === "referral_opportunity")).toBeUndefined();
  });

  test("detects revenue momentum up", () => {
    const patterns = detectGrowthPatterns({
      ...baseMetrics,
      revenueWeekOverWeek: { current: 120, prior: 80 },
    });
    const found = patterns.find(p => p.type === "revenue_momentum_up");
    expect(found).toBeDefined();
    expect(found.detail.changePct).toBe(50);
  });

  test("detects revenue momentum down", () => {
    const patterns = detectGrowthPatterns({
      ...baseMetrics,
      revenueWeekOverWeek: { current: 60, prior: 100 },
    });
    const found = patterns.find(p => p.type === "revenue_momentum_down");
    expect(found).toBeDefined();
    expect(found.detail.changePct).toBe(-40);
  });

  test("ignores small revenue changes (<15%)", () => {
    const patterns = detectGrowthPatterns({
      ...baseMetrics,
      revenueWeekOverWeek: { current: 95, prior: 100 },
    });
    expect(patterns.find(p => p.type?.startsWith("revenue_momentum"))).toBeUndefined();
  });
});

// ── V2 Recommendations ──────────────────────────────────────

describe("V2 recommendations", () => {
  const metrics = {
    aov: 850,
    topProducts: [{ name: "Latte", revenue: 5000, orders: 50, pctOfRevenue: 40 }],
  };

  test("generates attribution training recommendation", () => {
    const patterns = [{ type: "attribution_declining", severity: "high", detail: { current: 42, prior: 65, dropPct: 35 } }];
    const recs = buildGrowthRecommendations(metrics, patterns);
    expect(recs.length).toBe(1);
    expect(recs[0].type).toBe("attribution_training");
    expect(recs[0].title).toContain("35%");
    expect(recs[0].description).toContain("phone numbers");
  });

  test("generates promo adjustment recommendation", () => {
    const patterns = [{ type: "promo_stalling", severity: "high", detail: { stallRate: 75, promoName: "Coffee Card" } }];
    const recs = buildGrowthRecommendations(metrics, patterns);
    expect(recs[0].type).toBe("promo_adjustment");
    expect(recs[0].title).toContain("75%");
    expect(recs[0].description).toContain("Coffee Card");
  });

  test("generates tier adjustment recommendation", () => {
    const patterns = [{
      type: "tier_bottleneck", severity: "medium",
      detail: { tierName: "Silver", nextTierName: "Gold", countAtTier: 20, countAtNext: 3, nextThreshold: 30 },
    }];
    const recs = buildGrowthRecommendations(metrics, patterns);
    expect(recs[0].type).toBe("tier_adjustment");
    expect(recs[0].title).toContain("Silver");
    expect(recs[0].description).toContain("23"); // 30 * 0.75 = 22.5 → 23
  });

  test("generates referral launch recommendation", () => {
    const patterns = [{ type: "referral_opportunity", severity: "medium", detail: { repeatRate: 55 } }];
    const recs = buildGrowthRecommendations(metrics, patterns);
    expect(recs[0].type).toBe("referral_launch");
    expect(recs[0].description).toContain("Bring a friend");
  });

  test("generates positive momentum recommendation", () => {
    const patterns = [{ type: "revenue_momentum_up", severity: "info", detail: { changePct: 25, currentWeekCents: 12500, priorWeekCents: 10000 } }];
    const recs = buildGrowthRecommendations(metrics, patterns);
    expect(recs[0].type).toBe("momentum_positive");
    expect(recs[0].title).toContain("25%");
  });

  test("generates momentum action recommendation for decline", () => {
    const patterns = [{ type: "revenue_momentum_down", severity: "high", detail: { changePct: -30, currentWeekCents: 7000, priorWeekCents: 10000 } }];
    const recs = buildGrowthRecommendations(metrics, patterns);
    expect(recs[0].type).toBe("momentum_action");
    expect(recs[0].title).toContain("30%");
    expect(recs[0].description).toContain("double stamps");
  });

  test("recommendations sorted by priority", () => {
    const patterns = [
      { type: "revenue_momentum_up", severity: "info", detail: { changePct: 20, currentWeekCents: 1200, priorWeekCents: 1000 } },
      { type: "attribution_declining", severity: "high", detail: { current: 40, prior: 65, dropPct: 38 } },
    ];
    const recs = buildGrowthRecommendations(metrics, patterns);
    expect(recs[0].type).toBe("attribution_training"); // priority 1
    expect(recs[1].type).toBe("momentum_positive"); // priority 3
  });
});
