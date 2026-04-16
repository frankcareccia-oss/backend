// test/square-wave2.test.js — Wave 2: Square-specific verification

"use strict";

const request = require("supertest");
const { getApp, consumerToken, authHeader } = require("./helpers/setup");
const { prisma, resetDb, createConsumer, createMerchant } = require("./helpers/seed");
const { encrypt } = require("../src/utils/encrypt");

let app, auth, consumer, merchant, store, sqConn, promo;

beforeAll(async () => {
  app = getApp();
  await resetDb();

  merchant = await createMerchant({ name: "Square Wave2 Shop" });
  store = await prisma.store.create({
    data: { merchantId: merchant.id, name: "Square Store", phoneRaw: "555-0001" },
  });
  sqConn = await prisma.posConnection.create({
    data: {
      merchantId: merchant.id, posType: "square", status: "active",
      accessTokenEnc: encrypt("sq-wave2-token"), externalMerchantId: "SQ_WAVE2",
    },
  });
  promo = await prisma.promotion.create({
    data: {
      merchantId: merchant.id, name: "Square Loyalty",
      mechanic: "stamps", threshold: 3, repeatable: true,
      rewardType: "discount_fixed", rewardValue: 500, status: "active",
      rewardExpiryDays: 60,
    },
  });

  consumer = await createConsumer({ phoneE164: "+14085552222" });
  const token = consumerToken({ consumerId: consumer.id, phone: consumer.phoneE164 });
  auth = authHeader(token);
}, 15000);

afterAll(async () => { await prisma.$disconnect(); });

describe("Wave 2: Square Activation + Redemption", () => {
  let entitlement, giftCard;

  beforeAll(async () => {
    // Simulate a milestone: create entitlement + gift card (as if pos.stamps.js ran)
    const progress = await prisma.consumerPromoProgress.create({
      data: {
        consumerId: consumer.id, promotionId: promo.id, merchantId: merchant.id,
        stampCount: 0, lifetimeEarned: 3, lastEarnedAt: new Date(),
      },
    });
    const redemption = await prisma.promoRedemption.create({
      data: {
        progressId: progress.id, promotionId: promo.id,
        consumerId: consumer.id, merchantId: merchant.id,
        pointsDecremented: 3, balanceBefore: 3, balanceAfter: 0,
        status: "granted", grantedAt: new Date(),
      },
    });
    entitlement = await prisma.entitlement.create({
      data: {
        consumerId: consumer.id, merchantId: merchant.id, storeId: store.id,
        type: "reward", sourceId: redemption.id, status: "active",
        metadataJson: { displayLabel: "$5.00 off" },
      },
    });
    giftCard = await prisma.consumerGiftCard.create({
      data: {
        consumerId: consumer.id, posConnectionId: sqConn.id,
        squareGiftCardId: "gftc:wave2test", squareGan: "7783320000009999",
        active: true, expiresAt: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000),
      },
    });
  });

  it("activates a Square reward (flags entitlement metadata)", async () => {
    const res = await request(app)
      .post(`/me/wallet/${entitlement.id}/activate`)
      .set(auth);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.type).toBe("giftcard");
    expect(res.body.instructions).toContain("barcode");

    // Check entitlement metadata was updated
    const updated = await prisma.entitlement.findUnique({ where: { id: entitlement.id } });
    expect(updated.metadataJson.activatedAt).toBeDefined();
  });

  it("check-in shows Square gift card as pending reward", async () => {
    const res = await request(app)
      .post("/consumer/checkin")
      .set(auth)
      .send({ storeId: store.id, triggeredBy: "manual" });

    expect(res.status).toBe(200);
    expect(res.body.pendingRewards.length).toBeGreaterThanOrEqual(1);
    const gcReward = res.body.pendingRewards.find(r => r.type === "giftcard");
    expect(gcReward).toBeDefined();
  });

  it("discover shows Square merchant with enrolled status", async () => {
    // Add coordinates to the store
    await prisma.store.update({
      where: { id: store.id },
      data: { latitude: 37.7749, longitude: -122.4194, discoverability: true },
    });

    const res = await request(app)
      .get("/consumer/discover?lat=37.7749&lng=-122.4194&radiusMeters=5000")
      .set(auth);

    expect(res.status).toBe(200);
    const m = res.body.merchants.find(x => x.merchantName === "Square Wave2 Shop");
    expect(m).toBeDefined();
    expect(m.consumerRelationship.enrolled).toBe(true);
    expect(m.consumerRelationship.rewardReady).toBe(true);
  });

  it("expiry cron marks expired Square gift card inactive", async () => {
    // Create a separate merchant + connection for expiry test to avoid unique constraint
    const expMerchant = await createMerchant({ name: "Expiry Sq Test" });
    const expConn = await prisma.posConnection.create({
      data: { merchantId: expMerchant.id, posType: "square", status: "active", accessTokenEnc: encrypt("sq-exp-token"), externalMerchantId: "SQ_EXP_1" },
    });
    const expiredCard = await prisma.consumerGiftCard.create({
      data: {
        consumerId: consumer.id, posConnectionId: expConn.id,
        squareGiftCardId: "gftc:expired999", squareGan: "7783320000008888",
        active: true, expiresAt: new Date(Date.now() - 1000),
      },
    });

    // Mock fetch for Square API
    const origFetch = global.fetch;
    global.fetch = jest.fn(async (url, opts) => {
      if (url.includes("/gift-cards/gftc:expired999") && !opts?.method) {
        return { ok: true, json: async () => ({ gift_card: { balance_money: { amount: 300, currency: "USD" } } }) };
      }
      if (url.includes("/gift-cards/activities")) {
        return { ok: true, json: async () => ({ gift_card_activity: {} }) };
      }
      return { ok: true, json: async () => ({}) };
    });

    const { expireSquareGiftCards } = require("../src/cron/reward.expiry.cron");
    await expireSquareGiftCards(new Date());

    global.fetch = origFetch;

    const updated = await prisma.consumerGiftCard.findUnique({ where: { id: expiredCard.id } });
    expect(updated.active).toBe(false);

    // Verify audit event
    const event = await prisma.giftCardEvent.findFirst({
      where: { giftCardId: expiredCard.id, eventType: "ADJUST" },
    });
    expect(event).toBeTruthy();
    expect(event.payloadJson.reason).toBe("promotion_expired");
  });
});
