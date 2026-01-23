"use strict";

const request = require("supertest");
const {
  prisma,
  resetDb,
  createMerchantWithBillingAccount,
  createUser,
  addMerchantUser,
  createInvoice,
} = require("./helpers/seed");
const { signUserJwt } = require("./helpers/jwt");

// Mock Stripe so /payments/intent doesn't depend on real Stripe env
jest.mock("../src/payments/stripe", () => ({
  createPaymentIntent: jest.fn(),
  retrievePaymentIntent: jest.fn(),
}));

function captureStdoutLocal() {
  const original = process.stdout.write;
  const output = [];
  // eslint-disable-next-line no-param-reassign
  process.stdout.write = (chunk, encoding, cb) => {
    output.push(String(chunk));
    return original.call(process.stdout, chunk, encoding, cb);
  };
  return {
    output,
    restore: () => {
      process.stdout.write = original;
    },
  };
}

describe("Merchant-auth payments intent access control", () => {
  let app;

  beforeAll(() => {
    ({ app } = require("../index"));
  });

  beforeEach(async () => {
    await resetDb();
    const stripe = require("../src/payments/stripe");
    stripe.createPaymentIntent.mockResolvedValue({ clientSecret: "pi_secret_test_12345" });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  test("User not in merchant cannot POST /payments/intent (403) and emits denied hook", async () => {
    const { id: merchantId, billingAccount } = await createMerchantWithBillingAccount({
      name: "M1",
      billingEmail: "billing@m1.com",
    });

    const inv = await createInvoice({
      billingAccountId: billingAccount.id,
      merchantId,
      status: "issued",
      totalCents: 500,
    });

    const outsider = await createUser({ email: "outsider@example.com" });
    const token = signUserJwt(outsider.id);

    const { output, restore } = captureStdoutLocal();
    try {
      const res = await request(app)
        .post("/payments/intent")
        .set("Authorization", `Bearer ${token}`)
        .send({ invoiceId: inv.id, amountCents: inv.totalCents });

      expect(res.status).toBe(403);

      const joined = output.join("\n");
      expect(joined).toContain("billing.intent.denied");
      expect(joined).toContain("TC-S-ROLE-01");
    } finally {
      restore();
    }
  });

  test("User in merchant can POST /payments/intent (200) and returns clientSecret", async () => {
    const { id: merchantId, billingAccount } = await createMerchantWithBillingAccount({
      name: "M1",
      billingEmail: "billing@m1.com",
    });

    const inv = await createInvoice({
      billingAccountId: billingAccount.id,
      merchantId,
      status: "issued",
      totalCents: 500,
    });

    const insider = await createUser({ email: "insider@example.com" });
    await addMerchantUser({ merchantId, userId: insider.id, role: "merchant_admin" });
    const token = signUserJwt(insider.id);

    const res = await request(app)
      .post("/payments/intent")
      .set("Authorization", `Bearer ${token}`)
      .send({ invoiceId: inv.id, amountCents: inv.totalCents });

    expect(res.status).toBe(200);

    const clientSecret = res.body?.clientSecret ?? res.body?.client_secret;
    expect(typeof clientSecret).toBe("string");
    expect(clientSecret.length).toBeGreaterThan(5);
  });
});
