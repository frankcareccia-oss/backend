/**
 * square.webhook.routes.js — Square webhook ingestion
 *
 * Receives Square webhook events (PAYMENT_COMPLETED, PAYMENT_UPDATED, etc.),
 * verifies HMAC signature, normalises the payload, and dispatches to PV
 * visit/stamp pipeline.
 *
 * IMPORTANT: Must be mounted with express.raw BEFORE express.json.
 * Pattern matches the existing Stripe webhook in index.js.
 *
 * Env vars required:
 *   SQUARE_WEBHOOK_SIGNATURE_KEY — from Square Developer Dashboard
 */

const crypto = require("crypto");
const express = require("express");
const { prisma } = require("../db/prisma");
const { accumulateStamps } = require("./pos.stamps");
const { writeEventLog } = require("../eventlog/eventlog");
const { SquareAdapter } = require("./adapters/square.adapter");
const { syncCatalogFromPos } = require("./pos.catalog.sync");

const SQUARE_WEBHOOK_SIGNATURE_KEY = process.env.SQUARE_WEBHOOK_SIGNATURE_KEY || "";

// ─── HMAC Verification ────────────────────────────────────────────────────────

/**
 * Verify Square webhook signature.
 * Square signs: HMAC-SHA256(notificationUrl + rawBodyString, signatureKey) → base64
 *
 * @param {string} notificationUrl — the full URL Square POSTed to (from req)
 * @param {Buffer} rawBody
 * @param {string} signature — value of x-square-hmacsha256-signature header
 * @returns {boolean}
 */
function verifySquareSignature(notificationUrl, rawBody, signature) {
  if (!SQUARE_WEBHOOK_SIGNATURE_KEY || process.env.NODE_ENV !== "production") {
    console.warn("[square.webhook] Skipping signature verification in non-production");
    return true;
  }

  const message = notificationUrl + rawBody.toString("utf8");
  const expected = crypto
    .createHmac("sha256", SQUARE_WEBHOOK_SIGNATURE_KEY)
    .update(message)
    .digest("base64");

  // Timing-safe compare
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

// ─── Order enrichment ────────────────────────────────────────────────────────

/**
 * Fetch order line items from Square Orders API and store in PosOrder + PosOrderItem.
 * Runs async after visit creation — never blocks the webhook response.
 */
async function enrichOrderData(adapter, { visitId, merchantId, storeId, consumerId, orderId }) {
  if (!orderId) return;

  try {
    const orderData = await adapter._squareFetch(`/orders/${orderId}`);
    const order = orderData?.order;
    if (!order) return;

    const posOrder = await prisma.posOrder.create({
      data: {
        visitId,
        merchantId,
        storeId,
        consumerId: consumerId || null,
        externalOrderId: orderId,
        posType: "square",
        orderState: order.state || null,
        totalAmount: order.total_money?.amount || null,
        totalTax: order.total_tax_money?.amount || null,
        totalDiscount: order.total_discount_money?.amount || null,
        totalTip: order.total_tip_money?.amount || null,
        currency: order.total_money?.currency || "USD",
        rawJson: order,
        items: {
          create: (order.line_items || []).map((li) => ({
            itemName: li.name || null,
            itemSku: li.catalog_object_id || null,
            variationName: li.variation_name || null,
            variationId: li.catalog_version || null,
            categoryName: li.category?.name || null,
            quantity: parseInt(li.quantity, 10) || 1,
            unitPrice: li.base_price_money?.amount || null,
            totalPrice: li.total_money?.amount || null,
            totalTax: li.total_tax_money?.amount || null,
            totalDiscount: li.total_discount_money?.amount || null,
            itemType: li.item_type || null,
            rawJson: li,
          })),
        },
      },
    });

    console.log(`[square.webhook] order enriched: orderId=${orderId} items=${order.line_items?.length || 0} posOrderId=${posOrder.id}`);
  } catch (e) {
    console.error(`[square.webhook] order enrichment failed: orderId=${orderId}`, e?.message || String(e));
  }
}

// ─── Catalog sync handler ────────────────────────────────────────────────────

/**
 * Handle catalog.version.updated — trigger a full catalog re-sync.
 * Finds the PosConnection by externalMerchantId and re-syncs.
 */
async function handleCatalogUpdate(squareMerchantId) {
  if (!squareMerchantId) return { skipped: true, reason: "no merchant_id in event" };

  const conn = await prisma.posConnection.findFirst({
    where: { externalMerchantId: squareMerchantId, posType: "square", status: "active" },
  });

  if (!conn) {
    console.warn(`[square.webhook] catalog update for unknown merchant: ${squareMerchantId}`);
    return { skipped: true, reason: "no PosConnection for merchant" };
  }

  const adapter = new SquareAdapter(conn);
  const result = await syncCatalogFromPos(prisma, adapter, {
    merchantId: conn.merchantId,
    posConnectionId: conn.id,
    trigger: "webhook",
  });

  return { catalogSync: true, ...result.summary };
}

// ─── Event dispatcher ─────────────────────────────────────────────────────────

/**
 * Process a verified Square webhook event.
 * Handles: payment.created/updated, catalog.version.updated
 */
async function dispatchSquareEvent(eventType, data, merchantIdFromEvent) {
  // ── Catalog sync ───────────────────────────────────────────
  if (eventType === "catalog.version.updated") {
    return handleCatalogUpdate(merchantIdFromEvent);
  }

  // ── Payment processing ─────────────────────────────────────
  if (eventType !== "payment.updated" && eventType !== "payment.created") {
    console.log(`[square.webhook] unhandled event type: ${eventType}`);
    return { skipped: true };
  }

  const payment = data?.object?.payment;
  if (!payment) return { skipped: true, reason: "no payment object" };

  // Only process payments that have reached COMPLETED status
  if (payment.status !== "COMPLETED") {
    console.log(`[square.webhook] skipping payment status=${payment.status}`);
    return { skipped: true, reason: `payment status ${payment.status}` };
  }

  const locationId = payment.location_id;
  const squarePaymentId = payment.id;
  const amountMoney = payment.amount_money; // { amount: cents, currency }

  if (!locationId || !squarePaymentId) {
    return { skipped: true, reason: "missing location_id or payment id" };
  }

  // Idempotency: skip if this payment was already processed
  const existing = await prisma.visit.findFirst({
    where: { posVisitId: squarePaymentId },
    select: { id: true },
  });
  if (existing) {
    return { duplicate: true, visitId: existing.id };
  }

  // Find the PosLocationMap → pvStoreId
  const locationMap = await prisma.posLocationMap.findFirst({
    where: { externalLocationId: locationId, active: true },
    include: { posConnection: true },
  });

  if (!locationMap) {
    console.warn(`[square.webhook] no location map for Square locationId=${locationId}`);
    return { skipped: true, reason: "unmapped location" };
  }

  const { pvStoreId, posConnection } = locationMap;
  const merchantId = posConnection.merchantId;

  // Resolve consumer via Square customer / email
  const adapter = new SquareAdapter(posConnection);
  const consumerId = await adapter.resolveConsumer(payment);

  // Create the Visit
  const visit = await prisma.visit.create({
    data: {
      storeId: pvStoreId,
      merchantId,
      consumerId: consumerId || null,
      source: "square_webhook",
      status: consumerId ? "identified" : "pending_identity",
      posVisitId: squarePaymentId,
      metadata: {
        squarePaymentId,
        locationId,
        amountMoney,
        eventType,
      },
    },
    select: { id: true },
  });

  writeEventLog(prisma, {
    eventType: "visit.registered",
    merchantId,
    storeId: pvStoreId,
    consumerId: consumerId || null,
    visitId: visit.id,
    source: "square_webhook",
    outcome: "success",
    payloadJson: { squarePaymentId, locationId },
  });

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
      console.error("[square.webhook] accumulateStamps error:", e?.message || String(e));
    }
  }

  // Order enrichment — fetch line items from Square Orders API (fire-and-forget)
  const orderId = payment.order_id || null;
  enrichOrderData(adapter, {
    visitId: visit.id,
    merchantId,
    storeId: pvStoreId,
    consumerId: consumerId || null,
    orderId,
  }).catch((e) => {
    console.error("[square.webhook] enrichOrderData error:", e?.message || String(e));
  });

  return { visitId: visit.id, consumerId, identified: !!consumerId };
}

