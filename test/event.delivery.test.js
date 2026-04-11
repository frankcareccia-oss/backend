// tests/event.delivery.test.js — Event delivery accounting: create, process, fail, dead-letter, stats

const { getApp } = require("./helpers/setup");
const { prisma, resetDb, createMerchant } = require("./helpers/seed");
const { writeOutboxEventDirect } = require("../src/events/event.outbox.service");
const {
  createDelivery,
  isAlreadyProcessed,
  markProcessing,
  markProcessed,
  markDeliveryFailed,
  getDeliveryStats,
  getDeadLetters,
} = require("../src/events/event.delivery.service");
const { createPublisher } = require("../src/events/event.publisher.job");

let app;
let merchant;

beforeAll(async () => {
  app = getApp();
  await resetDb();
  merchant = await createMerchant({ name: "Delivery Test Shop" });
}, 15000);

afterAll(async () => {
  await prisma.$disconnect();
});

describe("Event Delivery Service", () => {
  let outboxEvent;

  beforeAll(async () => {
    outboxEvent = await writeOutboxEventDirect(prisma, {
      eventType: "reward_granted",
      aggregateType: "reward",
      aggregateId: "del-1",
      merchantId: merchant.id,
      payload: { test: true },
    });
  });

  it("creates a delivery record", async () => {
    const delivery = await createDelivery(prisma, outboxEvent, "notification");
    expect(delivery).toHaveProperty("id");
    expect(delivery.consumerName).toBe("notification");
    expect(delivery.status).toBe("pending");
    expect(delivery.eventId).toBe(outboxEvent.eventId);
  });

  it("is idempotent — returns existing on duplicate", async () => {
    const delivery2 = await createDelivery(prisma, outboxEvent, "notification");
    expect(delivery2).toBeTruthy();
    expect(delivery2.consumerName).toBe("notification");
  });

  it("creates separate delivery per consumer", async () => {
    const d2 = await createDelivery(prisma, outboxEvent, "walletRefresh");
    expect(d2.consumerName).toBe("walletRefresh");
    // Should be a different record
    const d1 = await prisma.eventDelivery.findFirst({
      where: { outboxEventId: outboxEvent.id, consumerName: "notification" },
    });
    expect(d1.id).not.toBe(d2.id);
  });

  it("marks delivery as processing", async () => {
    const d = await prisma.eventDelivery.findFirst({
      where: { outboxEventId: outboxEvent.id, consumerName: "notification" },
    });
    await markProcessing(prisma, d.id);
    const updated = await prisma.eventDelivery.findUnique({ where: { id: d.id } });
    expect(updated.status).toBe("processing");
    expect(updated.startedAt).toBeTruthy();
  });

  it("marks delivery as processed with result", async () => {
    const d = await prisma.eventDelivery.findFirst({
      where: { outboxEventId: outboxEvent.id, consumerName: "notification" },
    });
    await markProcessed(prisma, d.id, { sent: true, channel: "sms" });
    const updated = await prisma.eventDelivery.findUnique({ where: { id: d.id } });
    expect(updated.status).toBe("processed");
    expect(updated.completedAt).toBeTruthy();
    expect(updated.resultJson).toHaveProperty("sent", true);
  });

  it("isAlreadyProcessed returns true for processed", async () => {
    const result = await isAlreadyProcessed(prisma, outboxEvent.id, "notification");
    expect(result).toBe(true);
  });

  it("isAlreadyProcessed returns false for unprocessed", async () => {
    const result = await isAlreadyProcessed(prisma, outboxEvent.id, "walletRefresh");
    expect(result).toBe(false);
  });

  it("marks delivery as failed with retry", async () => {
    const d = await prisma.eventDelivery.findFirst({
      where: { outboxEventId: outboxEvent.id, consumerName: "walletRefresh" },
    });
    await markDeliveryFailed(prisma, d.id, new Error("Timeout"));
    const updated = await prisma.eventDelivery.findUnique({ where: { id: d.id } });
    expect(updated.status).toBe("failed");
    expect(updated.attempts).toBe(1);
    expect(updated.lastError).toContain("Timeout");
    expect(updated.nextRetryAt).toBeTruthy();
  });

  it("dead-letters after max attempts", async () => {
    const event2 = await writeOutboxEventDirect(prisma, {
      eventType: "test_dead_delivery",
      aggregateType: "test",
      aggregateId: "dead-del-1",
      payload: {},
    });
    const d = await createDelivery(prisma, event2, "deadConsumer");

    // Simulate 3 failures (maxAttempts = 3)
    for (let i = 0; i < 3; i++) {
      await markDeliveryFailed(prisma, d.id, new Error("Failure #" + (i + 1)));
    }

    const updated = await prisma.eventDelivery.findUnique({ where: { id: d.id } });
    expect(updated.status).toBe("dead_lettered");
    expect(updated.attempts).toBe(3);
  });

  it("returns delivery stats", async () => {
    const stats = await getDeliveryStats(prisma);
    expect(stats).toHaveProperty("pending");
    expect(stats).toHaveProperty("processed");
    expect(stats).toHaveProperty("failed");
    expect(stats).toHaveProperty("dead_lettered");
    expect(stats.processed).toBeGreaterThanOrEqual(1);
  });

  it("returns dead letters", async () => {
    const dead = await getDeadLetters(prisma);
    expect(dead.length).toBeGreaterThanOrEqual(1);
    dead.forEach(d => expect(d.status).toBe("dead_lettered"));
  });
});

