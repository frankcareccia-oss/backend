// tests/admin.billing.test.js — Admin billing: invoices, billing accounts, generate, issue, void

const request = require("supertest");
const { getApp, adminToken, authHeader } = require("./helpers/setup");
const { prisma, resetDb, createMerchant, createBillingAccount } = require("./helpers/seed");

let app;
let auth;
let merchant;
let billingAcct;
let invoiceId;

beforeAll(async () => {
  app = getApp();
  await resetDb();

  // Admin user
  const adminUser = await prisma.user.create({
    data: { email: "billing-admin@perkvalet.org", passwordHash: "x", systemRole: "pv_admin" },
  });
  auth = authHeader(adminToken({ userId: adminUser.id }));

  // Merchant with billing account
  merchant = await createMerchant({ name: "Billing Test Shop" });
  billingAcct = await createBillingAccount({ merchantId: merchant.id, billingEmail: "billing@test.com" });
}, 15000);

afterAll(async () => {
  await prisma.$disconnect();
});

describe("Admin Invoice Generation", () => {
  describe("POST /admin/billing/generate-invoice", () => {
    it("generates a draft invoice", async () => {
      const res = await request(app)
        .post("/admin/billing/generate-invoice")
        .set(auth)
        .send({ merchantId: merchant.id, totalCents: 5000 });
      expect(res.status).toBe(201);
      expect(res.body.ok).toBe(true);
      expect(res.body).toHaveProperty("invoiceId");
      expect(res.body.invoice.totalCents).toBe(5000);
      expect(res.body.invoice.status).toBe("draft");
      invoiceId = res.body.invoiceId;
    });

    it("accepts dollar amount", async () => {
      const res = await request(app)
        .post("/admin/billing/generate-invoice")
        .set(auth)
        .send({ merchantId: merchant.id, total: 75.50 });
      expect(res.status).toBe(201);
      expect(res.body.invoice.totalCents).toBe(7550);
    });

    it("rejects missing merchantId", async () => {
      const res = await request(app)
        .post("/admin/billing/generate-invoice")
        .set(auth)
        .send({ totalCents: 1000 });
      expect(res.status).toBe(400);
    });
  });
});

describe("Admin Invoices", () => {
  describe("GET /admin/invoices", () => {
    it("lists all invoices", async () => {
      const res = await request(app).get("/admin/invoices").set(auth);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("items");
      expect(Array.isArray(res.body.items)).toBe(true);
      expect(res.body.items.length).toBeGreaterThanOrEqual(1);
    });

    it("filters by status", async () => {
      const res = await request(app).get("/admin/invoices?status=draft").set(auth);
      expect(res.status).toBe(200);
      res.body.items.forEach(i => expect(i.status).toBe("draft"));
    });

    it("filters by merchantId", async () => {
      const res = await request(app)
        .get(`/admin/invoices?merchantId=${merchant.id}`)
        .set(auth);
      expect(res.status).toBe(200);
      res.body.items.forEach(i => expect(i.merchantId).toBe(merchant.id));
    });
  });

  describe("GET /admin/invoices/:invoiceId", () => {
    it("returns invoice detail with line items", async () => {
      const res = await request(app)
        .get(`/admin/invoices/${invoiceId}`)
        .set(auth);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("invoice");
      expect(res.body).toHaveProperty("lineItems");
      expect(res.body.invoice.id).toBe(invoiceId);
    });

    it("rejects non-existent invoice", async () => {
      const res = await request(app).get("/admin/invoices/99999").set(auth);
      expect(res.status).toBe(404);
    });
  });

  describe("POST /admin/invoices/:invoiceId/issue", () => {
    it("issues a draft invoice", async () => {
      const res = await request(app)
        .post(`/admin/invoices/${invoiceId}/issue`)
        .set(auth)
        .send({ netTermsDays: 30 });
      expect(res.status).toBe(200);
      expect(res.body.invoice.status).toBe("issued");
      expect(res.body.invoice.issuedAt).toBeTruthy();
      expect(res.body.invoice.dueAt).toBeTruthy();
    });

    it("rejects re-issuing an already issued invoice", async () => {
      const res = await request(app)
        .post(`/admin/invoices/${invoiceId}/issue`)
        .set(auth)
        .send({});
      expect([400, 409]).toContain(res.status);
    });
  });

  describe("POST /admin/invoices/:invoiceId/void", () => {
    it("voids an issued invoice", async () => {
      const res = await request(app)
        .post(`/admin/invoices/${invoiceId}/void`)
        .set(auth);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("void");
    });
  });

  describe("GET /admin/invoices/:invoiceId/late-fee-preview", () => {
    it("returns late fee preview", async () => {
      // Create + issue a fresh invoice for preview
      const gen = await request(app)
        .post("/admin/billing/generate-invoice")
        .set(auth)
        .send({ merchantId: merchant.id, totalCents: 3000 });
      const freshId = gen.body.invoiceId;

      await request(app)
        .post(`/admin/invoices/${freshId}/issue`)
        .set(auth)
        .send({ netTermsDays: 0 }); // due immediately

      const res = await request(app)
        .get(`/admin/invoices/${freshId}/late-fee-preview`)
        .set(auth);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("invoiceId");
      expect(res.body).toHaveProperty("isLate");
      expect(res.body.preview).toBe(true);
    });
  });
});

describe("Admin Billing Account", () => {
  describe("GET /admin/merchants/:merchantId/billing-account", () => {
    it("returns billing account", async () => {
      const res = await request(app)
        .get(`/admin/merchants/${merchant.id}/billing-account`)
        .set(auth);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("billingAccount");
      expect(res.body.billingAccount.merchantId).toBe(merchant.id);
    });

    it("rejects non-existent merchant", async () => {
      const res = await request(app)
        .get("/admin/merchants/99999/billing-account")
        .set(auth);
      expect(res.status).toBe(404);
    });
  });

  describe("PATCH /admin/merchants/:merchantId/billing-account", () => {
    it("updates billing email", async () => {
      const res = await request(app)
        .patch(`/admin/merchants/${merchant.id}/billing-account`)
        .set(auth)
        .send({ billingEmail: "updated@billing.com" });
      expect(res.status).toBe(200);
      expect(res.body.billingAccount.billingEmail).toBe("updated@billing.com");
    });

    it("updates billing address", async () => {
      const res = await request(app)
        .patch(`/admin/merchants/${merchant.id}/billing-account`)
        .set(auth)
        .send({
          billingAddress1: "789 Oak Ave",
          billingCity: "Austin",
          billingState: "tx",
          billingPostal: "73301",
        });
      expect(res.status).toBe(200);
      expect(res.body.billingAccount.billingState).toBe("TX"); // uppercased
    });

    it("rejects empty billing email", async () => {
      const res = await request(app)
        .patch(`/admin/merchants/${merchant.id}/billing-account`)
        .set(auth)
        .send({ billingEmail: "" });
      expect(res.status).toBe(400);
    });
  });
});

describe("Admin Billing Policy", () => {
  describe("GET /admin/billing-policy", () => {
    it("returns billing policy", async () => {
      const res = await request(app).get("/admin/billing-policy").set(auth);
      expect(res.status).toBe(200);
      expect(res.body).toBeTruthy();
    });
  });

  describe("GET /admin/merchants/:merchantId/billing-policy", () => {
    it("returns merchant billing policy bundle", async () => {
      const res = await request(app)
        .get(`/admin/merchants/${merchant.id}/billing-policy`)
        .set(auth);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("merchantId");
      expect(res.body).toHaveProperty("effective");
    });
  });
});
