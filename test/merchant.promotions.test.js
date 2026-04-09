// tests/merchant.promotions.test.js — Promotion CRUD and lifecycle

const request = require("supertest");
const { getApp, merchantToken, authHeader } = require("./helpers/setup");
const { prisma, resetDb, createMerchant, createUser, addMerchantUser } = require("./helpers/seed");

let app;
let auth;

beforeAll(async () => {
  app = getApp();
  await resetDb();

  const merchant = await createMerchant({ name: "Promo Test Shop" });
  const user = await createUser({ email: "promo-test@perkvalet.org" });
  await addMerchantUser({ merchantId: merchant.id, userId: user.id, role: "merchant_admin" });

  const token = merchantToken({ userId: user.id, merchantId: merchant.id });
  auth = authHeader(token);
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("Merchant Promotions", () => {
  let promoId;

  describe("POST /merchant/promotions", () => {
    it("creates a stamp promotion", async () => {
      const res = await request(app)
        .post("/merchant/promotions")
        .set(auth)
        .send({
          name: "Test Loyalty Card",
          mechanic: "stamps",
          threshold: 5,
          rewardType: "custom",
          rewardNote: "Free test item",
        });
      expect(res.status).toBe(201);
      expect(res.body.promotion).toHaveProperty("id");
      expect(res.body.promotion.name).toBe("Test Loyalty Card");
      expect(res.body.promotion.status).toBe("draft");
      expect(res.body.promotion.threshold).toBe(5);
      expect(res.body.promotion.repeatable).toBe(true);
      promoId = res.body.promotion.id;
    });

    it("rejects missing required fields", async () => {
      const res = await request(app)
        .post("/merchant/promotions")
        .set(auth)
        .send({ name: "Incomplete" });
      expect(res.status).toBe(400);
    });
  });

  describe("GET /merchant/promotions", () => {
    it("lists promotions", async () => {
      const res = await request(app).get("/merchant/promotions").set(auth);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("promotions");
      expect(Array.isArray(res.body.promotions)).toBe(true);
    });

    it("filters by status", async () => {
      const res = await request(app).get("/merchant/promotions?status=draft").set(auth);
      expect(res.status).toBe(200);
      res.body.promotions.forEach(p => expect(p.status).toBe("draft"));
    });
  });

  describe("PATCH /merchant/promotions/:id", () => {
    it("updates promotion name", async () => {
      const res = await request(app)
        .patch(`/merchant/promotions/${promoId}`)
        .set(auth)
        .send({ name: "Updated Loyalty Card" });
      expect(res.status).toBe(200);
      expect(res.body.promotion.name).toBe("Updated Loyalty Card");
    });
  });

  describe("Promotion lifecycle", () => {
    it("transitions draft → staged", async () => {
      const res = await request(app)
        .patch(`/merchant/promotions/${promoId}`)
        .set(auth)
        .send({ status: "staged" });
      expect(res.status).toBe(200);
      expect(res.body.promotion.status).toBe("staged");
    });

    it("transitions staged → active", async () => {
      const res = await request(app)
        .patch(`/merchant/promotions/${promoId}`)
        .set(auth)
        .send({ status: "active" });
      expect(res.status).toBe(200);
      expect(res.body.promotion.status).toBe("active");
      expect(res.body.promotion.firstActivatedAt).toBeTruthy();
    });

    it("rejects invalid transition (active → draft)", async () => {
      const res = await request(app)
        .patch(`/merchant/promotions/${promoId}`)
        .set(auth)
        .send({ status: "draft" });
      expect(res.status).toBe(409);
    });

    it("transitions active → paused", async () => {
      const res = await request(app)
        .patch(`/merchant/promotions/${promoId}`)
        .set(auth)
        .send({ status: "paused" });
      expect(res.status).toBe(200);
      expect(res.body.promotion.status).toBe("paused");
    });
  });
});
