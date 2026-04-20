/**
 * promo.referral.js — Referral promotion logic
 *
 * Flow:
 * 1. Referrer gets a unique code (auto-generated on enrollment)
 * 2. Referee signs up or enrolls using that code
 * 3. When referee makes first purchase → both get rewarded (next visit)
 *
 * Anti-fraud: same phone = self-referral blocked.
 * Rewards always for next visit (POS constraint).
 */

"use strict";

const { prisma } = require("../db/prisma");
const crypto = require("crypto");

/**
 * Generate a unique, human-friendly referral code.
 * Format: FIRSTNAME-MERCHANT-XXXX (e.g. JANE-BLVD-X7K2)
 */
function generateReferralCode(consumerName, merchantName) {
  const first = (consumerName || "FRIEND").split(/\s+/)[0].toUpperCase().slice(0, 6);
  const merch = (merchantName || "PV").split(/\s+/)[0].toUpperCase().slice(0, 4);
  const rand = crypto.randomBytes(2).toString("hex").toUpperCase().slice(0, 4);
  return `${first}-${merch}-${rand}`;
}

/**
 * Get or create a referral code for a consumer on a referral promotion.
 */
async function getOrCreateReferralCode(consumerId, promotionId) {
  // Check for existing code
  const existing = await prisma.referralCode.findFirst({
    where: { consumerId, promotionId },
  });
  if (existing) return existing;

  // Get consumer and merchant names for code generation
  const consumer = await prisma.consumer.findUnique({
    where: { id: consumerId },
    select: { firstName: true },
  });
  const promotion = await prisma.promotion.findUnique({
    where: { id: promotionId },
    select: { merchantId: true, merchant: { select: { name: true } } },
  });

  // Generate unique code (retry on collision)
  let code;
  let attempts = 0;
  while (attempts < 5) {
    code = generateReferralCode(consumer?.firstName, promotion?.merchant?.name);
    const collision = await prisma.referralCode.findUnique({ where: { code } });
    if (!collision) break;
    attempts++;
  }

  return prisma.referralCode.create({
    data: {
      promotionId,
      consumerId,
      code,
    },
  });
}

/**
 * Apply a referral code — called when a new consumer enrolls using a code.
 * Creates a ReferralRedemption record. Rewards are granted on first purchase.
 *
 * @returns {{ success, error?, referralRedemption? }}
 */
async function applyReferralCode(refereeId, code) {
  const referralCode = await prisma.referralCode.findUnique({
    where: { code },
    include: { promotion: { select: { id: true, merchantId: true, status: true } } },
  });

  if (!referralCode) {
    return { success: false, error: "INVALID_CODE", message: "Referral code not found" };
  }

  if (referralCode.promotion.status !== "active") {
    return { success: false, error: "PROMO_INACTIVE", message: "This referral program is no longer active" };
  }

  if (referralCode.usedCount >= referralCode.maxUses) {
    return { success: false, error: "CODE_EXHAUSTED", message: "This referral code has reached its maximum uses" };
  }

  // Self-referral check — same consumer
  if (referralCode.consumerId === refereeId) {
    return { success: false, error: "SELF_REFERRAL", message: "You cannot refer yourself" };
  }

  // Phone-based self-referral check
  const [referrer, referee] = await Promise.all([
    prisma.consumer.findUnique({ where: { id: referralCode.consumerId }, select: { phoneE164: true } }),
    prisma.consumer.findUnique({ where: { id: refereeId }, select: { phoneE164: true } }),
  ]);
  if (referrer?.phoneE164 && referee?.phoneE164 && referrer.phoneE164 === referee.phoneE164) {
    return { success: false, error: "SELF_REFERRAL", message: "You cannot refer yourself" };
  }

  // Already referred check
  const existing = await prisma.referralRedemption.findUnique({
    where: { referralCodeId_refereeId: { referralCodeId: referralCode.id, refereeId } },
  });
  if (existing) {
    return { success: false, error: "ALREADY_REFERRED", message: "You've already been referred by this person" };
  }

  // Create the referral redemption
  const redemption = await prisma.referralRedemption.create({
    data: {
      referralCodeId: referralCode.id,
      referrerId: referralCode.consumerId,
      refereeId,
      merchantId: referralCode.promotion.merchantId,
    },
  });

  // Increment used count
  await prisma.referralCode.update({
    where: { id: referralCode.id },
    data: { usedCount: { increment: 1 } },
  });

  return { success: true, referralRedemption: redemption };
}

