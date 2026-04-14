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

const CLOVER_WEBHOOK_SECRET = process.env.CLOVER_WEBHOOK_SECRET || "";

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
    express.raw({ type: "*/*" }),
    async (req, res) => {
      const rawBody = req.rawBody || req.body || Buffer.alloc(0);
      const signature = req.headers["x-clover-hmac"] || "";

      // Always respond 200 quickly — Clover expects fast ACK
      // Verification requests just need a 200
      let event;
      try {
        const bodyStr = rawBody.toString("utf8");
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

      // Process payment events
      if (merchantEvents.payments) {
        for (const payment of merchantEvents.payments) {
          await handleCloverPayment(conn, cloverMerchantId, payment);
        }
      }

      // Process order events
      if (merchantEvents.orders) {
        for (const order of merchantEvents.orders) {
          console.log("[clover.webhook] order event:", order.type, order.objectId);
        }
      }
    }
  }

  return { processed: true };
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

  // Stamp accumulation for identified consumers
  if (consumerId) {
    try {
      await accumulateStamps(prisma, {
        consumerId,
        merchantId,
        storeId: pvStoreId,
        visitId: visit.id,
      });
    } catch (e) {
      console.error("[clover.webhook] accumulateStamps error:", e?.message);
    }
  }

  return { visitId: visit.id, consumerId, identified: !!consumerId };
}

module.exports = { registerCloverWebhookRoute };
