/**
 * simulator.projections.js — Objective-driven projection engine
 *
 * Each projection function takes a baseline (merchant metrics) and params
 * (promotion config) and returns objective-specific metrics, summary cards,
 * and chart data points.
 *
 * The engine speaks the merchant's language, not the system's language.
 */

"use strict";

// ── Objective metadata ──────────────────────────────────────────

const OBJECTIVES = {
  "bring-back": {
    label: "Bring customers back more often",
    metric: "Avg visits/member/month",
    historicalLabel: "Current frequency",
    projectedLabel: "Projected frequency",
    chartType: "line",
  },
  "grow-base": {
    label: "Grow my loyal customer base",
    metric: "Total enrolled members",
    historicalLabel: "Current members",
    projectedLabel: "Projected members",
    chartType: "line",
  },
  "drive-revenue": {
    label: "Drive more revenue per visit",
    metric: "Avg transaction value ($)",
    historicalLabel: "Current avg transaction",
    projectedLabel: "Projected avg transaction",
    chartType: "line",
  },
  "fill-slow": {
    label: "Fill my slow periods",
    metric: "Transactions during target window",
    historicalLabel: "Current traffic",
    projectedLabel: "Projected traffic",
    chartType: "bar",
  },
  "reward-best": {
    label: "Reward my best customers",
    metric: "% of members still active at 90 days",
    historicalLabel: "Current retention",
    projectedLabel: "Projected retention",
    chartType: "line",
  },
};

// ── Data sufficiency ────────────────────────────────────────────

function getDataSufficiency(dataAgeDays, merchantType) {
  const category = merchantType || "business";

  if (dataAgeDays === 0) {
    return {
      level: "none",
      label: "No transaction data yet",
      detail: `These projections use industry averages for a ${category}. Once your POS data starts flowing, we'll replace them with your actual numbers — typically within 2-3 weeks.`,
      estimateDays: 14,
      dots: 0,
    };
  }
  if (dataAgeDays < 7) {
    return {
      level: "minimal",
      label: "Collecting data",
      detail: `We're still learning your store's patterns. Projections will become directional in ~${7 - dataAgeDays} days.`,
      estimateDays: 7 - dataAgeDays,
      dots: 1,
    };
  }
  if (dataAgeDays < 14) {
    return {
      level: "low",
      label: "Early projections",
      detail: `Based on ${dataAgeDays} days of data. Expect better accuracy in ~${14 - dataAgeDays} days.`,
      estimateDays: 14 - dataAgeDays,
      dots: 2,
    };
  }
  if (dataAgeDays < 60) {
    return {
      level: "medium",
      label: "Moderate confidence",
      detail: `Based on ${dataAgeDays} days of real transaction data.`,
      estimateDays: 0,
      dots: 3,
    };
  }
  return {
    level: "high",
    label: "High confidence",
    detail: `Based on ${Math.round(dataAgeDays / 30)} months of solid data.`,
    estimateDays: 0,
    dots: 5,
  };
}

// ── Rolling average smoother ────────────────────────────────────

function rollingAverage(dataPoints, windowDays = 7) {
  return dataPoints.map((point, index) => {
    const start = Math.max(0, index - windowDays + 1);
    const windowSlice = dataPoints.slice(start, index + 1);
    const result = { date: point.date };
    // Average all numeric fields
    for (const key of Object.keys(point)) {
      if (key === "date") continue;
      if (typeof point[key] === "number") {
        const avg = windowSlice.reduce((sum, p) => sum + (p[key] || 0), 0) / windowSlice.length;
        result[key] = Math.round(avg * 100) / 100;
      }
    }
    return result;
  });
}

// ── Industry defaults (when merchant has no data) ───────────────

function getIndustryDefaults(merchantType) {
  const defaults = {
    coffee_shop: { avgTransactionValueCents: 650, avgDailyVisitors: 120, avgVisitsPerMonth: 2.8 },
    restaurant: { avgTransactionValueCents: 2200, avgDailyVisitors: 80, avgVisitsPerMonth: 1.5 },
    fitness: { avgTransactionValueCents: 1500, avgDailyVisitors: 50, avgVisitsPerMonth: 8.0 },
    salon_spa: { avgTransactionValueCents: 6500, avgDailyVisitors: 15, avgVisitsPerMonth: 1.2 },
    retail: { avgTransactionValueCents: 3500, avgDailyVisitors: 60, avgVisitsPerMonth: 1.8 },
  };
  return defaults[merchantType] || { avgTransactionValueCents: 1500, avgDailyVisitors: 60, avgVisitsPerMonth: 2.0 };
}

// ── Resolve baseline with fallbacks ─────────────────────────────

