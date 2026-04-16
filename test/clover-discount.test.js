// test/clover-discount.test.js — Clover discount reward delivery tests

"use strict";

const { prisma, resetDb, createMerchant, createConsumer } = require("./helpers/seed");
const { encrypt } = require("../src/utils/encrypt");

// Mock fetch for Clover API calls
const fetchCalls = [];
const fetchMocks = [];

function mockFetch(urlPattern, response) {
  fetchMocks.push({ pattern: urlPattern, response });
}

function resetFetchMocks() {
  fetchCalls.length = 0;
  fetchMocks.length = 0;
}

let merchant, consumer, posConn, store;

beforeAll(async () => {
  global._origFetch = global.fetch;
  global.fetch = jest.fn(async (url, opts) => {
    fetchCalls.push({ url, method: opts?.method || "GET", body: opts?.body ? JSON.parse(opts.body) : null });
    for (const mock of fetchMocks) {
      if (url.includes(mock.pattern)) {
        const resp = typeof mock.response === "function" ? mock.response(url, opts) : mock.response;
        return {
          ok: resp.ok !== false,
          status: resp.status || 200,
          json: async () => resp.body,
          text: async () => JSON.stringify(resp.body),
        };
      }
    }
    return {
      ok: false,
      status: 404,
      json: async () => ({ message: `No mock for ${url}` }),
      text: async () => JSON.stringify({ message: `No mock for ${url}` }),
    };
  });
});

afterAll(async () => {
  global.fetch = global._origFetch;
  await prisma.$disconnect();
});

beforeEach(async () => {
  await resetDb();
  resetFetchMocks();

  merchant = await createMerchant({ name: "Clover Discount Shop" });
  consumer = await prisma.consumer.create({
    data: { phoneE164: "+17735550099", firstName: "Jane", lastName: "Doe" },
  });
  store = await prisma.store.create({
    data: { merchantId: merchant.id, name: "Main Store", phoneRaw: "773-555-0099" },
  });
  posConn = await prisma.posConnection.create({
    data: {
      merchantId: merchant.id,
      posType: "clover",
      status: "active",
      accessTokenEnc: encrypt("clover-test-token"),
      externalMerchantId: "CLO_MERCH_1",
    },
  });
});

describe("Clover Order Enrichment", () => {
  it("stores Clover order line items via webhook", async () => {
    await prisma.posLocationMap.create({
      data: {
        posConnectionId: posConn.id,
        externalLocationId: "CLO_MERCH_1",
        pvStoreId: store.id,
        active: true,
      },
    });

    // Mock: getPayment
    mockFetch("/payments/PAY_ENRICH", {
      body: { id: "PAY_ENRICH", amount: 850, order: { id: "ORD_ENRICH" } },
    });
    // Mock: getOrder (called twice — once for consumer resolution, once for enrichment)
    mockFetch("/orders/ORD_ENRICH", {
      body: {
        id: "ORD_ENRICH",
        state: "open",
        currency: "USD",
        total: 850,
        lineItems: {
          elements: [
            { id: "LI_1", name: "Large Latte", price: 500, isRevenue: true },
            { id: "LI_2", name: "Muffin", price: 350, isRevenue: true },
          ],
        },
      },
    });
    // Mock: customer search (for consumer resolution — returns no match)
    mockFetch("/customers", { body: { elements: [] } });

    const request = require("supertest");
    const { getApp } = require("./helpers/setup");
    const app = getApp();

    await request(app)
      .post("/webhooks/clover")
      .set("Content-Type", "application/json")
      .send({
        merchants: {
          CLO_MERCH_1: {
            payments: [{ objectId: "PAY_ENRICH", type: "CREATE" }],
          },
        },
      });

    // Wait for async processing
    await new Promise(r => setTimeout(r, 1000));

    const posOrder = await prisma.posOrder.findFirst({
      where: { externalOrderId: "ORD_ENRICH" },
      include: { items: true },
    });

    expect(posOrder).not.toBeNull();
    expect(posOrder.posType).toBe("clover");
    expect(posOrder.totalAmount).toBe(850);
    expect(posOrder.items).toHaveLength(2);
    expect(posOrder.items[0].itemName).toBe("Large Latte");
    expect(posOrder.items[0].unitPrice).toBe(500);
    expect(posOrder.items[1].itemName).toBe("Muffin");
    expect(posOrder.items[1].unitPrice).toBe(350);
  });
});

