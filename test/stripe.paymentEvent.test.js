// tests/stripe.paymentEvent.test.js — Verify Stripe webhooks write to PaymentEvent ledger

"use strict";

const request = require("supertest");
const {
  prisma,
  resetDb,
  createMerchantWithBillingAccount,
  createIssuedInvoice,
} = require("./helpers/seed");

jest.mock("../src/payments/stripe", () => ({
  createPaymentIntent: jest.fn(),
  retrievePaymentIntent: jest.fn(),
  verifyWebhook: jest.fn(),
}));

describe("Stripe → PaymentEvent Ledger", () => {
  let app;

  beforeAll(() => {
    app = require("../index");
  });

  beforeEach(async () => {
    await resetDb();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  test("payment_intent.succeeded writes PaymentEvent", async () => {
    const stripe = require("../src/payments/stripe");

    const merchant = await createMerchantWithBillingAccount();
    const invoice = await createIssuedInvoice({
      merchantId: merchant.id,
      billingAccountId: merchant.billingAccount.id,
      totalCents: 5000,
    });

    const intentId = "pi_stripe_pe_test_" + Date.now();

    await prisma.payment.create({
      data: {
        invoiceId: invoice.id,
        amountCents: 5000,
        status: "pending",
        providerChargeId: intentId,
        payerEmail: "test@test.com",
      },
    });

    stripe.verifyWebhook.mockImplementation(() => ({
      type: "payment_intent.succeeded",
      data: {
        object: {
          id: intentId,
          latest_charge: "ch_test_001",
          amount: 5000,
          metadata: { invoiceId: String(invoice.id) },
        },
      },
    }));

    stripe.retrievePaymentIntent.mockResolvedValue({
      id: intentId,
      latest_charge: "ch_test_001",
      amount: 5000,
      metadata: { invoiceId: String(invoice.id) },
    });

    const res = await request(app)
      .post("/webhooks/stripe")
      .set("stripe-signature", "t=1,v1=fake")
      .set("Content-Type", "application/json")
      .send({});

    expect(res.status).toBe(200);

    // Verify PaymentEvent was recorded
    const events = await prisma.paymentEvent.findMany({
      where: { providerEventId: intentId },
    });

    expect(events.length).toBe(1);
    expect(events[0].eventType).toBe("payment_completed");
    expect(events[0].source).toBe("stripe");
    expect(events[0].merchantId).toBe(merchant.id);
    expect(events[0].amountCents).toBe(5000);
    expect(events[0].providerOrderId).toBe(String(invoice.id));
  });

  test("idempotent replay does NOT create duplicate PaymentEvent", async () => {
    const stripe = require("../src/payments/stripe");

    const merchant = await createMerchantWithBillingAccount();
    const invoice = await createIssuedInvoice({
      merchantId: merchant.id,
      billingAccountId: merchant.billingAccount.id,
      totalCents: 3000,
    });

    const intentId = "pi_stripe_idem_" + Date.now();

    await prisma.payment.create({
      data: {
        invoiceId: invoice.id,
        amountCents: 3000,
        status: "pending",
        providerChargeId: intentId,
        payerEmail: "test@test.com",
      },
    });

    stripe.verifyWebhook.mockImplementation(() => ({
      type: "payment_intent.succeeded",
      data: {
        object: {
          id: intentId,
          latest_charge: "ch_test_002",
          amount: 3000,
          metadata: { invoiceId: String(invoice.id) },
        },
      },
    }));

    stripe.retrievePaymentIntent.mockResolvedValue({
      id: intentId,
      latest_charge: "ch_test_002",
      amount: 3000,
      metadata: { invoiceId: String(invoice.id) },
    });

    // First call
    await request(app)
      .post("/webhooks/stripe")
      .set("stripe-signature", "t=1,v1=fake")
      .send({});

    // Second call (replay)
    await request(app)
      .post("/webhooks/stripe")
      .set("stripe-signature", "t=1,v1=fake")
      .send({});

    // Should only have 1 PaymentEvent (idempotency gate blocks second)
    const events = await prisma.paymentEvent.findMany({
      where: { providerEventId: intentId },
    });
    expect(events.length).toBe(1);
  });
});
