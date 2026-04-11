// tests/event.replay.test.js — Replay tooling: replay, dead-letters, trace, health, API

const request = require("supertest");
const { getApp, adminToken, merchantToken, authHeader } = require("./helpers/setup");
const { prisma, resetDb, createMerchant, createUser, addMerchantUser } = require("./helpers/seed");
const { captureStdout } = require("./helpers/captureStdout");
const { writeOutboxEventDirect, uuid, markFailed } = require("../src/events/event.outbox.service");
const { createDelivery, markDeliveryFailed } = require("../src/events/event.delivery.service");
const { replayEvent, replayDeadLetters, getEventTrace, getOpsHealth, getDeadLetterReport } = require("../src/events/event.replay.service");

let app;
let adminAuth;
let merchAuth;
let merchant;

beforeAll(async () => {
  app = getApp();
  await resetDb();

  merchant = await createMerchant({ name: "Replay Test Shop" });

  const admin = await prisma.user.create({
    data: { email: "replay-admin@perkvalet.org", passwordHash: "x", systemRole: "pv_admin" },
  });
  adminAuth = authHeader(adminToken({ userId: admin.id }));

  const merchUser = await createUser({ email: "replay-merch@perkvalet.org" });
  await addMerchantUser({ merchantId: merchant.id, userId: merchUser.id, role: "owner" });
  merchAuth = authHeader(merchantToken({ userId: merchUser.id, merchantId: merchant.id }));
}, 15000);

afterAll(async () => {
  await prisma.$disconnect();
});

describe("Replay Service", () => {
  let deadEvent;

  beforeAll(async () => {
    // Create an event and dead-letter it
    deadEvent = await writeOutboxEventDirect(prisma, {
      eventType: "test_replay",
      aggregateType: "test",
      aggregateId: "replay-1",
      correlationId: "corr-replay-001",
      merchantId: merchant.id,
      payload: { test: true },
    });

    // Simulate 5 failures → dead_lettered
    for (let i = 0; i < 5; i++) {
      await markFailed(prisma, deadEvent.id, "Failure #" + (i + 1), i, 5);
    }

    // Create delivery and dead-letter it
    const delivery = await createDelivery(prisma, deadEvent, "testConsumer");
    for (let i = 0; i < 3; i++) {
      await markDeliveryFailed(prisma, delivery.id, new Error("Delivery fail #" + (i + 1)));
    }
  });

  it("replays a dead-lettered event and emits hook", async () => {
    const hooks = [];
    const result = await replayEvent(prisma, deadEvent.eventId, (name, data) => hooks.push({ name, data }));

    expect(result.replayed).toBe(true);
    expect(result.deliveriesReset).toBeGreaterThanOrEqual(1);

    // Verify event reset to pending
    const updated = await prisma.eventOutbox.findUnique({ where: { id: deadEvent.id } });
    expect(updated.status).toBe("pending");
    expect(updated.publishAttempts).toBe(0);

    // Verify delivery reset
    const deliveries = await prisma.eventDelivery.findMany({
      where: { outboxEventId: deadEvent.id },
    });
    deliveries.forEach(d => expect(d.status).toBe("pending"));

    const hook = hooks.find(h => h.name === "event.replay.executed");
    expect(hook).toBeTruthy();
    expect(hook.data.tc).toBe("TC-EV-06");
  });

  it("returns not-found for unknown eventId", async () => {
    const result = await replayEvent(prisma, "nonexistent-uuid");
    expect(result.replayed).toBe(false);
    expect(result.reason).toContain("not found");
  });

  it("skips already-published events", async () => {
    const pubEvent = await writeOutboxEventDirect(prisma, {
      eventType: "test_published",
      aggregateType: "test",
      aggregateId: "pub-skip-1",
      payload: {},
    });
    await prisma.eventOutbox.update({ where: { id: pubEvent.id }, data: { status: "published", publishedAt: new Date() } });

    const result = await replayEvent(prisma, pubEvent.eventId);
    expect(result.replayed).toBe(false);
    expect(result.reason).toContain("already published");
  });
});

describe("Replay Dead Letters", () => {
  it("replays all dead-lettered events", async () => {
    // Create a new dead event
    const event = await writeOutboxEventDirect(prisma, {
      eventType: "test_dead_replay",
      aggregateType: "test",
      aggregateId: "dead-replay-1",
      payload: {},
    });
    for (let i = 0; i < 5; i++) {
      await markFailed(prisma, event.id, "fail", i, 5);
    }

    const result = await replayDeadLetters(prisma, { limit: 10 });
    expect(result.replayed).toBeGreaterThanOrEqual(1);
  });
});

