// test/feature.gate.test.js — Feature gate unit tests

"use strict";

const {
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
} = require("../src/utils/feature.gate");

// ── canAccess: tier gating ──────────────────────────────────────

describe("canAccess — tier gating", () => {
  const baseMerchant = { id: 1, planTier: "base", acquisitionPath: "clover_marketplace" };
  const valueMerchant = { id: 2, planTier: "value_added", acquisitionPath: "clover_marketplace" };

  test("base merchant can access ungated features", () => {
    const result = canAccess(baseMerchant, "standard_stamp_promotions");
    expect(result.allowed).toBe(true);
  });

  test("base merchant blocked from Value-Added features", () => {
    for (const feature of VALUE_ADDED_FEATURES) {
      const result = canAccess(baseMerchant, feature);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("upgrade_required");
    }
  });

  test("value_added merchant can access all features", () => {
    for (const feature of VALUE_ADDED_FEATURES) {
      const result = canAccess(valueMerchant, feature);
      expect(result.allowed).toBe(true);
    }
  });

  test("null merchant returns not allowed", () => {
    const result = canAccess(null, "growth_advisor");
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("no_merchant");
  });

  test("missing planTier defaults to base", () => {
    const result = canAccess({ id: 3 }, "growth_advisor");
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("upgrade_required");
  });
});

// ── canAccess: POS-required gating ──────────────────────────────

describe("canAccess — POS-required features", () => {
  const manualMerchant = { id: 10, planTier: "value_added", acquisitionPath: "manual" };
  const cloverMerchant = { id: 11, planTier: "value_added", acquisitionPath: "clover_marketplace" };

  test("manual merchant blocked from POS-required features", () => {
    for (const feature of POS_REQUIRED_FEATURES) {
      const result = canAccess(manualMerchant, feature);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("pos_required");
    }
  });

  test("POS merchant can access POS-required features", () => {
    for (const feature of POS_REQUIRED_FEATURES) {
      const result = canAccess(cloverMerchant, feature);
      expect(result.allowed).toBe(true);
    }
  });
});

// ── canCreatePromotion: promo limit ─────────────────────────────

describe("canCreatePromotion — promo limits", () => {
  const baseMerchant = { id: 20, planTier: "base" };
  const valueMerchant = { id: 21, planTier: "value_added" };

  test("base merchant with 0 active promos → allowed", () => {
    const result = canCreatePromotion(baseMerchant, 0);
    expect(result.allowed).toBe(true);
  });

  test("base merchant with 1 active promo → blocked", () => {
    const result = canCreatePromotion(baseMerchant, 1);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("promo_limit");
    expect(result.limit).toBe(BASE_LIMITS.activePromotions);
  });

  test("base merchant with 5 active promos → blocked", () => {
    const result = canCreatePromotion(baseMerchant, 5);
    expect(result.allowed).toBe(false);
  });

  test("value_added merchant with any count → allowed", () => {
    expect(canCreatePromotion(valueMerchant, 0).allowed).toBe(true);
    expect(canCreatePromotion(valueMerchant, 10).allowed).toBe(true);
    expect(canCreatePromotion(valueMerchant, 100).allowed).toBe(true);
  });

  test("null merchant defaults to base", () => {
    const result = canCreatePromotion(null, 1);
    expect(result.allowed).toBe(false);
  });
});

// ── upgradeRoute ────────────────────────────────────────────────

describe("upgradeRoute", () => {
  test("clover_marketplace → marketplace/clover", () => {
    const route = upgradeRoute({ acquisitionPath: "clover_marketplace" });
    expect(route.type).toBe("marketplace");
    expect(route.marketplace).toBe("clover");
  });

  test("square_marketplace → marketplace/square", () => {
    const route = upgradeRoute({ acquisitionPath: "square_marketplace" });
    expect(route.type).toBe("marketplace");
    expect(route.marketplace).toBe("square");
  });

  test("clover_direct → stripe", () => {
    const route = upgradeRoute({ acquisitionPath: "clover_direct" });
    expect(route.type).toBe("stripe");
  });

  test("manual → stripe", () => {
    const route = upgradeRoute({ acquisitionPath: "manual" });
    expect(route.type).toBe("stripe");
  });

  test("null merchant → stripe", () => {
    const route = upgradeRoute(null);
    expect(route.type).toBe("stripe");
  });
});

