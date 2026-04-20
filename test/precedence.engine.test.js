// test/precedence.engine.test.js — Consumer Happiness Precedence Engine

"use strict";

const {
  selectWinningPromotion,
  buildNotificationText,
} = require("../src/pos/pos.precedence.engine");

// ── Helper: build a mock progress record ────────────────────

function mkProgress(overrides = {}) {
  return {
    id: 1,
    consumerId: 100,
    promotionId: 10,
    merchantId: 1,
    stampCount: 3,
    lifetimeEarned: 3,
    lastEarnedAt: new Date("2026-04-10"),
    promotion: {
      id: 10,
      name: "Coffee Stamps",
      threshold: 8,
      rewardType: "discount_fixed",
      rewardValue: 500,
      timeframeDays: null,
    },
    ...overrides,
  };
}

// ── selectWinningPromotion ───────────────────────────────────

describe("selectWinningPromotion", () => {
  test("returns no_active_promos for empty array", () => {
    const { winner, reason } = selectWinningPromotion([]);
    expect(winner).toBeNull();
    expect(reason).toBe("no_active_promos");
  });

  test("returns no_active_promos for null", () => {
    const { winner, reason } = selectWinningPromotion(null);
    expect(winner).toBeNull();
    expect(reason).toBe("no_active_promos");
  });

  test("returns only_one_promo when single promotion", () => {
    const promo = mkProgress();
    const { winner, reason } = selectWinningPromotion([promo]);
    expect(winner).toBe(promo);
    expect(reason).toBe("only_one_promo");
  });

  // Level 3: closest to expiry
  test("Level 3 — selects promo with stamps closest to expiry", () => {
    const promoA = mkProgress({
      id: 1, promotionId: 10, stampCount: 5,
      lastEarnedAt: new Date("2026-04-01"),
      promotion: { id: 10, name: "Promo A", threshold: 8, rewardValue: 500, rewardType: "discount_fixed", timeframeDays: 30 },
    });
    const promoB = mkProgress({
      id: 2, promotionId: 20, stampCount: 2,
      lastEarnedAt: new Date("2026-04-15"),
      promotion: { id: 20, name: "Promo B", threshold: 8, rewardValue: 500, rewardType: "discount_fixed", timeframeDays: 30 },
    });

    const { winner, reason } = selectWinningPromotion([promoA, promoB]);
    expect(reason).toBe("closest_to_expiry");
    expect(winner.promotionId).toBe(10); // promoA expires first (Apr 1 + 30 = May 1)
  });

  test("Level 3 — skips promos with no stamps (nothing to lose)", () => {
    const promoA = mkProgress({
      id: 1, promotionId: 10, stampCount: 0,
      lastEarnedAt: new Date("2026-04-01"),
      promotion: { id: 10, name: "Promo A", threshold: 8, rewardValue: 500, rewardType: "discount_fixed", timeframeDays: 30 },
    });
    const promoB = mkProgress({
      id: 2, promotionId: 20, stampCount: 4,
      lastEarnedAt: null,
      promotion: { id: 20, name: "Promo B", threshold: 8, rewardValue: 300, rewardType: "discount_fixed", timeframeDays: null },
    });

    const { winner, reason } = selectWinningPromotion([promoA, promoB]);
    // promoA has 0 stamps, so Level 3 skips it; promoB has no expiry so also skips
    // Falls through to Level 4
    expect(reason).toBe("closest_to_milestone");
    expect(winner.promotionId).toBe(20);
  });

  // Level 4: closest to milestone
  test("Level 4 — selects promo closest to milestone (highest %)", () => {
    const promoA = mkProgress({
      id: 1, promotionId: 10, stampCount: 6,
      promotion: { id: 10, name: "Promo A", threshold: 8, rewardValue: 300, rewardType: "discount_fixed", timeframeDays: null },
    });
    const promoB = mkProgress({
      id: 2, promotionId: 20, stampCount: 2,
      promotion: { id: 20, name: "Promo B", threshold: 10, rewardValue: 1000, rewardType: "discount_fixed", timeframeDays: null },
    });

    const { winner, reason } = selectWinningPromotion([promoA, promoB]);
    expect(reason).toBe("closest_to_milestone");
    expect(winner.promotionId).toBe(10); // 6/8 = 75% vs 2/10 = 20%
  });

  test("Level 4 — equal milestone % goes to first (stable sort)", () => {
    const promoA = mkProgress({
      id: 1, promotionId: 10, stampCount: 4,
      promotion: { id: 10, name: "Promo A", threshold: 8, rewardValue: 500, rewardType: "discount_fixed", timeframeDays: null },
    });
    const promoB = mkProgress({
      id: 2, promotionId: 20, stampCount: 5,
      promotion: { id: 20, name: "Promo B", threshold: 10, rewardValue: 500, rewardType: "discount_fixed", timeframeDays: null },
    });

    const { winner, reason } = selectWinningPromotion([promoA, promoB]);
    expect(reason).toBe("closest_to_milestone");
    // 4/8 = 50% vs 5/10 = 50% — equal, first wins
    expect(winner.promotionId).toBe(10);
  });

  // Level 5: highest value (both at threshold — stampCount === threshold, so Level 4 filters them out)
  test("Level 5 — selects highest reward value when all at threshold", () => {
    const promoA = mkProgress({
      id: 1, promotionId: 10, stampCount: 8,
      promotion: { id: 10, name: "Promo A", threshold: 8, rewardValue: 300, rewardType: "discount_fixed", timeframeDays: null },
    });
    const promoB = mkProgress({
      id: 2, promotionId: 20, stampCount: 8,
      promotion: { id: 20, name: "Promo B", threshold: 8, rewardValue: 1000, rewardType: "discount_fixed", timeframeDays: null },
    });

    const { winner, reason } = selectWinningPromotion([promoA, promoB]);
    expect(reason).toBe("highest_value");
    expect(winner.promotionId).toBe(20); // $10 > $3
  });

  // hasReadyReward flag
  test("includes hasReadyReward when rewards exist", () => {
    const promoA = mkProgress({ id: 1, promotionId: 10 });
    const promoB = mkProgress({ id: 2, promotionId: 20 });

    const { hasReadyReward } = selectWinningPromotion([promoA, promoB], [{ id: 1 }]);
    expect(hasReadyReward).toBe(true);
  });

  test("hasReadyReward is false when no rewards", () => {
    const promoA = mkProgress({ id: 1, promotionId: 10 });
    const promoB = mkProgress({ id: 2, promotionId: 20 });

    const { hasReadyReward } = selectWinningPromotion([promoA, promoB], []);
    expect(hasReadyReward).toBe(false);
  });
});