describe("Event Trace", () => {
  it("traces events by correlationId", async () => {
    const corrId = "corr-trace-" + Date.now();

    await writeOutboxEventDirect(prisma, {
      eventType: "trace_event_1",
      aggregateType: "test",
      aggregateId: "trace-1",
      correlationId: corrId,
      payload: { step: 1 },
    });
    await writeOutboxEventDirect(prisma, {
      eventType: "trace_event_2",
      aggregateType: "test",
      aggregateId: "trace-2",
      correlationId: corrId,
      causationId: "some-cause",
      payload: { step: 2 },
    });

    const trace = await getEventTrace(prisma, corrId);
    expect(trace.length).toBe(2);
    expect(trace[0].correlationId).toBe(corrId);
    expect(trace[1].correlationId).toBe(corrId);
  });
});

describe("Ops Health", () => {
  it("returns health dashboard data", async () => {
    const health = await getOpsHealth(prisma);
    expect(health).toHaveProperty("outbox");
    expect(health).toHaveProperty("delivery");
    expect(health).toHaveProperty("failedConsumers");
    expect(health.outbox).toHaveProperty("pending");
    expect(health.outbox).toHaveProperty("published");
    expect(health.delivery).toHaveProperty("processed");
  });
});

describe("Dead Letter Report", () => {
  it("returns dead-lettered events with consumer details", async () => {
    // Ensure at least one dead event exists
    const event = await writeOutboxEventDirect(prisma, {
      eventType: "dead_report_test",
      aggregateType: "test",
      aggregateId: "dead-rpt-1",
      payload: {},
    });
    for (let i = 0; i < 5; i++) {
      await markFailed(prisma, event.id, "report fail", i, 5);
    }

    const report = await getDeadLetterReport(prisma);
    expect(report.length).toBeGreaterThanOrEqual(1);
    expect(report[0]).toHaveProperty("eventId");
    expect(report[0]).toHaveProperty("eventType");
    expect(report[0]).toHaveProperty("lastError");
  });
});

describe("Event Ops API", () => {
  it("GET /admin/events/health returns health data", async () => {
    const { output, restore } = captureStdout();
    try {
      const res = await request(app).get("/admin/events/health").set(adminAuth);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("outbox");
      expect(res.body).toHaveProperty("delivery");

      const joined = output.join("\n");
      expect(joined).toContain("event.ops.health_queried");
      expect(joined).toContain("TC-EV-07");
    } finally {
      restore();
    }
  });

  it("GET /admin/events/dead-letters returns report", async () => {
    const res = await request(app).get("/admin/events/dead-letters").set(adminAuth);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("items");
  });

  it("GET /admin/events/trace/:corrId returns chain", async () => {
    const corrId = "corr-api-test-" + Date.now();
    await writeOutboxEventDirect(prisma, {
      eventType: "api_trace_test",
      aggregateType: "test",
      aggregateId: "api-trace-1",
      correlationId: corrId,
      payload: {},
    });

    const { output, restore } = captureStdout();
    try {
      const res = await request(app).get("/admin/events/trace/" + corrId).set(adminAuth);
      expect(res.status).toBe(200);
      expect(res.body.correlationId).toBe(corrId);
      expect(res.body.events.length).toBe(1);

      const joined = output.join("\n");
      expect(joined).toContain("event.ops.trace_queried");
      expect(joined).toContain("TC-EV-08");
    } finally {
      restore();
    }
  });

  it("POST /admin/events/replay/:eventId replays event", async () => {
    const event = await writeOutboxEventDirect(prisma, {
      eventType: "api_replay_test",
      aggregateType: "test",
      aggregateId: "api-replay-1",
      payload: {},
    });
    for (let i = 0; i < 5; i++) {
      await markFailed(prisma, event.id, "fail", i, 5);
    }

    const res = await request(app)
      .post("/admin/events/replay/" + event.eventId)
      .set(adminAuth);
    expect(res.status).toBe(200);
    expect(res.body.replayed).toBe(true);
  });

  it("POST /admin/events/replay-dead-letters replays all", async () => {
    const res = await request(app)
      .post("/admin/events/replay-dead-letters")
      .set(adminAuth);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("replayed");
    expect(res.body).toHaveProperty("total");
  });

  it("rejects non-admin on all ops routes", async () => {
    const routes = [
      ["GET", "/admin/events/health"],
      ["GET", "/admin/events/dead-letters"],
      ["GET", "/admin/events/trace/abc"],
      ["POST", "/admin/events/replay/abc"],
      ["POST", "/admin/events/replay-dead-letters"],
    ];

    for (const [method, path] of routes) {
      const res = await request(app)[method.toLowerCase()](path).set(merchAuth);
      expect(res.status).toBe(401);
    }
  });
});
