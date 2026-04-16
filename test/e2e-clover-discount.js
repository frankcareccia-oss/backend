/**
 * e2e-clover-discount.js — End-to-end Clover discount reward test
 *
 * Tests the full pipeline against the real Clover sandbox:
 *   1. Seed local DB with Brewed Awakening merchant + Clover connection + promotion
 *   2. Create a Clover customer with known phone
 *   3. Create orders via Clover API, simulate payment webhooks
 *   4. Verify: stamps accumulate → milestone → discount applied to Clover order
 *
 * Usage: node test/e2e-clover-discount.js
 * Requires: .env with CLOVER_API_BASE, TOKEN_ENCRYPTION_KEY
 */

"use strict";

require("dotenv").config();

const { PrismaClient } = require("@prisma/client");
const { encrypt } = require("../src/utils/encrypt");

const prisma = new PrismaClient();

// ── Clover sandbox config ──
const CLOVER_TOKEN = "2035b155-f94c-4ac0-f08e-35dcc26fd031"; // Brewed Awakening
const CLOVER_MID = "JB0AQ7GDQCWA1";
const CLOVER_API = process.env.CLOVER_API_BASE || "https://apisandbox.dev.clover.com";
const TEST_PHONE = "+14085559999";
const BACKEND_URL = "http://localhost:3001";