function resolveBaseline(baseline, merchantType) {
  const industry = getIndustryDefaults(merchantType);
  return {
    avgDailyVisitors: baseline.avgDailyVisitors || industry.avgDailyVisitors,
    attributionRate: baseline.attributionRate || 0.15,
    avgVisitsPerConsumerPerMonth: baseline.avgVisitsPerConsumerPerMonth || industry.avgVisitsPerMonth,
    currentEnrolled: baseline.currentEnrolled || 0,
    enrollmentConversionRate: baseline.enrollmentConversionRate || 0.15,
    avgTransactionValueCents: baseline.avgTransactionValueCents || industry.avgTransactionValueCents,
    dataAgeDays: baseline.dataAgeDays || 0,
  };
}

// ── Curve generators ────────────────────────────────────────────

function generateRevenueAndCostCurve(monthlyRevenueCents, monthlyCostCents, daysForward = 90) {
  const rawPoints = [];
  const today = new Date();
  for (let i = 0; i <= daysForward; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() + i);
    const rampFactor = Math.min(1, i / 30);
    rawPoints.push({
      date: d.toISOString().slice(0, 10),
      revenue: Math.round((monthlyRevenueCents / 30) * rampFactor),
      cost: Math.round((monthlyCostCents / 30) * rampFactor),
      net: Math.round(((monthlyRevenueCents - monthlyCostCents) / 30) * rampFactor),
    });
  }
  return rollingAverage(rawPoints);
}

function generateMetricCurve(currentValue, projectedValue, daysForward = 90, shape = "s-curve") {
  const rawPoints = [];
  const today = new Date();
  const delta = projectedValue - currentValue;

  for (let i = 0; i <= daysForward; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() + i);
    const t = i / daysForward;

    let factor;
    if (shape === "s-curve") {
      // Sigmoid: slow start, steep middle, plateau
      factor = 1 / (1 + Math.exp(-10 * (t - 0.4)));
    } else if (shape === "compound") {
      // Accelerating growth
      factor = Math.pow(t, 1.5);
    } else if (shape === "decay") {
      // Retention decay — shows percentage retained
      factor = t; // linear for projection
    } else {
      factor = t; // linear fallback
    }

    rawPoints.push({
      date: d.toISOString().slice(0, 10),
      historical: currentValue,
      projected: Math.round((currentValue + delta * factor) * 100) / 100,
    });
  }
  return rollingAverage(rawPoints);
}

// ── Objective 1: Frequency ("Bring customers back") ────────────

function projectFrequency(baseline, params, previousOutcome) {
  const b = baseline;
  const { stampThreshold, rewardValueCents } = params;

  const frequencyLiftFactor = params.promotionType === "tiered" ? 1.40 : 1.25;
  // Use learning loop if available
  const adjustedLift = previousOutcome?.repeatVisitLift
    ? 1 + previousOutcome.repeatVisitLift
    : frequencyLiftFactor;

  const projectedFrequency = b.avgVisitsPerConsumerPerMonth * adjustedLift;
  const incrementalVisits = (projectedFrequency - b.avgVisitsPerConsumerPerMonth) * Math.max(1, b.currentEnrolled);

  const projectedMonthlyRevenueCents = Math.round(incrementalVisits * b.avgTransactionValueCents);
  const projectedMonthlyCostCents = Math.round(
    Math.max(1, b.currentEnrolled) * (projectedFrequency / Math.max(1, stampThreshold)) * rewardValueCents
  );

  return {
    objective: "bring-back",
    objectiveLabel: OBJECTIVES["bring-back"].label,
    primaryMetricLabel: OBJECTIVES["bring-back"].metric,
    chartType: "line",
    currentValue: b.avgVisitsPerConsumerPerMonth.toFixed(1) + "x",
    projectedValue: projectedFrequency.toFixed(1) + "x",
    changeDescription: `+${Math.round((adjustedLift - 1) * 100)}% more visits per member`,
    projectedMonthlyRevenueCents,
    projectedMonthlyCostCents,
    netRevenueCents: projectedMonthlyRevenueCents - projectedMonthlyCostCents,
    projectionPoints: generateRevenueAndCostCurve(projectedMonthlyRevenueCents, projectedMonthlyCostCents),
    metricPoints: generateMetricCurve(b.avgVisitsPerConsumerPerMonth, projectedFrequency, 90, "s-curve"),
  };
}

// ── Objective 2: Enrollment ("Grow my loyal base") ──────────────

