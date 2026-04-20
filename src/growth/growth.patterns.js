// src/growth/growth.patterns.js
//
// Pattern Engine — deterministic rule detection.
// Inspects metrics and emits pattern objects.
// No ML, no simulation — explicit thresholds only.

"use strict";

// ── Thresholds (configurable constants) ──────────────────────

const THRESHOLDS = {
  LOW_REPEAT_RATE: 0.30,            // below 30% = low repeat
  SLOW_PERIOD_RATIO: 0.60,          // afternoon < 60% of morning = slow
  LOW_AOV_CENTS: 800,               // below $8.00 = low basket
  HIGH_CONCENTRATION_PCT: 60,       // top 3 products > 60% of revenue
  LOW_FIRST_TO_SECOND: 0.25,        // below 25% first-to-second visit rate
  MIN_ORDERS_FOR_INSIGHT: 10,       // need at least 10 orders for meaningful data
  MIN_CONSUMERS_FOR_INSIGHT: 5,     // need at least 5 unique consumers
};

/**
 * Detect growth patterns from merchant metrics.
 *
 * @param {GrowthMetrics} metrics — from getMerchantGrowthMetrics()
 * @returns {Array<{ type: string, severity: string, detail: object }>}
 */
function detectGrowthPatterns(metrics) {
  const patterns = [];

  // Guard: not enough data
  if (metrics.totalOrders < THRESHOLDS.MIN_ORDERS_FOR_INSIGHT) {
    patterns.push({
      type: "insufficient_data",
      severity: "info",
      detail: { totalOrders: metrics.totalOrders, needed: THRESHOLDS.MIN_ORDERS_FOR_INSIGHT },
    });
    return patterns;
  }

  // 1. Low repeat rate
  if (metrics.repeatRate !== null && metrics.repeatRate < THRESHOLDS.LOW_REPEAT_RATE) {
    patterns.push({
      type: "low_repeat",
      severity: metrics.repeatRate < 0.15 ? "high" : "medium",
      detail: { repeatRate: metrics.repeatRate, threshold: THRESHOLDS.LOW_REPEAT_RATE },
    });
  }

  // 2. Slow afternoon / time-of-day imbalance
  if (metrics.revenueByHour?.length === 24) {
    const morningRev = metrics.revenueByHour.slice(6, 12).reduce((s, h) => s + h.revenue, 0);
    const afternoonRev = metrics.revenueByHour.slice(12, 18).reduce((s, h) => s + h.revenue, 0);

    if (morningRev > 0 && afternoonRev < morningRev * THRESHOLDS.SLOW_PERIOD_RATIO) {
      patterns.push({
        type: "slow_afternoon",
        severity: afternoonRev < morningRev * 0.40 ? "high" : "medium",
        detail: {
          morningRevenue: morningRev,
          afternoonRevenue: afternoonRev,
          ratio: morningRev > 0 ? Math.round((afternoonRev / morningRev) * 100) : 0,
        },
      });
    }
  }

  // 3. Low AOV
  if (metrics.aov !== null && metrics.aov < THRESHOLDS.LOW_AOV_CENTS) {
    patterns.push({
      type: "low_aov",
      severity: metrics.aov < 500 ? "high" : "medium",
      detail: { aov: metrics.aov, threshold: THRESHOLDS.LOW_AOV_CENTS },
    });
  }

  // 4. High revenue concentration in top products
  if (metrics.topProducts?.length >= 3) {
    const top3Pct = metrics.topProducts.slice(0, 3).reduce((s, p) => s + p.pctOfRevenue, 0);
    if (top3Pct > THRESHOLDS.HIGH_CONCENTRATION_PCT) {
      patterns.push({
        type: "high_concentration",
        severity: top3Pct > 80 ? "high" : "medium",
        detail: {
          top3Pct,
          topProducts: metrics.topProducts.slice(0, 3).map((p) => p.name),
        },
      });
    }
  }

  // 5. Low first-to-second visit conversion
  if (metrics.firstToSecondVisitRate !== null && metrics.firstToSecondVisitRate < THRESHOLDS.LOW_FIRST_TO_SECOND) {
    patterns.push({
      type: "low_first_to_second",
      severity: metrics.firstToSecondVisitRate < 0.15 ? "high" : "medium",
      detail: {
        rate: metrics.firstToSecondVisitRate,
        threshold: THRESHOLDS.LOW_FIRST_TO_SECOND,
      },
    });
  }

  // ── V2 patterns (use enriched metrics) ────────────────────

  // 6. Attribution rate declining — team may not be asking for phone numbers
  if (metrics.attributionTrend) {
    const { current, prior } = metrics.attributionTrend;
    if (current < 0.5 && current < prior * 0.85) {
      patterns.push({
        type: "attribution_declining",
        severity: current < 0.4 ? "high" : "medium",
        detail: { current: Math.round(current * 100), prior: Math.round(prior * 100), dropPct: Math.round((1 - current / prior) * 100) },
      });
    }
  }

  // 7. Promotion stalling — enrolled consumers not progressing
  if (metrics.promoStallRate != null && metrics.promoStallRate > 0.60) {
    patterns.push({
      type: "promo_stalling",
      severity: metrics.promoStallRate > 0.80 ? "high" : "medium",
      detail: { stallRate: Math.round(metrics.promoStallRate * 100), promoName: metrics.stalledPromoName },
    });
  }

  // 8. Tiered bottleneck — consumers cluster at a specific tier
  if (metrics.tierBottleneck) {
    patterns.push({
      type: "tier_bottleneck",
      severity: "medium",
      detail: metrics.tierBottleneck,
    });
  }

  // 9. Referral opportunity — high repeat rate but no referral program
  if (metrics.repeatRate > 0.40 && !metrics.hasReferralPromo) {
    patterns.push({
      type: "referral_opportunity",
      severity: "medium",
      detail: { repeatRate: Math.round(metrics.repeatRate * 100) },
    });
  }

  // 10. Revenue momentum — compare last 7d to prior 7d
  if (metrics.revenueWeekOverWeek) {
    const { current, prior } = metrics.revenueWeekOverWeek;
    if (prior > 0) {
      const changePct = Math.round(((current - prior) / prior) * 100);
      if (Math.abs(changePct) > 15) {
        patterns.push({
          type: changePct > 0 ? "revenue_momentum_up" : "revenue_momentum_down",
          severity: Math.abs(changePct) > 30 ? "high" : "info",
          detail: { changePct, currentWeekCents: current, priorWeekCents: prior },
        });
      }
    }
  }

  return patterns;
}

module.exports = { detectGrowthPatterns, THRESHOLDS };
