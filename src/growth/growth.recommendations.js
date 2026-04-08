// src/growth/growth.recommendations.js
//
// Recommendation Engine — maps detected patterns to actionable suggestions.
// Each recommendation includes type, title, description, and reason.
// No generic advice — every recommendation ties to measured data.

"use strict";

/**
 * Build Growth Advisor recommendations from metrics and detected patterns.
 *
 * @param {GrowthMetrics} metrics
 * @param {Array<{ type, severity, detail }>} patterns
 * @returns {Array<{ type, title, description, reason, priority }>}
 */
function buildGrowthRecommendations(metrics, patterns) {
  const recommendations = [];

  for (const pattern of patterns) {
    if (pattern.type === "insufficient_data") continue;

    switch (pattern.type) {
      case "low_repeat": {
        const pct = Math.round((pattern.detail.repeatRate || 0) * 100);
        recommendations.push({
          type: "loyalty",
          title: "Increase repeat visits",
          description: `Offer a Buy ${Math.min(metrics.aov ? 5 : 3, 10)} Get 1 Free stamp card to encourage return visits.`,
          reason: `Only ${pct}% of customers return for a second visit within 30 days.`,
          priority: pattern.severity === "high" ? 1 : 2,
        });
        break;
      }

      case "slow_afternoon": {
        const ratio = pattern.detail.ratio;
        recommendations.push({
          type: "time_based_promo",
          title: "Lift slow afternoon traffic",
          description: "Offer a 10–15% discount or bonus stamp for purchases between 2–5pm.",
          reason: `Afternoon revenue is only ${ratio}% of morning revenue.`,
          priority: pattern.severity === "high" ? 1 : 2,
        });
        break;
      }

      case "low_aov": {
        const aovDollars = ((metrics.aov || 0) / 100).toFixed(2);
        // Suggest bundle using top products if available
        const topNames = metrics.topProducts?.slice(0, 2).map((p) => p.name).join(" + ");
        const bundleSuggestion = topNames ? `Bundle: ${topNames}` : "Create a combo deal with your top sellers";
        recommendations.push({
          type: "bundle",
          title: "Increase average ticket",
          description: `${bundleSuggestion} to encourage larger purchases.`,
          reason: `Average order value is $${aovDollars}, which is below target.`,
          priority: pattern.severity === "high" ? 1 : 2,
        });
        break;
      }

      case "low_first_to_second": {
        const pct = Math.round((pattern.detail.rate || 0) * 100);
        recommendations.push({
          type: "visit_incentive",
          title: "Bring first-timers back",
          description: "Offer a welcome reward — e.g., 20% off or a free item on the second visit.",
          reason: `Only ${pct}% of first-time visitors return for a second visit.`,
          priority: pattern.severity === "high" ? 1 : 2,
        });
        break;
      }

      case "high_concentration": {
        const top3 = pattern.detail.topProducts?.join(", ");
        recommendations.push({
          type: "high_frequency_reward",
          title: "Reward your best sellers",
          description: `Create a loyalty program around ${top3 || "your top products"} to deepen engagement.`,
          reason: `Top 3 products account for ${pattern.detail.top3Pct}% of revenue — doubling down drives loyalty.`,
          priority: 3,
        });
        break;
      }
    }
  }

  // Sort by priority
  recommendations.sort((a, b) => a.priority - b.priority);

  return recommendations;
}

module.exports = { buildGrowthRecommendations };
