// test/simulator.projections.test.js — Objective-driven simulator projection engine

const {
  projectByObjective,
  getDataSufficiency,
  checkDivergence,
  rollingAverage,
  resolveBaseline,
  getIndustryDefaults,
  projectFrequency,
  projectEnrollment,
  projectBasketSize,
  projectTraffic,
  projectRetention,
  generateRevenueAndCostCurve,
  generateMetricCurve,
  OBJECTIVES,
} = require("../src/merchant/simulator.projections");

// ── Shared test baseline ────────────────────────────────────────

const BASELINE = {
  avgDailyVisitors: 100,
  attributionRate: 0.60,
  avgVisitsPerConsumerPerMonth: 2.5,
  currentEnrolled: 200,
  enrollmentConversionRate: 0.15,
  avgTransactionValueCents: 850,
  dataAgeDays: 30,
};

const PARAMS = {
  stampThreshold: 8,
  rewardValueCents: 500,
  expiryDays: 90,
  promotionType: "stamp",
};

// ── OBJECTIVES metadata ─────────────────────────────────────────

describe("OBJECTIVES metadata", () => {
  test("defines all five objectives", () => {
    expect(Object.keys(OBJECTIVES)).toEqual(
      expect.arrayContaining(["bring-back", "grow-base", "drive-revenue", "fill-slow", "reward-best"])
    );
  });

  test("each objective has label, metric, chartType", () => {
    for (const key of Object.keys(OBJECTIVES)) {
      expect(OBJECTIVES[key]).toHaveProperty("label");
      expect(OBJECTIVES[key]).toHaveProperty("metric");
      expect(OBJECTIVES[key]).toHaveProperty("chartType");
    }
  });

  test("fill-slow uses bar chart", () => {
    expect(OBJECTIVES["fill-slow"].chartType).toBe("bar");
  });
});

// ── Data sufficiency ────────────────────────────────────────────

describe("getDataSufficiency", () => {
  test("0 days = none level", () => {
    const s = getDataSufficiency(0, "coffee_shop");
    expect(s.level).toBe("none");
    expect(s.dots).toBe(0);
    expect(s.detail).toContain("industry averages");
  });

  test("3 days = minimal level", () => {
    const s = getDataSufficiency(3, "coffee_shop");
    expect(s.level).toBe("minimal");
    expect(s.dots).toBe(1);
    expect(s.estimateDays).toBe(4);
  });

  test("10 days = low level", () => {
    const s = getDataSufficiency(10);
    expect(s.level).toBe("low");
    expect(s.dots).toBe(2);
    expect(s.detail).toContain("10 days");
  });

  test("30 days = medium level", () => {
    const s = getDataSufficiency(30);
    expect(s.level).toBe("medium");
    expect(s.dots).toBe(3);
  });

  test("90 days = high level", () => {
    const s = getDataSufficiency(90);
    expect(s.level).toBe("high");
    expect(s.dots).toBe(5);
    expect(s.detail).toContain("3 months");
  });

  test("estimates days until better accuracy", () => {
    const s = getDataSufficiency(5, "retail");
    expect(s.estimateDays).toBe(2); // 7 - 5
  });
});

// ── Rolling average ─────────────────────────────────────────────

describe("rollingAverage", () => {
  test("smooths staircase input", () => {
    const staircase = [
      { date: "2026-04-01", value: 0 },
      { date: "2026-04-02", value: 0 },
      { date: "2026-04-03", value: 0 },
      { date: "2026-04-04", value: 10 },
      { date: "2026-04-05", value: 10 },
      { date: "2026-04-06", value: 10 },
      { date: "2026-04-07", value: 10 },
    ];
    const smoothed = rollingAverage(staircase, 7);
    // First point should be 0, last should be ~5.7 (average of 0,0,0,10,10,10,10)
    expect(smoothed[0].value).toBe(0);
    expect(smoothed[6].value).toBeCloseTo(5.71, 1);
    // All intermediate points should be between 0 and 10
    for (const pt of smoothed) {
      expect(pt.value).toBeGreaterThanOrEqual(0);
      expect(pt.value).toBeLessThanOrEqual(10);
    }
  });

  test("preserves date field", () => {
    const pts = [{ date: "2026-01-01", value: 5 }];
    const result = rollingAverage(pts);
    expect(result[0].date).toBe("2026-01-01");
  });

  test("handles single point", () => {
    const pts = [{ date: "2026-01-01", value: 42 }];
    const result = rollingAverage(pts, 7);
    expect(result[0].value).toBe(42);
  });
});

// ── Resolve baseline ────────────────────────────────────────────

