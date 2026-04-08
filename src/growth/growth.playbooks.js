// src/growth/growth.playbooks.js
//
// Playbook Library — controlled strategy layer for Growth Advisor.
// Growth Advisor selects from this library, never invents freely.
// Each playbook is a proven strategy tied to a specific business problem.

"use strict";

// ── Playbook definitions ─────────────────────────────────────

const PLAYBOOKS = [
  {
    id: "bundle_increase_aov",
    name: "Increase Average Order Value",
    triggers: ["low_aov"],
    cta: { label: "Create Bundle", route: "/merchant/bundles" },
  },
  {
    id: "slow_hours_promo",
    name: "Boost Slow Hours",
    triggers: ["slow_afternoon"],
    cta: { label: "Create Promotion", route: "/merchant/promotions" },
  },
  {
    id: "loyalty_repeat_visits",
    name: "Drive Repeat Visits",
    triggers: ["low_repeat"],
    cta: { label: "Create Loyalty Program", route: "/merchant/promotions/new" },
  },
  {
    id: "first_return_incentive",
    name: "Bring First-Timers Back",
    triggers: ["low_first_to_second"],
    cta: { label: "Create Welcome Reward", route: "/merchant/promotions/new" },
  },
  {
    id: "best_seller_promo",
    name: "Reward Best Sellers",
    triggers: ["high_concentration"],
    cta: { label: "Create Loyalty Program", route: "/merchant/promotions/new" },
  },
  {
    id: "starter_playbook",
    name: "Get Started",
    triggers: ["insufficient_data"],
    cta: { label: "View Reports", route: "/merchant/reports" },

  },
];

// ── Helpers ──────────────────────────────────────────────────

function fmt(cents) {
  if (cents == null) return "--";
  return `$${(cents / 100).toFixed(2)}`;
}

// ── Personalization ──────────────────────────────────────────

/**
 * Personalize a playbook with real merchant data.
 * Returns the output contract: { playbookId, headline, insight, recommendation, reason, confidence, cta }
 *
 * @param {object} playbook — from PLAYBOOKS
 * @param {object} pattern — the matched pattern from detectGrowthPatterns()
 * @param {GrowthMetrics} metrics
 * @returns {object}
 */
