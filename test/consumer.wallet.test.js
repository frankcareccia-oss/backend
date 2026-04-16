// tests/consumer.wallet.test.js — Consumer wallet and promotions

const request = require("supertest");
const { getApp, consumerToken, authHeader } = require("./helpers/setup");
const { prisma, resetDb, createConsumer, createMerchant } = require("./helpers/seed");
const { encrypt } = require("../src/utils/encrypt");

let app;
let auth;
let consumer;

beforeAll(async () => {
  app = getApp();
  await resetDb();

  consumer = await createConsumer({ phoneE164: "+14085551212" });
  const token = consumerToken({ consumerId: consumer.id, phone: consumer.phoneE164 });
  auth = authHeader(token);
}, 15000);

afterAll(async () => {
  await prisma.$disconnect();
});

describe("Consumer Wallet", () => {
  describe("GET /me/summary", () => {
    it("returns summary counts", async () => {
      const res = await request(app).get("/me/summary").set(auth);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("rewardsReady");
      expect(res.body).toHaveProperty("rewardsRedeemed");
      expect(res.body).toHaveProperty("programsJoined");
      expect(typeof res.body.rewardsReady).toBe("number");
    });

    it("returns hasAccountIssue false when no duplicate alerts", async () => {
      const res = await request(app).get("/me/summary").set(auth);
      expect(res.status).toBe(200);
      expect(res.body.hasAccountIssue).toBe(false);
    });

    it("returns hasAccountIssue true when pending duplicate alert exists", async () => {
      // Need a merchant + posConnection to create the alert
      const merchant = await createMerchant({ name: "Dup Alert Shop" });
      const posConn = await prisma.posConnection.create({
        data: {
          merchantId: merchant.id,
          posType: "square",
          status: "active",
          accessTokenEnc: encrypt("sq-test-token"),
          externalMerchantId: "SQ_DUP_SUMMARY",
        },
      });

      await prisma.duplicateCustomerAlert.create({
        data: {
          merchantId: merchant.id,
          posConnectionId: posConn.id,
          phoneE164: consumer.phoneE164,
          squareCustomerIds: [
            { id: "SQ_CUST_1", name: "Test One", phone: consumer.phoneE164 },
            { id: "SQ_CUST_2", name: "Test Two", phone: consumer.phoneE164 },
          ],
          status: "pending",
        },
      });

      const res = await request(app).get("/me/summary").set(auth);
      expect(res.status).toBe(200);
      expect(res.body.hasAccountIssue).toBe(true);
    });

    it("returns hasAccountIssue false when alert is resolved", async () => {
      // Clean up any pending alerts from prior tests
      await prisma.duplicateCustomerAlert.deleteMany({ where: { phoneE164: consumer.phoneE164 } });

      const merchant = await createMerchant({ name: "Resolved Alert Shop" });
      const posConn = await prisma.posConnection.create({
        data: {
          merchantId: merchant.id,
          posType: "square",
          status: "active",
          accessTokenEnc: encrypt("sq-test-token"),
          externalMerchantId: "SQ_DUP_RESOLVED",
        },
      });

      await prisma.duplicateCustomerAlert.create({
        data: {
          merchantId: merchant.id,
          posConnectionId: posConn.id,
          phoneE164: consumer.phoneE164,
          squareCustomerIds: [
            { id: "SQ_CUST_1", name: "Test One", phone: consumer.phoneE164 },
            { id: "SQ_CUST_2", name: "Test Two", phone: consumer.phoneE164 },
          ],
          status: "resolved",
          resolvedAt: new Date(),
        },
      });

      const res = await request(app).get("/me/summary").set(auth);
      expect(res.status).toBe(200);
      expect(res.body.hasAccountIssue).toBe(false);
    });

    it("rejects unauthenticated", async () => {
      const res = await request(app).get("/me/summary");
      expect(res.status).toBe(401);
    });
  });

  describe("GET /me/wallet", () => {
    it("returns wallet with active filter", async () => {
      const res = await request(app).get("/me/wallet?status=active").set(auth);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("wallet");
      expect(Array.isArray(res.body.wallet)).toBe(true);
    });

    it("returns wallet with redeemed filter", async () => {
      const res = await request(app).get("/me/wallet?status=redeemed").set(auth);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.wallet)).toBe(true);
    });

    it("rejects invalid status filter", async () => {
      const res = await request(app).get("/me/wallet?status=bogus").set(auth);
      expect(res.status).toBe(400);
    });
  });

  describe("GET /me/wallet/giftcards", () => {
    let merchant, posConn, giftCard;

    beforeAll(async () => {
      merchant = await createMerchant({ name: "GC Wallet Shop" });
      posConn = await prisma.posConnection.create({
        data: {
          merchantId: merchant.id,
          posType: "square",
          status: "active",
          accessTokenEnc: encrypt("sq-test-token"),
          externalMerchantId: "SQ_WALLET_1",
        },
      });
      giftCard = await prisma.consumerGiftCard.create({
        data: {
          consumerId: consumer.id,
          posConnectionId: posConn.id,
          squareGiftCardId: "gftc:test123",
          squareGan: "7783320000001234",
          active: true,
        },
      });

      // Mock fetch for Square balance API
      global._origFetch = global.fetch;
      global.fetch = jest.fn(async (url) => {
        if (url.includes("/gift-cards/gftc:test123")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              gift_card: {
                id: "gftc:test123",
                balance_money: { amount: 500, currency: "USD" },
              },
            }),
          };
        }
        return { ok: false, status: 404, json: async () => ({ errors: [{ detail: "not found" }] }) };
      });
    });

    afterAll(() => {
      global.fetch = global._origFetch;
    });

    it("returns gift cards with live balance", async () => {
      const res = await request(app).get("/me/wallet/giftcards").set(auth);
      expect(res.status).toBe(200);
      expect(res.body.giftCards).toHaveLength(1);
      expect(res.body.giftCards[0]).toMatchObject({
        id: giftCard.id,
        merchantId: merchant.id,
        merchantName: "GC Wallet Shop",
        ganLast4: "1234",
        balanceCents: 500,
        currency: "USD",
      });
    });

    it("rejects unauthenticated", async () => {
      const res = await request(app).get("/me/wallet/giftcards");
      expect(res.status).toBe(401);
    });
  });

  describe("POST /me/wallet/giftcards/:id/present", () => {
    let merchant, posConn, giftCard;

    beforeAll(async () => {
      merchant = await createMerchant({ name: "GC Present Shop" });
      posConn = await prisma.posConnection.create({
        data: {
          merchantId: merchant.id,
          posType: "square",
          status: "active",
          accessTokenEnc: encrypt("sq-test-token-2"),
          externalMerchantId: "SQ_PRESENT_1",
        },
      });
      giftCard = await prisma.consumerGiftCard.create({
        data: {
          consumerId: consumer.id,
          posConnectionId: posConn.id,
          squareGiftCardId: "gftc:present456",
          squareGan: "7783320000005678",
          active: true,
        },
      });

      global._origFetch2 = global.fetch;
      global.fetch = jest.fn(async (url) => {
        if (url.includes("/gift-cards/gftc:present456")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              gift_card: {
                id: "gftc:present456",
                balance_money: { amount: 500, currency: "USD" },
              },
            }),
          };
        }
        return { ok: false, status: 404, json: async () => ({ errors: [{ detail: "not found" }] }) };
      });
    });

    afterAll(() => {
      global.fetch = global._origFetch2;
    });

    it("returns GAN and balance for barcode display", async () => {
      const res = await request(app)
        .post(`/me/wallet/giftcards/${giftCard.id}/present`)
        .set(auth);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        gan: "7783320000005678",
        ganLast4: "5678",
        balanceCents: 500,
        currency: "USD",
        merchantId: merchant.id,
      });

      // Verify PRESENTED event was logged
      const event = await prisma.giftCardEvent.findFirst({
        where: { giftCardId: giftCard.id, eventType: "PRESENTED" },
      });
      expect(event).toBeTruthy();
      expect(event.amountCents).toBe(500);
      expect(event.ganLast4).toBe("5678");
    });

    it("rejects when gift card not found", async () => {
      const res = await request(app)
        .post("/me/wallet/giftcards/99999/present")
        .set(auth);
      expect(res.status).toBe(404);
    });

    it("rejects unauthenticated", async () => {
      const res = await request(app)
        .post(`/me/wallet/giftcards/${giftCard.id}/present`);
      expect(res.status).toBe(401);
    });
  });
});

