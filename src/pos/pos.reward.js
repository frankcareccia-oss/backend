// src/pos/pos.reward.js
// Reward grant processing — Phase A (transactional correctness).
// Called from /pos/reward route BEFORE PosReward record is written.
// Never touches NDJSON or EventLog — those remain in pos.persist.js.

/**
 * Validate eligibility and process the reward grant for a consumer.
 *
 * - Finds the first ConsumerPromoProgress with milestonesAvailable > 0
 * - Decrements stampCount and milestonesAvailable atomically
 * - Creates a PromoRedemption record (status: granted)
 * - Returns structured §7 payload
 *
 * Returns { error } if no reward is available.
 */
async function processRewardGrant(prisma, { consumerId, merchantId, storeId, associateUserId }) {
  // Find the first promotion progress record with a reward ready to grant
  const progress = await prisma.consumerPromoProgress.findFirst({
    where: {
      consumerId,
      merchantId,
      milestonesAvailable: { gt: 0 },
    },
    include: {
      promotion: {
        select: {
          id: true,
          name: true,
          threshold: true,
          rewardType: true,
          rewardValue: true,
          rewardNote: true,
          rewardSku: true,
        },
      },
    },
  });

  if (!progress) return { error: "no_reward_available" };

  const promo = progress.promotion;

  // Build reward label and description
  let rewardLabel = promo.name;
  let rewardDescription = promo.rewardNote || null;

  if (promo.rewardType === "discount_pct" && promo.rewardValue) {
    rewardLabel = `${promo.rewardValue}% off`;
  } else if (promo.rewardType === "discount_fixed" && promo.rewardValue) {
    rewardLabel = `$${(promo.rewardValue / 100).toFixed(2)} off`;
  } else if (promo.rewardNote) {
    rewardLabel = promo.rewardNote;
  }

  const balanceBefore = progress.stampCount;
  const balanceAfter = Math.max(0, balanceBefore - promo.threshold);

  // Atomic: decrement progress + create redemption record
  const [updatedProgress, redemption] = await prisma.$transaction([
    prisma.consumerPromoProgress.update({
      where: { id: progress.id },
      data: {
        stampCount: { decrement: promo.threshold },
        milestonesAvailable: { decrement: 1 },
      },
    }),
    prisma.promoRedemption.create({
      data: {
        progressId: progress.id,
        promotionId: promo.id,
        consumerId,
        merchantId,
        pointsDecremented: promo.threshold,
        balanceBefore,
        balanceAfter,
        status: "granted",
        grantedAt: new Date(),
        grantedByStoreId: storeId || null,
        grantedByUserId: associateUserId || null,
      },
    }),
  ]);

  // Mark matching Entitlement as redeemed (wallet layer — fire-and-forget)
  try {
    const entitlement = await prisma.entitlement.findFirst({
      where: {
        consumerId,
        merchantId,
        sourceId: promo.id,
        type: "reward",
        status: "active",
      },
      orderBy: { createdAt: "asc" },
      select: { id: true },
    });
    if (entitlement) {
      await prisma.entitlement.update({
        where: { id: entitlement.id },
        data: { status: "redeemed", redeemedAt: new Date() },
      });
    }
  } catch (e) {
    console.error("[reward] entitlement mark-redeemed failed:", e?.message || String(e));
  }

  return {
    success: true,
    redemptionId: redemption.id,
    consumer: { id: consumerId },
    reward: {
      label: rewardLabel,
      description: rewardDescription,
      type: promo.rewardType,
      programName: promo.name,
    },
    progress: {
      programLabel: promo.name,
      remainingStamps: updatedProgress.stampCount,
      milestonesRemaining: updatedProgress.milestonesAvailable,
    },
  };
}

module.exports = { processRewardGrant };