describe("Clover Duplicate Customer Detection", () => {
  it("creates alert when duplicate customers found on payment", async () => {
    await prisma.posLocationMap.create({
      data: {
        posConnectionId: posConn.id,
        externalLocationId: "CLO_MERCH_1",
        pvStoreId: store.id,
        active: true,
      },
    });

    // Mock: getPayment
    mockFetch("/payments/PAY_DUP", {
      body: { id: "PAY_DUP", amount: 500, order: { id: "ORD_DUP" } },
    });
    // Mock: getOrder with customer phone
    mockFetch("/orders/ORD_DUP", {
      body: {
        id: "ORD_DUP",
        customers: { elements: [{ phoneNumbers: { elements: [{ phoneNumber: "+17735550099" }] } }] },
        lineItems: { elements: [] },
      },
    });
    // Mock: customer search returns 2 duplicates
    mockFetch("filter=phoneNumber", {
      body: {
        elements: [
          { id: "CLO_CUST_1", firstName: "Jane", lastName: "Doe" },
          { id: "CLO_CUST_2", firstName: "Jane", lastName: "D" },
        ],
      },
    });

    const request = require("supertest");
    const { getApp } = require("./helpers/setup");
    const app = getApp();

    await request(app)
      .post("/webhooks/clover")
      .set("Content-Type", "application/json")
      .send({
        merchants: {
          CLO_MERCH_1: {
            payments: [{ objectId: "PAY_DUP", type: "CREATE" }],
          },
        },
      });

    await new Promise(r => setTimeout(r, 1500));

    const alerts = await prisma.duplicateCustomerAlert.findMany({
      where: { merchantId: merchant.id, status: "pending" },
    });

    expect(alerts.length).toBeGreaterThanOrEqual(1);
    const alert = alerts.find(a => a.phoneE164 === "+17735550099");
    if (alert) {
      expect(alert.squareCustomerIds).toHaveLength(2);
    }
  });

  it("does NOT create alert when only one customer found", async () => {
    // This test ensures no false positives — single customer = no alert
    await prisma.posLocationMap.create({
      data: {
        posConnectionId: posConn.id,
        externalLocationId: "CLO_MERCH_1",
        pvStoreId: store.id,
        active: true,
      },
    });

    mockFetch("/payments/PAY_SINGLE", {
      body: { id: "PAY_SINGLE", amount: 500, order: { id: "ORD_SINGLE" } },
    });
    mockFetch("/orders/ORD_SINGLE", {
      body: {
        id: "ORD_SINGLE",
        customers: { elements: [{ phoneNumbers: { elements: [{ phoneNumber: "+17735550099" }] } }] },
        lineItems: { elements: [] },
      },
    });
    mockFetch("filter=phoneNumber", {
      body: { elements: [{ id: "CLO_CUST_ONLY", firstName: "Jane", lastName: "Doe" }] },
    });

    const request = require("supertest");
    const { getApp } = require("./helpers/setup");
    const app = getApp();

    await request(app)
      .post("/webhooks/clover")
      .set("Content-Type", "application/json")
      .send({
        merchants: {
          CLO_MERCH_1: {
            payments: [{ objectId: "PAY_SINGLE", type: "CREATE" }],
          },
        },
      });

    await new Promise(r => setTimeout(r, 1000));

    const alerts = await prisma.duplicateCustomerAlert.findMany({
      where: { merchantId: merchant.id },
    });
    expect(alerts).toHaveLength(0);
  });
});

