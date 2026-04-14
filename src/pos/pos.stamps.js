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
 * @param {{ consumerId: number, merchantId: number, storeId: number|null, visitId: number|null }} ctx
 * @returns {Promise<Array<{ promotionId: number, stampCount: number, milestoneEarned: boolean }>>}
 */
async function accumulateStamps(prisma, { consumerId, merchantId, storeId, visitId }) {
  const promotions = await prisma.promotion.findMany({
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
    },
  });

  if (!promotions.length) return [];

  const now = new Date();
  const results = [];

  for (const promo of promotions) {
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
            stampCount: 1,
            lifetimeEarned: 1,
            lastEarnedAt: now,
          },
          update: {
            stampCount: { increment: 1 },
            lifetimeEarned: { increment: 1 },
            lastEarnedAt: now,
          },
          select: { id: true, stampCount: true },
        });

        const milestoneEarned = upserted.stampCount % promo.threshold === 0;

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
              visitId: visitId || null,
            },
          });
        } catch (outboxErr) {
          // Never block the reward flow — log and continue
          console.error("[pos.stamps] outbox write error:", outboxErr?.message || String(outboxErr));
        }

        return {
          progressId: upserted.id,
          promotionId: promo.id,
          stampCount: milestoneEarned ? 0 : upserted.stampCount,
          milestoneEarned,
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

        // Issue gift card reward (fire-and-forget — never blocks the pipeline)
        issueGiftCardReward({ consumerId, merchantId, promo }).catch(e => {
          console.error("[pos.stamps] gift card reward error:", e?.message || String(e));
        });
      }
    } catch (e) {
      console.error(
        `[stamps] accumulate failed — consumerId=${consumerId} promotionId=${promo.id}:`,
        e?.message || String(e)
      );
    }
  }

  return results;
}

module.exports = { accumulateStamps };
