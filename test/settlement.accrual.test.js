// tests/settlement.accrual.test.js — CPG model + settlement accrual + consumer integration

const request = require("supertest");
const { getApp } = require("./helpers/setup");
const { prisma, resetDb, createMerchant } = require("./helpers/seed");
const { captureStdout } = require("./helpers/captureStdout");
const { createAccrual, getOpenAccruals, getAccrualSummary } = require("../src/settlement/settlement.accrual.service");
const { writeOutboxEventDirect, uuid } = require("../src/events/event.outbox.service");
const { createSettlementAccrualConsumer } = require("../src/consumers/settlementAccrual.consumer");

let app;
let merchant;
let cpg;
let storeId;

beforeAll(async () => {
  app = getApp();
  await resetDb();

  merchant = await createMerchant({ name: "Settlement Test Market" });
  const store = await prisma.store.create({
    data: { merchantId: merchant.id, name: "Settlement Store", phoneRaw: "", phoneCountry: "US" },
  });
  storeId = store.id;

  // Create CPG entity
  cpg = await prisma.cpgEntity.create({
    data: {
      name: "Test General Mills",
      status: "active",
      settlementCadence: "weekly",
      payoutDelayDays: 7,
      disputeWindowDays: 14,
      minimumPayoutCents: 5000,
      feeHandling: "cpg_pays",
      platformFeeCents: 25, // $0.25 per transaction
    },
  });

  // Create merchant participation
  await prisma.cpgParticipation.create({
    data: {
      cpgId: cpg.id,
      merchantId: merchant.id,
      status: "active",
      agreedAt: new Date(),
    },
  });
}, 15000);

afterAll(async () => {
  await prisma.$disconnect();
});

describe("CPG Entity", () => {
  it("CPG exists with settlement policy", async () => {
    const found = await prisma.cpgEntity.findUnique({ where: { id: cpg.id } });
    expect(found.name).toBe("Test General Mills");
    expect(found.settlementCadence).toBe("weekly");
    expect(found.platformFeeCents).toBe(25);
    expect(found.feeHandling).toBe("cpg_pays");
  });

  it("merchant has active participation", async () => {
    const p = await prisma.cpgParticipation.findFirst({
      where: { cpgId: cpg.id, merchantId: merchant.id },
    });
    expect(p.status).toBe("active");
    expect(p.agreedAt).toBeTruthy();
  });
});

describe("Settlement Accrual Service", () => {
  it("creates an accrual and emits hook", async () => {
    const hooks = [];
    const { accrual, created } = await createAccrual({
      sourceEventId: uuid(),
      cpgId: cpg.id,
      merchantId: merchant.id,
      storeId,
      grossAmountCents: 250,
      feeAmountCents: 25,
      upc: "012345678901",
      transactionId: "txn-test-001",
      emitHook: (name, data) => hooks.push({ name, data }),
    });

    expect(created).toBe(true);
    expect(accrual.grossAmountCents).toBe(250);
    expect(accrual.feeAmountCents).toBe(25);
    expect(accrual.netAmountCents).toBe(225);
    expect(accrual.status).toBe("open");
    expect(accrual.cpgId).toBe(cpg.id);

    const hook = hooks.find(h => h.name === "settlement.accrual.created");
    expect(hook).toBeTruthy();
    expect(hook.data.tc).toBe("TC-SET-01");
  });

  it("is idempotent — skips duplicate sourceEventId", async () => {
    const eventId = uuid();

    const first = await createAccrual({
      sourceEventId: eventId,
      cpgId: cpg.id,
      merchantId: merchant.id,
      grossAmountCents: 100,
    });
    expect(first.created).toBe(true);

    const second = await createAccrual({
      sourceEventId: eventId,
      cpgId: cpg.id,
      merchantId: merchant.id,
      grossAmountCents: 100,
    });
    expect(second.created).toBe(false);
    expect(second.accrual.id).toBe(first.accrual.id);
  });

  it("queries open accruals", async () => {
    const accruals = await getOpenAccruals({ cpgId: cpg.id });
    expect(accruals.length).toBeGreaterThanOrEqual(1);
    accruals.forEach(a => expect(a.status).toBe("open"));
  });

  it("returns accrual summary by merchant", async () => {
    const summary = await getAccrualSummary({ cpgId: cpg.id });
    expect(summary.accrualCount).toBeGreaterThanOrEqual(1);
    expect(summary.totalGrossCents).toBeGreaterThan(0);
    expect(summary.totalNetCents).toBeGreaterThan(0);
    expect(Array.isArray(summary.byMerchant)).toBe(true);
    expect(summary.byMerchant[0]).toHaveProperty("merchantId", merchant.id);
  });
});

