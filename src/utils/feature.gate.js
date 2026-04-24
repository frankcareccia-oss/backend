// src/utils/feature.gate.js
// Feature gating — checks merchant.planTier against the package matrix.
// Layers on top of billing.service.js (invoice policy); does NOT replace it.

const { emitPvHook } = require("./hooks");

// ---------- feature registry ----------

const TIER = { BASE: "base", VALUE_ADDED: "value_added" };

// Features gated to value_added only.
// Everything NOT listed here is available to all tiers.
const VALUE_ADDED_FEATURES = new Set([
  // Loyalty engine
  "tiered_promotions",
  "conditional_promotions",
  "referral_program",
  "bundle_promotions",
  "multipliers",
  // POS integration
  "multi_location_stamps",
  "employee_sync",
  // Merchant dashboard
  "advanced_analytics",
  "per_store_performance",
  "team_attribution",
  "associate_leaderboard",
  // AI + intelligence
  "promotion_simulator",
  "growth_advisor",
  "ai_descriptions",
  "weekly_briefing",
  // Consumer
  "referral_sharing",
  // Support
  "priority_support",
]);

// Features that require a POS connection regardless of tier.
const POS_REQUIRED_FEATURES = new Set([
  "auto_stamp_webhook",
  "catalog_sync",
  "discount_reward_delivery",
  "multi_location_stamps",
  "employee_sync",
  "team_attribution",
  "associate_leaderboard",
]);

// Base tier limits
const BASE_LIMITS = {
  activePromotions: 1,
};

// ---------- core gate ----------

/**
 * Check whether a merchant can access a named feature.
 *
 * @param {object} merchant - Merchant row (must include planTier, billingSource, acquisitionPath)
 * @param {string} feature  - Feature key from the registry above
 * @returns {{ allowed: boolean, reason?: string }}
 */
function canAccess(merchant, feature) {
  if (!merchant) return { allowed: false, reason: "no_merchant" };

  const tier = merchant.planTier || TIER.BASE;

  // Value-Added gate
  if (VALUE_ADDED_FEATURES.has(feature) && tier !== TIER.VALUE_ADDED) {
    emitPvHook("feature.gate.blocked", {
      merchantId: merchant.id,
      feature,
      tier,
      reason: "upgrade_required",
    });
    return { allowed: false, reason: "upgrade_required" };
  }

  // POS-required gate
  if (POS_REQUIRED_FEATURES.has(feature) && merchant.acquisitionPath === "manual") {
    emitPvHook("feature.gate.blocked", {
      merchantId: merchant.id,
      feature,
      reason: "pos_required",
    });
    return { allowed: false, reason: "pos_required" };
  }

  return { allowed: true };
}

/**
 * Check whether a merchant can create another active promotion.
 *
 * @param {object} merchant          - Merchant row
 * @param {number} activePromoCount  - Current number of active promotions
 * @returns {{ allowed: boolean, reason?: string, limit?: number }}
 */
function canCreatePromotion(merchant, activePromoCount) {
  const tier = merchant?.planTier || TIER.BASE;

  if (tier === TIER.VALUE_ADDED) return { allowed: true };

  if (activePromoCount >= BASE_LIMITS.activePromotions) {
    emitPvHook("feature.gate.blocked", {
      merchantId: merchant?.id,
      feature: "create_promotion",
      tier,
      reason: "promo_limit",
      limit: BASE_LIMITS.activePromotions,
      current: activePromoCount,
    });
    return {
      allowed: false,
      reason: "promo_limit",
      limit: BASE_LIMITS.activePromotions,
    };
  }

  return { allowed: true };
}

/**
 * Return the upgrade path for a merchant (where to send them).
 *
 * @param {object} merchant - Merchant row
 * @returns {{ type: "marketplace" | "stripe", marketplace?: string }}
 */
function upgradeRoute(merchant) {
  const path = merchant?.acquisitionPath || "manual";

  if (path.startsWith("clover_marketplace")) {
    return { type: "marketplace", marketplace: "clover" };
  }
  if (path.startsWith("square_marketplace")) {
    return { type: "marketplace", marketplace: "square" };
  }

  // Path B/C — direct or manual → Stripe checkout
  return { type: "stripe" };
}

module.exports = {
  TIER,
  VALUE_ADDED_FEATURES,
  POS_REQUIRED_FEATURES,
  BASE_LIMITS,
  canAccess,
  canCreatePromotion,
  upgradeRoute,
};