function personalizePlaybook(playbook, pattern, metrics) {
  const top = metrics.topProducts || [];
  const confidence = metrics.totalOrders >= 30 ? "high" : metrics.totalOrders >= 10 ? "moderate" : "low";
  const confidenceNote = confidence === "low" ? "Based on limited transaction history — " : "";

  switch (playbook.id) {
    case "bundle_increase_aov": {
      const aov = fmt(metrics.aov);
      const target = fmt(pattern.detail?.threshold);

      let recommendation = "Create a combo deal to encourage customers to add more to their order.";
      if (top.length >= 2) {
        const p1 = top[0];
        const p2 = top[1];
        const p1Price = p1.orders > 0 ? Math.round(p1.revenue / p1.orders) : null;
        const p2Price = p2.orders > 0 ? Math.round(p2.revenue / p2.orders) : null;
        if (p1Price && p2Price) {
          const full = p1Price + p2Price;
          const combo = Math.round(full * 0.90);
          recommendation = `Bundle "${p1.name} + ${p2.name}" for ${fmt(combo)} (normally ${fmt(full)} — saves your customer ${fmt(full - combo)}).`;
        } else {
          recommendation = `Bundle your "${p1.name}" with a "${p2.name}" at a combo price.`;
        }
      } else if (top.length >= 1) {
        recommendation = `Pair your "${top[0].name}" with a complementary item at a combo price.`;
      }

      return {
        playbookId: playbook.id,
        headline: `${confidenceNote}Your average sale is ${aov} — here's how to grow it`,
        insight: `Average order value is ${aov}, below the ${target} target.`,
        recommendation,
        reason: `At ${aov} per order, each transaction leaves money on the table. Bundles are the easiest way to lift this.`,
        confidence,
        cta: playbook.cta,
      };
    }

    case "slow_hours_promo": {
      const morningDollars = fmt(pattern.detail?.morningRevenue);
      const afternoonDollars = fmt(pattern.detail?.afternoonRevenue);
      const ratio = pattern.detail?.ratio || 0;
      const topProduct = top[0];
      const example = topProduct
        ? `Try offering a bonus stamp on ${topProduct.name} orders between 2–5pm.`
        : "Try offering a bonus stamp or 15% off between 2–5pm.";

      return {
        playbookId: playbook.id,
        headline: `${confidenceNote}Your afternoons are slow — ${afternoonDollars} vs ${morningDollars} mornings`,
        insight: `Afternoon sales are only ${ratio}% of morning traffic.`,
        recommendation: example,
        reason: `Morning revenue is ${morningDollars} but afternoons drop to ${afternoonDollars}. A targeted promo can close that gap.`,
        confidence,
        cta: playbook.cta,
      };
    }

    case "loyalty_repeat_visits": {
      const pct = Math.round((pattern.detail?.repeatRate || 0) * 100);
      const topProduct = top[0];
      const example = topProduct
        ? `For example, "Buy 5 ${topProduct.name}s, get the next one free."`
        : "";

      return {
        playbookId: playbook.id,
        headline: `${confidenceNote}Only ${pct}% of your customers come back`,
        insight: `${100 - pct}% of customers visit once and don't return.`,
        recommendation: `Start a stamp card: reward customers after every 5 purchases. ${example}`,
        reason: `A loyalty program gives customers a reason to come back instead of going somewhere else.`,
        confidence,
        cta: playbook.cta,
      };
    }

    case "first_return_incentive": {
      const pct = Math.round((pattern.detail?.rate || 0) * 100);
      const topProduct = top[0];
      const example = topProduct
        ? `Give new customers a free ${topProduct.name} on their second visit.`
        : "Offer 20% off or a free item on the second visit.";

      return {
        playbookId: playbook.id,
        headline: `${confidenceNote}Only ${pct}% of first-timers come back`,
        insight: `${100 - pct}% of new customers never return.`,
        recommendation: `Create a welcome reward that unlocks on visit #2. ${example}`,
        reason: `A small incentive on the second visit dramatically improves retention.`,
        confidence,
        cta: playbook.cta,
      };
    }

    case "best_seller_promo": {
      const topNames = pattern.detail?.topProducts || [];
      const top1 = topNames[0] || "your top product";
      const pct = pattern.detail?.top3Pct || 0;

      return {
        playbookId: playbook.id,
        headline: `${confidenceNote}${top1} is your star — build loyalty around it`,
        insight: `Top 3 products drive ${pct}% of revenue.`,
        recommendation: `Create a "${top1} Lovers" stamp card: buy 5, get the next one free.`,
        reason: `When ${pct}% of revenue comes from a few items, a focused loyalty program on those items maximizes impact.`,
        confidence,
        cta: playbook.cta,
      };
    }

    case "starter_playbook": {
      return {
        playbookId: playbook.id,
        headline: "Not enough data yet to give personalized advice",
        insight: `Only ${metrics.totalOrders} orders recorded so far. Growth Advisor needs at least 10 orders.`,
        recommendation: "Keep processing transactions through your POS. Insights will appear as data builds up.",
        reason: "Accurate recommendations require enough transaction history to identify patterns.",
        confidence: "low",
        cta: playbook.cta,
      };
    }

    default:
      return null;
  }
}

// ── Selection ────────────────────────────────────────────────

/**
 * Select and personalize playbooks based on detected patterns.
 *
 * @param {Array<{ type, severity, detail }>} patterns — from detectGrowthPatterns()
 * @param {GrowthMetrics} metrics
 * @returns {Array<PlaybookOutput>}
 */
function selectPlaybooks(patterns, metrics) {
  const results = [];

  for (const pattern of patterns) {
    // Find matching playbooks for this pattern
    const matches = PLAYBOOKS.filter((pb) => pb.triggers.includes(pattern.type));

    for (const playbook of matches) {
      // Don't duplicate
      if (results.some((r) => r.playbookId === playbook.id)) continue;

      const personalized = personalizePlaybook(playbook, pattern, metrics);
      if (personalized) {
        results.push(personalized);
      }
    }
  }

  // Sort: high confidence first, then by pattern severity
  const confOrder = { high: 0, moderate: 1, low: 2 };
  results.sort((a, b) => (confOrder[a.confidence] || 2) - (confOrder[b.confidence] || 2));

  return results;
}

module.exports = { PLAYBOOKS, selectPlaybooks, personalizePlaybook };
