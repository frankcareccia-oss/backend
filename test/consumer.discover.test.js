// test/consumer.discover.test.js — Discover + enrollment

"use strict";

const request = require("supertest");
const { getApp, consumerToken, authHeader } = require("./helpers/setup");
const { prisma, resetDb, createConsumer, createMerchant } = require("./helpers/seed");

let app, auth, consumer, merchant, store, promo;

beforeAll(async () => {
  app = getApp();
  await resetDb();

  merchant = await createMerchant({ name: "Discover Coffee" });
  store = await prisma.store.create({
    data: {
      merchantId: merchant.id, name: "Downtown Cafe", phoneRaw: "555-0100",
      latitude: 37.7749, longitude: -122.4194,
      discoverability: true, category: "cafe",
    },
  });
  promo = await prisma.promotion.create({
    data: {
      merchantId: merchant.id, name: "Buy 5 Get $3 Off",
      mechanic: "stamps", threshold: 5, repeatable: true,
      rewardType: "discount_fixed", rewardValue: 300, status: "active",
      rewardExpiryDays: 90,
    },
  });

  consumer = await createConsumer({ phoneE164: "+14085551000" });
  const token = consumerToken({ consumerId: consumer.id, phone: consumer.phoneE164 });
  auth = authHeader(token);
}, 15000);

afterAll(async () => { await prisma.$disconnect(); });

describe("Discover", () => {
  describe("GET /consumer/discover", () => {
    it("returns nearby merchants with promo data", async () => {
      const res = await request(app)
        .get("/consumer/discover?lat=37.7749&lng=-122.4194&radiusMeters=5000")
        .set(auth);

      expect(res.status).toBe(200);
      expect(res.body.merchants).toBeDefined();
      expect(res.body.merchants.length).toBeGreaterThanOrEqual(1);

      const m = res.body.merchants.find(x => x.storeName === "Downtown Cafe");
      expect(m).toBeDefined();
      expect(m.merchantName).toBe("Discover Coffee");
      expect(m.category).toBe("cafe");
      expect(m.consumerRelationship.enrolled).toBe(false);
      expect(m.availablePromotions.length).toBeGreaterThanOrEqual(1);
      expect(m.availablePromotions[0].name).toBe("Buy 5 Get $3 Off");
      expect(m.availablePromotions[0].stampThreshold).toBe(5);
    });

    it("excludes non-discoverable stores", async () => {
      const hiddenStore = await prisma.store.create({
        data: {
          merchantId: merchant.id, name: "Hidden Store", phoneRaw: "555-0200",
          latitude: 37.7750, longitude: -122.4195, discoverability: false,
        },
      });

      const res = await request(app)
        .get("/consumer/discover?lat=37.7749&lng=-122.4194&radiusMeters=5000")
        .set(auth);

      const hidden = res.body.merchants.find(x => x.storeName === "Hidden Store");
      expect(hidden).toBeUndefined();
    });

    it("shows enrollment status for enrolled consumer", async () => {
      // Enroll consumer
      await prisma.consumerPromoProgress.create({
        data: {
          consumerId: consumer.id, promotionId: promo.id, merchantId: merchant.id,
          stampCount: 3, lifetimeEarned: 3, lastEarnedAt: new Date(),
        },
      });

      const res = await request(app)
        .get("/consumer/discover?lat=37.7749&lng=-122.4194&radiusMeters=5000")
        .set(auth);

      const m = res.body.merchants.find(x => x.storeName === "Downtown Cafe");
      expect(m.consumerRelationship.enrolled).toBe(true);
      expect(m.consumerRelationship.stampCount).toBe(3);
      expect(m.consumerRelationship.milestone).toBe(5);
      expect(m.consumerRelationship.stampsToNext).toBe(2);
      expect(m.consumerRelationship.progressPercent).toBe(60);
    });

    it("returns empty when no stores nearby", async () => {
      const res = await request(app)
        .get("/consumer/discover?lat=40.7128&lng=-74.0060&radiusMeters=1000")
        .set(auth);

      expect(res.status).toBe(200);
      expect(res.body.merchants).toEqual([]);
    });

    it("rejects unauthenticated", async () => {
      const res = await request(app)
        .get("/consumer/discover?lat=37.7749&lng=-122.4194");
      expect(res.status).toBe(401);
    });
  });

  describe("POST /consumer/promotions/enroll", () => {
    let enrollPromo;

    beforeAll(async () => {
      const enrollMerchant = await createMerchant({ name: "Enroll Shop" });
      enrollPromo = await prisma.promotion.create({
        data: {
          merchantId: enrollMerchant.id, name: "Enroll Test Promo",
          mechanic: "stamps", threshold: 10, repeatable: true,
          rewardType: "discount_fixed", rewardValue: 500, status: "active",
        },
      });
    });

    it("enrolls consumer in promotion", async () => {
      const res = await request(app)
        .post("/consumer/promotions/enroll")
        .set(auth)
        .send({ promotionId: enrollPromo.id, triggeredBy: "discover" });

      expect(res.status).toBe(200);
      expect(res.body.enrolled).toBe(true);
      expect(res.body.stampCount).toBe(0);
      expect(res.body.milestone).toBe(10);
      expect(res.body.promotionName).toBe("Enroll Test Promo");
    });

    it("rejects duplicate enrollment", async () => {
      const res = await request(app)
        .post("/consumer/promotions/enroll")
        .set(auth)
        .send({ promotionId: enrollPromo.id });

      expect(res.status).toBe(409);
    });

    it("rejects non-existent promotion", async () => {
      const res = await request(app)
        .post("/consumer/promotions/enroll")
        .set(auth)
        .send({ promotionId: 99999 });

      expect(res.status).toBe(404);
    });

    it("rejects unauthenticated", async () => {
      const res = await request(app)
        .post("/consumer/promotions/enroll")
        .send({ promotionId: enrollPromo.id });

      expect(res.status).toBe(401);
    });
  });
});
