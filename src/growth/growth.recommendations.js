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

      // ── V2 recommendations ──────────────────────────────────

      case "attribution_declining": {
        recommendations.push({
          type: "attribution_training",
          title: `Attribution dropped ${pattern.detail.dropPct}% — your team may need a refresher`,
          description: `Your attribution rate fell from ${pattern.detail.prior}% to ${pattern.detail.current}%. This means fewer customers are being identified at checkout. A quick team huddle about asking for phone numbers can turn this around in a week.`,
          reason: "When attribution drops, your loyalty programs can't reward customers who are actually visiting. Every unidentified visit is a missed stamp.",
          priority: 1,
        });
        break;
      }

      case "promo_stalling": {
        recommendations.push({
          type: "promo_adjustment",
          title: `${pattern.detail.stallRate}% of enrolled customers have stalled`,
          description: `Most customers in ${pattern.detail.promoName || "your program"} aren't making progress toward their reward. Consider lowering the threshold or adding a bonus-stamp promotion to re-energize them.`,
          reason: "When customers stall, they lose motivation and eventually forget about the program. A small push — like double stamps for a week — can restart momentum.",
          priority: 1,
        });
        break;
      }

      case "tier_bottleneck": {
        const d = pattern.detail;
        recommendations.push({
          type: "tier_adjustment",
          title: `Most customers are stuck at ${d.tierName} — ${d.nextTierName} feels too far away`,
          description: `${d.countAtTier} customers reached ${d.tierName} but only ${d.countAtNext} made it to ${d.nextTierName}. Consider lowering the ${d.nextTierName} threshold from ${d.nextThreshold} to ${Math.round(d.nextThreshold * 0.75)} visits, or adding a mid-tier milestone.`,
          reason: "When the gap between tiers is too wide, customers plateau and disengage. Shorter gaps keep the momentum going.",
          priority: 2,
        });
        break;
      }

      case "referral_opportunity": {
        recommendations.push({
          type: "referral_launch",
          title: `${pattern.detail.repeatRate}% of your customers come back — they'd refer their friends`,
          description: `Your repeat rate is strong. Launch a referral program: "Bring a friend — you both get $3 off." Your loyal customers are your best marketing channel.`,
          reason: "Customers with high repeat rates trust you. A referral program turns that trust into growth — and it costs less than any ad.",
          priority: 2,
        });
        break;
      }

      case "revenue_momentum_up": {
        recommendations.push({
          type: "momentum_positive",
          title: `Revenue is up ${pattern.detail.changePct}% this week — keep it going`,
          description: `Your weekly revenue grew from ${fmt(pattern.detail.priorWeekCents)} to ${fmt(pattern.detail.currentWeekCents)}. Whatever you're doing is working. Consider doubling down with a limited-time promotion to sustain the momentum.`,
          reason: "Growth momentum is fragile. The best time to launch a new promotion is when things are already trending up.",
          priority: 3,
        });
        break;
      }

      case "revenue_momentum_down": {
        recommendations.push({
          type: "momentum_action",
          title: `Revenue dipped ${Math.abs(pattern.detail.changePct)}% this week — here's what to try`,
          description: `Weekly revenue dropped from ${fmt(pattern.detail.priorWeekCents)} to ${fmt(pattern.detail.currentWeekCents)}. This could be seasonal, but consider a time-limited offer to bring traffic back — "This week only: double stamps on afternoon visits."`,
          reason: "Short-term dips are normal, but acting early prevents them from becoming trends. A targeted promotion shows customers you're here for them.",
          priority: 1,
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
