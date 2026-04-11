/**
 * src/consumers/growthMetrics.consumer.js
 *
 * Handles promotion_outcome_refresh_requested events.
 * Triggers a Growth Advisor metrics recomputation for the merchant.
 * Decouples metric refresh from the hot path.
 */

"use strict";

function createGrowthMetricsConsumer({ prisma, emitPvHook }) {
  return async function handleGrowthMetrics(event) {
    const payload = event.payloadJson || {};
    const merchantId = event.merchantId || payload.merchantId;

    if (!merchantId) {
      return { skipped: true, reason: "no merchantId" };
    }

    emitPvHook("consumer.growth_metrics.processed", {
      tc: "TC-CON-04",
      sev: "info",
      stable: "consumer:growthMetrics:" + event.eventId,
      eventId: event.eventId,
      merchantId,
    });

    // TODO: Call growth metrics recomputation service.
    // For now, promotion outcomes are computed via cron — this consumer
    // establishes the event-driven trigger pattern.
    console.log("[growthMetrics.consumer] processed:", event.eventType, "merchant:", merchantId);

    return { refreshRequested: true, merchantId };
  };
}

module.exports = { createGrowthMetricsConsumer };
