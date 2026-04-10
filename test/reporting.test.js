// tests/reporting.test.js — Merchant + Admin reporting endpoints

const request = require("supertest");
const { getApp, merchantToken, adminToken, authHeader } = require("./helpers/setup");
const { prisma, resetDb, createMerchant, createUser, addMerchantUser } = require("./helpers/seed");

let app;
let merchAuth;
let adminAuth;
let merchant;

beforeAll(async () => {
  app = getApp();
  await resetDb();

  merchant = await createMerchant({ name: "Report Test Shop" });
  const owner = await createUser({ email: "report-owner@perkvalet.org" });
  await addMerchantUser({ merchantId: merchant.id, userId: owner.id, role: "owner" });
  merchAuth = authHeader(merchantToken({ userId: owner.id, merchantId: merchant.id }));

  const admin = await prisma.user.create({
    data: { email: "report-admin@perkvalet.org", passwordHash: "x", systemRole: "pv_admin" },
  });
  adminAuth = authHeader(adminToken({ userId: admin.id }));
}, 15000);

afterAll(async () => {
  await prisma.$disconnect();
});

describe("Merchant Reports", () => {
  describe("GET /merchant/reports/overview", () => {
    it("returns overview with default range", async () => {
      const res = await request(app)
        .get("/merchant/reports/overview")
        .set(merchAuth);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("range");
      expect(res.body).toHaveProperty("totalVisits");
    });

    it("accepts 90d range", async () => {
      const res = await request(app)
        .get("/merchant/reports/overview?range=90d")
        .set(merchAuth);
      expect(res.status).toBe(200);
      expect(res.body.range).toBe("90d");
    });

    it("rejects unauthenticated", async () => {
      const res = await request(app).get("/merchant/reports/overview");
      expect(res.status).toBe(401);
    });
  });

  describe("GET /merchant/reports/stores", () => {
    it("returns store reports", async () => {
      const res = await request(app)
        .get("/merchant/reports/stores")
        .set(merchAuth);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("stores");
    });
  });

  describe("GET /merchant/reports/promotions", () => {
    it("returns promotion reports", async () => {
      const res = await request(app)
        .get("/merchant/reports/promotions")
        .set(merchAuth);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("promotions");
    });
  });
});

describe("Admin Reports", () => {
  describe("GET /admin/merchants/:merchantId/reports/overview", () => {
    it("returns merchant overview", async () => {
      const res = await request(app)
        .get(`/admin/merchants/${merchant.id}/reports/overview`)
        .set(adminAuth);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("totalVisits");
    });
  });

  describe("GET /admin/merchants/:merchantId/reports/stores", () => {
    it("returns merchant store reports", async () => {
      const res = await request(app)
        .get(`/admin/merchants/${merchant.id}/reports/stores`)
        .set(adminAuth);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("stores");
    });
  });

  describe("GET /admin/merchants/:merchantId/reports/promotions", () => {
    it("returns merchant promotion reports", async () => {
      const res = await request(app)
        .get(`/admin/merchants/${merchant.id}/reports/promotions`)
        .set(adminAuth);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("promotions");
    });
  });

  describe("GET /admin/reports/platform", () => {
    it("returns platform-wide report", async () => {
      const res = await request(app)
        .get("/admin/reports/platform")
        .set(adminAuth);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("merchants");
      expect(res.body).toHaveProperty("visits");
    });

    it("rejects non-admin", async () => {
      const res = await request(app)
        .get("/admin/reports/platform")
        .set(merchAuth);
      expect(res.status).toBe(401);
    });
  });
});
