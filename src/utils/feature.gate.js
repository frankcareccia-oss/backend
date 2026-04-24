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

// ---------- tier UI tinting ----------

const TIER_TINT = {
  base: {
    cardBg: "#F7F7F5",        // cool off-white
    cardBorder: "#1D9E75",     // brand teal
    accent: "#6B7280",         // muted gray
    badge: null,               // no badge for base-available features
  },
  value_added: {
    cardBg: "#FFF8F0",         // warm cream
    cardBorder: "#E8671A",     // brand orange
    accent: "#E8671A",         // brand orange
    badge: "Value-Added",
  },
  locked: {
    cardBg: "#F4F4F0",         // page background (blends in = dimmed)
    cardBorder: "#E5E2DC",     // faint border
    accent: "#C4BFB6",         // muted
    badge: null,               // no badge — lock icon + CTA is enough
    opacity: 0.65,
  },
};

// Dashboard cards and their feature keys for gating
const DASHBOARD_CARDS = [
  { key: "promotions",        label: "Promotions",           feature: null,                   desc: "Create and manage stamp programs",                        upgradeCta: null },
  { key: "products",          label: "Products",             feature: null,                   desc: "Manage your product catalog",                             upgradeCta: null },
  { key: "stores",            label: "Stores",               feature: null,                   desc: "Manage store locations and QR codes",                     upgradeCta: null },
  { key: "basic_reports",     label: "Reports",              feature: null,                   desc: "30-day performance summary",                              upgradeCta: null },
  { key: "qr_codes",          label: "QR Codes",             feature: null,                   desc: "Generate and print store QR codes",                       upgradeCta: null },
  { key: "bundles",           label: "Bundles",              feature: "bundle_promotions",    desc: "Create product bundles with combo pricing",               upgradeCta: "Add your first bundle" },
  { key: "growth_advisor",    label: "Growth Advisor",       feature: "growth_advisor",       desc: "AI-powered growth recommendations and insights",          upgradeCta: "See Growth Advisor in action" },
  { key: "simulator",         label: "Promotion Simulator",  feature: "promotion_simulator",  desc: "Project ROI before launching promotions",                 upgradeCta: "Preview your promotion's impact" },
  { key: "advanced_analytics",label: "Advanced Analytics",   feature: "advanced_analytics",   desc: "Trends, segmentation, and deep performance data",         upgradeCta: "Unlock advanced reporting" },
  { key: "ai_descriptions",   label: "AI Descriptions",     feature: "ai_descriptions",      desc: "Auto-generate promotion copy and terms",                  upgradeCta: "Let AI write your promos" },
  { key: "team_attribution",  label: "Team Performance",     feature: "team_attribution",     desc: "Employee attribution and capture rate tracking",           upgradeCta: "Track your team's impact" },
  { key: "weekly_briefing",   label: "Weekly Briefing",      feature: "weekly_briefing",      desc: "AI-generated weekly business summary delivered to you",    upgradeCta: "Get your weekly briefing" },
];

/**
 * Build a feature manifest for the frontend — each card with its tier, tint, and lock status.
 *
 * @param {object} merchant - Merchant row (planTier, acquisitionPath)
 * @returns {Array<{ key, label, tier, allowed, tint, reason? }>}
 */
function buildFeatureManifest(merchant) {
  const tier = merchant?.planTier || TIER.BASE;

  return DASHBOARD_CARDS.map(card => {
    if (!card.feature) {
      return {
        key: card.key,
        label: card.label,
        desc: card.desc,
        tier: "base",
        allowed: true,
        tint: TIER_TINT.base,
      };
    }

    const gate = canAccess(merchant, card.feature);

    if (gate.allowed) {
      return {
        key: card.key,
        label: card.label,
        desc: card.desc,
        tier: "value_added",
        allowed: true,
        tint: TIER_TINT.value_added,
      };
    }

    return {
      key: card.key,
      label: card.label,
      desc: card.desc,
      tier: "value_added",
      allowed: false,
      reason: gate.reason,
      upgradeCta: card.upgradeCta,
      tint: TIER_TINT.locked,
    };
  });
}

module.exports = {
  TIER,
  TIER_TINT,
  DASHBOARD_CARDS,
  VALUE_ADDED_FEATURES,
  POS_REQUIRED_FEATURES,
  BASE_LIMITS,
  canAccess,
  canCreatePromotion,
  upgradeRoute,
  buildFeatureManifest,
};
