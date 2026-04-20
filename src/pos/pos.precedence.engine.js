/**
 * pos.precedence.engine.js — Consumer Happiness Precedence Engine
 *
 * When a consumer is enrolled in multiple promotions at the same merchant,
 * this engine selects the one that benefits them most. Automatically.
 * No consumer choice at the counter. No merchant configuration.
 *
 * The 5-level hierarchy:
 *   Level 1: Bundle governs (stub — requires advanced promo engine)
 *   Level 2: Reward ready from prior visit — still stamp, but surface reward
 *   Level 3: Stamps closest to expiry — protect what they're about to lose
 *   Level 4: Closest to milestone — get them to a reward faster
 *   Level 5: Highest reward value — give them the best deal
 *
 * Multiplier rule: conditional bonuses (afternoon double, etc.) multiply
 * the winner — they don't compete. (Stub — requires conditional promo type)
 *
 * Key constraint: rewards are ALWAYS for the next visit. The current
 * transaction earns stamps; the reward is waiting when they come back.
 */

"use strict";

/**
 * Select the winning promotion from a list of active progress records.
 *
 * @param {Array} activeProgress — ConsumerPromoProgress records with `.promotion` included
 * @returns {{ winner, reason, readyReward? }}
 */
function selectWinningPromotion(activeProgress, readyRewards) {
  // No promos = nothing to do
  if (!activeProgress || activeProgress.length === 0) {
    return { winner: null, reason: "no_active_promos" };
  }

  // Single promo = skip hierarchy
  if (activeProgress.length === 1) {
    return { winner: activeProgress[0], reason: "only_one_promo" };
  }

  // Level 1: Bundle governs — stub for future
  // (When bundle promo types exist, check if transaction items match a bundle)

  // Level 2: Ready reward from prior visit
  // We still stamp — but note that a reward is waiting for surfacing.
  // The stamp goes to the best card below; the reward is a separate concern.
  const hasReadyReward = readyRewards && readyRewards.length > 0;

  // Level 3: Stamps closest to expiry
  const withExpiry = activeProgress.filter(p => {
    if (!p.promotion.timeframeDays || p.stampCount === 0) return false;
    // Calculate when stamps expire based on lastEarnedAt + timeframeDays
    if (!p.lastEarnedAt) return false;
    const expiresAt = new Date(p.lastEarnedAt);
    expiresAt.setDate(expiresAt.getDate() + p.promotion.timeframeDays);
    p._expiresAt = expiresAt; // attach for sorting
    return true;
  }).sort((a, b) => a._expiresAt - b._expiresAt);

  if (withExpiry.length > 0) {
    return {
      winner: withExpiry[0],
      reason: "closest_to_expiry",
      hasReadyReward,
    };
  }

  // Level 4: Closest to milestone (highest % of threshold completed)
  const withProgress = activeProgress
    .filter(p => p.stampCount < p.promotion.threshold)
    .sort((a, b) => {
      const pctA = a.stampCount / a.promotion.threshold;
      const pctB = b.stampCount / b.promotion.threshold;
      return pctB - pctA; // highest percentage first
    });

  if (withProgress.length > 0) {
    return {
      winner: withProgress[0],
      reason: "closest_to_milestone",
      hasReadyReward,
    };
  }

  // Level 5: Highest reward value
  const byValue = [...activeProgress].sort((a, b) => {
    const valA = a.promotion.rewardValue || 0;
    const valB = b.promotion.rewardValue || 0;
    return valB - valA;
  });

  return {
    winner: byValue[0],
    reason: "highest_value",
    hasReadyReward,
  };
}

/**
 * Build consumer-facing notification text for the stamp event.
 * Always uses next-visit language for rewards.
 *
 * @param {{ promotionName, stampsAwarded, stampCount, threshold, milestoneEarned, reason, multiplier }} ctx
 * @returns {{ stampText, milestoneText? }}
 */