// ── buildNotificationText ────────────────────────────────────

describe("buildNotificationText", () => {
  test("standard stamp — shows count and remaining", () => {
    const { stampText } = buildNotificationText({
      merchantName: "BLVD Coffee",
      promotionName: "Buy 8 Get $5 Off",
      stampsAwarded: 1,
      stampCount: 5,
      threshold: 8,
      milestoneEarned: false,
      reason: "only_one_promo",
    });

    expect(stampText).toContain("BLVD Coffee");
    expect(stampText).toContain("1 stamp added");
    expect(stampText).toContain("5 of 8");
    expect(stampText).toContain("3 more visits");
  });

  test("milestone earned — next-visit language", () => {
    const { milestoneText } = buildNotificationText({
      merchantName: "BLVD Coffee",
      promotionName: "Buy 8 Get $5 Off",
      stampsAwarded: 1,
      stampCount: 0,
      threshold: 8,
      milestoneEarned: true,
      reason: "closest_to_milestone",
      rewardLabel: "$5.00 off",
    });

    expect(milestoneText).toContain("$5.00 off");
    expect(milestoneText).toContain("next visit");
  });

  test("milestone without reward label — generic next-visit text", () => {
    const { milestoneText } = buildNotificationText({
      merchantName: "BLVD Coffee",
      promotionName: "Loyalty",
      stampsAwarded: 1,
      stampCount: 0,
      threshold: 5,
      milestoneEarned: true,
      reason: "only_one_promo",
    });

    expect(milestoneText).toContain("next time you come in");
  });

  test("expiry protection — explains why this card was chosen", () => {
    const { stampText } = buildNotificationText({
      merchantName: "BLVD Coffee",
      promotionName: "Happy Hour Card",
      stampsAwarded: 1,
      stampCount: 4,
      threshold: 6,
      milestoneEarned: false,
      reason: "closest_to_expiry",
    });

    expect(stampText).toContain("expiring soon");
  });

  test("multiplier applied — shows bonus", () => {
    const { stampText } = buildNotificationText({
      merchantName: "BLVD Coffee",
      promotionName: "Coffee Card",
      stampsAwarded: 2,
      stampCount: 6,
      threshold: 8,
      milestoneEarned: false,
      reason: "closest_to_milestone",
      multiplier: 2,
    });

    expect(stampText).toContain("2 stamps added");
    expect(stampText).toContain("double bonus");
    expect(stampText).toContain("2 more visits");
  });

  test("3x multiplier text", () => {
    const { stampText } = buildNotificationText({
      merchantName: "BLVD",
      promotionName: "Card",
      stampsAwarded: 3,
      stampCount: 3,
      threshold: 10,
      milestoneEarned: false,
      reason: "only_one_promo",
      multiplier: 3,
    });

    expect(stampText).toContain("3x bonus");
  });

  test("1 more visit — singular", () => {
    const { stampText } = buildNotificationText({
      merchantName: "BLVD",
      promotionName: "Card",
      stampsAwarded: 1,
      stampCount: 7,
      threshold: 8,
      milestoneEarned: false,
      reason: "only_one_promo",
    });

    expect(stampText).toContain("1 more visit");
    expect(stampText).not.toContain("visits");
  });

  test("no milestoneText when not earned", () => {
    const { milestoneText } = buildNotificationText({
      merchantName: "BLVD",
      promotionName: "Card",
      stampsAwarded: 1,
      stampCount: 3,
      threshold: 8,
      milestoneEarned: false,
      reason: "only_one_promo",
    });

    expect(milestoneText).toBeNull();
  });
});