/**
 * Check and grant referral rewards when a referee makes their first purchase.
 * Called from accumulateStamps pipeline when we detect a consumer's first visit.
 *
 * Both referrer and referee get rewards (for their NEXT visit).
 */
async function checkReferralReward(consumerId, merchantId) {
  // Find any pending referral redemptions where this consumer is the referee
  const pendingReferrals = await prisma.referralRedemption.findMany({
    where: {
      refereeId: consumerId,
      merchantId,
      firstPurchaseAt: null, // not yet triggered
    },
    include: {
      referralCode: {
        include: {
          promotion: {
            select: {
              id: true, rewardType: true, rewardValue: true,
              rewardNote: true, rewardSku: true, name: true,
            },
          },
        },
      },
    },
  });

  if (!pendingReferrals.length) return [];

  const rewards = [];
  const now = new Date();

  for (const ref of pendingReferrals) {
    const promo = ref.referralCode.promotion;

    // Mark as triggered
    await prisma.referralRedemption.update({
      where: { id: ref.id },
      data: { firstPurchaseAt: now, referrerRewarded: true, refereeRewarded: true },
    });

    // Grant reward to referrer (for next visit)
    const referrerRedemption = await prisma.promoRedemption.create({
      data: {
        promotionId: promo.id,
        consumerId: ref.referrerId,
        merchantId,
        pointsDecremented: 0,
        balanceBefore: 0,
        balanceAfter: 0,
        status: "granted",
        grantedAt: now,
      },
    });
    await prisma.entitlement.create({
      data: {
        consumerId: ref.referrerId,
        merchantId,
        type: "reward",
        sourceId: referrerRedemption.id,
        status: "active",
        metadataJson: {
          displayLabel: `Referral reward: ${buildRewardLabel(promo)}`,
          rewardProgramId: promo.id,
          referralType: "referrer",
        },
      },
    });

    // Grant reward to referee (for next visit)
    const refereeRedemption = await prisma.promoRedemption.create({
      data: {
        promotionId: promo.id,
        consumerId: ref.refereeId,
        merchantId,
        pointsDecremented: 0,
        balanceBefore: 0,
        balanceAfter: 0,
        status: "granted",
        grantedAt: now,
      },
    });
    await prisma.entitlement.create({
      data: {
        consumerId: ref.refereeId,
        merchantId,
        type: "reward",
        sourceId: refereeRedemption.id,
        status: "active",
        metadataJson: {
          displayLabel: `Welcome reward: ${buildRewardLabel(promo)}`,
          rewardProgramId: promo.id,
          referralType: "referee",
        },
      },
    });

    rewards.push({
      referrerId: ref.referrerId,
      refereeId: ref.refereeId,
      promotionName: promo.name,
      rewardLabel: buildRewardLabel(promo),
    });
  }

  return rewards;
}

function buildRewardLabel(promo) {
  if (promo.rewardType === "discount_fixed" && promo.rewardValue) return `$${(promo.rewardValue / 100).toFixed(2)} off`;
  if (promo.rewardType === "discount_pct" && promo.rewardValue) return `${promo.rewardValue}% off`;
  if (promo.rewardNote) return promo.rewardNote;
  return "Reward";
}

module.exports = {
  generateReferralCode,
  getOrCreateReferralCode,
  applyReferralCode,
  checkReferralReward,
};
