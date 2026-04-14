/**
 * toast.webhook.routes.js — Toast webhook ingestion
 *
 * Receives Toast webhook events (order completed),
 * and dispatches to PV visit/stamp pipeline.
 *
 * Must be mounted with raw body capture BEFORE express.json (same as Square/Clover).
 *
 * Toast webhook payload:
 *   { timestamp, eventCategory, eventType, guid, details: { restaurantGuid, orderGuid, ... } }
 */

const express = require("express");
const crypto = require("crypto");
const { prisma } = require("../db/prisma");
const { recordPaymentEvent } = require("../payments/paymentEvent.service");
const { accumulateStamps } = require("./pos.stamps");
const { writeEventLog } = require("../eventlog/eventlog");
const { ToastAdapter } = require("./adapters/toast.adapter");

const TOAST_WEBHOOK_SECRET = process.env.TOAST_WEBHOOK_SECRET || "";

/**
 * Verify Toast webhook signature.
 * Toast signs webhooks with HMAC-SHA256 using the webhook secret.
 */
function verifyToastSignature(rawBody, signature) {
  if (!TOAST_WEBHOOK_SECRET || process.env.NODE_ENV !== "production") {
    return true; // Skip in dev/sandbox
  }

  try {
    const expected = crypto
      .createHmac("sha256", TOAST_WEBHOOK_SECRET)
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
 * Register the Toast webhook endpoint.
 * Call BEFORE app.use(express.json()).
 */
function registerToastWebhookRoute(app) {
  app.post(
    "/webhooks/toast",
    express.raw({ type: "*/*" }),
    async (req, res) => {
      const rawBody = req.rawBody || req.body || Buffer.alloc(0);
      const signature = req.headers["x-toast-signature"] || "";

      let event;
      try {
        const bodyStr = rawBody.toString("utf8");
        if (!bodyStr || bodyStr.trim() === "") {
          console.log("[toast.webhook] verification ping received");
          return res.status(200).json({ received: true, verified: true });
        }
        event = JSON.parse(bodyStr);
      } catch (e) {
        console.log("[toast.webhook] non-JSON body:", rawBody.toString("utf8").slice(0, 100));
        return res.status(200).json({ received: true });
      }

      if (!verifyToastSignature(rawBody, signature)) {
        console.warn("[toast.webhook] signature verification failed");
        if (process.env.NODE_ENV === "production") {
          return res.status(403).json({ error: "Invalid signature" });
        }
      }

      const eventType = event.eventType || event.type || "unknown";
      const restaurantGuid = event.restaurantGuid || event.details?.restaurantGuid || null;

      console.log("[toast.webhook] received:", eventType, "restaurant:", restaurantGuid);

      // Respond 200 immediately
      res.status(200).json({ received: true });

      // Dispatch asynchronously
      try {
        await dispatchToastEvent(event);
      } catch (e) {
        console.error("[toast.webhook] dispatch error:", e?.message || String(e));
      }
    }
  );
}

/**
 * Process a Toast webhook event.
 */
async function dispatchToastEvent(event) {
  const eventType = event.eventType || event.type || "unknown";

  console.log("[toast.webhook] dispatching:", eventType, JSON.stringify(event).slice(0, 300));

  // Toast order events we care about:
  // - "ORDER_PAID" or "ORDER_CLOSED" — a completed payment
  const restaurantGuid = event.restaurantGuid || event.details?.restaurantGuid || null;
  const orderGuid = event.orderGuid || event.details?.orderGuid || null;

  if (!restaurantGuid) {
    console.warn("[toast.webhook] no restaurantGuid in event");
    return { skipped: true, reason: "no restaurant" };
  }

  // Only process payment-related events
  const paymentEvents = ["ORDER_PAID", "ORDER_CLOSED", "PAYMENT_COLLECTED"];
  if (!paymentEvents.includes(eventType)) {
    console.log("[toast.webhook] ignoring event type:", eventType);
    return { skipped: true, reason: "non-payment event" };
  }

  // Find PV merchant via PosConnection
  const conn = await prisma.posConnection.findFirst({
    where: { externalMerchantId: restaurantGuid, posType: "toast", status: "active" },
  });

  if (!conn) {
    console.warn("[toast.webhook] no PosConnection for Toast restaurant:", restaurantGuid);
    return { skipped: true, reason: "unmapped restaurant" };
  }

  await handleToastPayment(conn, restaurantGuid, event);
  return { processed: true };
}

/**
 * Handle a Toast payment event.
 * Full pipeline: resolve location → fetch order → resolve consumer → create visit → stamps
 */
async function handleToastPayment(conn, restaurantGuid, event) {
  const orderGuid = event.orderGuid || event.details?.orderGuid || event.guid;
  const eventType = event.eventType || event.type || "unknown";

  if (!orderGuid) return;

  console.log("[toast.webhook] payment:", eventType, orderGuid);

  const posVisitId = "toast:" + orderGuid;

  // Idempotency: skip if already processed
  const existing = await prisma.visit.findFirst({
    where: { posVisitId },
    select: { id: true },
  });
  if (existing) {
    console.log("[toast.webhook] duplicate order:", orderGuid, "→ visit", existing.id);
    return { duplicate: true, visitId: existing.id };
  }

  // Resolve location → PV store
  const locationMap = await prisma.posLocationMap.findFirst({
    where: { externalLocationId: restaurantGuid, active: true },
    include: { posConnection: true },
  });

  if (!locationMap) {
    console.warn("[toast.webhook] no location map for Toast restaurant:", restaurantGuid);
    return { skipped: true, reason: "unmapped location" };
  }

  const { pvStoreId } = locationMap;
  const merchantId = conn.merchantId;

  // Fetch order details from Toast API for amount + customer info
  const adapter = new ToastAdapter(conn);
  let orderDetails = null;
  let amountCents = 0;
  let paymentGuid = null;
  try {
    orderDetails = await adapter.getOrder(orderGuid);
    // Sum all check totals
    for (const check of (orderDetails?.checks || [])) {
      amountCents += Math.round((check.totalAmount || 0) * 100);
      // Get first payment GUID
      if (!paymentGuid && check.payments?.length) {
        paymentGuid = check.payments[0].guid;
      }
    }
  } catch (e) {
    console.warn("[toast.webhook] could not fetch order details:", e?.message);
  }

  // Resolve consumer via order's customer info
  let consumerId = null;
  if (orderDetails) {
    try {
      consumerId = await adapter.resolveConsumer(orderDetails);
    } catch (e) {
      console.warn("[toast.webhook] consumer resolution error:", e?.message);
    }
  }

  // Create the Visit
  const visit = await prisma.visit.create({
    data: {
      storeId: pvStoreId,
      merchantId,
      consumerId: consumerId || null,
      source: "toast_webhook",
      status: consumerId ? "identified" : "pending_identity",
      posVisitId,
      metadata: {
        toastOrderGuid: orderGuid,
        toastRestaurantGuid: restaurantGuid,
        amountCents,
        paymentGuid,
        eventType,
      },
    },
    select: { id: true },
  });

  console.log("[toast.webhook] visit created:", visit.id, consumerId ? "identified" : "pending_identity");

  // Write event log
  writeEventLog(prisma, {
    eventType: "visit.registered",
    merchantId,
    storeId: pvStoreId,
    consumerId: consumerId || null,
    visitId: visit.id,
    source: "toast_webhook",
    outcome: "success",
    payloadJson: { toastOrderGuid: orderGuid, toastRestaurantGuid: restaurantGuid },
  });

  // Record immutable payment event
  try {
    await recordPaymentEvent({
      eventType: "payment_completed",
      source: "toast",
      merchantId,
      storeId: pvStoreId,
      consumerId: consumerId || null,
      amountCents,
      currency: "usd",
      providerEventId: posVisitId,
      providerOrderId: orderGuid,
      metadata: {
        toastRestaurantGuid: restaurantGuid,
        orderGuid,
        paymentGuid,
        eventType,
        visitId: visit.id,
        posType: "toast",
      },
      emitHook: (name, data) => {
        console.log(JSON.stringify({ pvHook: name, ts: new Date().toISOString(), ...data }));
      },
    });
  } catch (e) {
    console.error("[toast.webhook] PaymentEvent recording error:", e?.message);
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
      console.error("[toast.webhook] accumulateStamps error:", e?.message);
    }
  }

  return { visitId: visit.id, consumerId, identified: !!consumerId };
}

module.exports = { registerToastWebhookRoute };
