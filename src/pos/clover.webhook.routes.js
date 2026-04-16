/**
 * clover.webhook.routes.js — Clover webhook ingestion
 *
 * Receives Clover webhook events, verifies signature,
 * and dispatches to PV visit/stamp pipeline.
 *
 * Must be mounted with express.raw BEFORE express.json (same as Square).
 *
 * Clover webhook verification:
 * - Clover sends a verification code to confirm endpoint ownership
 * - Endpoint must respond with 200 to any POST
 */

const express = require("express");
const crypto = require("crypto");
const { prisma } = require("../db/prisma");
const { recordPaymentEvent } = require("../payments/paymentEvent.service");
const { accumulateStamps } = require("./pos.stamps");
const { writeEventLog } = require("../eventlog/eventlog");
const { CloverAdapter } = require("./adapters/clover.adapter");

const { syncCatalogFromPos } = require("./pos.catalog.sync");

const CLOVER_WEBHOOK_SECRET = process.env.CLOVER_WEBHOOK_SECRET || "";
const CLOVER_API_BASE = process.env.CLOVER_API_BASE || "https://apisandbox.dev.clover.com";

// ─── Webhook dedup cache ─────────────────────────────────────────────────────
const DEDUP_TTL_MS = 5 * 60 * 1000;
const recentEventIds = new Map();

function isDuplicateEvent(eventId) {
  if (!eventId) return false;
  if (recentEventIds.has(eventId)) return true;
  recentEventIds.set(eventId, Date.now());
  if (recentEventIds.size > 500) {
    const cutoff = Date.now() - DEDUP_TTL_MS;
    for (const [id, ts] of recentEventIds) {
      if (ts < cutoff) recentEventIds.delete(id);
    }
  }
  return false;
}

/**
 * Normalize a phone string to E.164 format.
 */
