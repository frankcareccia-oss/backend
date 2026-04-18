/**
 * promo.legal.flags.js — Flag & warn engine for promotions
 *
 * Scans promotions for potential legal/business risks.
 * NEVER blocks — always flag and warn. Merchant drives.
 * Acknowledgments are immutable audit trail entries.
 *
 * NOTE: Full ruleset requires attorney input. This is the framework
 * with initial common-sense flags.
 */

"use strict";

const { prisma } = require("../db/prisma");

/**
 * Scan a promotion and return an array of flags.
 * Each flag: { id, severity, title, message, field, action }
 *
 * @param {object} promo — promotion data (from DB or from creation form)
 * @returns {Array<object>} flags
 */
function scanPromotion(promo) {
  const flags = [];

  // No expiry date — open-ended liability
  if (!promo.rewardExpiryDays || promo.rewardExpiryDays > 365) {
    flags.push({
      id: "no_expiry",
      severity: "warning",
      title: "No reward expiry",
      message: "This promotion has no expiry date (or over 365 days). Customers could redeem rewards indefinitely, which may create unexpected costs. Many merchants set a 90-day window.",
      field: "rewardExpiryDays",
      action: "Set an expiry window",
    });
  }

  // Very short expiry — consumer-unfriendly
  if (promo.rewardExpiryDays && promo.rewardExpiryDays < 30) {
    flags.push({
      id: "short_expiry",
      severity: "info",
      title: "Short reward expiry",
      message: `Rewards expire in ${promo.rewardExpiryDays} days. Platform minimum is 30 days to give customers a fair chance to use their reward.`,
      field: "rewardExpiryDays",
      action: "Increase to at least 30 days",
    });
  }

  // No end date on the promotion itself
  if (!promo.endAt) {
    flags.push({
      id: "no_end_date",
      severity: "info",
      title: "No promotion end date",
      message: "This promotion runs indefinitely. Consider setting an end date so you can evaluate performance and adjust.",
      field: "endAt",
      action: "Set an end date",
    });
  }

  // Very high threshold — customer may never reach it
  if (promo.threshold && promo.threshold > 15) {
    flags.push({
      id: "high_threshold",
      severity: "info",
      title: "High visit threshold",
      message: `Requiring ${promo.threshold} visits is a long journey for customers. Many merchants find 8-10 visits gets the best balance of engagement and cost.`,
      field: "threshold",
      action: "Consider lowering the threshold",
    });
  }

  // Very low threshold — generous, may be costly
  if (promo.threshold && promo.threshold < 4) {
    flags.push({
      id: "low_threshold",
      severity: "info",
      title: "Low visit threshold",
      message: `Requiring only ${promo.threshold} visits means customers earn rewards quickly. This is generous — make sure your budget reflects that.`,
      field: "threshold",
      action: "Review your budget cap",
    });
  }

  // Reward value undefined or zero
  if (promo.rewardType === "discount_fixed" && (!promo.rewardValue || promo.rewardValue <= 0)) {
    flags.push({
      id: "no_reward_value",
      severity: "warning",
      title: "Reward value not set",
      message: "This discount reward has no dollar value set. Customers won't know what they're earning.",
      field: "rewardValue",
      action: "Set a reward value",
    });
  }

  // "Free" without specifying which item
  if (promo.rewardType === "free_item" && !promo.rewardSku && !promo.rewardNote) {
    flags.push({
      id: "vague_free_item",
      severity: "warning",
      title: "Free item not specified",
      message: '"Free item" without specifying which item can lead to disputes. Specify the item or add a note like "free drip coffee (12oz)".',
      field: "rewardSku",
      action: "Specify the free item",
    });
  }

  // No legal text / terms
  if (!promo.legalText || promo.legalText.trim().length < 20) {
    flags.push({
      id: "no_terms",
      severity: "warning",
      title: "No terms & conditions",
      message: "This promotion has no terms & conditions. Adding clear terms protects both you and your customers.",
      field: "legalText",
      action: "Generate terms",
    });
  }

  return flags;
}

/**
 * Record a merchant's acknowledgment of a flag.
 * Immutable — stored in PromoAuditLog, never deletable.
 *
 * @param {number} promotionId
 * @param {number} userId
 * @param {string} flagId — e.g., "no_expiry"
 * @param {string} action — "acknowledged" or "updated"
 */
async function acknowledgeFlagRisk(promotionId, userId, flagId, action) {
  await prisma.promoAuditLog.create({
    data: {
      promotionId,
      userId,
      action: `flag_${action}`,
      detail: `Flag "${flagId}" ${action} by merchant`,
    },
  });

  console.log(JSON.stringify({
    pvHook: "promo.flag.acknowledged",
    ts: new Date().toISOString(),
    tc: "TC-LEGAL-01",
    sev: "info",
    promotionId,
    userId,
    flagId,
    action,
  }));
}

module.exports = { scanPromotion, acknowledgeFlagRisk };