describe("resolveBaseline", () => {
  test("uses merchant data when available", () => {
    const resolved = resolveBaseline(BASELINE, "coffee_shop");
    expect(resolved.avgDailyVisitors).toBe(100);
    expect(resolved.avgTransactionValueCents).toBe(850);
  });

  test("falls back to industry defaults when data missing", () => {
    const empty = { avgDailyVisitors: 0, attributionRate: 0, avgVisitsPerConsumerPerMonth: 0, currentEnrolled: 0, enrollmentConversionRate: 0, avgTransactionValueCents: 0, dataAgeDays: 0 };
    const resolved = resolveBaseline(empty, "coffee_shop");
    expect(resolved.avgDailyVisitors).toBe(120);
    expect(resolved.avgTransactionValueCents).toBe(650);
  });

  test("uses generic defaults for unknown merchant type", () => {
    const empty = { avgDailyVisitors: 0, attributionRate: 0, avgVisitsPerConsumerPerMonth: 0, currentEnrolled: 0, enrollmentConversionRate: 0, avgTransactionValueCents: 0, dataAgeDays: 0 };
    const resolved = resolveBaseline(empty, "unknown_type");
    expect(resolved.avgDailyVisitors).toBe(60);
    expect(resolved.avgTransactionValueCents).toBe(1500);
  });
});

// ── Industry defaults ───────────────────────────────────────────

describe("getIndustryDefaults", () => {
  test("returns coffee shop defaults", () => {
    const d = getIndustryDefaults("coffee_shop");
    expect(d.avgTransactionValueCents).toBe(650);
    expect(d.avgDailyVisitors).toBe(120);
  });

  test("returns generic defaults for unknown type", () => {
    const d = getIndustryDefaults("pet_grooming");
    expect(d.avgTransactionValueCents).toBe(1500);
  });
});

// ── Objective 1: Frequency ──────────────────────────────────────

describe("projectFrequency", () => {
  test("projects frequency lift for stamp program", () => {
    const result = projectFrequency(BASELINE, PARAMS);
    expect(result.objective).toBe("bring-back");
    expect(result.projectedValue).toMatch(/\dx$/);
    expect(result.projectedMonthlyRevenueCents).toBeGreaterThan(0);
    expect(result.changeDescription).toContain("+25%");
  });

  test("applies higher lift for tiered programs", () => {
    const tieredParams = { ...PARAMS, promotionType: "tiered" };
    const result = projectFrequency(BASELINE, tieredParams);
    expect(result.changeDescription).toContain("+40%");
  });

  test("uses previous outcome for learning loop", () => {
    const outcome = { repeatVisitLift: 0.30 };
    const result = projectFrequency(BASELINE, PARAMS, outcome);
    expect(result.changeDescription).toContain("+30%");
  });

  test("returns projection points array", () => {
    const result = projectFrequency(BASELINE, PARAMS);
    expect(result.projectionPoints).toHaveLength(91); // 0..90
    expect(result.projectionPoints[0]).toHaveProperty("date");
    expect(result.projectionPoints[0]).toHaveProperty("revenue");
    expect(result.projectionPoints[0]).toHaveProperty("cost");
  });
});

// ── Objective 2: Enrollment ─────────────────────────────────────

describe("projectEnrollment", () => {
  test("projects member growth", () => {
    const result = projectEnrollment(BASELINE, PARAMS);
    expect(result.objective).toBe("grow-base");
    expect(parseInt(result.projectedValue.replace(/,/g, ""))).toBeGreaterThan(BASELINE.currentEnrolled);
    expect(result.changeDescription).toContain("new members/month");
  });

  test("applies learning loop conversion rate", () => {
    const outcome = { enrollmentActual: 50, enrollmentProjected: 100 };
    const result = projectEnrollment(BASELINE, PARAMS, outcome);
    // Should adjust rate: 50/100 * 0.15 = 0.075
    expect(result.projectedMonthlyRevenueCents).toBeGreaterThan(0);
  });
});

// ── Objective 3: Basket Size ────────────────────────────────────

describe("projectBasketSize", () => {
  test("projects 25% AOV lift", () => {
    const result = projectBasketSize(BASELINE, PARAMS);
    expect(result.objective).toBe("drive-revenue");
    // Current $8.50 → projected $10.63
    expect(result.currentValue).toBe("$8.50");
    expect(result.changeDescription).toContain("per transaction");
    expect(result.projectedMonthlyRevenueCents).toBeGreaterThan(0);
  });
});

// ── Objective 4: Traffic ────────────────────────────────────────

describe("projectTraffic", () => {
  test("projects slow-period traffic lift", () => {
    const result = projectTraffic(BASELINE, PARAMS);
    expect(result.objective).toBe("fill-slow");
    expect(result.chartType).toBe("bar");
    expect(result.changeDescription).toContain("during slow periods");
  });

  test("generates bar chart data with target hours", () => {
    const result = projectTraffic(BASELINE, PARAMS);
    expect(result.barData).toBeDefined();
    expect(result.barData.length).toBe(13); // 6am..6pm
    const targetHours = result.barData.filter(h => h.isTarget);
    expect(targetHours.length).toBe(4); // 2pm-5pm
    // Projected should be higher than current in target window
    for (const h of targetHours) {
      expect(h.projected).toBeGreaterThanOrEqual(h.current);
    }
  });
});