describe("Consumer Promotions", () => {
  describe("GET /me/promotions", () => {
    it("returns available promotions", async () => {
      const res = await request(app).get("/me/promotions").set(auth);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("promotions");
      expect(Array.isArray(res.body.promotions)).toBe(true);
    });
  });

  describe("POST /me/promotions/:id/join", () => {
    it("rejects joining non-existent promotion", async () => {
      const res = await request(app).post("/me/promotions/99999/join").set(auth);
      expect([404, 422]).toContain(res.status);
    });
  });

  describe("POST /me/wallet/:id/redeem-request", () => {
    it("rejects non-existent entitlement", async () => {
      const res = await request(app).post("/me/wallet/99999/redeem-request").set(auth);
      expect(res.status).toBe(404);
    });
  });
});

describe("Consumer Reward Activation", () => {
  let activateMerchant, activateStore, cloverConn, promo, entitlement, rewardDiscount;

  // Mock fetch for Clover API
  beforeAll(async () => {
    global._origFetchActivate = global.fetch;
    global.fetch = jest.fn(async (url, opts) => {
      if (url.includes("/discounts") && opts?.method === "POST") {
        return {
          ok: true, status: 200,
          json: async () => ({ id: "TMPL_TEST_123", name: JSON.parse(opts.body).name, amount: JSON.parse(opts.body).amount }),
        };
      }
      return { ok: false, status: 404, json: async () => ({ message: "Not found" }) };
    });

    activateMerchant = await createMerchant({ name: "Activate Test Shop" });
    activateStore = await prisma.store.create({
      data: { merchantId: activateMerchant.id, name: "Activate Store", phoneRaw: "555-9999" },
    });
    cloverConn = await prisma.posConnection.create({
      data: {
        merchantId: activateMerchant.id,
        posType: "clover",
        status: "active",
        accessTokenEnc: encrypt("clover-activate-token"),
        externalMerchantId: "CLO_ACTIVATE_1",
      },
    });
    promo = await prisma.promotion.create({
      data: {
        merchantId: activateMerchant.id,
        name: "Activate Promo",
        mechanic: "stamps",
        threshold: 5,
        repeatable: true,
        rewardType: "discount_fixed",
        rewardValue: 300,
        status: "active",
      },
    });

    // Create entitlement + PosRewardDiscount (simulating a milestone)
    const progress = await prisma.consumerPromoProgress.create({
      data: {
        consumerId: consumer.id, promotionId: promo.id, merchantId: activateMerchant.id,
        stampCount: 0, lifetimeEarned: 5, lastEarnedAt: new Date(),
      },
    });
    const redemption = await prisma.promoRedemption.create({
      data: {
        progressId: progress.id,
        promotionId: promo.id, consumerId: consumer.id, merchantId: activateMerchant.id,
        pointsDecremented: 5, balanceBefore: 5, balanceAfter: 0,
        status: "granted", grantedAt: new Date(),
      },
    });
    entitlement = await prisma.entitlement.create({
      data: {
        consumerId: consumer.id, merchantId: activateMerchant.id,
        storeId: activateStore.id, type: "reward", sourceId: redemption.id,
        status: "active", metadataJson: { displayLabel: "$3.00 off" },
      },
    });
    rewardDiscount = await prisma.posRewardDiscount.create({
      data: {
        consumerId: consumer.id, merchantId: activateMerchant.id,
        posConnectionId: cloverConn.id, entitlementId: entitlement.id,
        promotionId: promo.id, discountName: "PerkValet Reward — $3.00 off",
        amountCents: 300, rewardType: "discount_fixed", status: "earned",
        expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
      },
    });
  });

  afterAll(() => {
    global.fetch = global._origFetchActivate;
  });

  describe("POST /me/wallet/:id/activate", () => {
    it("activates a Clover reward — creates discount template", async () => {
      const res = await request(app)
        .post(`/me/wallet/${entitlement.id}/activate`)
        .set(auth);

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.activated).toBe(true);
      expect(res.body.type).toBe("discount");
      expect(res.body.discountName).toContain("PerkValet");
      expect(res.body.instructions).toContain("associate");

      // Verify PosRewardDiscount was updated
      const updated = await prisma.posRewardDiscount.findUnique({ where: { id: rewardDiscount.id } });
      expect(updated.status).toBe("activated");
      expect(updated.cloverDiscountId).toBe("TMPL_TEST_123");
    });

    it("rejects activating an already activated reward", async () => {
      const res = await request(app)
        .post(`/me/wallet/${entitlement.id}/activate`)
        .set(auth);

      // No "earned" reward left — should fail
      expect(res.status).toBe(400);
    });

    it("rejects non-existent entitlement", async () => {
      const res = await request(app)
        .post("/me/wallet/99999/activate")
        .set(auth);

      expect(res.status).toBe(404);
    });

    it("rejects unauthenticated", async () => {
      const res = await request(app)
        .post(`/me/wallet/${entitlement.id}/activate`);

      expect(res.status).toBe(401);
    });
  });
});
