// tests/square.paymentEvent.test.js — Verify Square webhooks write to PaymentEvent ledger

const request = require("supertest");
const { getApp } = require("./helpers/setup");
const { prisma, resetDb, createMerchant } = require("./helpers/seed");

let app;
let merchant;
let storeId;

beforeAll(async () => {
  app = getApp();
  await resetDb();

  merchant = await createMerchant({ name: "Square PE Test" });

  const store = await prisma.store.create({
    data: { merchantId: merchant.id, name: "Square Store", phoneRaw: "", phoneCountry: "US" },
  });
  storeId = store.id;

  // Create a POS connection and location map so the webhook can resolve the store
  const conn = await prisma.posConnection.create({
    data: {
      merchantId: merchant.id,
      posType: "square",
      externalMerchantId: "SQ_TEST_MERCHANT",
      accessTokenEnc: "fake-token",
      status: "active",
    },
  });

  await prisma.posLocationMap.create({
    data: {
      posConnectionId: conn.id,
      externalLocationId: "SQ_LOC_001",
      pvStoreId: storeId,
      active: true,
    },
  });
}, 15000);

afterAll(async () => {
  await prisma.$disconnect();
});

describe("Square → PaymentEvent Ledger", () => {
  const squarePaymentId = "sq_pay_pe_test_" + Date.now();

  it("COMPLETED payment webhook writes PaymentEvent", async () => {
    const res = await request(app)
      .post("/webhooks/square")
      .set("Content-Type", "application/json")
      .send({
        merchant_id: "SQ_TEST_MERCHANT",
        type: "payment.updated",
        data: {
          type: "payment",
          object: {
            payment: {
              id: squarePaymentId,
              status: "COMPLETED",
              location_id: "SQ_LOC_001",
              amount_money: { amount: 1250, currency: "USD" },
              order_id: "sq_order_001",
            },
          },
        },
      });
    expect(res.status).toBe(200);

    // Wait for async dispatch to complete
    await new Promise(r => setTimeout(r, 2000));

    // Verify PaymentEvent was recorded
    const events = await prisma.paymentEvent.findMany({
      where: { providerEventId: squarePaymentId },
    });

    expect(events.length).toBe(1);
    expect(events[0].eventType).toBe("payment_completed");
    expect(events[0].source).toBe("square");
    expect(events[0].merchantId).toBe(merchant.id);
    expect(events[0].storeId).toBe(storeId);
    expect(events[0].amountCents).toBe(1250);
    expect(events[0].providerOrderId).toBe("sq_order_001");
  });

  it("duplicate payment does NOT create duplicate PaymentEvent", async () => {
    // Send the same payment again
    await request(app)
      .post("/webhooks/square")
      .set("Content-Type", "application/json")
      .send({
        merchant_id: "SQ_TEST_MERCHANT",
        type: "payment.updated",
        data: {
          type: "payment",
          object: {
            payment: {
              id: squarePaymentId,
              status: "COMPLETED",
              location_id: "SQ_LOC_001",
              amount_money: { amount: 1250, currency: "USD" },
            },
          },
        },
      });

    await new Promise(r => setTimeout(r, 1000));

    // Should still be exactly 1 event
    const events = await prisma.paymentEvent.findMany({
      where: { providerEventId: squarePaymentId },
    });
    expect(events.length).toBe(1);
  });

  it("non-COMPLETED payment does NOT write PaymentEvent", async () => {
    const pendingId = "sq_pay_pending_" + Date.now();

    await request(app)
      .post("/webhooks/square")
      .set("Content-Type", "application/json")
      .send({
        merchant_id: "SQ_TEST_MERCHANT",
        type: "payment.created",
        data: {
          type: "payment",
          object: {
            payment: {
              id: pendingId,
              status: "APPROVED",
              location_id: "SQ_LOC_001",
              amount_money: { amount: 500, currency: "USD" },
            },
          },
        },
      });

    await new Promise(r => setTimeout(r, 1000));

    const events = await prisma.paymentEvent.findMany({
      where: { providerEventId: pendingId },
    });
    expect(events.length).toBe(0);
  });

  it("PaymentEvent has correct metadata", async () => {
    const events = await prisma.paymentEvent.findMany({
      where: { providerEventId: squarePaymentId },
    });

    const meta = events[0].metadataJson;
    expect(meta).toHaveProperty("locationId", "SQ_LOC_001");
    expect(meta).toHaveProperty("squareStatus", "COMPLETED");
    expect(meta).toHaveProperty("visitId");
  });
});
