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
      rewardType: true,
      rewardValue: true,
      rewardNote: true,
    },
  });

  if (!promotions.length) return [];

  const now = new Date();
  const results = [];

  for (const promo of promotions) {
    try {
      const result = await prisma.$transaction(async (tx) => {
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
          await tx.consumerPromoProgress.update({
            where: { id: upserted.id },
            data: { milestonesAvailable: { increment: 1 } },
          });

          await tx.entitlement.create({
            data: {
              consumerId,
              merchantId,
              storeId: storeId || null,
              type: "reward",
              sourceId: promo.id,
              status: "active",
              metadataJson: {
                displayLabel: buildDisplayLabel(promo),
                rewardProgramId: promo.id,
                issuedVisitId: visitId || null,
              },
            },
          });
        }

        return {
          progressId: upserted.id,
          promotionId: promo.id,
          stampCount: upserted.stampCount,
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
