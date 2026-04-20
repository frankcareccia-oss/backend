/**
 * promo.conflict.js — Promotion conflict detection
 *
 * Detects overlapping promotions when creating or activating a promo.
 * Returns informational warnings — never blocks. The precedence engine
 * handles the actual resolution at transaction time.
 *
 * Two checkpoints:
 *   1. At draft creation — early heads-up
 *   2. At activation — final check (state may have changed since draft)
 */

"use strict";

const { prisma } = require("../db/prisma");

/**
 * Detect conflicts between a new/activating promotion and existing active ones.
 *
 * @param {{ id?, merchantId, promotionType, storeId?, categoryId? }} newPromo
 * @param {string} checkpoint — "draft" or "activation"
 * @returns {Array<{ type, severity, existingPromo, message, explanation }>}
 */
async function detectConflicts(newPromo, checkpoint = "draft") {
  const activePromos = await prisma.promotion.findMany({
    where: {
      merchantId: newPromo.merchantId,
      status: "active",
      id: newPromo.id ? { not: newPromo.id } : undefined, // exclude self
    },
    select: {
      id: true, name: true, promotionType: true,
      storeId: true, categoryId: true, threshold: true,
      rewardType: true, rewardValue: true,
    },
  });

  if (activePromos.length === 0) return [];

  const conflicts = [];

  for (const existing of activePromos) {
    const scopeOverlap = calculateScopeOverlap(newPromo, existing);
    if (scopeOverlap === "none") continue;

    const newType = newPromo.promotionType || "stamp";
    const existingType = existing.promotionType || "stamp";

    // Same mechanic, same or overlapping scope
    if (newType === existingType && (newType === "stamp" || newType === "tiered")) {
      conflicts.push({
        type: scopeOverlap === "full" ? "same_mechanic_full" : "same_mechanic_partial",
        severity: "warning",
        existingPromo: { id: existing.id, name: existing.name, promotionType: existingType },
        message: `You already have an active ${existingType} program "${existing.name}" at ${scopeOverlap === "full" ? "the same locations" : "overlapping locations"}.`,
        explanation: "Customers enrolled in both will earn stamps toward whichever program benefits them most — automatically. PerkValet's precedence engine handles this.",
      });
    }

    // Cross-type: stamp/tiered + conditional
    else if ((newType === "conditional" && (existingType === "stamp" || existingType === "tiered")) ||
             ((newType === "stamp" || newType === "tiered") && existingType === "conditional")) {
      conflicts.push({
        type: "conditional_modifier",
        severity: "informational",
        existingPromo: { id: existing.id, name: existing.name, promotionType: existingType },
        message: `This works well with your "${existing.name}" program.`,
        explanation: "Conditional bonuses (like double stamps) multiply the stamps earned on other programs — they don't compete. This is how it's designed to work.",
      });
    }

    // Cross-type: referral + anything
    else if (newType === "referral" || existingType === "referral") {
      // Referral programs don't conflict with anything — they're complementary
      continue;
    }

    // Any other combination
    else if (newType !== existingType) {
      conflicts.push({
        type: "cross_type",
        severity: "informational",
        existingPromo: { id: existing.id, name: existing.name, promotionType: existingType },
        message: `You'll have both a ${newType} and a ${existingType} program active.`,
        explanation: "PerkValet handles multiple program types automatically — customers always get the best outcome without having to choose at the counter.",
      });
    }
  }

  return conflicts;
}

/**
 * Calculate scope overlap between two promotions.
 * @returns "full" | "partial" | "none"
 */
function calculateScopeOverlap(promoA, promoB) {
  // Both merchant-wide → full overlap
  if (!promoA.storeId && !promoB.storeId) return "full";

  // Both store-specific, same store → full overlap
  if (promoA.storeId && promoB.storeId && promoA.storeId === promoB.storeId) return "full";

  // Both store-specific, different stores → no overlap
  if (promoA.storeId && promoB.storeId && promoA.storeId !== promoB.storeId) return "none";

  // One merchant-wide, one store-specific → partial overlap
  return "partial";
}

module.exports = { detectConflicts, calculateScopeOverlap };