// ── Feature registry sanity ─────────────────────────────────────

describe("Feature registry", () => {
  test("VALUE_ADDED_FEATURES is a non-empty Set", () => {
    expect(VALUE_ADDED_FEATURES).toBeInstanceOf(Set);
    expect(VALUE_ADDED_FEATURES.size).toBeGreaterThan(10);
  });

  test("POS_REQUIRED_FEATURES is a non-empty Set", () => {
    expect(POS_REQUIRED_FEATURES).toBeInstanceOf(Set);
    expect(POS_REQUIRED_FEATURES.size).toBeGreaterThan(3);
  });

  test("BASE_LIMITS.activePromotions is 1", () => {
    expect(BASE_LIMITS.activePromotions).toBe(1);
  });

  test("TIER constants are correct", () => {
    expect(TIER.BASE).toBe("base");
    expect(TIER.VALUE_ADDED).toBe("value_added");
  });
});

// ── TIER_TINT ───────────────────────────────────────────────────

describe("TIER_TINT", () => {
  test("has base, value_added, and locked tints", () => {
    expect(TIER_TINT.base).toBeDefined();
    expect(TIER_TINT.value_added).toBeDefined();
    expect(TIER_TINT.locked).toBeDefined();
  });

  test("base tint has teal border, no badge", () => {
    expect(TIER_TINT.base.cardBorder).toBe("#1D9E75");
    expect(TIER_TINT.base.badge).toBeNull();
  });

  test("value_added tint has brand orange and badge", () => {
    expect(TIER_TINT.value_added.cardBorder).toBe("#E8671A");
    expect(TIER_TINT.value_added.badge).toBe("Value-Added");
  });

  test("locked tint has dimmed opacity and no badge", () => {
    expect(TIER_TINT.locked.opacity).toBe(0.65);
    expect(TIER_TINT.locked.badge).toBeNull();
  });
});

// ── buildFeatureManifest ────────────────────────────────────────

describe("buildFeatureManifest", () => {
  test("value_added merchant — all features allowed, no locked cards", () => {
    const manifest = buildFeatureManifest({ id: 1, planTier: "value_added", acquisitionPath: "clover_marketplace" });
    expect(manifest.length).toBe(DASHBOARD_CARDS.length);
    expect(manifest.every(f => f.allowed)).toBe(true);

    // Base features get base tint
    const promos = manifest.find(f => f.key === "promotions");
    expect(promos.tint).toEqual(TIER_TINT.base);

    // Value-Added features get value_added tint
    const advisor = manifest.find(f => f.key === "growth_advisor");
    expect(advisor.tint).toEqual(TIER_TINT.value_added);
  });

  test("base merchant — base features allowed, VA features locked", () => {
    const manifest = buildFeatureManifest({ id: 2, planTier: "base", acquisitionPath: "clover_marketplace" });

    const promos = manifest.find(f => f.key === "promotions");
    expect(promos.allowed).toBe(true);
    expect(promos.tint).toEqual(TIER_TINT.base);

    const advisor = manifest.find(f => f.key === "growth_advisor");
    expect(advisor.allowed).toBe(false);
    expect(advisor.reason).toBe("upgrade_required");
    expect(advisor.tint).toEqual(TIER_TINT.locked);
  });

  test("manual merchant — POS features show pos_required", () => {
    const manifest = buildFeatureManifest({ id: 3, planTier: "value_added", acquisitionPath: "manual" });

    const team = manifest.find(f => f.key === "team_attribution");
    expect(team.allowed).toBe(false);
    expect(team.reason).toBe("pos_required");
  });

  test("null merchant — treats as base", () => {
    const manifest = buildFeatureManifest(null);
    const locked = manifest.filter(f => !f.allowed);
    expect(locked.length).toBeGreaterThan(0);
  });
});
