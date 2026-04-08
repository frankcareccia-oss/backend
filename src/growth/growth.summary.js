// src/growth/growth.summary.js
//
// Summary Composer — deterministic plain-language summary.
// AI summary can be layered on top later; this is the always-available fallback.

"use strict";

/**
 * Build a plain-language summary from metrics, patterns, and recommendations.
 *
 * @param {GrowthMetrics} metrics
 * @param {Array} patterns
 * @param {Array} recommendations
 * @returns {string}
 */
function buildGrowthSummary(metrics, patterns, recommendations) {
  if (patterns.some((p) => p.type === "insufficient_data")) {
    return `Not enough transaction data yet (${metrics.totalOrders} orders in the last ${metrics.period?.days || 30} days). Growth Advisor needs at least 10 orders to generate meaningful insights.`;
  }

  const parts = [];

  // Opening: volume context
  const aovDollars = metrics.aov ? `$${(metrics.aov / 100).toFixed(2)}` : "unknown";
  parts.push(
    `Over the last ${metrics.period?.days || 30} days, your store had ${metrics.totalOrders} orders with an average ticket of ${aovDollars}.`
  );

  // Key insight: repeat rate
  if (metrics.repeatRate !== null) {
    const pct = Math.round(metrics.repeatRate * 100);
    if (pct < 30) {
      parts.push(`Your repeat rate is ${pct}% — most customers aren't coming back.`);
    } else if (pct < 50) {
      parts.push(`Your repeat rate is ${pct}% — there's room to grow loyalty.`);
    } else {
      parts.push(`Your repeat rate is ${pct}% — solid customer loyalty.`);
    }
  }

  // Key insight: time-of-day
  const slowAfternoon = patterns.find((p) => p.type === "slow_afternoon");
  if (slowAfternoon) {
    parts.push(`Afternoon traffic is ${slowAfternoon.detail.ratio}% of morning levels — a clear opportunity.`);
  }

  // Recommendation count
  if (recommendations.length > 0) {
    parts.push(
      `We have ${recommendations.length} recommendation${recommendations.length > 1 ? "s" : ""} to help you grow.`
    );
  }

  return parts.join(" ");
}

module.exports = { buildGrowthSummary };
