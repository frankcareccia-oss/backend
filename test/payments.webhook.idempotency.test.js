"use strict";

const request = require("supertest");
const { captureStdout } = require("./helpers/captureStdout");
const {
  prisma,
  resetDb,
  createMerchantWithBillingAccount,
  createIssuedInvoice,
} = require("./helpers/seed");

// payments.routes.js imports verifyWebhook from "./stripe"
jest.mock("../src/payments/stripe", () => {
  return {
    createPaymentIntent: jest.fn(),
    retrievePaymentIntent: jest.fn(),
    verifyWebhook: jest.fn(),
  };
});

describe("Stripe webhook idempotency (payment_intent.succeeded)", () => {
  let app;

  const WEBHOOK_PATH = process.env.PV_TEST_WEBHOOK_PATH || "/webhooks/stripe";

  beforeAll(() => {
    ({ app } = require("../index"));
  });

  beforeEach(async () => {
    await resetDb();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  test("replaying payment_intent.succeeded does not double-apply invoice paid", async () => {
    const stripe = require("../src/payments/stripe");

    const merchant = await createMerchantWithBillingAccount();
    const invoice = await createIssuedInvoice({
      merchantId: merchant.id,
      billingAccountId: merchant.billingAccount.id,
      totalCents: 5000,
    });

    const paymentIntentId = "pi_test_123";
    const chargeId = "ch_test_123";

    // IMPORTANT:
    // Your webhook handler logs stable:"stripe_pi:<intentId>" and emits unmatched_intent for intentId,
    // which implies it looks up Payment by PaymentIntent id.
    // So we seed providerChargeId with the *payment intent id* to match the handler’s lookup.
    await prisma.payment.create({
      data: {
        invoiceId: invoice.id,
        amountCents: 5000,
        status: "pending",
        providerChargeId: paymentIntentId,
        payerEmail: "payer@example.com",
      },
    });

    stripe.verifyWebhook.mockImplementation(() => ({
      type: "payment_intent.succeeded",
      data: {
        object: {
          id: paymentIntentId,
          latest_charge: chargeId,
          amount: 5000,
          metadata: { invoiceId: String(invoice.id) },
        },
      },
    }));

    stripe.retrievePaymentIntent.mockResolvedValue({
      id: paymentIntentId,
      latest_charge: chargeId,
      amount: 5000,
      metadata: { invoiceId: String(invoice.id) },
    });

    const { output, restore } = captureStdout();
    try {
      const res1 = await request(app)
        .post(WEBHOOK_PATH)
        .set("stripe-signature", "t=1,v1=fake")
        .set("Content-Type", "application/json")
        .send({});

      expect(res1.status).toBe(200);

      const res2 = await request(app)
        .post(WEBHOOK_PATH)
        .set("stripe-signature", "t=1,v1=fake")
        .set("Content-Type", "application/json")
        .send({});

      expect(res2.status).toBe(200);

      const joined = output.join("\n");
      expect(joined).toContain("billing.webhook.idempotent_hit");
      expect(joined).toContain("TC-S-WH-01");
    } finally {
      restore();
    }
  });
});
