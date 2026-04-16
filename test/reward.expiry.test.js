// test/reward.expiry.test.js — Reward expiry notifications + cleanup

"use strict";

const { prisma, resetDb, createMerchant, createConsumer } = require("./helpers/seed");
const { encrypt } = require("../src/utils/encrypt");

let merchant, consumer, posConn;

// Mock fetch for Square/Clover API calls
beforeAll(async () => {
  global._origFetch = global.fetch;
  global.fetch = jest.fn(async (url, opts) => {
    // Mock all external API calls as successful
    if (url.includes("/gift-cards/") && !opts?.method) {
      // GET gift card balance
      return { ok: true, json: async () => ({ gift_card: { balance_money: { amount: 500, currency: "USD" } } }) };
    }
    if (url.includes("/gift-cards/activities")) {
      return { ok: true, json: async () => ({ gift_card_activity: { type: opts?.body?.includes("DEACTIVATE") ? "DEACTIVATE" : "ADJUST_DECREMENT" } }) };
    }
    if (url.includes("/discounts/") && opts?.method === "DELETE") {
      return { ok: true, json: async () => ({}) };
    }
    return { ok: true, json: async () => ({}) };
  });
});

afterAll(async () => {
  global.fetch = global._origFetch;
  await prisma.$disconnect();
});

beforeEach(async () => {
  await resetDb();

  merchant = await createMerchant({ name: "Expiry Test Shop" });
  consumer = await prisma.consumer.create({
    data: { phoneE164: "+14085557777", firstName: "Expiry", lastName: "Tester", email: "expiry@test.com" },
  });
  posConn = await prisma.posConnection.create({
    data: {
      merchantId: merchant.id, posType: "clover", status: "active",
      accessTokenEnc: encrypt("test-token"), externalMerchantId: "CLO_EXPIRY_1",
    },
  });
});

describe("Reward Expiry", () => {
  const { expireCloverRewards, expireSquareGiftCards, sendExpiryNotifications } = require("../src/cron/reward.expiry.cron");

  describe("expireCloverRewards", () => {
    it("marks expired Clover rewards and deletes templates", async () => {
      const reward = await prisma.posRewardDiscount.create({
        data: {
          consumerId: consumer.id, merchantId: merchant.id, posConnectionId: posConn.id,
          promotionId: 1, discountName: "Expired Reward", amountCents: 300,
          rewardType: "discount_fixed", status: "activated",
          cloverDiscountId: "TMPL_EXPIRED",
          expiresAt: new Date(Date.now() - 1000), // already expired
        },
      });

      await expireCloverRewards(new Date());

      const updated = await prisma.posRewardDiscount.findUnique({ where: { id: reward.id } });
      expect(updated.status).toBe("expired");

      // Verify DELETE was called
      const deleteCalls = global.fetch.mock.calls.filter(c => c[1]?.method === "DELETE");
      expect(deleteCalls.length).toBeGreaterThanOrEqual(1);
    });

    it("does not expire rewards that haven't reached expiresAt", async () => {
      const reward = await prisma.posRewardDiscount.create({
        data: {
          consumerId: consumer.id, merchantId: merchant.id, posConnectionId: posConn.id,
          promotionId: 2, discountName: "Still Valid", amountCents: 300,
          rewardType: "discount_fixed", status: "earned",
          expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days from now
        },
      });

      await expireCloverRewards(new Date());

      const updated = await prisma.posRewardDiscount.findUnique({ where: { id: reward.id } });
      expect(updated.status).toBe("earned");
    });
  });

  describe("expireSquareGiftCards", () => {
    it("zeros out and deactivates expired Square gift cards", async () => {
      const sqConn = await prisma.posConnection.create({
        data: {
          merchantId: merchant.id, posType: "square", status: "active",
          accessTokenEnc: encrypt("sq-token"), externalMerchantId: "SQ_EXPIRY_1",
        },
      });
      const card = await prisma.consumerGiftCard.create({
        data: {
          consumerId: consumer.id, posConnectionId: sqConn.id,
          squareGiftCardId: "gftc:expired123", squareGan: "1234567890",
          active: true, expiresAt: new Date(Date.now() - 1000),
        },
      });

      await expireSquareGiftCards(new Date());

      const updated = await prisma.consumerGiftCard.findUnique({ where: { id: card.id } });
      expect(updated.active).toBe(false);

      // Verify ADJUST_DECREMENT + DEACTIVATE were called
      const activityCalls = global.fetch.mock.calls.filter(c => c[0]?.includes("/gift-cards/activities"));
      expect(activityCalls.length).toBeGreaterThanOrEqual(2);

      // Verify ADJUST event logged
      const event = await prisma.giftCardEvent.findFirst({ where: { giftCardId: card.id, eventType: "ADJUST" } });
      expect(event).toBeTruthy();
      expect(event.payloadJson.reason).toBe("promotion_expired");
    });
  });

  describe("sendExpiryNotifications", () => {
    it("sends 14-day warning and records dedup", async () => {
      await prisma.posRewardDiscount.create({
        data: {
          consumerId: consumer.id, merchantId: merchant.id, posConnectionId: posConn.id,
          promotionId: 3, discountName: "Warning Test", amountCents: 300,
          rewardType: "discount_fixed", status: "earned",
          expiresAt: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000), // 10 days out (within 14-day window)
        },
      });

      await sendExpiryNotifications(new Date());

      // Should have created notification records
      const notifications = await prisma.rewardNotification.findMany({ where: { consumerId: consumer.id } });
      expect(notifications.length).toBeGreaterThanOrEqual(1);
      expect(notifications.some(n => n.notificationType === "14_day")).toBe(true);
    });

    it("does not send duplicate notifications", async () => {
      const reward = await prisma.posRewardDiscount.create({
        data: {
          consumerId: consumer.id, merchantId: merchant.id, posConnectionId: posConn.id,
          promotionId: 4, discountName: "Dedup Test", amountCents: 300,
          rewardType: "discount_fixed", status: "earned",
          expiresAt: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000), // 5 days out
        },
      });

      // Pre-create a notification record (already sent)
      await prisma.rewardNotification.create({
        data: { consumerId: consumer.id, rewardId: reward.id, rewardType: "discount", notificationType: "14_day", channel: "email" },
      });
      await prisma.rewardNotification.create({
        data: { consumerId: consumer.id, rewardId: reward.id, rewardType: "discount", notificationType: "14_day", channel: "sms" },
      });

      await sendExpiryNotifications(new Date());

      // Should not have created more 14-day notifications
      const notifications = await prisma.rewardNotification.findMany({
        where: { consumerId: consumer.id, notificationType: "14_day" },
      });
      expect(notifications).toHaveLength(2); // only the 2 we pre-created
    });

    it("skips already-redeemed rewards", async () => {
      await prisma.posRewardDiscount.create({
        data: {
          consumerId: consumer.id, merchantId: merchant.id, posConnectionId: posConn.id,
          promotionId: 5, discountName: "Already Redeemed", amountCents: 300,
          rewardType: "discount_fixed", status: "redeemed",
          expiresAt: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000),
        },
      });

      await sendExpiryNotifications(new Date());

      const notifications = await prisma.rewardNotification.findMany({ where: { consumerId: consumer.id } });
      expect(notifications).toHaveLength(0);
    });
  });
});