// ─── Route registration ───────────────────────────────────────────────────────

/**
 * Register the Square webhook endpoint.
 * Call this BEFORE app.use(express.json()) with express.raw() as body parser.
 */
function registerSquareWebhookRoute(app) {
  app.post(
    "/webhooks/square",
    express.raw({ type: "*/*" }),
    async (req, res) => {
      const signature = req.headers["x-square-hmacsha256-signature"] || "";
      if (!signature && process.env.NODE_ENV === "production") {
        return res.status(400).json({ error: "Missing signature header" });
      }

      // Use rawBody captured by early middleware in index.js, fall back to req.body
      const rawBody = req.rawBody || req.body || Buffer.alloc(0);

      // Build the notification URL Square used (must match exactly what's in Square Dashboard)
      const notificationUrl = process.env.SQUARE_WEBHOOK_URL ||
        `${req.headers["x-forwarded-proto"] || req.protocol}://${req.headers["x-forwarded-host"] || req.get("host")}${req.originalUrl}`;

      if (!verifySquareSignature(notificationUrl, rawBody, signature)) {
        console.warn("[square.webhook] signature verification failed");
        return res.status(403).json({ error: "Invalid signature" });
      }

      let event;
      try {
        event = JSON.parse(rawBody.toString("utf8"));
      } catch (e) {
        console.error("[square.webhook] JSON parse failed:", e?.message);
        return res.status(400).json({ error: "Invalid JSON body" });
      }

      const { type: eventType, data, merchant_id: eventMerchantId } = event;

      // Respond 200 immediately — Square requires fast ACK
      res.status(200).json({ received: true });

      // Dispatch asynchronously so Square doesn't time out waiting
      console.log(`[square.webhook] dispatching ${eventType}`, JSON.stringify(data).slice(0, 200));
      dispatchSquareEvent(eventType, data, eventMerchantId).then((result) => {
        console.log("[square.webhook] dispatch result:", JSON.stringify(result));
      }).catch((e) => {
        console.error("[square.webhook] dispatch error:", e?.message || String(e), e?.stack);
      });
    }
  );
}

module.exports = { registerSquareWebhookRoute };
