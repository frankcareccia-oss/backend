// tests/hardening/admin.escalation.test.js — Permission escalation & input abuse for admin routes

const request = require("supertest");
const { getApp, merchantToken, consumerToken, adminToken, authHeader } = require("../helpers/setup");
const { prisma, resetDb, createMerchant, createUser, addMerchantUser } = require("../helpers/seed");

let app;
let merchAuth;
let consumerAuth;
let adminAuth;
let merchant;

beforeAll(async () => {
  app = getApp();
  await resetDb();

  // Admin user
  const admin = await prisma.user.create({
    data: { email: "hardening-admin@perkvalet.org", passwordHash: "x", systemRole: "pv_admin" },
  });
  adminAuth = authHeader(adminToken({ userId: admin.id }));

  // Merchant user
  merchant = await createMerchant({ name: "Escalation Test Shop" });
  const merchUser = await createUser({ email: "escalation-merch@perkvalet.org" });
  await addMerchantUser({ merchantId: merchant.id, userId: merchUser.id, role: "merchant_admin" });
  merchAuth = authHeader(merchantToken({ userId: merchUser.id, merchantId: merchant.id }));

  // Consumer
  const consumer = await prisma.consumer.create({
    data: { phoneE164: "+14085559999", status: "active" },
  });
  consumerAuth = authHeader(consumerToken({ consumerId: consumer.id, phone: consumer.phoneE164 }));
}, 15000);

afterAll(async () => {
  await prisma.$disconnect();
});

describe("Permission Escalation", () => {
  describe("Merchant user cannot access admin routes", () => {
    it("GET /merchants — 401", async () => {
      const res = await request(app).get("/merchants").set(merchAuth);
      expect(res.status).toBe(401);
    });

    it("POST /merchants — 401", async () => {
      const res = await request(app).post("/merchants").set(merchAuth).send({ name: "Hack" });
      expect(res.status).toBe(401);
    });

    it("GET /admin/invoices — 401", async () => {
      const res = await request(app).get("/admin/invoices").set(merchAuth);
      expect(res.status).toBe(401);
    });

    it("GET /admin/platform/config — 401", async () => {
      const res = await request(app).get("/admin/platform/config").set(merchAuth);
      expect(res.status).toBe(401);
    });

    it("POST /admin/billing/generate-invoice — 401", async () => {
      const res = await request(app)
        .post("/admin/billing/generate-invoice")
        .set(merchAuth)
        .send({ merchantId: merchant.id, totalCents: 1000 });
      expect(res.status).toBe(401);
    });
  });

  describe("Consumer token cannot access admin routes", () => {
    it("GET /merchants — 401", async () => {
      const res = await request(app).get("/merchants").set(consumerAuth);
      expect(res.status).toBe(401);
    });

    it("POST /admin/billing/generate-invoice — 401", async () => {
      const res = await request(app)
        .post("/admin/billing/generate-invoice")
        .set(consumerAuth)
        .send({ merchantId: 1, totalCents: 1000 });
      expect(res.status).toBe(401);
    });
  });

  describe("Consumer token cannot access merchant routes", () => {
    it("GET /merchant/stores — 401", async () => {
      const res = await request(app).get("/merchant/stores").set(consumerAuth);
      expect(res.status).toBe(401);
    });

    it("POST /merchant/products — 401", async () => {
      const res = await request(app)
        .post("/merchant/products")
        .set(consumerAuth)
        .send({ name: "Hack Product" });
      expect(res.status).toBe(401);
    });
  });

  describe("No token at all", () => {
    it("GET /merchants — 401", async () => {
      const res = await request(app).get("/merchants");
      expect(res.status).toBe(401);
    });

    it("GET /merchant/stores — 401", async () => {
      const res = await request(app).get("/merchant/stores");
      expect(res.status).toBe(401);
    });

    it("GET /me — 401", async () => {
      const res = await request(app).get("/me");
      expect(res.status).toBe(401);
    });
  });
});

