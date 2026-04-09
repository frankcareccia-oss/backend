// tests/merchant.invoices.test.js — Merchant invoice list + detail

const request = require("supertest");
const { getApp, merchantToken, authHeader } = require("./helpers/setup");
const {
  prisma, resetDb, createMerchant, createUser, addMerchantUser,
  createBillingAccount, createIssuedInvoice,
} = require("./helpers/seed");

let app;
let auth;
let merchant;
let invoiceId;

beforeAll(async () => {
  app = getApp();
  await resetDb();

  merchant = await createMerchant({ name: "Invoice Test Shop" });
  const billingAcct = await createBillingAccount({ merchantId: merchant.id, billingEmail: "billing@invoicetest.com" });
  const user = await createUser({ email: "invoice-test@perkvalet.org" });
  await addMerchantUser({ merchantId: merchant.id, userId: user.id, role: "owner" });

  // Seed an invoice
  const inv = await createIssuedInvoice({
    merchantId: merchant.id,
    billingAccountId: billingAcct.id,
    totalCents: 10000,
    status: "issued",
  });
  invoiceId = inv.id;

  const token = merchantToken({ userId: user.id, merchantId: merchant.id });
  auth = authHeader(token);
}, 15000);

afterAll(async () => {
  await prisma.$disconnect();
});

describe("Merchant Invoices", () => {
  describe("GET /merchant/invoices", () => {
    it("lists invoices for merchant", async () => {
      const res = await request(app).get("/merchant/invoices").set(auth);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("items");
      expect(Array.isArray(res.body.items)).toBe(true);
      expect(res.body.items.length).toBeGreaterThanOrEqual(1);
      const inv = res.body.items.find(i => i.id === invoiceId);
      expect(inv).toBeTruthy();
      expect(inv.totalCents).toBe(10000);
      expect(inv.status).toBe("issued");
    });

    it("rejects unauthenticated", async () => {
      const res = await request(app).get("/merchant/invoices");
      expect(res.status).toBe(401);
    });
  });

  describe("GET /merchant/invoices/:invoiceId", () => {
    it("returns invoice detail", async () => {
      const res = await request(app)
        .get(`/merchant/invoices/${invoiceId}`)
        .set(auth);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("invoice");
      expect(res.body.invoice.id).toBe(invoiceId);
      expect(res.body.invoice.totalCents).toBe(10000);
      expect(res.body.invoice.merchantId).toBe(merchant.id);
    });

    it("rejects non-existent invoice", async () => {
      const res = await request(app)
        .get("/merchant/invoices/99999")
        .set(auth);
      expect(res.status).toBe(404);
    });

    it("rejects invalid invoiceId", async () => {
      const res = await request(app)
        .get("/merchant/invoices/abc")
        .set(auth);
      expect(res.status).toBe(400);
    });

    it("rejects unauthenticated", async () => {
      const res = await request(app)
        .get(`/merchant/invoices/${invoiceId}`);
      expect(res.status).toBe(401);
    });
  });
});