async function cloverApi(method, path, body) {
  const opts = {
    method,
    headers: { Authorization: `Bearer ${CLOVER_TOKEN}`, "Content-Type": "application/json" },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${CLOVER_API}/v3/merchants/${CLOVER_MID}${path}`, opts);
  const data = await res.json();
  if (!res.ok) throw new Error(`Clover ${method} ${path}: ${res.status} ${data?.message || JSON.stringify(data)}`);
  return data;
}

async function sendWebhook(payload) {
  const res = await fetch(`${BACKEND_URL}/webhooks/clover`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: await res.json() };
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Main ──

async function main() {
  console.log("═══════════════════════════════════════════════════");
  console.log("  E2E Clover Discount Reward Test");
  console.log("═══════════════════════════════════════════════════\n");

  // ── Step 0: Verify Clover API access ──
  console.log("Step 0: Verify Clover API access...");
  const merchant = await cloverApi("GET", "");
  console.log(`  ✓ Connected to "${merchant.name}" (${CLOVER_MID})\n`);

  // ── Step 1: Seed local DB ──
  console.log("Step 1: Seed local DB (Brewed Awakening + promotion)...");

  // Clean up any previous test data
  await prisma.posRewardDiscount.deleteMany({});
  await prisma.entitlement.deleteMany({});
  await prisma.promoRedemption.deleteMany({});
  await prisma.consumerPromoProgress.deleteMany({});
  await prisma.posOrder.deleteMany({});
  await prisma.visit.deleteMany({});
  await prisma.posLocationMap.deleteMany({});
  await prisma.posConnection.deleteMany({});
  await prisma.promotion.deleteMany({});

  // Find or create merchant
  let pvMerchant = await prisma.merchant.findFirst({ where: { name: "Brewed Awakening" } });
  if (!pvMerchant) {
    pvMerchant = await prisma.merchant.create({ data: { name: "Brewed Awakening", status: "active" } });
  }

  // Find or create store
  let pvStore = await prisma.store.findFirst({ where: { merchantId: pvMerchant.id, name: "Brewed Awakening Main" } });
  if (!pvStore) {
    pvStore = await prisma.store.create({
      data: { merchantId: pvMerchant.id, name: "Brewed Awakening Main", phoneRaw: "408-555-1212" },
    });
  }

  // Create Clover POS connection
  const posConn = await prisma.posConnection.create({
    data: {
      merchantId: pvMerchant.id,
      posType: "clover",
      externalMerchantId: CLOVER_MID,
      accessTokenEnc: encrypt(CLOVER_TOKEN),
      status: "active",
    },
  });

  // Map Clover merchant to PV store
  await prisma.posLocationMap.create({
    data: {
      posConnectionId: posConn.id,
      externalLocationId: CLOVER_MID,
      externalLocationName: "Brewed Awakening",
      pvStoreId: pvStore.id,
      pvStoreName: pvStore.name,
      active: true,
    },
  });

  // Create promotion: "Buy 2, get $3 off" (low threshold for testing)
  const promo = await prisma.promotion.create({
    data: {
      merchantId: pvMerchant.id,
      name: "Buy 2 Get $3 Off",
      mechanic: "stamps",
      threshold: 2,
      repeatable: true,
      rewardType: "discount_fixed",
      rewardValue: 300, // $3.00
      status: "active",
    },
  });

  // Create or find PV consumer matching test phone
  let pvConsumer = await prisma.consumer.findUnique({ where: { phoneE164: TEST_PHONE } });
  if (!pvConsumer) {
    pvConsumer = await prisma.consumer.create({
      data: { phoneE164: TEST_PHONE, firstName: "E2E", lastName: "Tester", phoneCountry: "US" },
    });
  }

  console.log(`  ✓ Merchant: ${pvMerchant.id} (${pvMerchant.name})`);
  console.log(`  ✓ Store: ${pvStore.id} (${pvStore.name})`);
  console.log(`  ✓ PosConnection: ${posConn.id} (clover → ${CLOVER_MID})`);
  console.log(`  ✓ Promotion: ${promo.id} (${promo.name}, threshold=${promo.threshold})`);
  console.log(`  ✓ Consumer: ${pvConsumer.id} (${TEST_PHONE})\n`);

  // ── Step 2: Create Clover customer with matching phone ──
  console.log("Step 2: Create Clover customer with matching phone...");
  let cloverCustomer;
  try {
    cloverCustomer = await cloverApi("POST", "/customers", {
      firstName: "E2E",
      lastName: "Tester",
      phoneNumbers: [{ phoneNumber: TEST_PHONE }],
    });
    console.log(`  ✓ Clover customer created: ${cloverCustomer.id}\n`);
  } catch (e) {
    console.log(`  ⚠ Customer creation failed (may already exist): ${e.message}`);
    // Try to find existing
    const search = await cloverApi("GET", `/customers?filter=phoneNumber=${encodeURIComponent(TEST_PHONE)}`);
    cloverCustomer = search.elements?.[0];
    if (cloverCustomer) {
      console.log(`  ✓ Found existing Clover customer: ${cloverCustomer.id}\n`);
    } else {
      throw new Error("Could not create or find Clover customer");
    }
  }

  // ── Step 3: Visit 1 — Create Clover order + direct pipeline ──
  // NOTE: Clover sandbox doesn't allow creating payments via API (requires POS device).
  // So we create real Clover orders, then drive the pipeline directly via accumulateStamps
  // and applyPendingCloverRewards — same code path the webhook would call.
  const { accumulateStamps } = require("../src/pos/pos.stamps");

  console.log("Step 3: Visit 1 — Create Clover order + run pipeline...");
  const order1 = await cloverApi("POST", "/orders", { state: "open" });
  await cloverApi("POST", `/orders/${order1.id}/line_items`, { name: "Large Latte", price: 500 });
  console.log(`  ✓ Clover order 1 created: ${order1.id} (Large Latte $5.00)`);

  // Create visit (simulating what the webhook would do)
  const visit1 = await prisma.visit.create({
    data: {
      storeId: pvStore.id, merchantId: pvMerchant.id, consumerId: pvConsumer.id,
      source: "clover_webhook", status: "identified",
      posVisitId: `clover:e2e_pay_1_${Date.now()}`,
      metadata: { cloverMerchantId: CLOVER_MID, orderId: order1.id, amountCents: 500 },
    },
  });

  // Run stamp accumulation (same function the webhook calls)
  await accumulateStamps(prisma, {
    consumerId: pvConsumer.id, merchantId: pvMerchant.id,
    storeId: pvStore.id, visitId: visit1.id, posType: "clover", orderId: order1.id,
  });

  await sleep(1000);

  let progress = await prisma.consumerPromoProgress.findFirst({
    where: { consumerId: pvConsumer.id, promotionId: promo.id },
  });
  console.log(`  ✓ Stamps after visit 1: ${progress?.stampCount || 0}/${promo.threshold}\n`);

  // ── Step 4: Visit 2 — Milestone! Discount should be created ──
  console.log("Step 4: Visit 2 — Milestone! Creating Clover order + running pipeline...");
  const order2 = await cloverApi("POST", "/orders", { state: "open" });
  await cloverApi("POST", `/orders/${order2.id}/line_items`, { name: "Cappuccino", price: 450 });
  await cloverApi("POST", `/orders/${order2.id}/line_items`, { name: "Croissant", price: 350 });
  console.log(`  ✓ Clover order 2 created: ${order2.id} (Cappuccino $4.50 + Croissant $3.50 = $8.00)`);

  const visit2 = await prisma.visit.create({
    data: {
      storeId: pvStore.id, merchantId: pvMerchant.id, consumerId: pvConsumer.id,
      source: "clover_webhook", status: "identified",
      posVisitId: `clover:e2e_pay_2_${Date.now()}`,
      metadata: { cloverMerchantId: CLOVER_MID, orderId: order2.id, amountCents: 800 },
    },
  });

  // Check and apply pending rewards from any previous milestones
  const { applyPendingCloverRewards } = require("../src/pos/pos.clover.discount");
  await applyPendingCloverRewards({ consumerId: pvConsumer.id, merchantId: pvMerchant.id, posConnection: posConn, orderId: order2.id });

  // Run stamp accumulation — this should trigger milestone (stamp 2 of 2)
  await accumulateStamps(prisma, {
    consumerId: pvConsumer.id, merchantId: pvMerchant.id,
    storeId: pvStore.id, visitId: visit2.id, posType: "clover", orderId: order2.id,
  });

  await sleep(2000);

  // Check stamps (should be back to 0 after milestone)
  progress = await prisma.consumerPromoProgress.findFirst({
    where: { consumerId: pvConsumer.id, promotionId: promo.id },
  });
  console.log(`  ✓ Stamps after visit 2: ${progress?.stampCount || 0}/${promo.threshold} (should be 0 = milestone hit)`);

  // Check entitlement
  const entitlements = await prisma.entitlement.findMany({
    where: { consumerId: pvConsumer.id, type: "reward", status: "active" },
  });
  console.log(`  ✓ Active entitlements: ${entitlements.length} (should be 1)`);

  // Check PosRewardDiscount
  const discounts = await prisma.posRewardDiscount.findMany({
    where: { consumerId: pvConsumer.id },
    orderBy: { createdAt: "desc" },
  });
  console.log(`  ✓ PosRewardDiscount records: ${discounts.length}`);
  for (const d of discounts) {
    console.log(`    → ${d.discountName} | status: ${d.status} | order: ${d.cloverOrderId || "(pending)"}`);
  }

  // ── Step 5: Verify discount on Clover ──
  console.log("\nStep 5: Verify discount on Clover order...");

  // Check if any pending discount was applied to the second order
  const appliedDiscount = discounts.find(d => d.status === "applied");
  const pendingDiscount = discounts.find(d => d.status === "pending");

  if (appliedDiscount) {
    console.log(`  ✓ Discount APPLIED to order ${appliedDiscount.cloverOrderId}`);

    // Fetch the order from Clover to verify
    const cloverOrder = await cloverApi("GET", `/orders/${appliedDiscount.cloverOrderId}?expand=discounts,lineItems`);
    console.log(`  ✓ Clover order total: ${cloverOrder.total || "N/A"} cents`);
    console.log(`  ✓ Clover discounts: ${cloverOrder.discounts?.elements?.length || 0}`);
    if (cloverOrder.discounts?.elements) {
      for (const d of cloverOrder.discounts.elements) {
        console.log(`    → "${d.name}" amount: ${d.amount} percentage: ${d.percentage || "N/A"}`);
      }
    }
  } else if (pendingDiscount) {
    console.log(`  ✓ Discount stored as PENDING (next visit will apply it)`);
    console.log(`    → ${pendingDiscount.discountName}`);

    // Create visit 3 to trigger pending reward application
    console.log("\n  Step 5b: Visit 3 — Apply pending reward...");
    const order3 = await cloverApi("POST", "/orders", { state: "open" });
    await cloverApi("POST", `/orders/${order3.id}/line_items`, { name: "Americano", price: 400 });
    await cloverApi("POST", `/orders/${order3.id}/line_items`, { name: "Bagel", price: 350 });
    console.log(`  ✓ Clover order 3 created: ${order3.id} (Americano $4.00 + Bagel $3.50 = $7.50)`);

    const visit3 = await prisma.visit.create({
      data: {
        storeId: pvStore.id, merchantId: pvMerchant.id, consumerId: pvConsumer.id,
        source: "clover_webhook", status: "identified",
        posVisitId: `clover:e2e_pay_3_${Date.now()}`,
        metadata: { cloverMerchantId: CLOVER_MID, orderId: order3.id, amountCents: 750 },
      },
    });

    const { applyPendingCloverRewards: applyPending3 } = require("../src/pos/pos.clover.discount");
    await applyPending3({ consumerId: pvConsumer.id, merchantId: pvMerchant.id, posConnection: posConn, orderId: order3.id });
    console.log(`  ✓ Pending rewards checked on order 3`);

    await sleep(3000);

    // Check if the pending reward was now applied
    const updated = await prisma.posRewardDiscount.findUnique({ where: { id: pendingDiscount.id } });
    if (updated.status === "applied") {
      console.log(`  ✓ Pending discount NOW APPLIED to order ${updated.cloverOrderId}`);

      // Verify on Clover
      const cloverOrder = await cloverApi("GET", `/orders/${updated.cloverOrderId}?expand=discounts,lineItems`);
      console.log(`  ✓ Clover order discounts: ${cloverOrder.discounts?.elements?.length || 0}`);
      if (cloverOrder.discounts?.elements) {
        for (const d of cloverOrder.discounts.elements) {
          console.log(`    → "${d.name}" amount: ${d.amount}`);
        }
      }

      console.log("\n  ✅ Go verify in Clover dashboard:");
      console.log(`     https://sandbox.dev.clover.com/dashboard → Orders → search for ${updated.cloverOrderId}`);
    } else {
      console.log(`  ⚠ Discount still ${updated.status}: ${updated.skippedReason || "unknown"}`);
    }
  } else {
    console.log("  ⚠ No discount records found — check pipeline logs above");
  }

  // ── Summary ──
  console.log("\n═══════════════════════════════════════════════════");
  console.log("  E2E RESULTS");
  console.log("═══════════════════════════════════════════════════");

  const visits = await prisma.visit.findMany({ where: { merchantId: pvMerchant.id }, orderBy: { createdAt: "asc" } });
  const orders = await prisma.posOrder.findMany({ where: { merchantId: pvMerchant.id } });
  const allDiscounts = await prisma.posRewardDiscount.findMany({ where: { consumerId: pvConsumer.id } });

  console.log(`  Visits created: ${visits.length}`);
  console.log(`  Orders enriched: ${orders.length}`);
  console.log(`  Entitlements: ${entitlements.length}`);
  console.log(`  Discount records: ${allDiscounts.length} (${allDiscounts.filter(d=>d.status==="applied").length} applied, ${allDiscounts.filter(d=>d.status==="pending").length} pending)`);
  console.log("═══════════════════════════════════════════════════\n");
}

main()
  .catch((e) => {
    console.error("\n❌ E2E test failed:", e.message);
    console.error(e.stack);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