describe("Clover Discount Reward", () => {
  const { applyCloverDiscount, issueCloverDiscountReward, applyPendingCloverRewards, buildDiscountName, resolveRewardAmountCents } = require("../src/pos/pos.clover.discount");

  describe("buildDiscountName", () => {
    it("builds name for fixed discount", () => {
      const name = buildDiscountName({ rewardType: "discount_fixed", rewardValue: 500 });
      expect(name).toBe("PerkValet Reward — $5.00 off");
    });

    it("builds name for percentage discount", () => {
      const name = buildDiscountName({ rewardType: "discount_pct", rewardValue: 20 });
      expect(name).toBe("PerkValet Reward — 20% off");
    });

    it("builds name for free item with product name", () => {
      const name = buildDiscountName({ rewardType: "free_item" }, "Large Latte");
      expect(name).toBe("PerkValet Reward — Free Large Latte");
    });

    it("falls back to promo name", () => {
      const name = buildDiscountName({ rewardType: "custom", name: "Coffee Lovers Special" });
      expect(name).toBe("PerkValet Reward — Coffee Lovers Special");
    });
  });

  describe("resolveRewardAmountCents", () => {
    it("returns rewardValue for discount_fixed", async () => {
      const amt = await resolveRewardAmountCents({ rewardType: "discount_fixed", rewardValue: 500 }, merchant.id);
      expect(amt).toBe(500);
    });

    it("returns null for discount_pct", async () => {
      const amt = await resolveRewardAmountCents({ rewardType: "discount_pct", rewardValue: 20 }, merchant.id);
      expect(amt).toBeNull();
    });

    it("resolves free_item price from product catalog", async () => {
      await prisma.product.create({
        data: { merchantId: merchant.id, name: "Large Latte", sku: "LATTE-L", priceCents: 500, status: "active" },
      });
      const amt = await resolveRewardAmountCents({ rewardType: "free_item", rewardSku: "LATTE-L" }, merchant.id);
      expect(amt).toBe(500);
    });
  });

  describe("applyCloverDiscount", () => {
    it("applies a fixed discount to an order", async () => {
      // Mock: order with line items totaling $8.50
      mockFetch("/orders/ORD_1?expand=lineItems", {
        body: { lineItems: { elements: [{ price: 500 }, { price: 350 }] } },
      });
      // Mock: discount creation
      mockFetch("/orders/ORD_1/discounts", {
        body: { id: "DISC_1", name: "PerkValet Reward — $5.00 off", amount: -500 },
      });

      const result = await applyCloverDiscount({
        posConnection: posConn,
        orderId: "ORD_1",
        promo: { id: 1, name: "Coffee Loyalty", rewardType: "discount_fixed", rewardValue: 500 },
        consumerId: consumer.id,
      });

      expect(result.applied).toBe(true);
      expect(result.discountId).toBe("DISC_1");

      // Verify PosRewardDiscount record
      const record = await prisma.posRewardDiscount.findFirst({ where: { consumerId: consumer.id } });
      expect(record.status).toBe("applied");
      expect(record.amountCents).toBe(500);
      expect(record.cloverDiscountId).toBe("DISC_1");
    });

    it("applies a percentage discount", async () => {
      mockFetch("/orders/ORD_2/discounts", {
        body: { id: "DISC_2", name: "PerkValet Reward — 20% off", percentage: 20 },
      });

      const result = await applyCloverDiscount({
        posConnection: posConn,
        orderId: "ORD_2",
        promo: { id: 2, name: "20% Off", rewardType: "discount_pct", rewardValue: 20 },
        consumerId: consumer.id,
      });

      expect(result.applied).toBe(true);
      const record = await prisma.posRewardDiscount.findFirst({ where: { consumerId: consumer.id } });
      expect(record.percentage).toBe(20);
      expect(record.amountCents).toBeNull();
    });

    it("SKIPS when order total < reward amount (discount guard)", async () => {
      // Mock: order total is only $3.00 but reward is $5.00
      mockFetch("/orders/ORD_3?expand=lineItems", {
        body: { lineItems: { elements: [{ price: 300 }] } },
      });

      const result = await applyCloverDiscount({
        posConnection: posConn,
        orderId: "ORD_3",
        promo: { id: 3, name: "Big Reward", rewardType: "discount_fixed", rewardValue: 500 },
        consumerId: consumer.id,
      });

      expect(result.skipped).toBe(true);
      expect(result.reason).toContain("order total ($3.00) < reward value ($5.00)");

      // Verify record is stored with status "skipped"
      const record = await prisma.posRewardDiscount.findFirst({ where: { consumerId: consumer.id } });
      expect(record.status).toBe("skipped");
      expect(record.skippedReason).toContain("order total");
    });

    it("does NOT apply discount guard for percentage discounts", async () => {
      // Percentage discounts are always safe — no order total check needed
      mockFetch("/orders/ORD_4/discounts", {
        body: { id: "DISC_4", name: "PerkValet Reward — 50% off", percentage: 50 },
      });

      const result = await applyCloverDiscount({
        posConnection: posConn,
        orderId: "ORD_4",
        promo: { id: 4, name: "Half Off", rewardType: "discount_pct", rewardValue: 50 },
        consumerId: consumer.id,
      });

      expect(result.applied).toBe(true);
      // Should NOT have called getOrderTotal
      const totalCalls = fetchCalls.filter(c => c.url.includes("expand=lineItems"));
      expect(totalCalls).toHaveLength(0);
    });
  });

  describe("issueCloverDiscountReward", () => {
    it("stores pending reward for next_visit timing", async () => {
      const result = await issueCloverDiscountReward({
        consumerId: consumer.id,
        merchantId: merchant.id,
        promo: { id: 10, name: "Loyalty Reward", rewardType: "discount_fixed", rewardValue: 500, rewardTiming: "next_visit" },
        orderId: "ORD_X",
      });

      expect(result.pending).toBe(true);
      const record = await prisma.posRewardDiscount.findFirst({ where: { consumerId: consumer.id } });
      expect(record.status).toBe("pending");
      expect(record.cloverOrderId).toBeNull();
    });

    it("applies discount instantly when timing is instant", async () => {
      // Mock: order total $8.50
      mockFetch("/orders/ORD_INST?expand=lineItems", {
        body: { lineItems: { elements: [{ price: 500 }, { price: 350 }] } },
      });
      mockFetch("/orders/ORD_INST/discounts", {
        body: { id: "DISC_INST", name: "PerkValet Reward — $5.00 off", amount: -500 },
      });

      const result = await issueCloverDiscountReward({
        consumerId: consumer.id,
        merchantId: merchant.id,
        promo: { id: 12, name: "Instant Coffee", rewardType: "discount_fixed", rewardValue: 500, rewardTiming: "instant" },
        orderId: "ORD_INST",
      });

      expect(result.applied).toBe(true);
      expect(result.discountId).toBe("DISC_INST");

      // Should be recorded as "applied", not "pending"
      const record = await prisma.posRewardDiscount.findFirst({ where: { consumerId: consumer.id } });
      expect(record.status).toBe("applied");
      expect(record.cloverOrderId).toBe("ORD_INST");
    });

    it("falls back to pending when instant has no orderId", async () => {
      const result = await issueCloverDiscountReward({
        consumerId: consumer.id,
        merchantId: merchant.id,
        promo: { id: 13, name: "No Order", rewardType: "discount_fixed", rewardValue: 500, rewardTiming: "instant" },
        orderId: null,
      });

      expect(result.pending).toBe(true);
      const record = await prisma.posRewardDiscount.findFirst({ where: { consumerId: consumer.id } });
      expect(record.status).toBe("pending");
    });

    it("skips instant when discount guard rejects and stores as skipped", async () => {
      // Mock: order total only $2.00, reward is $5.00
      mockFetch("/orders/ORD_GUARD?expand=lineItems", {
        body: { lineItems: { elements: [{ price: 200 }] } },
      });

      const result = await issueCloverDiscountReward({
        consumerId: consumer.id,
        merchantId: merchant.id,
        promo: { id: 14, name: "Too Big Reward", rewardType: "discount_fixed", rewardValue: 500, rewardTiming: "instant" },
        orderId: "ORD_GUARD",
      });

      expect(result.skipped).toBe(true);
      const record = await prisma.posRewardDiscount.findFirst({ where: { consumerId: consumer.id } });
      expect(record.status).toBe("skipped");
    });

    it("returns null when no Clover connection exists", async () => {
      // Delete the connection
      await prisma.posConnection.delete({ where: { id: posConn.id } });

      const result = await issueCloverDiscountReward({
        consumerId: consumer.id,
        merchantId: merchant.id,
        promo: { id: 11, name: "No Connection", rewardType: "discount_fixed", rewardValue: 500 },
        orderId: "ORD_Y",
      });

      expect(result).toBeNull();
    });
  });

  describe("applyPendingCloverRewards", () => {
    it("applies a pending reward on the next payment", async () => {
      // Create a pending reward
      const pending = await prisma.posRewardDiscount.create({
        data: {
          consumerId: consumer.id,
          merchantId: merchant.id,
          posConnectionId: posConn.id,
          promotionId: 20,
          discountName: "PerkValet Reward — $5.00 off",
          amountCents: 500,
          rewardType: "discount_fixed",
          status: "pending",
        },
      });

      // Mock: order total is $8.00 (passes guard)
      mockFetch("/orders/ORD_NEXT?expand=lineItems", {
        body: { lineItems: { elements: [{ price: 800 }] } },
      });
      mockFetch("/orders/ORD_NEXT/discounts", {
        body: { id: "DISC_NEXT", name: "PerkValet Reward — $5.00 off", amount: -500 },
      });

      const results = await applyPendingCloverRewards({
        consumerId: consumer.id,
        merchantId: merchant.id,
        posConnection: posConn,
        orderId: "ORD_NEXT",
      });

      expect(results).toHaveLength(1);
      expect(results[0].applied).toBe(true);

      // Verify the original pending record was updated
      const updated = await prisma.posRewardDiscount.findUnique({ where: { id: pending.id } });
      expect(updated.status).toBe("applied");
      expect(updated.cloverOrderId).toBe("ORD_NEXT");
      expect(updated.cloverDiscountId).toBe("DISC_NEXT");
    });

    it("leaves reward pending when discount guard rejects", async () => {
      await prisma.posRewardDiscount.create({
        data: {
          consumerId: consumer.id,
          merchantId: merchant.id,
          posConnectionId: posConn.id,
          promotionId: 21,
          discountName: "PerkValet Reward — $10.00 off",
          amountCents: 1000,
          rewardType: "discount_fixed",
          status: "pending",
        },
      });

      // Mock: order total is only $3.00
      mockFetch("/orders/ORD_SMALL?expand=lineItems", {
        body: { lineItems: { elements: [{ price: 300 }] } },
      });

      const results = await applyPendingCloverRewards({
        consumerId: consumer.id,
        merchantId: merchant.id,
        posConnection: posConn,
        orderId: "ORD_SMALL",
      });

      expect(results).toHaveLength(1);
      expect(results[0].skipped).toBe(true);

      // Original record should still be pending
      const records = await prisma.posRewardDiscount.findMany({
        where: { consumerId: consumer.id, status: "pending" },
      });
      expect(records).toHaveLength(1);
    });

    it("returns empty array when no pending rewards", async () => {
      const results = await applyPendingCloverRewards({
        consumerId: consumer.id,
        merchantId: merchant.id,
        posConnection: posConn,
        orderId: "ORD_NONE",
      });
      expect(results).toEqual([]);
    });
  });
});
