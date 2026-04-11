// tests/event.outbox.test.js — Event outbox: write, publish, retry, dead-letter

const { getApp } = require("./helpers/setup");
const { prisma, resetDb, createMerchant } = require("./helpers/seed");
const { captureStdout } = require("./helpers/captureStdout");
const {
  writeOutboxEvent,
  writeOutboxEventDirect,
  fetchPendingEvents,
  markPublished,
  markFailed,
  getOutboxStats,
  uuid,
} = require("../src/events/event.outbox.service");
const { createPublisher } = require("../src/events/event.publisher.job");

let app;
let merchant;

beforeAll(async () => {
  app = getApp();
  await resetDb();
  merchant = await createMerchant({ name: "Outbox Test Shop" });
}, 15000);

afterAll(async () => {
  await prisma.$disconnect();
});

describe("Event Outbox Service", () => {
  it("writes an outbox event with UUID eventId", async () => {
    const event = await writeOutboxEventDirect(prisma, {
      eventType: "reward_granted",
      aggregateType: "reward",
      aggregateId: "123",
      merchantId: merchant.id,
      consumerId: 1,
      payload: { promotionId: 10, stampCount: 5 },
    });

    expect(event).toHaveProperty("id");
    expect(event.eventId).toMatch(/^[0-9a-f-]{36}$/);
    expect(event.eventType).toBe("reward_granted");
    expect(event.aggregateType).toBe("reward");
    expect(event.status).toBe("pending");
    expect(event.publishAttempts).toBe(0);
    expect(event.payloadJson).toHaveProperty("promotionId", 10);
  });

  it("enforces unique idempotencyKey", async () => {
    const key = "unique-key-" + Date.now();

    await writeOutboxEventDirect(prisma, {
      eventType: "reward_granted",
      aggregateType: "reward",
      aggregateId: "456",
      idempotencyKey: key,
      payload: {},
    });

    await expect(writeOutboxEventDirect(prisma, {
      eventType: "reward_granted",
      aggregateType: "reward",
      aggregateId: "456",
      idempotencyKey: key,
      payload: {},
    })).rejects.toThrow();
  });

  it("writes outbox event inside a transaction", async () => {
    const result = await prisma.$transaction(async (tx) => {
      const m = await tx.merchant.create({ data: { name: "TX Test" } });
      const event = await writeOutboxEvent(tx, {
        eventType: "notification_requested",
        aggregateType: "visit",
        aggregateId: "v-100",
        merchantId: m.id,
        payload: { message: "Welcome!" },
      });
      return { merchantId: m.id, eventId: event.eventId };
    });

    expect(result.eventId).toBeTruthy();

    // Verify both merchant and event exist (committed together)
    const m = await prisma.merchant.findUnique({ where: { id: result.merchantId } });
    expect(m).toBeTruthy();
    const e = await prisma.eventOutbox.findFirst({ where: { eventId: result.eventId } });
    expect(e).toBeTruthy();
    expect(e.status).toBe("pending");
  });

  it("fetches pending events", async () => {
    const events = await fetchPendingEvents(prisma, 10);
    expect(events.length).toBeGreaterThanOrEqual(1);
    events.forEach(e => expect(e.status).toBe("pending"));
  });

  it("marks event as published", async () => {
    const events = await fetchPendingEvents(prisma, 1);
    const e = events[0];
    await markPublished(prisma, e.id);

    const updated = await prisma.eventOutbox.findUnique({ where: { id: e.id } });
    expect(updated.status).toBe("published");
    expect(updated.publishedAt).toBeTruthy();
  });

  it("marks event as failed with backoff", async () => {
    const event = await writeOutboxEventDirect(prisma, {
      eventType: "test_fail",
      aggregateType: "test",
      aggregateId: "fail-1",
      payload: {},
    });

    await markFailed(prisma, event.id, "Connection timeout", 0, 5);

    const updated = await prisma.eventOutbox.findUnique({ where: { id: event.id } });
    expect(updated.status).toBe("failed");
    expect(updated.publishAttempts).toBe(1);
    expect(updated.lastError).toBe("Connection timeout");
    expect(new Date(updated.nextAttemptAt).getTime()).toBeGreaterThan(Date.now());
  });

  it("marks event as dead_lettered after max attempts", async () => {
    const event = await writeOutboxEventDirect(prisma, {
      eventType: "test_dead",
      aggregateType: "test",
      aggregateId: "dead-1",
      payload: {},
      idempotencyKey: "dead-test-" + Date.now(),
    });

    await markFailed(prisma, event.id, "Permanent failure", 4, 5); // 5th attempt = dead

    const updated = await prisma.eventOutbox.findUnique({ where: { id: event.id } });
    expect(updated.status).toBe("dead_lettered");
    expect(updated.publishAttempts).toBe(5);
  });

  it("returns outbox stats", async () => {
    const stats = await getOutboxStats(prisma);
    expect(stats).toHaveProperty("pending");
    expect(stats).toHaveProperty("published");
    expect(stats).toHaveProperty("failed");
    expect(stats).toHaveProperty("dead_lettered");
    expect(typeof stats.pending).toBe("number");
  });

  it("generates valid UUIDs", () => {
    const id = uuid();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe("Event Publisher", () => {
  it("publishes pending events to registered consumers", async () => {
    // Create a pending event
    const event = await writeOutboxEventDirect(prisma, {
      eventType: "reward_granted",
      aggregateType: "reward",
      aggregateId: "pub-test-1",
      merchantId: merchant.id,
      payload: { test: true },
    });

    const received = [];
    const publisher = createPublisher(prisma, null);
    publisher.register("reward_granted", async (e) => {
      received.push(e);
    });

    await publisher.runOnce();

    expect(received.length).toBeGreaterThanOrEqual(1);
    const match = received.find(e => e.eventId === event.eventId);
    expect(match).toBeTruthy();

    // Event should be marked published
    const updated = await prisma.eventOutbox.findUnique({ where: { id: event.id } });
    expect(updated.status).toBe("published");
  });

  it("emits hooks on publish", async () => {
    const event = await writeOutboxEventDirect(prisma, {
      eventType: "notification_requested",
      aggregateType: "test",
      aggregateId: "hook-test-1",
      payload: { notify: true },
    });

    const hooks = [];
    const publisher = createPublisher(prisma, (name, data) => hooks.push({ name, data }));
    publisher.register("notification_requested", async () => {});

    await publisher.runOnce();

    const pubHook = hooks.find(h => h.name === "event.published" && h.data.eventId === event.eventId);
    expect(pubHook).toBeTruthy();
    expect(pubHook.data.tc).toBe("TC-EV-01");
  });

  it("handles consumer failure with retry", async () => {
    const event = await writeOutboxEventDirect(prisma, {
      eventType: "test_consumer_fail",
      aggregateType: "test",
      aggregateId: "fail-consumer-1",
      payload: {},
    });

    const publisher = createPublisher(prisma, null);
    publisher.register("test_consumer_fail", async () => {
      throw new Error("Consumer exploded");
    });

    await publisher.runOnce();

    const updated = await prisma.eventOutbox.findUnique({ where: { id: event.id } });
    expect(updated.status).toBe("failed");
    expect(updated.publishAttempts).toBe(1);
    // Specific error is in the delivery record, outbox gets summary
    expect(updated.lastError).toBeTruthy();

    // Verify the delivery record has the specific error
    const delivery = await prisma.eventDelivery.findFirst({
      where: { outboxEventId: event.id },
    });
    expect(delivery).toBeTruthy();
    expect(delivery.lastError).toContain("Consumer exploded");
  });

  it("marks events with no consumers as published", async () => {
    const event = await writeOutboxEventDirect(prisma, {
      eventType: "orphan_event_type",
      aggregateType: "test",
      aggregateId: "orphan-1",
      payload: {},
    });

    const publisher = createPublisher(prisma, null);
    // No consumer registered for "orphan_event_type"
    await publisher.runOnce();

    const updated = await prisma.eventOutbox.findUnique({ where: { id: event.id } });
    expect(updated.status).toBe("published");
  });
});
