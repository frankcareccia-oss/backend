// tests/pos.routes.test.js — POS route auth guards and validation

const request = require("supertest");
const { getApp, merchantToken, consumerToken, authHeader } = require("./helpers/setup");
const { prisma, resetDb, createMerchant, createUser, addMerchantUser } = require("./helpers/seed");

let app;
let merchAuth;
let consumerAuth;

beforeAll(async () => {
  app = getApp();
  await resetDb();

  const merchant = await createMerchant({ name: "POS Route Test" });
  const user = await createUser({ email: "pos-route@perkvalet.org" });
  await addMerchantUser({ merchantId: merchant.id, userId: user.id, role: "merchant_admin" });
  merchAuth = authHeader(merchantToken({ userId: user.id, merchantId: merchant.id }));

  const consumer = await prisma.consumer.create({
    data: { phoneE164: "+14085558888", status: "active" },
  });
  consumerAuth = authHeader(consumerToken({ consumerId: consumer.id, phone: consumer.phoneE164 }));
}, 15000);

afterAll(async () => {
  await prisma.$disconnect();
});

describe("POS Routes Auth Guards", () => {
  const posRoutes = [
    ["GET", "/pos/stats/today"],
    ["GET", "/pos/activity/recent"],
    ["GET", "/pos/bundles/available"],
  ];

  describe("rejects unauthenticated requests", () => {
    posRoutes.forEach(([method, path]) => {
      it(`${method} ${path} — 401`, async () => {
        const res = await request(app)[method.toLowerCase()](path);
        expect(res.status).toBe(401);
      });
    });
  });

  describe("rejects consumer tokens on POS routes", () => {
    posRoutes.forEach(([method, path]) => {
      it(`${method} ${path} — rejects consumer token`, async () => {
        const res = await request(app)[method.toLowerCase()](path).set(consumerAuth);
        expect(res.status).toBe(401);
      });
    });
  });

  describe("POST /pos/visit validation", () => {
    it("rejects unauthenticated", async () => {
      const res = await request(app).post("/pos/visit").send({ identifier: "test@test.com" });
      expect(res.status).toBe(401);
    });

    it("merchant token cannot use POS visit", async () => {
      const res = await request(app)
        .post("/pos/visit")
        .set(merchAuth)
        .send({ identifier: "test@test.com" });
      // Merchant tokens don't have pos:1 flag — may get 400, 401, or 403
      expect([400, 401, 403]).toContain(res.status);
    });
  });

  describe("POST /pos/reward validation", () => {
    it("rejects unauthenticated", async () => {
      const res = await request(app).post("/pos/reward").send({ identifier: "test@test.com" });
      expect(res.status).toBe(401);
    });
  });

  describe("POS bundles validation", () => {
    it("GET /pos/bundles/consumer rejects without identifier", async () => {
      // Even with merchant auth (which won't have POS flag), should reject
      const res = await request(app).get("/pos/bundles/consumer").set(merchAuth);
      expect([400, 401, 403]).toContain(res.status);
    });

    it("POST /pos/bundles/sell rejects unauthenticated", async () => {
      const res = await request(app)
        .post("/pos/bundles/sell")
        .send({ bundleId: 1 });
      expect(res.status).toBe(401);
    });

    it("POST /pos/bundles/:instanceId/redeem rejects unauthenticated", async () => {
      const res = await request(app).post("/pos/bundles/999/redeem");
      expect(res.status).toBe(401);
    });
  });
});
