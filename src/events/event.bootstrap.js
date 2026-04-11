/**
 * src/events/event.bootstrap.js
 *
 * Bootstrap the event publisher with all registered consumers.
 * Call once at app startup.
 *
 * Usage:
 *   const publisher = bootstrapEventPublisher(prisma, emitPvHook);
 *   publisher.start(5000); // poll every 5s
 */

"use strict";

const { createPublisher } = require("./event.publisher.job");
const { createNotificationConsumer } = require("../consumers/notification.consumer");
const { createWalletRefreshConsumer } = require("../consumers/walletRefresh.consumer");
const { createPromotionOutcomeConsumer } = require("../consumers/promotionOutcome.consumer");
const { createGrowthMetricsConsumer } = require("../consumers/growthMetrics.consumer");
const { createSettlementAccrualConsumer } = require("../consumers/settlementAccrual.consumer");

function bootstrapEventPublisher(prisma, emitPvHook) {
  const publisher = createPublisher(prisma, emitPvHook);

  const deps = { prisma, emitPvHook };

  // Register consumers for each event type
  // reward_granted → wallet refresh + promotion outcomes + notification
  publisher.register("reward_granted", "walletRefresh", createWalletRefreshConsumer(deps));
  publisher.register("reward_granted", "promotionOutcome", createPromotionOutcomeConsumer(deps));
  publisher.register("reward_granted", "notification", createNotificationConsumer(deps));

  // stamp_recorded → promotion outcomes
  publisher.register("stamp_recorded", "promotionOutcome", createPromotionOutcomeConsumer(deps));

  // notification_requested → notification
  publisher.register("notification_requested", "notification", createNotificationConsumer(deps));

  // wallet_refresh_requested → wallet refresh
  publisher.register("wallet_refresh_requested", "walletRefresh", createWalletRefreshConsumer(deps));

  // promotion_outcome_refresh_requested → growth metrics
  publisher.register("promotion_outcome_refresh_requested", "growthMetrics", createGrowthMetricsConsumer(deps));

  // subsidy_applied → settlement accrual (financial obligation)
  publisher.register("subsidy_applied", "settlementAccrual", createSettlementAccrualConsumer(deps));

  console.log("[event.bootstrap] registered consumers:", [
    "reward_granted → walletRefresh, promotionOutcome, notification",
    "stamp_recorded → promotionOutcome",
    "notification_requested → notification",
    "wallet_refresh_requested → walletRefresh",
    "promotion_outcome_refresh_requested → growthMetrics",
    "subsidy_applied → settlementAccrual",
  ].join("; "));

  return publisher;
}

module.exports = { bootstrapEventPublisher };
