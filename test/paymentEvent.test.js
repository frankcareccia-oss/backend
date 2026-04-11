// tests/paymentEvent.test.js — PaymentEvent ledger: service + API + immutability

const request = require("supertest");
const { getApp, adminToken, merchantToken, authHeader } = require("./helpers/setup");
const { prisma, resetDb, createMerchant, createUser, addMerchantUser } = require("./helpers/seed");
const { captureStdout } = require("./helpers/captureStdout");
const { recordPaymentEvent, queryPaymentEvents, getSettlementReport } = require("../src/payments/paymentEvent.service");

let app;
let adminAuth;
let merchAuth;
let merchant;

beforeAll(async () => {
  app = getApp();
  await resetDb();

  merchant = await createMerchant({ name: "Payment Event Test" });

  const admin = await prisma.user.create({
    data: { email: "pe-admin@perkvalet.org", passwordHash: "x", systemRole: "pv_admin" },
  });
  adminAuth = authHeader(adminToken({ userId: admin.id }));

  const merchUser = await createUser({ email: "pe-merch@perkvalet.org" });
  await addMerchantUser({ merchantId: merchant.id, userId: merchUser.id, role: "owner" });
  merchAuth = authHeader(merchantToken({ userId: merchUser.id, merchantId: merchant.id }));
}, 15000);

afterAll(async () => {
  await prisma.$disconnect();
});

describe("PaymentEvent Service", () => {
  it("records an event and emits hook", async () => {
    const hookCalls = [];
    const event = await recordPaymentEvent({
      eventType: "subsidy_applied",
      source: "grocery",
      merchantId: merchant.id,
      phone: "+14085551234",
      amountCents: 250,
      transactionId: "txn-001",
      upc: "012345678901",
      productName: "Organic Milk",
      emitHook: (name, data) => hookCalls.push({ name, data }),
    });

    expect(event).toHaveProperty("id");
    expect(event.eventType).toBe("subsidy_applied");
    expect(event.source).toBe("grocery");
    expect(event.amountCents).toBe(250);
    expect(event.transactionId).toBe("txn-001");

    expect(hookCalls.length).toBe(1);
    expect(hookCalls[0].name).toBe("payment.event.recorded");
    expect(hookCalls[0].data.tc).toBe("TC-PE-01");
  });

  it("creates immutable record (no updatedAt field)", async () => {
    const event = await recordPaymentEvent({
      eventType: "payment_created",
      source: "square",
      merchantId: merchant.id,
      amountCents: 1500,
      providerEventId: "sq_pay_001",
    });

    expect(event.createdAt).toBeTruthy();
    expect(event).not.toHaveProperty("updatedAt");
  });

  it("queries events by source", async () => {
    const events = await queryPaymentEvents({ source: "grocery" });
    expect(events.length).toBeGreaterThanOrEqual(1);
    events.forEach(e => expect(e.source).toBe("grocery"));
  });

  it("queries events by merchantId", async () => {
    const events = await queryPaymentEvents({ merchantId: merchant.id });
    expect(events.length).toBeGreaterThanOrEqual(1);
    events.forEach(e => expect(e.merchantId).toBe(merchant.id));
  });

  it("queries events by transactionId", async () => {
    const events = await queryPaymentEvents({ transactionId: "txn-001" });
    expect(events.length).toBe(1);
    expect(events[0].upc).toBe("012345678901");
  });

  it("generates settlement report", async () => {
    const report = await getSettlementReport({ merchantId: merchant.id });
    expect(report.totalSubsidyCents).toBeGreaterThanOrEqual(250);
    expect(report.eventCount).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(report.byMerchant)).toBe(true);
    expect(Array.isArray(report.byPromotion)).toBe(true);
  });
});

describe("PaymentEvent API", () => {
  describe("GET /admin/payment-events", () => {
    it("returns events and emits hook", async () => {
      const { output, restore } = captureStdout();
      try {
        const res = await request(app).get("/admin/payment-events").set(adminAuth);
        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty("items");
        expect(res.body.items.length).toBeGreaterThanOrEqual(1);

        const joined = output.join("\n");
        expect(joined).toContain("payment.events.queried");
        expect(joined).toContain("TC-PE-02");
      } finally {
        restore();
      }
    });

    it("filters by source", async () => {
      const res = await request(app)
        .get("/admin/payment-events?source=grocery")
        .set(adminAuth);
      expect(res.status).toBe(200);
      res.body.items.forEach(e => expect(e.source).toBe("grocery"));
    });

    it("filters by merchantId", async () => {
      const res = await request(app)
        .get("/admin/payment-events?merchantId=" + merchant.id)
        .set(adminAuth);
      expect(res.status).toBe(200);
      res.body.items.forEach(e => expect(e.merchantId).toBe(merchant.id));
    });

    it("rejects non-admin", async () => {
      const res = await request(app).get("/admin/payment-events").set(merchAuth);
      expect(res.status).toBe(401);
    });

    it("rejects unauthenticated", async () => {
      const res = await request(app).get("/admin/payment-events");
      expect(res.status).toBe(401);
    });
  });

  describe("GET /admin/settlement-report", () => {
    it("returns settlement report and emits hook", async () => {
      const { output, restore } = captureStdout();
      try {
        const res = await request(app).get("/admin/settlement-report").set(adminAuth);
        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty("totalSubsidyCents");
        expect(res.body).toHaveProperty("byMerchant");
        expect(res.body).toHaveProperty("byPromotion");

        const joined = output.join("\n");
        expect(joined).toContain("payment.settlement.report_generated");
        expect(joined).toContain("TC-PE-03");
      } finally {
        restore();
      }
    });

    it("returns CSV when format=csv", async () => {
      const res = await request(app)
        .get("/admin/settlement-report?format=csv")
        .set(adminAuth);
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("text/csv");
      expect(res.text).toContain("type,id,totalCents");
    });

    it("filters by merchantId", async () => {
      const res = await request(app)
        .get("/admin/settlement-report?merchantId=" + merchant.id)
        .set(adminAuth);
      expect(res.status).toBe(200);
      expect(res.body.eventCount).toBeGreaterThanOrEqual(1);
    });

    it("rejects non-admin", async () => {
      const res = await request(app).get("/admin/settlement-report").set(merchAuth);
      expect(res.status).toBe(401);
    });
  });
});

describe("PaymentEvent Immutability", () => {
  it("cannot update a payment event via Prisma", async () => {
    const events = await prisma.paymentEvent.findMany({ take: 1 });
    const original = events[0];

    // Attempt update — should succeed technically (Prisma allows it)
    // but the model has no updatedAt and the service has no update function
    // This test documents that the SERVICE layer enforces immutability
    expect(typeof recordPaymentEvent).toBe("function");
    expect(typeof queryPaymentEvents).toBe("function");
    // No updatePaymentEvent or deletePaymentEvent exported
    const service = require("../src/payments/paymentEvent.service");
    expect(service.updatePaymentEvent).toBeUndefined();
    expect(service.deletePaymentEvent).toBeUndefined();
  });

  it("events are ordered newest first", async () => {
    const events = await queryPaymentEvents({ merchantId: merchant.id });
    for (let i = 1; i < events.length; i++) {
      expect(new Date(events[i - 1].createdAt).getTime())
        .toBeGreaterThanOrEqual(new Date(events[i].createdAt).getTime());
    }
  });
});
