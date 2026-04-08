// src/growth/growth.recommendations.js
//
// Recommendation Engine — maps detected patterns to actionable suggestions.
// Uses real merchant data (product names, prices, percentages) to make
// every recommendation personal and specific. No generic advice.

"use strict";

function fmt(cents) {
  return `$${(cents / 100).toFixed(2)}`;
}

/**
 * Build Growth Advisor recommendations from metrics and detected patterns.
 *
 * @param {GrowthMetrics} metrics
 * @param {Array<{ type, severity, detail }>} patterns
 * @returns {Array<{ type, title, description, reason, priority }>}
 */
function buildGrowthRecommendations(metrics, patterns) {
  const recommendations = [];
  const top = metrics.topProducts || [];

  for (const pattern of patterns) {
    if (pattern.type === "insufficient_data") continue;

    switch (pattern.type) {
      case "low_repeat": {
        const pct = Math.round((pattern.detail.repeatRate || 0) * 100);
        const topProduct = top[0];
        const example = topProduct
          ? `For example, "Buy 5 ${topProduct.name}s, get the next one free."`
          : "";
        recommendations.push({
          type: "loyalty",
          title: `${pct}% of your customers come back — let's change that`,
          description: `Start a stamp card: reward customers after every 5 purchases. ${example}`,
          reason: `${100 - pct}% of customers visit once and don't return. A loyalty program gives them a reason to come back.`,
          priority: pattern.severity === "high" ? 1 : 2,
        });
        break;
      }

      case "slow_afternoon": {
        const ratio = pattern.detail.ratio;
        const morningDollars = fmt(pattern.detail.morningRevenue);
        const afternoonDollars = fmt(pattern.detail.afternoonRevenue);
        const topProduct = top[0];
        const example = topProduct
          ? `Try offering a bonus stamp on ${topProduct.name} orders between 2–5pm.`
          : "Try offering a bonus stamp or 15% off between 2–5pm.";
        recommendations.push({
          type: "time_based_promo",
          title: `Your afternoons are slow — ${afternoonDollars} vs ${morningDollars} mornings`,
          description: `Afternoon sales are only ${ratio}% of your morning traffic. ${example}`,
          reason: `Morning revenue is ${morningDollars} but afternoons drop to ${afternoonDollars}. A targeted promo can close that gap.`,
          priority: pattern.severity === "high" ? 1 : 2,
        });
        break;
      }

      case "low_aov": {
        const aovDollars = fmt(metrics.aov || 0);
        const targetDollars = fmt(pattern.detail.threshold);

        // Build a specific bundle suggestion from top 2 products
        let bundleExample = "";
        if (top.length >= 2 && top[0].revenue && top[1].revenue) {
          const p1 = top[0];
          const p2 = top[1];
          const p1Price = p1.orders > 0 ? Math.round(p1.revenue / p1.orders) : null;
          const p2Price = p2.orders > 0 ? Math.round(p2.revenue / p2.orders) : null;
          if (p1Price && p2Price) {
            const comboFull = p1Price + p2Price;
            const comboDiscount = Math.round(comboFull * 0.90); // 10% off combo
            bundleExample = `Bundle "${p1.name} + ${p2.name}" for ${fmt(comboDiscount)} (normally ${fmt(comboFull)} — saves your customer ${fmt(comboFull - comboDiscount)}).`;
          } else {
            bundleExample = `Bundle your "${p1.name}" with a "${p2.name}" at a small discount to increase basket size.`;
          }
        } else if (top.length >= 1) {
          bundleExample = `Pair your "${top[0].name}" with a complementary item at a combo price.`;
        }

        recommendations.push({
          type: "bundle",
          title: `Your average sale is ${aovDollars} — here's how to grow it`,
          description: bundleExample || `Create a combo deal to encourage customers to add more to their order.`,
          reason: `At ${aovDollars} per order (target: ${targetDollars}), each transaction leaves money on the table. Bundles are the easiest way to lift this.`,
          priority: pattern.severity === "high" ? 1 : 2,
        });
        break;
      }

      case "low_first_to_second": {
        const pct = Math.round((pattern.detail.rate || 0) * 100);
        const topProduct = top[0];
        const example = topProduct
          ? `For example, give new customers a free ${topProduct.name} on their second visit.`
          : "For example, offer 20% off or a free item on the second visit.";
        recommendations.push({
          type: "visit_incentive",
          title: `Only ${pct}% of first-timers come back — let's fix that`,
          description: `Create a welcome reward that unlocks on the second visit. ${example}`,
          reason: `${100 - pct}% of new customers never return. A small incentive on visit #2 dramatically improves retention.`,
          priority: pattern.severity === "high" ? 1 : 2,
        });
        break;
      }

      case "high_concentration": {
        const topNames = pattern.detail.topProducts || [];
        const top1 = topNames[0] || "your top product";
        recommendations.push({
          type: "high_frequency_reward",
          title: `${top1} is your star — build loyalty around it`,
          description: `Create a "${top1} Lovers" stamp card: buy 5, get the next one free. Your top 3 products drive ${pattern.detail.top3Pct}% of revenue — reward the customers who buy them.`,
          reason: `When ${pattern.detail.top3Pct}% of revenue comes from a few items, a focused loyalty program on those items maximizes impact.`,
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