describe("Settlement Accrual Consumer", () => {
  it("creates accrual from subsidy_applied event", async () => {
    const eventId = uuid();
    const handler = createSettlementAccrualConsumer({ emitPvHook: () => {} });

    const result = await handler({
      eventId,
      eventType: "subsidy_applied",
      merchantId: merchant.id,
      storeId,
      consumerId: null,
      correlationId: null,
      payloadJson: {
        subsidyCents: 150,
        upc: "023456789001",
        transactionId: "txn-consumer-001",
      },
    });

    expect(result.accrualId).toBeTruthy();
    expect(result.cpgId).toBe(cpg.id);
    expect(result.grossAmountCents).toBe(150);

    // Verify accrual in DB
    const accrual = await prisma.settlementAccrual.findUnique({
      where: { sourceEventId: eventId },
    });
    expect(accrual).toBeTruthy();
    expect(accrual.feeAmountCents).toBe(25); // from CPG platformFeeCents
    expect(accrual.netAmountCents).toBe(125); // 150 - 25
  });

  it("skips when no CPG participation", async () => {
    const otherMerchant = await createMerchant({ name: "No CPG Merchant" });
    const handler = createSettlementAccrualConsumer({ emitPvHook: () => {} });

    const result = await handler({
      eventId: uuid(),
      eventType: "subsidy_applied",
      merchantId: otherMerchant.id,
      payloadJson: { subsidyCents: 100 },
    });

    expect(result.skipped).toBe(true);
    expect(result.reason).toContain("no active CPG participation");
  });

  it("is idempotent — same event processed twice", async () => {
    const eventId = uuid();
    const handler = createSettlementAccrualConsumer({ emitPvHook: () => {} });

    const first = await handler({
      eventId,
      eventType: "subsidy_applied",
      merchantId: merchant.id,
      payloadJson: { subsidyCents: 200 },
    });
    expect(first.accrualId).toBeTruthy();

    const second = await handler({
      eventId,
      eventType: "subsidy_applied",
      merchantId: merchant.id,
      payloadJson: { subsidyCents: 200 },
    });
    expect(second.skipped).toBe(true);
    expect(second.reason).toContain("duplicate");
  });
});

describe("Grocery → Accrual Integration", () => {
  it("grocery /complete writes outbox event for settlement", async () => {
    const res = await request(app).post("/grocery/complete").send({
      phone: "4085551234",
      storeId,
      merchantId: merchant.id,
      items: [
        { upc: "012345678901", quantity: 1, priceCents: 599, subsidyCents: 250, productName: "Organic Milk" },
      ],
    });

    expect(res.status).toBe(201);

    // Check outbox has a subsidy_applied event
    const outbox = await prisma.eventOutbox.findMany({
      where: { eventType: "subsidy_applied" },
      orderBy: { createdAt: "desc" },
      take: 1,
    });
    expect(outbox.length).toBe(1);
    expect(outbox[0].payloadJson).toHaveProperty("subsidyCents", 250);
    expect(outbox[0].payloadJson).toHaveProperty("upc", "012345678901");
  });
});
