/**
 * src/consumers/promotionOutcome.consumer.js
 *
 * Handles reward_granted and stamp_recorded events.
 * Records promotion events for the Growth Advisor outcomes engine.
 * Replaces the inline fire-and-forget call to recordPromotionEvent().
 */

"use strict";

const { recordPromotionEvent } = require("../growth/promotionOutcome.events");

function createPromotionOutcomeConsumer({ prisma, emitPvHook }) {
  return async function handlePromotionOutcome(event) {
    const payload = event.payloadJson || {};
    const promotionId = payload.promotionId;
    const consumerId = event.consumerId || payload.consumerId;
    const merchantId = event.merchantId || payload.merchantId;
    const storeId = event.storeId || payload.storeId;
    const visitId = payload.visitId;

    if (!promotionId || !merchantId) {
      return { skipped: true, reason: "missing promotionId or merchantId" };
    }

    // Record the clip event (every stamp/visit)
    await recordPromotionEvent(prisma, {
      promotionId,
      merchantId,
      storeId,
      consumerId,
      eventType: "clip",
      visitId,
    });

    // If this was a reward grant, also record the grant event
    if (event.eventType === "reward_granted" || payload.milestoneEarned) {
      await recordPromotionEvent(prisma, {
        promotionId,
        merchantId,
        storeId,
        consumerId,
        eventType: "grant",
        visitId,
      });
    }

    emitPvHook("consumer.promotion_outcome.processed", {
      tc: "TC-CON-03",
      sev: "info",
      stable: "consumer:promotionOutcome:" + event.eventId,
      eventId: event.eventId,
      promotionId,
      merchantId,
      eventType: event.eventType,
      milestoneEarned: Boolean(payload.milestoneEarned),
    });

    return { recorded: true, promotionId, milestoneEarned: Boolean(payload.milestoneEarned) };
  };
}

module.exports = { createPromotionOutcomeConsumer };