function normalizePhone(raw) {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

/**
 * Check for duplicate Clover customers sharing the same phone number.
 * If duplicates found, creates or updates a DuplicateCustomerAlert.
 */
async function checkDuplicateCloverCustomers(adapter, phoneE164, merchantId, posConnectionId, cloverMerchantId) {
  if (!phoneE164) return null;
  try {
    const accessToken = require("../utils/encrypt").decrypt(adapter.conn.accessTokenEnc);
    const res = await fetch(
      `${CLOVER_API_BASE}/v3/merchants/${cloverMerchantId}/customers?filter=phoneNumber=${encodeURIComponent(phoneE164)}&expand=phoneNumbers`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    const data = await res.json();
    const customers = data.elements || [];
    if (customers.length <= 1) return null;

    const customerIds = customers.map(c => ({
      id: c.id,
      name: [c.firstName, c.lastName].filter(Boolean).join(" ") || "(no name)",
      phone: phoneE164,
    }));

    const existing = await prisma.duplicateCustomerAlert.findFirst({
      where: { posConnectionId, phoneE164, status: "pending" },
    });

    if (existing) {
      await prisma.duplicateCustomerAlert.update({
        where: { id: existing.id },
        data: { squareCustomerIds: customerIds, updatedAt: new Date() },
      });
    } else {
      await prisma.duplicateCustomerAlert.create({
        data: {
          merchantId,
          posConnectionId,
          phoneE164,
          squareCustomerIds: customerIds,
          status: "pending",
        },
      });
    }

    console.warn(`[clover.webhook] duplicate customers detected: phone=${phoneE164} count=${customers.length} merchant=${merchantId}`);
    console.log(JSON.stringify({
      pvHook: "clover.customer.duplicate",
      ts: new Date().toISOString(),
      tc: "TC-CLO-CUST-01",
      sev: "warn",
      phoneE164,
      count: customers.length,
      merchantId,
    }));
    return { duplicates: customers.length };
  } catch (e) {
    console.error("[clover.webhook] duplicate customer check error:", e?.message || String(e));
    return null;
  }
}

/**
 * Verify Clover webhook signature.
 * Clover signs webhooks with HMAC-SHA256 using the app secret.
 */
function verifyCloverSignature(rawBody, signature) {
  if (!CLOVER_WEBHOOK_SECRET || process.env.NODE_ENV !== "production") {
    return true; // Skip in dev/sandbox
  }

  try {
    const expected = crypto
      .createHmac("sha256", CLOVER_WEBHOOK_SECRET)
      .update(rawBody)
      .digest("hex");

    return crypto.timingSafeEqual(
      Buffer.from(expected),
      Buffer.from(String(signature))
    );
  } catch {
    return false;
  }
}

/**
 * Register the Clover webhook endpoint.
 * Call BEFORE app.use(express.json()).
 */
function registerCloverWebhookRoute(app) {
  app.post(
    "/webhooks/clover",
    async (req, res) => {
      const rawBody = req.rawBody || req.body || Buffer.alloc(0);
      const signature = req.headers["x-clover-hmac"] || "";

      console.log("[clover.webhook] raw body type:", typeof rawBody, "length:", rawBody?.length, "isBuffer:", Buffer.isBuffer(rawBody));

      // Always respond 200 quickly — Clover expects fast ACK
      // Verification requests just need a 200
      let event;
      try {
        const bodyStr = typeof rawBody === "string" ? rawBody : rawBody.toString("utf8");
        console.log("[clover.webhook] bodyStr:", bodyStr.slice(0, 300));
        if (!bodyStr || bodyStr.trim() === "") {
          // Empty body = verification ping
          console.log("[clover.webhook] verification ping received");
          return res.status(200).json({ received: true, verified: true });
        }
        event = JSON.parse(bodyStr);
      } catch (e) {
        console.log("[clover.webhook] non-JSON body (possibly verification):", rawBody.toString("utf8").slice(0, 100));
        return res.status(200).json({ received: true });
      }

      if (!verifyCloverSignature(rawBody, signature)) {
        console.warn("[clover.webhook] signature verification failed");
        // Still return 200 in sandbox to not block testing
        if (process.env.NODE_ENV === "production") {
          return res.status(403).json({ error: "Invalid signature" });
        }
      }

      // Clover webhook payload structure varies by event type
      // Common fields: type, merchantId, objectId, ts
      const eventType = event.type || event.eventType || "unknown";
      const merchantId = event.merchantId || event.merchant_id || null;

      console.log("[clover.webhook] received:", eventType, "merchant:", merchantId);

      // Respond 200 immediately
      res.status(200).json({ received: true });

      // Dispatch asynchronously
      try {
        await dispatchCloverEvent(event);
      } catch (e) {
        console.error("[clover.webhook] dispatch error:", e?.message || String(e));
      }
    }
  );
}

/**
 * Process a Clover webhook event.
 * Handles: payment events, order events, inventory updates
 */
async function dispatchCloverEvent(event) {
  const eventType = event.type || event.eventType || "unknown";

  // Clover event types we care about:
  // - "CREATE" with appId for orders/payments
  // - Inventory updates
  // The exact structure depends on the webhook subscription

  console.log("[clover.webhook] dispatching:", eventType, JSON.stringify(event).slice(0, 300));

  // For now, log the event structure so we can understand it
  // Full processing will be built once we see real webhook payloads

  // If this looks like a payment/order event, record it
  if (event.merchants && typeof event.merchants === "object") {
    for (const [cloverMerchantId, merchantEvents] of Object.entries(event.merchants)) {
      // Find PV merchant via PosConnection
      const conn = await prisma.posConnection.findFirst({
        where: { externalMerchantId: cloverMerchantId, posType: "clover", status: "active" },
      });

      if (!conn) {
        console.warn("[clover.webhook] no PosConnection for Clover merchant:", cloverMerchantId);
        continue;
      }

      // Clover sends events in two formats:
      // 1. Flat array: [{ objectId: "P:xxx", type: "CREATE" }, { objectId: "O:yyy", ... }]
      // 2. Keyed object: { payments: [...], orders: [...] }
      // Normalize to keyed format.
      let payments = [];
      let orders = [];
      let customers = [];
      let catalogItems = [];

      if (Array.isArray(merchantEvents)) {
        // Real Clover format — flat array with prefixed objectIds
        for (const evt of merchantEvents) {
          const oid = evt.objectId || "";
          if (oid.startsWith("P:")) {
            payments.push({ ...evt, objectId: oid.slice(2) });
          } else if (oid.startsWith("O:")) {
            orders.push({ ...evt, objectId: oid.slice(2) });
          } else if (oid.startsWith("C:")) {
            customers.push({ ...evt, objectId: oid.slice(2) });
          } else if (oid.startsWith("I:") || oid.startsWith("IC:")) {
            catalogItems.push(evt);
          }
        }
      } else {
        // Test/legacy format — keyed by type
        payments = merchantEvents.payments || [];
        orders = merchantEvents.orders || [];
        customers = merchantEvents.customers || [];
        catalogItems = [...(merchantEvents.items || []), ...(merchantEvents.item_categories || [])];
      }

      // Process payment events
      for (const payment of payments) {
        const dedupKey = `clover:pay:${cloverMerchantId}:${payment.objectId}:${payment.type}`;
        if (isDuplicateEvent(dedupKey)) {
          console.log("[clover.webhook] dedup skip:", dedupKey);
          continue;
        }
        await handleCloverPayment(conn, cloverMerchantId, payment);
      }

      // Process inventory/catalog events
      if (catalogItems.length > 0) {
        const dedupKey = `clover:catalog:${cloverMerchantId}:${Date.now()}`;
        if (!isDuplicateEvent(dedupKey)) {
          handleCloverCatalogUpdate(conn, cloverMerchantId).catch(e => {
            console.error("[clover.webhook] catalog sync error:", e?.message);
          });
        }
      }

      // Process customer events
      for (const custEvent of customers) {
        if (custEvent.type === "CREATE") {
          handleCloverCustomerCreated(conn, cloverMerchantId, custEvent).catch(e => {
            console.error("[clover.webhook] customer created handler error:", e?.message);
          });
        }
      }

      // Log order events (discount templates are applied by associate on register,
      // not injected by PV on order update — see docs/clover-reward-redemption-flow.md)
      for (const order of orders) {
        console.log("[clover.webhook] order event:", order.type, order.objectId);
      }
    }
  }

  return { processed: true };
}

/**
 * Handle Clover catalog update — trigger a full catalog re-sync.
 */
async function handleCloverCatalogUpdate(conn, cloverMerchantId) {
  const adapter = new CloverAdapter(conn);
  const result = await syncCatalogFromPos(prisma, adapter, {
    merchantId: conn.merchantId,
    posConnectionId: conn.id,
    trigger: "webhook",
  });
  console.log(JSON.stringify({
    pvHook: "clover.catalog.synced",
    ts: new Date().toISOString(),
    tc: "TC-CLO-CAT-01",
    sev: "info",
    merchantId: conn.merchantId,
    summary: result?.summary || null,
  }));
  return result;
}

/**
 * Handle Clover customer.created — check for duplicates by phone.
 */
async function handleCloverCustomerCreated(conn, cloverMerchantId, custEvent) {
  const custId = custEvent.objectId;
  if (!custId) return;

  const adapter = new CloverAdapter(conn);
  const accessToken = require("../utils/encrypt").decrypt(conn.accessTokenEnc);

  // Fetch the customer to get their phone
  try {
    const res = await fetch(
      `${CLOVER_API_BASE}/v3/merchants/${cloverMerchantId}/customers/${custId}?expand=phoneNumbers`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    const customer = await res.json();
    const phone = customer.phoneNumbers?.elements?.[0]?.phoneNumber;
    if (!phone) return;

    const phoneE164 = normalizePhone(phone);
    if (!phoneE164) return;

    await checkDuplicateCloverCustomers(adapter, phoneE164, conn.merchantId, conn.id, cloverMerchantId);
  } catch (e) {
    console.error("[clover.webhook] customer created duplicate check error:", e?.message);
  }
}

/**
 * Detect if a PV discount template was applied to a Clover order.
 * Called after payment webhook — scans order discounts for PV-branded names,
 * marks the reward as redeemed, updates entitlement, and deletes the template.
 */
async function detectCloverDiscountRedemption(adapter, { consumerId, merchantId, orderId, conn }) {
  try {
    const accessToken = require("../utils/encrypt").decrypt(conn.accessTokenEnc);
    const cloverMid = conn.externalMerchantId;

    // Fetch order with discounts
    const order = await adapter._cloverFetch(`/orders/${orderId}?expand=discounts`);
    const discounts = order?.discounts?.elements || [];

    if (!discounts.length) return;

    // Find activated PV rewards for this consumer + merchant
    const activatedRewards = await prisma.posRewardDiscount.findMany({
      where: { consumerId, merchantId, status: "activated", cloverDiscountId: { not: null } },
    });

    if (!activatedRewards.length) {
      // Also check by name pattern as fallback
      const pvDiscounts = discounts.filter(d => d.name && d.name.startsWith("PerkValet"));
      if (pvDiscounts.length > 0) {
        console.log(`[clover.webhook] PV-branded discount found on order ${orderId} but no matching activated reward`);
      }
      return;
    }

    // Match by discount template ID or by name
    for (const reward of activatedRewards) {
      const matchById = discounts.find(d => d.id === reward.cloverDiscountId);
      const matchByName = !matchById ? discounts.find(d => d.name === reward.discountName) : null;
      const match = matchById || matchByName;

      if (match) {
        // Mark as redeemed
        await prisma.posRewardDiscount.update({
          where: { id: reward.id },
          data: {
            status: "redeemed",
            cloverOrderId: orderId,
            appliedAt: new Date(),
          },
        });

        // Update entitlement if linked
        if (reward.entitlementId) {
          await prisma.entitlement.update({
            where: { id: reward.entitlementId },
            data: { status: "redeemed" },
          }).catch(() => {}); // ignore if already redeemed
        }

        // Delete the discount template from Clover register (cleanup)
        if (reward.cloverDiscountId) {
          try {
            await fetch(`${CLOVER_API_BASE}/v3/merchants/${cloverMid}/discounts/${reward.cloverDiscountId}`, {
              method: "DELETE",
              headers: { Authorization: `Bearer ${accessToken}` },
            });
            console.log(`[clover.webhook] deleted discount template ${reward.cloverDiscountId} from register`);
          } catch (delErr) {
            console.warn(`[clover.webhook] could not delete template ${reward.cloverDiscountId}:`, delErr?.message);
          }
        }

        console.log(`[clover.webhook] discount redeemed: reward ${reward.id} on order ${orderId}`);
        console.log(JSON.stringify({
          pvHook: "clover.discount.redeemed",
          ts: new Date().toISOString(),
          tc: "TC-CLO-DISC-07",
          sev: "info",
          consumerId,
          merchantId,
          orderId,
          rewardId: reward.id,
          discountName: reward.discountName,
        }));
      }
    }
  } catch (e) {
    console.error(`[clover.webhook] discount redemption detection error: orderId=${orderId}`, e?.message || String(e));
  }
}

/**
 * Fetch Clover order line items and store in PosOrder + PosOrderItem.
 * Fire-and-forget — never blocks the pipeline.
 */
async function enrichCloverOrderData(adapter, { visitId, merchantId, storeId, consumerId, orderId, cloverMerchantId }) {
  if (!orderId) return;
  try {
    const order = await adapter.getOrder(orderId);
    if (!order) return;

    const lineItems = order.lineItems?.elements || [];

    const posOrder = await prisma.posOrder.create({
      data: {
        visitId,
        merchantId,
        storeId,
        consumerId: consumerId || null,
        externalOrderId: orderId,
        posType: "clover",
        orderState: order.state || order.paymentState || null,
        totalAmount: order.total || null,
        totalTax: null,
        totalDiscount: null,
        totalTip: null,
        currency: order.currency || "USD",
        rawJson: order,
        items: {
          create: lineItems.map((li) => ({
            itemName: li.name || null,
            itemSku: li.item?.id || null,
            variationName: null,
            variationId: null,
            categoryName: null,
            quantity: 1,
            unitPrice: li.price || null,
            totalPrice: li.price || null,
            totalTax: null,
            totalDiscount: null,
            itemType: li.isRevenue ? "ITEM" : "FEE",
            rawJson: li,
          })),
        },
      },
    });

    console.log(`[clover.webhook] order enriched: orderId=${orderId} items=${lineItems.length} posOrderId=${posOrder.id}`);
    console.log(JSON.stringify({
      pvHook: "clover.order.enriched",
      ts: new Date().toISOString(),
      tc: "TC-CLO-ORD-01",
      sev: "info",
      orderId,
      merchantId,
      itemCount: lineItems.length,
    }));
  } catch (e) {
    console.error(`[clover.webhook] order enrichment failed: orderId=${orderId}`, e?.message || String(e));
  }
}

/**
 * Handle a Clover payment event.
 * Full pipeline: fetch payment → resolve location → resolve consumer → create visit → stamps
 */
async function handleCloverPayment(conn, cloverMerchantId, paymentEvent) {
  const paymentId = paymentEvent.objectId || paymentEvent.id;
  const eventAction = paymentEvent.type || "unknown"; // CREATE, UPDATE, DELETE

  if (!paymentId) return;

  console.log("[clover.webhook] payment:", eventAction, paymentId);

  const posVisitId = "clover:" + paymentId;

  // Idempotency: skip if this payment was already processed
  const existing = await prisma.visit.findFirst({
    where: { posVisitId },
    select: { id: true },
  });
  if (existing) {
    console.log("[clover.webhook] duplicate payment:", paymentId, "→ visit", existing.id);
    return { duplicate: true, visitId: existing.id };
  }

  // Resolve location → PV store
  // Clover merchant ID IS the location (no multi-location like Square)
  const locationMap = await prisma.posLocationMap.findFirst({
    where: { externalLocationId: cloverMerchantId, active: true },
    include: { posConnection: true },
  });

  if (!locationMap) {
    console.warn("[clover.webhook] no location map for Clover merchant:", cloverMerchantId);
    return { skipped: true, reason: "unmapped location" };
  }

  const { pvStoreId } = locationMap;
  const merchantId = conn.merchantId;

  // Fetch payment details from Clover API for amount + order info
  const adapter = new CloverAdapter(conn);
  let paymentDetails = null;
  let amountCents = 0;
  let orderId = null;
  try {
    paymentDetails = await adapter.getPayment(paymentId);
    amountCents = paymentDetails?.amount || 0;
    orderId = paymentDetails?.order?.id || null;
  } catch (e) {
    console.warn("[clover.webhook] could not fetch payment details:", e?.message);
    // Continue anyway — we can still create the visit without amount details
  }

  // Resolve consumer via Clover order's customer (phone match)
  let consumerId = null;
  if (orderId) {
    try {
      const order = await adapter.getOrder(orderId);
      consumerId = await adapter.resolveConsumer(order);
    } catch (e) {
      console.warn("[clover.webhook] consumer resolution error:", e?.message);
    }
  }

  // Duplicate customer detection (fire-and-forget)
  if (consumerId) {
    const consumer = await prisma.consumer.findUnique({ where: { id: consumerId }, select: { phoneE164: true } });
    if (consumer?.phoneE164) {
      checkDuplicateCloverCustomers(adapter, consumer.phoneE164, merchantId, conn.id, cloverMerchantId).catch(e => {
        console.error("[clover.webhook] duplicate check error:", e?.message);
      });
    }
  }

  // Create the Visit
  const visit = await prisma.visit.create({
    data: {
      storeId: pvStoreId,
      merchantId,
      consumerId: consumerId || null,
      source: "clover_webhook",
      status: consumerId ? "identified" : "pending_identity",
      posVisitId,
      metadata: {
        cloverPaymentId: paymentId,
        cloverMerchantId,
        amountCents,
        orderId,
        eventAction,
      },
    },
    select: { id: true },
  });

  console.log("[clover.webhook] visit created:", visit.id, consumerId ? "identified" : "pending_identity");

  // Write event log
  writeEventLog(prisma, {
    eventType: "visit.registered",
    merchantId,
    storeId: pvStoreId,
    consumerId: consumerId || null,
    visitId: visit.id,
    source: "clover_webhook",
    outcome: "success",
    payloadJson: { cloverPaymentId: paymentId, cloverMerchantId },
  });

  // Record immutable payment event in audit ledger
  try {
    await recordPaymentEvent({
      eventType: "payment_completed",
      source: "clover",
      merchantId,
      storeId: pvStoreId,
      consumerId: consumerId || null,
      amountCents,
      currency: "usd",
      providerEventId: posVisitId,
      providerOrderId: orderId,
      metadata: {
        cloverMerchantId,
        paymentId,
        eventAction,
        visitId: visit.id,
        posType: "clover",
      },
      emitHook: (name, data) => {
        console.log(JSON.stringify({ pvHook: name, ts: new Date().toISOString(), ...data }));
      },
    });
  } catch (e) {
    console.error("[clover.webhook] PaymentEvent recording error:", e?.message);
  }

  // ── Order enrichment (fire-and-forget) ──
  if (orderId) {
    enrichCloverOrderData(adapter, {
      visitId: visit.id, merchantId, storeId: pvStoreId,
      consumerId: consumerId || null, orderId, cloverMerchantId,
    }).catch(e => console.error("[clover.webhook] order enrichment failed:", e?.message));
  }

  // Stamp accumulation for identified consumers
  if (consumerId) {
    try {
      await accumulateStamps(prisma, {
        consumerId,
        merchantId,
        storeId: pvStoreId,
        visitId: visit.id,
        posType: "clover",
        orderId: orderId || null,
      });
    } catch (e) {
      console.error("[clover.webhook] accumulateStamps error:", e?.message);
    }
  }

  // Detect PV discount redemption on the order (fire-and-forget)
  if (consumerId && orderId) {
    detectCloverDiscountRedemption(adapter, { consumerId, merchantId, orderId, conn }).catch(e => {
      console.error("[clover.webhook] discount redemption detection error:", e?.message);
    });
  }

  return { visitId: visit.id, consumerId, identified: !!consumerId };
}

module.exports = { registerCloverWebhookRoute };
