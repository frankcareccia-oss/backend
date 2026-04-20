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
const { checkReferralReward } = require("../promo/promo.referral");
const { selectWinningPromotion, buildNotificationText, applyMultiplier } = require("./pos.precedence.engine");

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
      promotionType: true,
      tiers: { orderBy: { tierLevel: "asc" } },
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

  // Build progress map: promotionId → progress record
  const progressMap = new Map(existingProgress.map(p => [p.promotionId, p]));

  // For promos without progress yet, create virtual records for the engine
  // Always use the promotion from our initial query (which includes tiers)
  const allProgress = promotions.map(promo => {
    const existing = progressMap.get(promo.id);
    if (existing) return { ...existing, promotion: promo };
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

  // ── Stamp expiry enforcement ─────────────────────────────────
  // If a promotion has timeframeDays set and the consumer's last stamp
  // is older than that, reset their stampCount to 0 (expired).
  for (const prog of allProgress) {
    if (prog.id && prog.promotion.timeframeDays && prog.stampCount > 0 && prog.lastEarnedAt) {
      const daysSinceLastStamp = Math.floor((now - new Date(prog.lastEarnedAt)) / (1000 * 60 * 60 * 24));
      if (daysSinceLastStamp > prog.promotion.timeframeDays) {
        // Stamps expired — reset
        await prisma.consumerPromoProgress.update({
          where: { id: prog.id },
          data: { stampCount: 0 },
        });
        prog.stampCount = 0;
        console.log(`[pos.stamps] expired stamps: consumer=${consumerId} promo=${prog.promotionId} days=${daysSinceLastStamp}/${prog.promotion.timeframeDays}`);
      }
    }
  }

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

  // ── Apply conditional multipliers ───────────────────────────
  // Load all active conditions for this merchant's promotions
  const conditions = await prisma.promotionCondition.findMany({
    where: { promotion: { merchantId, status: "active" } },
  }).catch(() => []);

  // Get consumer's last visit for lapse detection
  const lastVisit = await prisma.visit.findFirst({
    where: { consumerId, merchantId, createdAt: { lt: new Date() } },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  }).catch(() => null);

  const { multiplier, bonusLabel } = applyMultiplier(conditions, {
    transactionTime: new Date(),
    orderTotalCents: null, // Will be populated when POS provides order total
    lastVisitAt: lastVisit?.createdAt || null,
  });

  const stampsToAward = Math.round(1 * multiplier);

  // Log precedence decision (fire-and-forget)
  if (allProgress.length > 1) {
    prisma.promotionPrecedenceLog.create({
      data: {
        consumerId,
        merchantId,
        visitId: visitId || null,
        winnerPromotionId: promo.id,
        reason,
        multiplierApplied: multiplier > 1,
        multiplier,
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
    const isTiered = promo.promotionType === "tiered" && promo.tiers && promo.tiers.length > 0;

    const result = await prisma.$transaction(async (tx) => {
      // Check if non-repeatable stamp promo already earned a reward
      if (!isTiered && !promo.repeatable) {
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
          currentTierLevel: 0,
        },
        update: {
          stampCount: { increment: stampsToAward },
          lifetimeEarned: { increment: stampsToAward },
          lastEarnedAt: now,
          lastPrecedenceReason: reason,
          lastPrecedenceAt: now,
        },
        select: { id: true, stampCount: true, lifetimeEarned: true, currentTierLevel: true },
      });

      let milestoneEarned = false;
      let tierCrossed = null;

      if (isTiered) {
        // ── Tiered: check if any new tier thresholds were crossed ──
        const newTiers = promo.tiers.filter(t =>
          t.tierLevel > (upserted.currentTierLevel || 0) &&
          upserted.lifetimeEarned >= t.threshold
        );

        if (newTiers.length > 0) {
          // Take the highest tier crossed (consumer may skip tiers on bonus stamps)
          tierCrossed = newTiers[newTiers.length - 1];
          milestoneEarned = true;

          // Update tier level (permanent — never resets)
          await tx.consumerPromoProgress.update({
            where: { id: upserted.id },
            data: {
              currentTierLevel: tierCrossed.tierLevel,
              milestonesAvailable: { increment: newTiers.length },
            },
          });

          // Grant reward for each tier crossed (all available on next visit)
          for (const tier of newTiers) {
            const tierPromo = { ...promo, rewardType: tier.rewardType, rewardValue: tier.rewardValue, rewardNote: tier.rewardNote };
            const redemption = await tx.promoRedemption.create({
              data: {
                progressId: upserted.id,
                promotionId: promo.id,
                consumerId,
                merchantId,
                pointsDecremented: 0, // tiered doesn't decrement
                balanceBefore: upserted.lifetimeEarned,
                balanceAfter: upserted.lifetimeEarned,
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
                  displayLabel: `${tier.tierName}: ${buildDisplayLabel(tierPromo)}`,
                  rewardProgramId: promo.id,
                  tierName: tier.tierName,
                  tierLevel: tier.tierLevel,
                  issuedVisitId: visitId || null,
                },
              },
            });
          }
        }
        // Tiered promos don't reset stampCount — lifetimeEarned is the progress metric
      } else {
        // ── Standard stamp: check threshold crossing ──
        milestoneEarned = upserted.stampCount % promo.threshold === 0 && upserted.stampCount > 0;

        if (milestoneEarned) {
          await tx.consumerPromoProgress.update({
            where: { id: upserted.id },
            data: { stampCount: 0, milestonesAvailable: { increment: 1 } },
          });

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
      }

      // Write outbox event
      try {
        await writeOutboxEvent(tx, {
          eventType: milestoneEarned ? "reward_granted" : "stamp_recorded",
          aggregateType: "reward",
          aggregateId: String(upserted.id),
          idempotencyKey: milestoneEarned
            ? `reward_granted:${consumerId}:${promo.id}:${upserted.lifetimeEarned}:${visitId || Date.now()}`
            : `stamp_recorded:${consumerId}:${promo.id}:${upserted.stampCount}:${visitId || Date.now()}`,
          merchantId,
          storeId: storeId || null,
          consumerId,
          payload: {
            promotionId: promo.id,
            promotionName: promo.name,
            promotionType: promo.promotionType || "stamp",
            stampCount: isTiered ? upserted.lifetimeEarned : (milestoneEarned ? 0 : upserted.stampCount),
            threshold: promo.threshold,
            milestoneEarned,
            tierCrossed: tierCrossed ? { name: tierCrossed.tierName, level: tierCrossed.tierLevel } : null,
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
        stampCount: isTiered ? upserted.lifetimeEarned : (milestoneEarned ? 0 : upserted.stampCount),
        milestoneEarned,
        tierCrossed: tierCrossed ? { name: tierCrossed.tierName, level: tierCrossed.tierLevel } : null,
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
      // For tiered promos, use the tier's reward details
      const rewardPromo = result.tierCrossed
        ? {
            ...promo,
            rewardType: promo.tiers?.find(t => t.tierLevel === result.tierCrossed.level)?.rewardType || promo.rewardType,
            rewardValue: promo.tiers?.find(t => t.tierLevel === result.tierCrossed.level)?.rewardValue || promo.rewardValue,
          }
        : promo;

      if (posType === "clover") {
        recordCloverRewardEarned({ consumerId, merchantId, promo: rewardPromo, entitlementId: null }).catch(e => {
          console.error("[pos.stamps] clover reward earned error:", e?.message || String(e));
        });
      } else {
        issueGiftCardReward({ consumerId, merchantId, promo: rewardPromo }).catch(e => {
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

  // ── Check for referral rewards (fire-and-forget) ────────────
  // If this consumer was referred and this is their first purchase,
  // both referrer and referee get rewarded for their next visit.
  checkReferralReward(consumerId, merchantId).catch(e => {
    console.error("[pos.stamps] referral reward check error:", e?.message || String(e));
  });

  return results;
}

module.exports = { accumulateStamps };