function buildNotificationText({
  merchantName,
  promotionName,
  stampsAwarded,
  stampCount,
  threshold,
  milestoneEarned,
  reason,
  multiplier,
  rewardLabel,
}) {
  const remaining = threshold - stampCount;
  const stampWord = stampsAwarded === 1 ? "stamp" : "stamps";

  // Base stamp notification
  let stampText = `${merchantName} — ${stampsAwarded} ${stampWord} added to ${promotionName} (${stampCount} of ${threshold})`;

  // Add reason context for multi-promo scenarios
  if (reason === "closest_to_expiry") {
    stampText += " — your stamps here were expiring soon";
  }

  // Add multiplier context
  if (multiplier && multiplier > 1) {
    const bonusLabel = multiplier === 2 ? "double" : `${multiplier}x`;
    stampText += ` · ${bonusLabel} bonus applied`;
  }

  // Progress hint
  if (!milestoneEarned && remaining > 0) {
    stampText += ` · ${remaining} more ${remaining === 1 ? "visit" : "visits"} until your next reward`;
  }

  // Milestone notification — always next-visit language
  let milestoneText = null;
  if (milestoneEarned) {
    milestoneText = rewardLabel
      ? `You earned ${rewardLabel}! It'll be waiting for you on your next visit.`
      : `You earned a reward at ${merchantName}! It'll be ready next time you come in.`;
  }

  return { stampText, milestoneText };
}

/**
 * Check active conditional modifiers and compute the stamp multiplier.
 * Multipliers don't stack — take the highest applicable one.
 *
 * @param {Array} conditions — PromotionCondition records for this merchant
 * @param {{ transactionTime: Date, orderTotalCents?: number, lastVisitAt?: Date }} ctx
 * @returns {{ multiplier: number, bonusLabel?: string }}
 */
function applyMultiplier(conditions, { transactionTime, orderTotalCents, lastVisitAt }) {
  if (!conditions || conditions.length === 0) {
    return { multiplier: 1, bonusLabel: null };
  }

  let bestMultiplier = 1;
  let bestLabel = null;

  for (const cond of conditions) {
    let matches = false;

    if (cond.conditionType === "time") {
      matches = isWithinTimeWindow(transactionTime, cond);
    } else if (cond.conditionType === "lapse" && lastVisitAt) {
      const daysSince = Math.floor((transactionTime - new Date(lastVisitAt)) / (1000 * 60 * 60 * 24));
      matches = cond.lapseDays && daysSince >= cond.lapseDays;
    } else if (cond.conditionType === "lapse" && !lastVisitAt) {
      // First visit ever — lapse condition applies (welcome bonus)
      matches = true;
    } else if (cond.conditionType === "spend") {
      matches = orderTotalCents && cond.minimumSpendCents && orderTotalCents >= cond.minimumSpendCents;
    }

    if (matches && cond.bonusMultiplier > bestMultiplier) {
      bestMultiplier = cond.bonusMultiplier;
      bestLabel = cond.bonusLabel || null;
    }
  }

  return {
    multiplier: bestMultiplier,
    bonusLabel: bestLabel,
  };
}

/**
 * Check if a timestamp falls within a time-window condition.
 */
function isWithinTimeWindow(timestamp, condition) {
  const { activeDays, activeStartHour, activeEndHour } = condition;

  // Day check
  if (activeDays && Array.isArray(activeDays) && activeDays.length > 0) {
    const dayNames = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
    const dayOfWeek = dayNames[timestamp.getDay()];
    if (!activeDays.includes(dayOfWeek)) return false;
  }

  // Hour check
  if (activeStartHour != null && activeEndHour != null) {
    const hour = timestamp.getHours();
    if (activeStartHour <= activeEndHour) {
      // Normal range: e.g. 14-17
      if (hour < activeStartHour || hour >= activeEndHour) return false;
    } else {
      // Overnight range: e.g. 22-6
      if (hour < activeStartHour && hour >= activeEndHour) return false;
    }
  }

  return true;
}

module.exports = {
  selectWinningPromotion,
  buildNotificationText,
  applyMultiplier,
  isWithinTimeWindow,
};
