// src/pos/pos.stamps.js
// Stamp accumulation — called after a visit is registered for an identified consumer.
//
// Responsibilities:
//   - Increment ConsumerPromoProgress.stampCount (and lifetimeEarned) for each
//     active promotion at the merchant.
//   - When stampCount crosses a threshold multiple: increment milestonesAvailable
//     AND create an Entitlement (type: reward, status: active) for the wallet layer.
//   - Write EventLog entries (stamp.recorded / reward.earned).
//
// Never throws — errors per-promotion are caught and logged; the POS response is
// never blocked by stamp accumulation failures.

const { writeEventLog } = require("../eventlog/eventlog");
const { recordPromotionEvent } = require("../growth/promotionOutcome.events");
const { writeOutboxEvent } = require("../events/event.outbox.service");
const { issueGiftCardReward } = require("./pos.giftcard");
const { recordCloverRewardEarned } = require("./pos.clover.discount");
const { selectWinningPromotion, buildNotificationText } = require("./pos.precedence.engine");

/**
 * Build the human-readable reward label for Entitlement metadata.
 * Mirrors the label logic in pos.reward.js and consumers.service.js.
 */
function buildDisplayLabel(promo) {
  if (promo.rewardType === "discount_pct" && promo.rewardValue) {
    return `${promo.rewardValue}% off`;
  }
  if (promo.rewardType === "discount_fixed" && promo.rewardValue) {
    return `$${(promo.rewardValue / 100).toFixed(2)} off`;
  }
  if (promo.rewardNote) return promo.rewardNote;
  return promo.name;
}

/**
 * Accumulate one stamp for each active promotion at this merchant for this consumer.
 *
 * For each promotion:
 *   - Upserts ConsumerPromoProgress (stampCount++, lifetimeEarned++, lastEarnedAt=now)
 *   - If new stampCount % threshold === 0:
 *       milestonesAvailable++ and Entitlement created (type:reward, status:active)
 *
 * @param {object} prisma
 * @param {{ consumerId: number, merchantId: number, storeId: number|null, visitId: number|null, posType?: string, orderId?: string }} ctx
 * @returns {Promise<Array<{ promotionId: number, stampCount: number, milestoneEarned: boolean }>>}
 */
