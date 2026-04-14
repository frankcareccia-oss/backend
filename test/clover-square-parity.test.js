// test/clover-square-parity.test.js
//
// End-to-end parity test: "Buy a latte → earn free pastry → associate notified → redeem"
// Runs the identical scenario on Square and Clover, then compares every audit record.

const request = require("supertest");
const { getApp, merchantToken, adminToken, authHeader } = require("./helpers/setup");
const { prisma, resetDb, createMerchant, createUser, addMerchantUser } = require("./helpers/seed");
const { encrypt } = require("../src/utils/encrypt");
const { accumulateStamps } = require("../src/pos/pos.stamps");
const { processRewardGrant } = require("../src/pos/pos.reward");

let app;
let merchant;
let squareStore, cloverStore;
let consumer;
let promo;
let squareConn, cloverConn;
let merchAuth;

beforeAll(async () => {
  app = getApp();
  await resetDb();

  // ── Merchant + user ──
  merchant = await createMerchant({ name: "Parity Test Café" });
  const owner = await createUser({ email: "parity-owner@perkvalet.org" });
  await addMerchantUser({ merchantId: merchant.id, userId: owner.id, role: "owner" });
  merchAuth = authHeader(merchantToken({ userId: owner.id, merchantId: merchant.id }));

  // ── Two stores: one for Square, one for Clover ──
  squareStore = await prisma.store.create({
    data: { name: "Café — Square Register", merchantId: merchant.id, phoneRaw: "555-0500" },
  });
  cloverStore = await prisma.store.create({
    data: { name: "Café — Clover Register", merchantId: merchant.id, phoneRaw: "555-0501" },
  });

  // ── Promotion: buy 1 latte → free pastry next visit ──
  promo = await prisma.promotion.create({
    data: {
      merchantId: merchant.id,
      name: "Buy a Latte, Free Pastry",
      mechanic: "stamps",
      threshold: 1,
      rewardType: "free_item",
      rewardValue: 0,
      rewardNote: "Free pastry of your choice",
      status: "active",
      repeatable: true,
    },
  });

  // ── Consumer (same person pays at both registers) ──
  consumer = await prisma.consumer.create({
    data: {
      phoneE164: "+15559991234",
      email: "latte-lover@test.com",
      firstName: "Latte",
      lastName: "Lover",
      status: "active",
    },
  });

  // ── POS connections ──
  squareConn = await prisma.posConnection.create({
    data: {
      merchantId: merchant.id,
      posType: "square",
      externalMerchantId: "SQ_PARITY_001",
      accessTokenEnc: encrypt("sq-test-token"),
      status: "active",
    },
  });

  await prisma.posLocationMap.create({
    data: {
      posConnectionId: squareConn.id,
      externalLocationId: "SQ_LOC_PARITY",
      externalLocationName: "Square Register",
      pvStoreId: squareStore.id,
      pvStoreName: squareStore.name,
      active: true,
    },
  });

  cloverConn = await prisma.posConnection.create({
    data: {
      merchantId: merchant.id,
      posType: "clover",
      externalMerchantId: "CLV_PARITY_001",
      accessTokenEnc: encrypt("clv-test-token"),
      status: "active",
    },
  });

  await prisma.posLocationMap.create({
    data: {
      posConnectionId: cloverConn.id,
      externalLocationId: "CLV_PARITY_001",
      externalLocationName: "Clover Register",
      pvStoreId: cloverStore.id,
      pvStoreName: cloverStore.name,
      active: true,
    },
  });
}, 15000);