function projectEnrollment(baseline, params, previousOutcome) {
  const b = baseline;
  const loyaltyMultiplier = 1.35;

  const conversionRate = previousOutcome?.enrollmentActual && previousOutcome?.enrollmentProjected
    ? (previousOutcome.enrollmentActual / previousOutcome.enrollmentProjected) * 0.15
    : b.enrollmentConversionRate || 0.15;

  const estimatedMonthlyNewEnrollments = Math.round(
    b.avgDailyVisitors * 30 * b.attributionRate * conversionRate
  );

  const projectedMembersAt90Days = b.currentEnrolled + (estimatedMonthlyNewEnrollments * 3);

  const incrementalRevenuePerMember = b.avgVisitsPerConsumerPerMonth
    * b.avgTransactionValueCents
    * (loyaltyMultiplier - 1);

  const projectedMonthlyRevenueCents = Math.round(estimatedMonthlyNewEnrollments * incrementalRevenuePerMember);

  const projectedMonthlyCostCents = Math.round(
    Math.max(1, b.currentEnrolled)
    * (b.avgVisitsPerConsumerPerMonth / Math.max(1, params.stampThreshold))
    * params.rewardValueCents
  );

  return {
    objective: "grow-base",
    objectiveLabel: OBJECTIVES["grow-base"].label,
    primaryMetricLabel: OBJECTIVES["grow-base"].metric,
    chartType: "line",
    currentValue: b.currentEnrolled.toLocaleString(),
    projectedValue: projectedMembersAt90Days.toLocaleString(),
    changeDescription: `+${estimatedMonthlyNewEnrollments} new members/month`,
    projectedMonthlyRevenueCents,
    projectedMonthlyCostCents,
    netRevenueCents: projectedMonthlyRevenueCents - projectedMonthlyCostCents,
    projectionPoints: generateRevenueAndCostCurve(projectedMonthlyRevenueCents, projectedMonthlyCostCents),
    metricPoints: generateMetricCurve(b.currentEnrolled, projectedMembersAt90Days, 90, "compound"),
  };
}

// ── Objective 3: Basket Size ("Drive more revenue") ─────────────

function projectBasketSize(baseline, params) {
  const b = baseline;
  const projectedAOV = Math.round(b.avgTransactionValueCents * 1.25);
  const aovLiftCents = projectedAOV - b.avgTransactionValueCents;

  const totalMonthlyTransactions = Math.round(b.avgDailyVisitors * 30 * b.attributionRate);

  const projectedMonthlyRevenueCents = Math.round(aovLiftCents * totalMonthlyTransactions);
  const projectedMonthlyCostCents = Math.round(
    totalMonthlyTransactions * 0.15 * (params.rewardValueCents || 0)
  );

  return {
    objective: "drive-revenue",
    objectiveLabel: OBJECTIVES["drive-revenue"].label,
    primaryMetricLabel: OBJECTIVES["drive-revenue"].metric,
    chartType: "line",
    currentValue: `$${(b.avgTransactionValueCents / 100).toFixed(2)}`,
    projectedValue: `$${(projectedAOV / 100).toFixed(2)}`,
    changeDescription: `+$${(aovLiftCents / 100).toFixed(2)} per transaction`,
    projectedMonthlyRevenueCents,
    projectedMonthlyCostCents,
    netRevenueCents: projectedMonthlyRevenueCents - projectedMonthlyCostCents,
    projectionPoints: generateRevenueAndCostCurve(projectedMonthlyRevenueCents, projectedMonthlyCostCents),
    metricPoints: generateMetricCurve(b.avgTransactionValueCents / 100, projectedAOV / 100, 90, "s-curve"),
  };
}

// ── Objective 4: Traffic ("Fill slow periods") ──────────────────

function projectTraffic(baseline, params) {
  const b = baseline;
  const targetWindowFraction = 0.15; // ~2-3 hours of a day, a couple days/week

  const currentWindowTransactions = Math.round(b.avgDailyVisitors * 30 * targetWindowFraction);
  const projectedWindowTransactions = Math.round(currentWindowTransactions * 1.35);
  const incrementalTransactions = projectedWindowTransactions - currentWindowTransactions;

  const projectedMonthlyRevenueCents = Math.round(incrementalTransactions * b.avgTransactionValueCents);
  const projectedMonthlyCostCents = Math.round(
    projectedWindowTransactions * b.attributionRate * (params.rewardValueCents / Math.max(1, params.stampThreshold))
  );

  // Bar chart data: 6am-6pm hourly breakdown
  const barData = [];
  for (let hour = 6; hour <= 18; hour++) {
    const label = hour <= 11 ? `${hour}am` : hour === 12 ? "12pm" : `${hour - 12}pm`;
    // Bell curve traffic pattern
    const peak = 9; // 9am peak for coffee shop
    const spread = 3;
    const normalizedTraffic = Math.exp(-0.5 * Math.pow((hour - peak) / spread, 2));
    const current = Math.round(b.avgDailyVisitors * normalizedTraffic * 0.12);
    const isTargetWindow = hour >= 14 && hour <= 17; // Slow afternoon
    barData.push({
      hour: label,
      current,
      projected: isTargetWindow ? Math.round(current * 1.35) : current,
      isTarget: isTargetWindow,
    });
  }

  return {
    objective: "fill-slow",
    objectiveLabel: OBJECTIVES["fill-slow"].label,
    primaryMetricLabel: OBJECTIVES["fill-slow"].metric,
    chartType: "bar",
    currentValue: `${currentWindowTransactions} transactions`,
    projectedValue: `${projectedWindowTransactions} transactions`,
    changeDescription: `+${incrementalTransactions} during slow periods`,
    projectedMonthlyRevenueCents,
    projectedMonthlyCostCents,
    netRevenueCents: projectedMonthlyRevenueCents - projectedMonthlyCostCents,
    projectionPoints: generateRevenueAndCostCurve(projectedMonthlyRevenueCents, projectedMonthlyCostCents),
    barData,
  };
}