describe("Publisher with Delivery Tracking", () => {
  it("creates delivery records for each consumer", async () => {
    const event = await writeOutboxEventDirect(prisma, {
      eventType: "reward_granted",
      aggregateType: "reward",
      aggregateId: "pub-del-1",
      merchantId: merchant.id,
      payload: { test: true },
    });

    const results = { consumer1: false, consumer2: false };

    const publisher = createPublisher(prisma, null);
    publisher.register("reward_granted", "testConsumer1", async () => { results.consumer1 = true; });
    publisher.register("reward_granted", "testConsumer2", async () => { results.consumer2 = true; });

    await publisher.runOnce();

    expect(results.consumer1).toBe(true);
    expect(results.consumer2).toBe(true);

    // Verify delivery records
    const deliveries = await prisma.eventDelivery.findMany({
      where: { outboxEventId: event.id },
    });
    expect(deliveries.length).toBe(2);
    deliveries.forEach(d => expect(d.status).toBe("processed"));
  });

  it("skips already-processed consumers on re-run", async () => {
    const event = await writeOutboxEventDirect(prisma, {
      eventType: "test_skip",
      aggregateType: "test",
      aggregateId: "skip-1",
      payload: {},
    });

    let callCount = 0;
    const publisher = createPublisher(prisma, null);
    publisher.register("test_skip", "countConsumer", async () => { callCount++; });

    // First run
    await publisher.runOnce();
    expect(callCount).toBe(1);

    // Manually reset outbox to pending to force re-processing attempt
    await prisma.eventOutbox.update({ where: { id: event.id }, data: { status: "pending" } });

    // Second run — consumer should be skipped (already processed)
    await publisher.runOnce();
    expect(callCount).toBe(1); // NOT 2
  });

  it("tracks failed consumer without blocking others", async () => {
    const event = await writeOutboxEventDirect(prisma, {
      eventType: "mixed_result",
      aggregateType: "test",
      aggregateId: "mixed-1",
      payload: {},
    });

    const publisher = createPublisher(prisma, null);
    publisher.register("mixed_result", "goodConsumer", async () => ({ ok: true }));
    publisher.register("mixed_result", "badConsumer", async () => { throw new Error("Boom"); });

    await publisher.runOnce();

    const deliveries = await prisma.eventDelivery.findMany({
      where: { outboxEventId: event.id },
      orderBy: { consumerName: "asc" },
    });

    const bad = deliveries.find(d => d.consumerName === "badConsumer");
    const good = deliveries.find(d => d.consumerName === "goodConsumer");

    expect(bad.status).toBe("failed");
    expect(bad.lastError).toContain("Boom");
    expect(good.status).toBe("processed");
  });
});
