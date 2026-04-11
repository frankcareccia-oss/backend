// tests/event.consumers.test.js — Async consumers: notification, wallet, promotion outcome, growth

const { getApp } = require("./helpers/setup");
const { prisma, resetDb, createMerchant } = require("./helpers/seed");
const { writeOutboxEventDirect } = require("../src/events/event.outbox.service");
const { createPublisher } = require("../src/events/event.publisher.job");
const { createNotificationConsumer } = require("../src/consumers/notification.consumer");
const { createWalletRefreshConsumer } = require("../src/consumers/walletRefresh.consumer");
const { createPromotionOutcomeConsumer } = require("../src/consumers/promotionOutcome.consumer");
const { createGrowthMetricsConsumer } = require("../src/consumers/growthMetrics.consumer");
const { bootstrapEventPublisher } = require("../src/events/event.bootstrap");

let app;
let merchant;

beforeAll(async () => {
  app = getApp();
  await resetDb();
  merchant = await createMerchant({ name: "Consumer Test Shop" });
}, 15000);

afterAll(async () => {
  await prisma.$disconnect();
});

describe("Notification Consumer", () => {
  it("processes notification event and emits hook", async () => {
    const hooks = [];
    const handler = createNotificationConsumer({
      prisma,
      emitPvHook: (name, data) => hooks.push({ name, data }),
    });

    const event = {
      eventId: "test-notif-001",
      eventType: "notification_requested",
      consumerId: 1,
      merchantId: merchant.id,
      payloadJson: { channel: "sms", message: "Your reward is ready!" },
    };

    const result = await handler(event);
    expect(result.notified).toBe(true);
    expect(result.channel).toBe("sms");

    const hook = hooks.find(h => h.name === "consumer.notification.processed");
    expect(hook).toBeTruthy();
    expect(hook.data.tc).toBe("TC-CON-01");
  });
});

describe("Wallet Refresh Consumer", () => {
  it("processes wallet refresh event", async () => {
    const hooks = [];
    const handler = createWalletRefreshConsumer({
      prisma,
      emitPvHook: (name, data) => hooks.push({ name, data }),
    });

    const result = await handler({
      eventId: "test-wallet-001",
      eventType: "reward_granted",
      consumerId: 42,
      merchantId: merchant.id,
      payloadJson: {},
    });

    expect(result.refreshed).toBe(true);
    expect(result.consumerId).toBe(42);

    const hook = hooks.find(h => h.name === "consumer.wallet_refresh.processed");
    expect(hook).toBeTruthy();
    expect(hook.data.tc).toBe("TC-CON-02");
  });

  it("skips when no consumerId", async () => {
    const handler = createWalletRefreshConsumer({ prisma, emitPvHook: () => {} });
    const result = await handler({
      eventId: "test-wallet-skip",
      eventType: "reward_granted",
      consumerId: null,
      payloadJson: {},
    });
    expect(result.skipped).toBe(true);
  });
});

describe("Promotion Outcome Consumer", () => {
  it("records clip event for stamp_recorded", async () => {
    const hooks = [];
    const handler = createPromotionOutcomeConsumer({
      prisma,
      emitPvHook: (name, data) => hooks.push({ name, data }),
    });

    // Need a real promotion for recordPromotionEvent
    const promo = await prisma.promotion.create({
      data: {
        merchantId: merchant.id,
        name: "Test Promo",
        mechanic: "stamps",
        threshold: 5,
        rewardType: "custom",
        rewardNote: "Free item",
        status: "active",
      },
    });

    const result = await handler({
      eventId: "test-outcome-001",
      eventType: "stamp_recorded",
      consumerId: 1,
      merchantId: merchant.id,
      storeId: null,
      payloadJson: { promotionId: promo.id, milestoneEarned: false, visitId: null },
    });

    expect(result.recorded).toBe(true);
    expect(result.milestoneEarned).toBe(false);

    const hook = hooks.find(h => h.name === "consumer.promotion_outcome.processed");
    expect(hook).toBeTruthy();
    expect(hook.data.tc).toBe("TC-CON-03");
  });

  it("records clip + grant for reward_granted", async () => {
    const hooks = [];
    const handler = createPromotionOutcomeConsumer({
      prisma,
      emitPvHook: (name, data) => hooks.push({ name, data }),
    });

    const promo = await prisma.promotion.findFirst({ where: { merchantId: merchant.id } });

    const result = await handler({
      eventId: "test-outcome-002",
      eventType: "reward_granted",
      consumerId: 1,
      merchantId: merchant.id,
      payloadJson: { promotionId: promo.id, milestoneEarned: true },
    });

    expect(result.recorded).toBe(true);
    expect(result.milestoneEarned).toBe(true);
  });

  it("skips when missing promotionId", async () => {
    const handler = createPromotionOutcomeConsumer({ prisma, emitPvHook: () => {} });
    const result = await handler({
      eventId: "test-outcome-skip",
      eventType: "stamp_recorded",
      merchantId: merchant.id,
      payloadJson: {},
    });
    expect(result.skipped).toBe(true);
  });
});

describe("Growth Metrics Consumer", () => {
  it("processes growth metrics refresh", async () => {
    const hooks = [];
    const handler = createGrowthMetricsConsumer({
      prisma,
      emitPvHook: (name, data) => hooks.push({ name, data }),
    });

    const result = await handler({
      eventId: "test-growth-001",
      eventType: "promotion_outcome_refresh_requested",
      merchantId: merchant.id,
      payloadJson: {},
    });

    expect(result.refreshRequested).toBe(true);

    const hook = hooks.find(h => h.name === "consumer.growth_metrics.processed");
    expect(hook).toBeTruthy();
    expect(hook.data.tc).toBe("TC-CON-04");
  });
});

describe("Bootstrap Integration", () => {
  it("bootstraps publisher with all consumers and processes events", async () => {
    // Write events that match registered consumers
    const rewardEvent = await writeOutboxEventDirect(prisma, {
      eventType: "reward_granted",
      aggregateType: "reward",
      aggregateId: "bootstrap-1",
      merchantId: merchant.id,
      consumerId: 1,
      payload: { promotionId: 1, milestoneEarned: true },
    });

    const notifEvent = await writeOutboxEventDirect(prisma, {
      eventType: "notification_requested",
      aggregateType: "notification",
      aggregateId: "bootstrap-2",
      merchantId: merchant.id,
      consumerId: 1,
      payload: { channel: "push", message: "Test" },
    });

    const publisher = bootstrapEventPublisher(prisma, () => {});
    await publisher.runOnce();

    // reward_granted should create 3 deliveries (walletRefresh, promotionOutcome, notification)
    const rewardDeliveries = await prisma.eventDelivery.findMany({
      where: { outboxEventId: rewardEvent.id },
    });
    expect(rewardDeliveries.length).toBe(3);

    // notification_requested should create 1 delivery
    const notifDeliveries = await prisma.eventDelivery.findMany({
      where: { outboxEventId: notifEvent.id },
    });
    expect(notifDeliveries.length).toBe(1);
    expect(notifDeliveries[0].consumerName).toBe("notification");
  });
});
