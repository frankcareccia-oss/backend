// test/pos.giftcard.test.js — Gift card reward automation tests

"use strict";

const { prisma, resetDb, createMerchant } = require("./helpers/seed");
const { encrypt } = require("../src/utils/encrypt");
const { issueGiftCardReward, resolveRewardAmountCents, reconcileGiftCardBalances } = require("../src/pos/pos.giftcard");

let merchant, consumer, posConn, store;

// Mock fetch for Square API calls
const fetchCalls = [];
let fetchResponses = {};

// Each mock is { pattern, response } — checked in order (first match wins)
const fetchMocks = [];

function mockFetch(urlPattern, response) {
  fetchMocks.push({ pattern: urlPattern, response });
}

function resetFetchMocks() {
  fetchCalls.length = 0;
  fetchMocks.length = 0;
}

beforeAll(async () => {
  // Save original fetch
  global._origFetch = global.fetch;

  global.fetch = jest.fn(async (url, opts) => {
    fetchCalls.push({ url, method: opts?.method, body: opts?.body ? JSON.parse(opts.body) : null });

    for (const mock of fetchMocks) {
      if (url.includes(mock.pattern)) {
        const resp = mock.response;
        return {
          ok: resp.ok !== false,
          status: resp.status || 200,
          json: async () => resp.body,
        };
      }
    }

    // Default: 404
    return {
      ok: false,
      status: 404,
      json: async () => ({ errors: [{ detail: `No mock for ${url}` }] }),
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

  merchant = await createMerchant({ name: "GC Test Shop" });

  consumer = await prisma.consumer.create({
    data: { phoneE164: "+14085559999" },
  });

  store = await prisma.store.create({
    data: { merchantId: merchant.id, name: "Main Store", phoneRaw: "408-555-0001" },
  });

  posConn = await prisma.posConnection.create({
    data: {
      merchantId: merchant.id,
      posType: "square",
      status: "active",
      accessTokenEnc: encrypt("sq-test-token"),
      externalMerchantId: "SQ_MERCH_1",
    },
  });

  await prisma.posLocationMap.create({
    data: {
      posConnectionId: posConn.id,
      externalLocationId: "SQ_LOC_1",
      pvStoreId: store.id,
      active: true,
    },
  });
});

// ── resolveRewardAmountCents ──

describe("resolveRewardAmountCents", () => {
  it("returns rewardValue for discount_fixed", async () => {
    const amt = await resolveRewardAmountCents(
      { rewardType: "discount_fixed", rewardValue: 500 },
      merchant.id
    );
    expect(amt).toBe(500);
  });

  it("returns product price for free_item with matching SKU", async () => {
    await prisma.product.create({
      data: {
        merchantId: merchant.id,
        name: "Latte",
        sku: "LATTE-001",
        priceCents: 450,
        status: "active",
      },
    });
    const amt = await resolveRewardAmountCents(
      { rewardType: "free_item", rewardSku: "LATTE-001" },
      merchant.id
    );
    expect(amt).toBe(450);
  });

  it("falls back to rewardValue when SKU product not found", async () => {
    const amt = await resolveRewardAmountCents(
      { rewardType: "free_item", rewardSku: "MISSING", rewardValue: 600 },
      merchant.id
    );
    expect(amt).toBe(600);
  });

  it("returns null for free_item with no SKU match and no rewardValue", async () => {
    const amt = await resolveRewardAmountCents(
      { rewardType: "free_item", rewardSku: "MISSING" },
      merchant.id
    );
    expect(amt).toBeNull();
  });

  it("returns null for discount_pct (cannot pre-load)", async () => {
    const amt = await resolveRewardAmountCents(
      { rewardType: "discount_pct", rewardValue: 10 },
      merchant.id
    );
    expect(amt).toBeNull();
  });

  it("returns null for unknown reward type", async () => {
    const amt = await resolveRewardAmountCents(
      { rewardType: "custom_coupon" },
      merchant.id
    );
    expect(amt).toBeNull();
  });
});

// ── issueGiftCardReward ──

describe("issueGiftCardReward", () => {
  const promo = {
    id: 1,
    name: "Buy 10 Get 1 Free",
    rewardType: "discount_fixed",
    rewardValue: 500,
  };

  function setupSquareMocks(overrides = {}) {
    // Customer search
    mockFetch("/customers/search", overrides.customerSearch || {
      body: { customers: [{ id: "SQ_CUST_1" }] },
    });

    // More specific patterns FIRST (activities, link-customer) before generic /gift-cards
    mockFetch("/gift-cards/activities", overrides.giftCardActivities || {
      body: { gift_card_activity: { id: "ACT_1", type: "ACTIVATE" } },
    });

    // Link customer
    mockFetch("/link-customer", overrides.linkCustomer || {
      body: {},
    });

    // Gift card create (generic /gift-cards — last so it doesn't shadow the above)
    mockFetch("/gift-cards", overrides.giftCardCreate || {
      body: { gift_card: { id: "GC_1", gan: "7777000011112222" } },
    });
  }

  it("creates gift card and loads funds for discount_fixed", async () => {
    setupSquareMocks();

    const result = await issueGiftCardReward({
      consumerId: consumer.id,
      merchantId: merchant.id,
      promo,
    });

    expect(result).toEqual({ giftCardId: "GC_1", amountCents: 500 });

    // Verify DB record
    const gc = await prisma.consumerGiftCard.findFirst({
      where: { consumerId: consumer.id },
    });
    expect(gc).toBeTruthy();
    expect(gc.squareGiftCardId).toBe("GC_1");
    expect(gc.squareGan).toBe("7777000011112222");
    expect(gc.active).toBe(true);

    // Verify Square API calls — new card activates with amount, no separate LOAD
    const urls = fetchCalls.map(c => c.url);
    expect(urls.some(u => u.includes("/customers/search"))).toBe(true);
    expect(urls.some(u => u.includes("/gift-cards"))).toBe(true);
    expect(urls.some(u => u.includes("/link-customer"))).toBe(true);

    // Activate should include the reward amount
    const activateCall = fetchCalls.find(c => c.url.includes("/gift-cards/activities") && c.body?.gift_card_activity?.type === "ACTIVATE");
    expect(activateCall.body.gift_card_activity.activate_activity_details.amount_money.amount).toBe(500);

    // No separate LOAD call for new cards
    const loadCalls = fetchCalls.filter(c => c.body?.gift_card_activity?.type === "LOAD");
    expect(loadCalls).toHaveLength(0);
  });

  it("reuses existing gift card on second reward", async () => {
    // Pre-create a gift card record
    await prisma.consumerGiftCard.create({
      data: {
        consumerId: consumer.id,
        posConnectionId: posConn.id,
        squareGiftCardId: "GC_EXISTING",
        squareGan: "1111222233334444",
        active: true,
      },
    });

    setupSquareMocks();

    const result = await issueGiftCardReward({
      consumerId: consumer.id,
      merchantId: merchant.id,
      promo,
    });

    expect(result).toEqual({ giftCardId: "GC_EXISTING", amountCents: 500 });

    // Should NOT have called gift card create
    const createCalls = fetchCalls.filter(c =>
      c.url.includes("/gift-cards") && !c.url.includes("/activities") && !c.url.includes("/link-customer")
    );
    expect(createCalls).toHaveLength(0);

    // Should have called LOAD for existing card
    const loadCalls = fetchCalls.filter(c => c.body?.gift_card_activity?.type === "LOAD");
    expect(loadCalls).toHaveLength(1);
    expect(loadCalls[0].body.gift_card_activity.load_activity_details.amount_money.amount).toBe(500);
  });

  it("skips when no calculable amount (discount_pct)", async () => {
    const result = await issueGiftCardReward({
      consumerId: consumer.id,
      merchantId: merchant.id,
      promo: { id: 2, name: "10% Off", rewardType: "discount_pct", rewardValue: 10 },
    });

    expect(result).toBeNull();
    expect(fetchCalls).toHaveLength(0);
  });

  it("skips when no active Square connection", async () => {
    await prisma.posConnection.update({
      where: { id: posConn.id },
      data: { status: "disconnected" },
    });

    const result = await issueGiftCardReward({
      consumerId: consumer.id,
      merchantId: merchant.id,
      promo,
    });

    expect(result).toBeNull();
    expect(fetchCalls).toHaveLength(0);
  });

  it("skips when no mapped location", async () => {
    await prisma.posLocationMap.deleteMany({ where: { posConnectionId: posConn.id } });

    const result = await issueGiftCardReward({
      consumerId: consumer.id,
      merchantId: merchant.id,
      promo,
    });

    expect(result).toBeNull();
    expect(fetchCalls).toHaveLength(0);
  });

  it("skips when consumer has no phone", async () => {
    const noPhone = await prisma.consumer.create({ data: {} });

    const result = await issueGiftCardReward({
      consumerId: noPhone.id,
      merchantId: merchant.id,
      promo,
    });

    expect(result).toBeNull();
    expect(fetchCalls).toHaveLength(0);
  });

  it("skips when Square customer not found", async () => {
    mockFetch("/customers/search", { body: { customers: [] } });

    const result = await issueGiftCardReward({
      consumerId: consumer.id,
      merchantId: merchant.id,
      promo,
    });

    expect(result).toBeNull();
  });

  it("returns null on Square API error (does not throw)", async () => {
    mockFetch("/customers/search", {
      ok: false,
      status: 500,
      body: { errors: [{ detail: "Internal Server Error" }] },
    });

    const result = await issueGiftCardReward({
      consumerId: consumer.id,
      merchantId: merchant.id,
      promo,
    });

    expect(result).toBeNull();
  });

  it("resolves same PV consumer when duplicate Square customers exist (same phone)", async () => {
    // Simulate: Square returns TWO customers with the same phone (merchant created a duplicate)
    // Our search takes customers[0] — but both normalize to the same PV consumer
    setupSquareMocks({
      customerSearch: {
        body: { customers: [
          { id: "SQ_CUST_DUPLICATE", phone_number: "+17735550001" },
          { id: "SQ_CUST_ORIGINAL",  phone_number: "+17735550001" },
        ] },
      },
    });

    const result = await issueGiftCardReward({
      consumerId: consumer.id,
      merchantId: merchant.id,
      promo,
    });

    expect(result).toEqual({ giftCardId: "GC_1", amountCents: 500 });

    // Gift card linked to whichever customer was returned first
    const linkCall = fetchCalls.find(c => c.url.includes("/link-customer"));
    expect(linkCall.body.customer_id).toBe("SQ_CUST_DUPLICATE");

    // But the ConsumerGiftCard in PV is still tied to our one consumer
    const gc = await prisma.consumerGiftCard.findFirst({ where: { consumerId: consumer.id } });
    expect(gc).toBeTruthy();
    expect(gc.squareGiftCardId).toBe("GC_1");
  });

  it("loads free_item reward using product price lookup", async () => {
    await prisma.product.create({
      data: {
        merchantId: merchant.id,
        name: "Espresso",
        sku: "ESP-001",
        priceCents: 350,
        status: "active",
      },
    });

    setupSquareMocks();

    const result = await issueGiftCardReward({
      consumerId: consumer.id,
      merchantId: merchant.id,
      promo: { id: 3, name: "Free Espresso", rewardType: "free_item", rewardSku: "ESP-001" },
    });

    expect(result).toEqual({ giftCardId: "GC_1", amountCents: 350 });
  });
});

// ── reconcileGiftCardBalances ──

describe("reconcileGiftCardBalances", () => {
  let gcRecord;

  async function createGiftCardWithEvents(loadCents, redeemCents = 0) {
    gcRecord = await prisma.consumerGiftCard.create({
      data: {
        consumerId: consumer.id,
        posConnectionId: posConn.id,
        squareGiftCardId: "GC_RECON_1",
        squareGan: "9999000011112222",
        active: true,
      },
    });

    // Seed LOAD event
    await prisma.giftCardEvent.create({
      data: {
        giftCardId: gcRecord.id,
        consumerId: consumer.id,
        merchantId: merchant.id,
        eventType: "LOAD",
        amountCents: loadCents,
        ganLast4: "2222",
      },
    });

    if (redeemCents > 0) {
      await prisma.giftCardEvent.create({
        data: {
          giftCardId: gcRecord.id,
          consumerId: consumer.id,
          merchantId: merchant.id,
          eventType: "REDEEMED",
          amountCents: redeemCents,
          ganLast4: "2222",
        },
      });
    }
  }

  it("logs RECONCILED when Square balance matches ledger", async () => {
    await createGiftCardWithEvents(500);

    // Square says $5.00 balance — matches LOAD of 500
    mockFetch("/gift-cards/GC_RECON_1", {
      body: { gift_card: { balance_money: { amount: 500, currency: "USD" } } },
    });

    const result = await reconcileGiftCardBalances();
    expect(result).toEqual({ reconciled: 1, adjusted: 0, errors: 0 });

    const events = await prisma.giftCardEvent.findMany({
      where: { giftCardId: gcRecord.id, eventType: "RECONCILED" },
    });
    expect(events).toHaveLength(1);
    expect(events[0].amountCents).toBe(500);
  });

  it("logs RECONCILED when balance matches after partial redemption", async () => {
    await createGiftCardWithEvents(500, 200);

    // Square says $3.00 — matches 500 LOAD - 200 REDEEMED
    mockFetch("/gift-cards/GC_RECON_1", {
      body: { gift_card: { balance_money: { amount: 300, currency: "USD" } } },
    });

    const result = await reconcileGiftCardBalances();
    expect(result).toEqual({ reconciled: 1, adjusted: 0, errors: 0 });
  });

  it("logs ADJUST when Square balance differs from ledger", async () => {
    await createGiftCardWithEvents(500);

    // Square says $3.00 but ledger expects $5.00 (external redemption we didn't see)
    mockFetch("/gift-cards/GC_RECON_1", {
      body: { gift_card: { balance_money: { amount: 300, currency: "USD" } } },
    });

    const result = await reconcileGiftCardBalances();
    expect(result).toEqual({ reconciled: 0, adjusted: 1, errors: 0 });

    const events = await prisma.giftCardEvent.findMany({
      where: { giftCardId: gcRecord.id, eventType: "ADJUST" },
    });
    expect(events).toHaveLength(1);
    expect(events[0].amountCents).toBe(-200); // 300 - 500 = -200
    expect(events[0].payloadJson).toMatchObject({
      squareBalanceCents: 300,
      ledgerExpectedCents: 500,
      deltaCents: -200,
    });
  });

  it("returns zeros when no active gift cards exist", async () => {
    const result = await reconcileGiftCardBalances();
    expect(result).toEqual({ reconciled: 0, adjusted: 0, errors: 0 });
  });

  it("counts errors when Square API fails for a card", async () => {
    await createGiftCardWithEvents(500);

    mockFetch("/gift-cards/GC_RECON_1", {
      ok: false,
      status: 500,
      body: { errors: [{ detail: "Internal Server Error" }] },
    });

    const result = await reconcileGiftCardBalances();
    expect(result).toEqual({ reconciled: 0, adjusted: 0, errors: 1 });

    // No RECONCILED or ADJUST events should be created
    const events = await prisma.giftCardEvent.findMany({
      where: { giftCardId: gcRecord.id, eventType: { in: ["RECONCILED", "ADJUST"] } },
    });
    expect(events).toHaveLength(0);
  });

  it("skips cards with disconnected posConnection", async () => {
    await createGiftCardWithEvents(500);
    await prisma.posConnection.update({
      where: { id: posConn.id },
      data: { status: "disconnected" },
    });

    const result = await reconcileGiftCardBalances();
    // Card is skipped (not active connection), not counted as error
    expect(result).toEqual({ reconciled: 0, adjusted: 0, errors: 0 });
    expect(fetchCalls).toHaveLength(0);
  });
});