async function accumulateStamps(prisma, { consumerId, merchantId, storeId, visitId, posType, orderId }) {
  const allPromotions = await prisma.promotion.findMany({
    where: { merchantId, status: "active" },
    select: {
      id: true,
      name: true,
      threshold: true,
      repeatable: true,
      rewardType: true,
      rewardValue: true,
      rewardSku: true,
      rewardNote: true,
      rewardExpiryDays: true,
      storeId: true,
      timeframeDays: true,
    },
  });

  // Filter: merchant-wide promos earn everywhere; store-specific only at that store
  const promotions = allPromotions.filter(p => !p.storeId || p.storeId === storeId);

  if (!promotions.length) return [];

  const now = new Date();

  // ── Precedence Engine: select winning promotion ──────────────

  // Get existing progress records for this consumer at this merchant
  const existingProgress = await prisma.consumerPromoProgress.findMany({
    where: { consumerId, promotionId: { in: promotions.map(p => p.id) } },
    include: { promotion: true },
  });

  // Build progress map: promotionId → progress record (with promotion attached)
  const progressMap = new Map(existingProgress.map(p => [p.promotionId, p]));

  // For promos without progress yet, create virtual records for the engine
  const allProgress = promotions.map(promo => {
    const existing = progressMap.get(promo.id);
    if (existing) return existing;
    // Virtual record for a promo the consumer hasn't started yet
    return {
      id: null,
      consumerId,
      promotionId: promo.id,
      merchantId,
      stampCount: 0,
      lifetimeEarned: 0,
      lastEarnedAt: null,
      promotion: promo,
    };
  });

  // Check for ready rewards from prior visits (for notification, not blocking)
  const readyRewards = await prisma.posRewardDiscount.findMany({
    where: { consumerId, merchantId, status: "activated" },
    orderBy: [{ expiresAt: "asc" }, { amountCents: "desc" }],
    take: 1,
  }).catch(() => []); // Graceful — table may not exist for all POS types

  // Run the precedence engine
  const { winner, reason, hasReadyReward } = selectWinningPromotion(allProgress, readyRewards);

  if (!winner) return [];

  const promo = winner.promotion;
  const stampsToAward = 1; // Multiplier stub — will be dynamic when conditional promos exist

  // Log precedence decision (fire-and-forget)
  if (allProgress.length > 1) {
    prisma.promotionPrecedenceLog.create({
      data: {
        consumerId,
        merchantId,
        visitId: visitId || null,
        winnerPromotionId: promo.id,
        reason,
        stampsAwarded: stampsToAward,
        candidateCount: allProgress.length,
      },
    }).catch(e => {
      console.error("[pos.stamps] precedence log error:", e?.message || String(e));
    });
  }

  // ── Award stamps to the winning promotion ─────────────────────

  const results = [];

  try {
    const result = await prisma.$transaction(async (tx) => {
      // Check if non-repeatable promo already earned a reward
      if (!promo.repeatable) {
        const existing = await tx.consumerPromoProgress.findUnique({
          where: { consumerId_promotionId: { consumerId, promotionId: promo.id } },
          select: { lifetimeEarned: true },
        });
        if (existing && existing.lifetimeEarned >= promo.threshold) {
          return { progressId: null, promotionId: promo.id, stampCount: 0, milestoneEarned: false, skipped: true };
        }
      }

      // Upsert: create on first visit, increment on subsequent visits
      const upserted = await tx.consumerPromoProgress.upsert({
        where: { consumerId_promotionId: { consumerId, promotionId: promo.id } },
        create: {
          consumerId,
          promotionId: promo.id,
          merchantId,
          stampCount: stampsToAward,
          lifetimeEarned: stampsToAward,
          lastEarnedAt: now,
          lastPrecedenceReason: reason,
          lastPrecedenceAt: now,
        },
        update: {
          stampCount: { increment: stampsToAward },
          lifetimeEarned: { increment: stampsToAward },
          lastEarnedAt: now,
          lastPrecedenceReason: reason,
          lastPrecedenceAt: now,
        },
        select: { id: true, stampCount: true },
      });

      const milestoneEarned = upserted.stampCount % promo.threshold === 0 && upserted.stampCount > 0;

      if (milestoneEarned) {
        // Reset stampCount to 0 (new card) and increment milestonesAvailable
        await tx.consumerPromoProgress.update({
          where: { id: upserted.id },
          data: { stampCount: 0, milestonesAvailable: { increment: 1 } },
        });

        // Create PromoRedemption so wallet can resolve promotion details
        const redemption = await tx.promoRedemption.create({
          data: {
            progressId: upserted.id,
            promotionId: promo.id,
            consumerId,
            merchantId,
            pointsDecremented: promo.threshold,
            balanceBefore: promo.threshold,
            balanceAfter: 0,
            status: "granted",
            grantedAt: now,
            grantedByStoreId: storeId || null,
          },
        });

        await tx.entitlement.create({
          data: {
            consumerId,
            merchantId,
            storeId: storeId || null,
            type: "reward",
            sourceId: redemption.id,
            status: "active",
            metadataJson: {
              displayLabel: buildDisplayLabel(promo),
              rewardProgramId: promo.id,
              issuedVisitId: visitId || null,
            },
          },
        });
      }

      // Write outbox event in same transaction as business truth
      try {
        await writeOutboxEvent(tx, {
          eventType: milestoneEarned ? "reward_granted" : "stamp_recorded",
          aggregateType: "reward",
          aggregateId: String(upserted.id),
          idempotencyKey: milestoneEarned
            ? `reward_granted:${consumerId}:${promo.id}:${upserted.stampCount}:${visitId || Date.now()}`
            : `stamp_recorded:${consumerId}:${promo.id}:${upserted.stampCount}:${visitId || Date.now()}`,
          merchantId,
          storeId: storeId || null,
          consumerId,
          payload: {
            promotionId: promo.id,
            promotionName: promo.name,
            stampCount: milestoneEarned ? 0 : upserted.stampCount,
            threshold: promo.threshold,
            milestoneEarned,
            precedenceReason: reason,
            stampsAwarded: stampsToAward,
            visitId: visitId || null,
          },
        });
      } catch (outboxErr) {
        console.error("[pos.stamps] outbox write error:", outboxErr?.message || String(outboxErr));
      }

      return {
        progressId: upserted.id,
        promotionId: promo.id,
        stampCount: milestoneEarned ? 0 : upserted.stampCount,
        milestoneEarned,
        precedenceReason: reason,
        stampsAwarded: stampsToAward,
      };
    });

    results.push(result);

    // EventLog — fire-and-forget
    writeEventLog(prisma, {
      eventType: result.milestoneEarned ? "reward.earned" : "stamp.recorded",
      merchantId,
      storeId: storeId || null,
      consumerId,
      visitId: visitId || null,
      source: "pos_integrated",
      outcome: "success",
      payloadJson: {
        promotionId: promo.id,
        stampCount: result.stampCount,
        milestoneEarned: result.milestoneEarned,
        precedenceReason: reason,
        candidateCount: allProgress.length,
      },
    });

    // Growth Advisor — Promotion Outcomes events (fire-and-forget)
    recordPromotionEvent(prisma, {
      promotionId: promo.id,
      merchantId,
      storeId,
      consumerId,
      eventType: "clip",
      visitId,
    });
    if (result.milestoneEarned) {
      recordPromotionEvent(prisma, {
        promotionId: promo.id,
        merchantId,
        storeId,
        consumerId,
        eventType: "grant",
        visitId,
      });

      // Issue reward for NEXT visit (fire-and-forget — never blocks the pipeline)
      if (posType === "clover") {
        recordCloverRewardEarned({ consumerId, merchantId, promo, entitlementId: null }).catch(e => {
          console.error("[pos.stamps] clover reward earned error:", e?.message || String(e));
        });
      } else {
        issueGiftCardReward({ consumerId, merchantId, promo }).catch(e => {
          console.error("[pos.stamps] gift card reward error:", e?.message || String(e));
        });
      }
    }
  } catch (e) {
    console.error(
      `[stamps] accumulate failed — consumerId=${consumerId} promotionId=${promo.id}:`,
      e?.message || String(e)
    );
  }

  return results;
}

module.exports = { accumulateStamps };