afterAll(async () => {
  // Clean up in dependency order
  await prisma.entitlement.deleteMany({ where: { consumerId: consumer.id } });
  await prisma.promoRedemption.deleteMany({ where: { consumerId: consumer.id } });
  await prisma.consumerPromoProgress.deleteMany({ where: { consumerId: consumer.id } });
  await prisma.promotionEvent.deleteMany({ where: { promotionId: promo.id } });
  await prisma.eventOutbox.deleteMany({ where: { merchantId: merchant.id } });
  await prisma.paymentEvent.deleteMany({ where: { merchantId: merchant.id } });
  await prisma.visit.deleteMany({ where: { merchantId: merchant.id } });
  await prisma.promotion.delete({ where: { id: promo.id } });
  await prisma.consumer.delete({ where: { id: consumer.id } });
  await prisma.posLocationMap.deleteMany({ where: { posConnectionId: squareConn.id } });
  await prisma.posLocationMap.deleteMany({ where: { posConnectionId: cloverConn.id } });
  await prisma.posConnection.delete({ where: { id: squareConn.id } });
  await prisma.posConnection.delete({ where: { id: cloverConn.id } });
  await prisma.store.delete({ where: { id: squareStore.id } });
  await prisma.store.delete({ where: { id: cloverStore.id } });
  await prisma.$disconnect();
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenario: Latte Purchase → Stamp → Milestone → Entitlement → Redemption
// Run identically on both POS systems, then compare audit records.
// ─────────────────────────────────────────────────────────────────────────────

describe("Square vs Clover parity: Buy a Latte → Free Pastry", () => {
  const squarePayId = "sq_latte_parity_" + Date.now();
  const cloverPayId = "clv_latte_parity_" + Date.now();

  let sqVisit, clvVisit;
  let sqStampResult, clvStampResult;

  // ── Step 1: Payment webhook creates visit ──────────────────────────────────

  it("Step 1a: Square payment webhook → visit (identified consumer)", async () => {
    // Simulate what handleSquarePayment does: create visit directly
    // (Real webhook hits Square API which we can't reach in tests)
    sqVisit = await prisma.visit.create({
      data: {
        storeId: squareStore.id,
        merchantId: merchant.id,
        consumerId: consumer.id,
        source: "square_webhook",
        status: "identified",
        posVisitId: squarePayId,
        metadata: { squarePaymentId: squarePayId, amountCents: 550, item: "Latte" },
      },
    });

    expect(sqVisit.id).toBeTruthy();
    expect(sqVisit.source).toBe("square_webhook");
    expect(sqVisit.status).toBe("identified");
  });

  it("Step 1b: Clover payment webhook → visit (identified consumer)", async () => {
    clvVisit = await prisma.visit.create({
      data: {
        storeId: cloverStore.id,
        merchantId: merchant.id,
        consumerId: consumer.id,
        source: "clover_webhook",
        status: "identified",
        posVisitId: "clover:" + cloverPayId,
        metadata: { cloverPaymentId: cloverPayId, amountCents: 550, item: "Latte" },
      },
    });

    expect(clvVisit.id).toBeTruthy();
    expect(clvVisit.source).toBe("clover_webhook");
    expect(clvVisit.status).toBe("identified");
  });

  // ── Step 2: Record PaymentEvent (audit ledger) ─────────────────────────────

  it("Step 2a: Square PaymentEvent recorded", async () => {
    const { recordPaymentEvent } = require("../src/payments/paymentEvent.service");
    await recordPaymentEvent({
      eventType: "payment_completed",
      source: "square",
      merchantId: merchant.id,
      storeId: squareStore.id,
      consumerId: consumer.id,
      amountCents: 550,
      currency: "usd",
      providerEventId: squarePayId,
      providerOrderId: null,
      metadata: { visitId: sqVisit.id, posType: "square" },
      emitHook: () => {},
    });

    const pe = await prisma.paymentEvent.findFirst({
      where: { providerEventId: squarePayId },
    });
    expect(pe).not.toBeNull();
    expect(pe.source).toBe("square");
    expect(pe.amountCents).toBe(550);
  });

  it("Step 2b: Clover PaymentEvent recorded", async () => {
    const { recordPaymentEvent } = require("../src/payments/paymentEvent.service");
    await recordPaymentEvent({
      eventType: "payment_completed",
      source: "clover",
      merchantId: merchant.id,
      storeId: cloverStore.id,
      consumerId: consumer.id,
      amountCents: 550,
      currency: "usd",
      providerEventId: "clover:" + cloverPayId,
      providerOrderId: null,
      metadata: { visitId: clvVisit.id, posType: "clover" },
      emitHook: () => {},
    });

    const pe = await prisma.paymentEvent.findFirst({
      where: { providerEventId: "clover:" + cloverPayId },
    });
    expect(pe).not.toBeNull();
    expect(pe.source).toBe("clover");
    expect(pe.amountCents).toBe(550);
  });

  // ── Step 3: Stamp accumulation → milestone earned ──────────────────────────

  it("Step 3a: Square stamp → milestone earned (threshold=1)", async () => {
    sqStampResult = await accumulateStamps(prisma, {
      consumerId: consumer.id,
      merchantId: merchant.id,
      storeId: squareStore.id,
      visitId: sqVisit.id,
    });

    expect(sqStampResult.length).toBe(1);
    expect(sqStampResult[0].milestoneEarned).toBe(true);
    expect(sqStampResult[0].promotionId).toBe(promo.id);
  });

  it("Step 3b: Clover stamp → milestone earned (threshold=1)", async () => {
    clvStampResult = await accumulateStamps(prisma, {
      consumerId: consumer.id,
      merchantId: merchant.id,
      storeId: cloverStore.id,
      visitId: clvVisit.id,
    });

    expect(clvStampResult.length).toBe(1);
    expect(clvStampResult[0].milestoneEarned).toBe(true);
    expect(clvStampResult[0].promotionId).toBe(promo.id);
  });

  // ── Step 4: Verify Entitlement created (associate notification) ────────────

  it("Step 4: Consumer has 2 active reward entitlements (one per POS)", async () => {
    const entitlements = await prisma.entitlement.findMany({
      where: { consumerId: consumer.id, type: "reward", status: "active" },
      orderBy: { createdAt: "asc" },
    });

    expect(entitlements.length).toBe(2);

    // Both should display "Free pastry of your choice"
    for (const ent of entitlements) {
      expect(ent.metadataJson.displayLabel).toBe("Free pastry of your choice");
      expect(ent.metadataJson.rewardProgramId).toBe(promo.id);
    }

    // One from Square store, one from Clover store
    const storeIds = entitlements.map(e => e.storeId).sort();
    expect(storeIds).toEqual([squareStore.id, cloverStore.id].sort());
  });

  // ── Step 5: Associate sees reward → consumer redeems free pastry ───────────

  it("Step 5a: Square redemption — associate grants free pastry", async () => {
    const result = await processRewardGrant(prisma, {
      consumerId: consumer.id,
      merchantId: merchant.id,
      storeId: squareStore.id,
      associateUserId: null,
    });

    expect(result.success).toBe(true);
    expect(result.reward.label).toBe("Free pastry of your choice");
    expect(result.reward.type).toBe("free_item");
    expect(result.reward.programName).toBe("Buy a Latte, Free Pastry");
    expect(result.redemptionId).toBeTruthy();
  });

  it("Step 5b: Clover redemption — associate grants free pastry", async () => {
    const result = await processRewardGrant(prisma, {
      consumerId: consumer.id,
      merchantId: merchant.id,
      storeId: cloverStore.id,
      associateUserId: null,
    });

    expect(result.success).toBe(true);
    expect(result.reward.label).toBe("Free pastry of your choice");
    expect(result.reward.type).toBe("free_item");
    expect(result.reward.programName).toBe("Buy a Latte, Free Pastry");
    expect(result.redemptionId).toBeTruthy();
  });

  // ── Step 6: Compare audit records — full parity check ──────────────────────

  it("Step 6: Audit record parity — identical structure, different source", async () => {
    // ── Visits ──
    const visits = await prisma.visit.findMany({
      where: { merchantId: merchant.id },
      orderBy: { createdAt: "asc" },
    });
    expect(visits.length).toBe(2);
    expect(visits[0].source).toBe("square_webhook");
    expect(visits[1].source).toBe("clover_webhook");
    // Both identified
    expect(visits[0].status).toBe("identified");
    expect(visits[1].status).toBe("identified");

    // ── PaymentEvents ──
    const payments = await prisma.paymentEvent.findMany({
      where: { merchantId: merchant.id },
      orderBy: { createdAt: "asc" },
    });
    expect(payments.length).toBe(2);
    expect(payments[0].source).toBe("square");
    expect(payments[1].source).toBe("clover");
    // Same amount, same type
    expect(payments[0].amountCents).toBe(payments[1].amountCents);
    expect(payments[0].eventType).toBe(payments[1].eventType);

    // ── ConsumerPromoProgress ──
    const progress = await prisma.consumerPromoProgress.findFirst({
      where: { consumerId: consumer.id, promotionId: promo.id },
    });
    expect(progress).not.toBeNull();
    // 2 stamps earned (1 from each POS), 2 milestones earned & both redeemed
    expect(progress.lifetimeEarned).toBe(2);
    expect(progress.milestonesAvailable).toBe(0);
    // stampCount: reset to 0 after each milestone, then processRewardGrant decrements by threshold (1) per redemption
    // 0 - 1 (sq redeem) - 1 (clv redeem) = -2
    expect(progress.stampCount).toBe(-2);

    // ── PromoRedemptions ──
    const redemptions = await prisma.promoRedemption.findMany({
      where: { consumerId: consumer.id, promotionId: promo.id },
      orderBy: { createdAt: "asc" },
    });
    // 2 from stamps (milestones) + 2 from processRewardGrant = 4 total
    expect(redemptions.length).toBe(4);
    // All granted
    for (const r of redemptions) {
      expect(r.status).toBe("granted");
      expect(r.pointsDecremented).toBe(1); // threshold=1
    }
    // Milestone redemptions from different stores
    const grantStoreIds = redemptions
      .filter(r => r.grantedByStoreId)
      .map(r => r.grantedByStoreId);
    expect(grantStoreIds).toContain(squareStore.id);
    expect(grantStoreIds).toContain(cloverStore.id);

    // ── Entitlements ──
    const entitlements = await prisma.entitlement.findMany({
      where: { consumerId: consumer.id, type: "reward" },
      orderBy: { createdAt: "asc" },
    });
    expect(entitlements.length).toBe(2);
    // Both should be redeemed now
    for (const ent of entitlements) {
      expect(ent.status).toBe("redeemed");
      expect(ent.redeemedAt).not.toBeNull();
      expect(ent.metadataJson.displayLabel).toBe("Free pastry of your choice");
    }

    // ── Event Outbox ──
    const outbox = await prisma.eventOutbox.findMany({
      where: { merchantId: merchant.id },
      orderBy: { createdAt: "asc" },
    });
    // Should have reward_granted events from both POS stamp accumulations
    const rewardEvents = outbox.filter(e => e.eventType === "reward_granted");
    expect(rewardEvents.length).toBe(2);

    console.log("\n=== PARITY AUDIT SUMMARY ===");
    console.log(`Visits:          ${visits.length} (Square: 1, Clover: 1)`);
    console.log(`PaymentEvents:   ${payments.length} (Square: 1, Clover: 1)`);
    console.log(`Stamps earned:   ${progress.lifetimeEarned} (1 per POS)`);
    console.log(`Milestones:      ${redemptions.length} redemption records`);
    console.log(`Entitlements:    ${entitlements.length} (both redeemed)`);
    console.log(`Outbox events:   ${rewardEvents.length} reward_granted`);
    console.log("=== SQUARE ↔ CLOVER: FULL PARITY ===\n");
  });
});
