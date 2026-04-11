/**
 * src/consumers/walletRefresh.consumer.js
 *
 * Handles wallet_refresh_requested and reward_granted events.
 * Refreshes derived wallet projections for the affected consumer.
 * In the current architecture this is a no-op (wallet is queried live),
 * but the consumer establishes the pattern for future caching/projections.
 */

"use strict";

function createWalletRefreshConsumer({ prisma, emitPvHook }) {
  return async function handleWalletRefresh(event) {
    const payload = event.payloadJson || {};
    const consumerId = event.consumerId || payload.consumerId;

    if (!consumerId) {
      return { skipped: true, reason: "no consumerId" };
    }

    emitPvHook("consumer.wallet_refresh.processed", {
      tc: "TC-CON-02",
      sev: "info",
      stable: "consumer:walletRefresh:" + event.eventId,
      eventId: event.eventId,
      consumerId,
      merchantId: event.merchantId,
    });

    // TODO: When wallet projections are cached, invalidate/rebuild here.
    // For now, wallet is queried live from DB — this is a no-op placeholder.
    console.log("[walletRefresh.consumer] processed:", event.eventType, "consumer:", consumerId);

    return { refreshed: true, consumerId };
  };
}

module.exports = { createWalletRefreshConsumer };