// ── Objective 5: Retention ──────────────────────────────────────

describe("projectRetention", () => {
  test("projects retention lift from 34% to 52%", () => {
    const result = projectRetention(BASELINE, PARAMS);
    expect(result.objective).toBe("reward-best");
    expect(result.currentValue).toBe("34%");
    expect(result.projectedValue).toBe("52%");
    expect(result.changeDescription).toContain("return after first visit");
  });

  test("generates metric points with decay curve", () => {
    const result = projectRetention(BASELINE, PARAMS);
    expect(result.metricPoints).toBeDefined();
    expect(result.metricPoints.length).toBe(91);
  });
});

// ── Curve generators ────────────────────────────────────────────

describe("generateRevenueAndCostCurve", () => {
  test("generates 91 points for 90-day forward", () => {
    const curve = generateRevenueAndCostCurve(30000, 10000, 90);
    expect(curve).toHaveLength(91);
  });

  test("starts near zero and ramps up", () => {
    const curve = generateRevenueAndCostCurve(30000, 10000, 90);
    expect(curve[0].revenue).toBeLessThan(curve[90].revenue);
    expect(curve[0].cost).toBeLessThan(curve[90].cost);
  });

  test("revenue exceeds cost for net-positive promotion", () => {
    const curve = generateRevenueAndCostCurve(30000, 10000, 90);
    expect(curve[90].revenue).toBeGreaterThan(curve[90].cost);
    expect(curve[90].net).toBeGreaterThan(0);
  });
});

describe("generateMetricCurve", () => {
  test("generates points from current to projected", () => {
    const curve = generateMetricCurve(2.0, 3.0, 90, "s-curve");
    expect(curve).toHaveLength(91);
    expect(curve[0].historical).toBe(2.0);
  });
});

// ── Divergence check ────────────────────────────────────────────

describe("checkDivergence", () => {
  test("returns null when within 20%", () => {
    expect(checkDivergence(100, 85)).toBeNull();
    expect(checkDivergence(100, 115)).toBeNull();
  });

  test("detects underperformance", () => {
    const result = checkDivergence(100, 70);
    expect(result.direction).toBe("under");
    expect(result.divergencePct).toBe(-30);
  });

  test("detects overperformance", () => {
    const result = checkDivergence(100, 130);
    expect(result.direction).toBe("over");
    expect(result.divergencePct).toBe(30);
  });

  test("handles zero projected gracefully", () => {
    expect(checkDivergence(0, 50)).toBeNull();
  });

  test("handles null inputs", () => {
    expect(checkDivergence(null, 50)).toBeNull();
    expect(checkDivergence(50, null)).toBeNull();
  });
});

// ── Main dispatch ───────────────────────────────────────────────

describe("projectByObjective", () => {
  test("dispatches to correct projection for each objective", () => {
    const objectives = ["bring-back", "grow-base", "drive-revenue", "fill-slow", "reward-best"];
    for (const obj of objectives) {
      const result = projectByObjective(obj, BASELINE, PARAMS, "coffee_shop");
      expect(result.objective).toBe(obj);
      expect(result.dataSufficiency).toBeDefined();
      expect(result.baseline).toBeDefined();
      expect(result.projectedMonthlyRevenueCents).toBeDefined();
      expect(result.projectedMonthlyCostCents).toBeDefined();
      expect(result.netRevenueCents).toBeDefined();
    }
  });

  test("falls back to frequency for unknown objective", () => {
    const result = projectByObjective("unknown", BASELINE, PARAMS, "coffee_shop");
    expect(result.objective).toBe("bring-back");
  });

  test("includes data sufficiency in response", () => {
    const result = projectByObjective("bring-back", BASELINE, PARAMS, "coffee_shop");
    expect(result.dataSufficiency.level).toBe("medium");
    expect(result.dataSufficiency.dots).toBe(3);
  });

  test("uses industry defaults when merchant has no data", () => {
    const emptyBaseline = { avgDailyVisitors: 0, attributionRate: 0, avgVisitsPerConsumerPerMonth: 0, currentEnrolled: 0, enrollmentConversionRate: 0, avgTransactionValueCents: 0, dataAgeDays: 0 };
    const result = projectByObjective("bring-back", emptyBaseline, PARAMS, "coffee_shop");
    expect(result.baseline.avgDailyVisitors).toBe(120);
    expect(result.baseline.avgTransactionValueCents).toBe(650);
    expect(result.dataSufficiency.level).toBe("none");
  });

  test("net revenue card turns negative when cost exceeds revenue", () => {
    // High reward, low threshold = expensive
    const expensiveParams = { ...PARAMS, stampThreshold: 1, rewardValueCents: 5000 };
    const result = projectByObjective("bring-back", BASELINE, expensiveParams, "coffee_shop");
    expect(result.netRevenueCents).toBeLessThan(0);
  });
});