// ── Objective 5: Retention ("Reward my best customers") ─────────

function projectRetention(baseline, params) {
  const b = baseline;

  const currentRetentionRate = 0.34;
  const projectedRetentionRate = 0.52;

  const totalFirstTimeVisitors = Math.round(b.avgDailyVisitors * 30 * 0.20);
  const currentReturning = Math.round(totalFirstTimeVisitors * currentRetentionRate);
  const projectedReturning = Math.round(totalFirstTimeVisitors * projectedRetentionRate);
  const incrementalReturning = projectedReturning - currentReturning;

  const projectedMonthlyRevenueCents = Math.round(
    incrementalReturning * b.avgVisitsPerConsumerPerMonth * b.avgTransactionValueCents
  );

  // Tiered cost: approximate
  const projectedMonthlyCostCents = Math.round(
    projectedReturning * (params.rewardValueCents / Math.max(1, params.stampThreshold)) * 0.6
  );

  // Retention decay curves
  const decayPoints = [];
  const today = new Date();
  for (let i = 0; i <= 90; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() + i);
    const t = i / 90;
    decayPoints.push({
      date: d.toISOString().slice(0, 10),
      historical: Math.round((1 - t * (1 - currentRetentionRate)) * 100),
      projected: Math.round((1 - t * (1 - projectedRetentionRate)) * 100),
    });
  }

  return {
    objective: "reward-best",
    objectiveLabel: OBJECTIVES["reward-best"].label,
    primaryMetricLabel: OBJECTIVES["reward-best"].metric,
    chartType: "line",
    currentValue: `${Math.round(currentRetentionRate * 100)}%`,
    projectedValue: `${Math.round(projectedRetentionRate * 100)}%`,
    changeDescription: `+${incrementalReturning} customers return after first visit/month`,
    projectedMonthlyRevenueCents,
    projectedMonthlyCostCents,
    netRevenueCents: projectedMonthlyRevenueCents - projectedMonthlyCostCents,
    projectionPoints: generateRevenueAndCostCurve(projectedMonthlyRevenueCents, projectedMonthlyCostCents),
    metricPoints: rollingAverage(decayPoints),
  };
}

// ── Divergence check (validation mode) ──────────────────────────

function checkDivergence(projected, actual) {
  if (!projected || !actual || projected === 0) return null;
  const divergencePct = ((actual - projected) / projected) * 100;

  if (Math.abs(divergencePct) < 20) return null;

  return {
    direction: divergencePct > 0 ? "over" : "under",
    divergencePct: Math.round(divergencePct),
    projectedValue: projected,
    actualValue: actual,
  };
}

// ── Main dispatch ───────────────────────────────────────────────

function projectByObjective(objective, rawBaseline, params, merchantType, previousOutcome) {
  const baseline = resolveBaseline(rawBaseline, merchantType);
  const sufficiency = getDataSufficiency(baseline.dataAgeDays, merchantType);

  let projection;
  switch (objective) {
    case "bring-back":
      projection = projectFrequency(baseline, params, previousOutcome);
      break;
    case "grow-base":
      projection = projectEnrollment(baseline, params, previousOutcome);
      break;
    case "drive-revenue":
      projection = projectBasketSize(baseline, params);
      break;
    case "fill-slow":
      projection = projectTraffic(baseline, params);
      break;
    case "reward-best":
      projection = projectRetention(baseline, params);
      break;
    default:
      // Fallback to frequency for unknown objectives
      projection = projectFrequency(baseline, params, previousOutcome);
      break;
  }

  return {
    ...projection,
    dataSufficiency: sufficiency,
    baseline,
  };
}

module.exports = {
  OBJECTIVES,
  projectByObjective,
  getDataSufficiency,
  checkDivergence,
  rollingAverage,
  resolveBaseline,
  getIndustryDefaults,
  // Export individual projectors for testing
  projectFrequency,
  projectEnrollment,
  projectBasketSize,
  projectTraffic,
  projectRetention,
  generateRevenueAndCostCurve,
  generateMetricCurve,
};