describe("Admin Input Abuse", () => {
  describe("Merchant name abuse", () => {
    it("rejects extremely long name", async () => {
      const res = await request(app)
        .post("/merchants")
        .set(adminAuth)
        .send({ name: "A".repeat(10000) });
      // Should either reject (400) or truncate — must not crash (500)
      expect(res.status).not.toBe(500);
    });

    it("handles unicode/emoji in name", async () => {
      const res = await request(app)
        .post("/merchants")
        .set(adminAuth)
        .send({ name: "Café ☕ Test 日本語" });
      expect([200, 201]).toContain(res.status);
    });

    it("rejects null byte in name", async () => {
      const res = await request(app)
        .post("/merchants")
        .set(adminAuth)
        .send({ name: "Test\x00Merchant" });
      expect(res.status).not.toBe(500);
    });
  });

  describe("SQL injection attempts", () => {
    it("login with SQL injection email", async () => {
      const res = await request(app)
        .post("/auth/login")
        .send({ email: "' OR 1=1 --", password: "anything" });
      expect(res.status).toBe(401);
    });

    it("merchant name SQL injection", async () => {
      const res = await request(app)
        .post("/merchants")
        .set(adminAuth)
        .send({ name: "'; DROP TABLE merchants; --" });
      // Should succeed (it's a valid string) but not execute SQL
      expect(res.status).not.toBe(500);
      // Verify merchants table still exists
      const check = await prisma.merchant.count();
      expect(check).toBeGreaterThan(0);
    });
  });

  describe("XSS attempts", () => {
    it("handles script tag in merchant name", async () => {
      const res = await request(app)
        .post("/merchants")
        .set(adminAuth)
        .send({ name: '<script>alert("xss")</script>' });
      expect(res.status).not.toBe(500);
    });

    it("handles script in billing email", async () => {
      const res = await request(app)
        .patch(`/admin/merchants/${merchant.id}/billing-account`)
        .set(adminAuth)
        .send({ billingEmail: '<script>alert("xss")</script>@evil.com' });
      // Should reject as invalid email or sanitize
      expect(res.status).not.toBe(500);
    });
  });

  describe("Type coercion attacks", () => {
    it("merchantId as string", async () => {
      const res = await request(app)
        .get("/merchants/abc")
        .set(adminAuth);
      expect(res.status).toBe(400);
    });

    it("merchantId as negative number", async () => {
      const res = await request(app)
        .get("/merchants/-1")
        .set(adminAuth);
      expect([400, 404]).toContain(res.status);
    });

    it("merchantId as float", async () => {
      const res = await request(app)
        .get("/merchants/1.5")
        .set(adminAuth);
      expect(res.status).not.toBe(500);
    });

    it("merchantId as very large number", async () => {
      const res = await request(app)
        .get("/merchants/99999999999")
        .set(adminAuth);
      expect([400, 404]).toContain(res.status);
    });

    it("invoice totalCents as negative", async () => {
      const res = await request(app)
        .post("/admin/billing/generate-invoice")
        .set(adminAuth)
        .send({ merchantId: merchant.id, totalCents: -500 });
      expect(res.status).not.toBe(500);
    });

    it("invoice totalCents as zero", async () => {
      const res = await request(app)
        .post("/admin/billing/generate-invoice")
        .set(adminAuth)
        .send({ merchantId: merchant.id, totalCents: 0 });
      expect(res.status).not.toBe(500);
    });

    it("config value as string instead of number", async () => {
      const res = await request(app)
        .put("/admin/platform/config")
        .set(adminAuth)
        .send({ consumer_jwt_ttl_days: "not a number" });
      expect(res.status).toBe(400);
    });
  });

  describe("JWT abuse", () => {
    it("malformed JWT", async () => {
      const res = await request(app)
        .get("/merchants")
        .set("Authorization", "Bearer not.a.valid.jwt");
      expect(res.status).toBe(401);
    });

    it("expired-style garbage token", async () => {
      const res = await request(app)
        .get("/merchants")
        .set("Authorization", "Bearer eyJhbGciOiJIUzI1NiJ9.eyJ1c2VySWQiOjF9.garbage");
      expect(res.status).toBe(401);
    });

    it("missing Bearer prefix", async () => {
      const res = await request(app)
        .get("/merchants")
        .set("Authorization", "Token abc123");
      expect(res.status).toBe(401);
    });

    it("empty Authorization header", async () => {
      const res = await request(app)
        .get("/merchants")
        .set("Authorization", "");
      expect(res.status).toBe(401);
    });
  });
});
