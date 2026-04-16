// test/consumer.checkin.test.js — Consumer check-in + nearby stores

"use strict";

const request = require("supertest");
const { getApp, consumerToken, authHeader } = require("./helpers/setup");
const { prisma, resetDb, createConsumer, createMerchant } = require("./helpers/seed");
const { encrypt } = require("../src/utils/encrypt");

let app, auth, consumer, merchant, store, posConn;

beforeAll(async () => {
  app = getApp();
  await resetDb();

  merchant = await createMerchant({ name: "Checkin Coffee" });
  store = await prisma.store.create({
    data: {
      merchantId: merchant.id,
      name: "Downtown Location",
      phoneRaw: "555-0100",
      latitude: 37.7749,
      longitude: -122.4194,
      geofenceRadiusMeters: 150,
    },
  });

  consumer = await createConsumer({ phoneE164: "+14085551234" });
  const token = consumerToken({ consumerId: consumer.id, phone: consumer.phoneE164 });
  auth = authHeader(token);

  // Create an active promotion
  await prisma.promotion.create({
    data: {
      merchantId: merchant.id,
      name: "Buy 5 Get $3 Off",
      mechanic: "stamps",
      threshold: 5,
      repeatable: true,
      rewardType: "discount_fixed",
      rewardValue: 300,
      status: "active",
    },
  });

  // Create Clover POS connection
  posConn = await prisma.posConnection.create({
    data: {
      merchantId: merchant.id,
      posType: "clover",
      status: "active",
      accessTokenEnc: encrypt("test-token"),
      externalMerchantId: "CLO_CHECKIN_1",
    },
  });
}, 15000);

afterAll(async () => {
  await prisma.$disconnect();
});

describe("Consumer Check-in", () => {
  describe("POST /consumer/checkin", () => {
    it("creates a check-in and returns reward status", async () => {
      const res = await request(app)
        .post("/consumer/checkin")
        .set(auth)
        .send({ storeId: store.id, triggeredBy: "geofence" });

      expect(res.status).toBe(200);
      expect(res.body.storeName).toBe("Downtown Location");
      expect(res.body.merchantName).toBe("Checkin Coffee");
      expect(res.body.checkinId).toBeDefined();
      expect(res.body.programs).toBeDefined();
      expect(res.body.pendingRewards).toBeDefined();
      expect(Array.isArray(res.body.programs)).toBe(true);
      expect(Array.isArray(res.body.pendingRewards)).toBe(true);
    });

    it("suppresses duplicate check-in within 2 hours", async () => {
      const res = await request(app)
        .post("/consumer/checkin")
        .set(auth)
        .send({ storeId: store.id, triggeredBy: "geofence" });

      expect(res.status).toBe(200);
      expect(res.body.duplicate).toBe(true);
      expect(res.body.checkinId).toBeUndefined();
      // Still returns reward status
      expect(res.body.storeName).toBe("Downtown Location");
      expect(res.body.programs).toBeDefined();
    });

    it("returns pending Clover reward when one exists", async () => {
      // Create a pending reward
      await prisma.posRewardDiscount.create({
        data: {
          consumerId: consumer.id,
          merchantId: merchant.id,
          posConnectionId: posConn.id,
          promotionId: 1,
          discountName: "PerkValet Reward — $3.00 off",
          amountCents: 300,
          rewardType: "discount_fixed",
          status: "earned",
        },
      });

      // Use manual trigger to avoid dedup (different triggeredBy doesn't matter — same store dedup)
      // Wait for dedup window or use a different store
      const store2 = await prisma.store.create({
        data: {
          merchantId: merchant.id,
          name: "Uptown Location",
          phoneRaw: "555-0200",
          latitude: 37.7850,
          longitude: -122.4100,
        },
      });

      const res = await request(app)
        .post("/consumer/checkin")
        .set(auth)
        .send({ storeId: store2.id, triggeredBy: "manual" });

      expect(res.status).toBe(200);
      expect(res.body.pendingRewards.length).toBeGreaterThanOrEqual(1);

      const reward = res.body.pendingRewards.find(r => r.type === "discount");
      expect(reward).toBeDefined();
      expect(reward.description).toBe("PerkValet Reward — $3.00 off");
      expect(reward.value).toBe(300);
      expect(reward.activatable).toBe(true);
    });

    it("returns empty pendingRewards when none exist", async () => {
      // Clean up rewards
      await prisma.posRewardDiscount.deleteMany({ where: { consumerId: consumer.id } });

      const store3 = await prisma.store.create({
        data: {
          merchantId: merchant.id,
          name: "Midtown Location",
          phoneRaw: "555-0300",
        },
      });

      const res = await request(app)
        .post("/consumer/checkin")
        .set(auth)
        .send({ storeId: store3.id, triggeredBy: "qr" });

      expect(res.status).toBe(200);
      expect(res.body.pendingRewards).toEqual([]);
    });

    it("rejects invalid storeId", async () => {
      const res = await request(app)
        .post("/consumer/checkin")
        .set(auth)
        .send({ storeId: 99999, triggeredBy: "manual" });

      expect(res.status).toBe(404);
    });

    it("rejects invalid triggeredBy", async () => {
      const res = await request(app)
        .post("/consumer/checkin")
        .set(auth)
        .send({ storeId: store.id, triggeredBy: "magic" });

      expect(res.status).toBe(400);
    });

    it("rejects unauthenticated", async () => {
      const res = await request(app)
        .post("/consumer/checkin")
        .send({ storeId: store.id, triggeredBy: "manual" });

      expect(res.status).toBe(401);
    });
  });

  describe("GET /consumer/stores/nearby", () => {
    it("returns stores within radius", async () => {
      // Query near the Downtown Location (37.7749, -122.4194)
      const res = await request(app)
        .get("/consumer/stores/nearby?lat=37.7749&lng=-122.4194&radiusMeters=500")
        .set(auth);

      expect(res.status).toBe(200);
      expect(res.body.stores).toBeDefined();
      expect(Array.isArray(res.body.stores)).toBe(true);

      const downtown = res.body.stores.find(s => s.storeName === "Downtown Location");
      expect(downtown).toBeDefined();
      expect(downtown.hasActivePromo).toBe(true);
      expect(downtown.distance).toBeLessThan(500);
    });

    it("returns empty when no stores nearby", async () => {
      // Query from far away (New York)
      const res = await request(app)
        .get("/consumer/stores/nearby?lat=40.7128&lng=-74.0060&radiusMeters=500")
        .set(auth);

      expect(res.status).toBe(200);
      expect(res.body.stores).toEqual([]);
    });

    it("rejects missing coordinates", async () => {
      const res = await request(app)
        .get("/consumer/stores/nearby")
        .set(auth);

      expect(res.status).toBe(400);
    });

    it("rejects unauthenticated", async () => {
      const res = await request(app)
        .get("/consumer/stores/nearby?lat=37.7749&lng=-122.4194");

      expect(res.status).toBe(401);
    });
  });
});
