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

// ─── Event dispatcher ─────────────────────────────────────────────────────────

/**
 * Process a verified Square webhook event.
 * Currently handles: payment.completed (maps to a PerkValet visit + stamps).
 */
async function dispatchSquareEvent(eventType, data) {
  // Square fires payment.updated when a payment reaches COMPLETED status
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

      // Build the notification URL Square used (must match exactly what's in Square Dashboard)
      // Use SQUARE_WEBHOOK_URL env var if set (avoids proxy header reconstruction issues),
      // otherwise fall back to reconstructing from headers.
      const notificationUrl = process.env.SQUARE_WEBHOOK_URL ||
        `${req.headers["x-forwarded-proto"] || req.protocol}://${req.headers["x-forwarded-host"] || req.get("host")}${req.originalUrl}`;

      console.log("[square.webhook] notificationUrl:", notificationUrl);
      console.log("[square.webhook] signature:", signature);
      console.log("[square.webhook] body isBuffer:", Buffer.isBuffer(req.body), "length:", req.body?.length);
      const bodyStr2 = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : String(req.body);
      const expected2 = require("crypto").createHmac("sha256", SQUARE_WEBHOOK_SIGNATURE_KEY).update(notificationUrl + bodyStr2).digest("base64");
      console.log("[square.webhook] computed:", expected2);
      if (!verifySquareSignature(notificationUrl, req.body, signature)) {
        console.warn("[square.webhook] signature verification failed");
        return res.status(403).json({ error: "Invalid signature" });
      }

      let event;
      try {
        const bodyStr = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : (typeof req.body === "string" ? req.body : JSON.stringify(req.body));
        event = JSON.parse(bodyStr);
      } catch (e) {
        console.error("[square.webhook] JSON parse failed:", e?.message);
        return res.status(400).json({ error: "Invalid JSON body" });
      }

      const { type: eventType, data } = event;

      // Respond 200 immediately — Square requires fast ACK
      res.status(200).json({ received: true });

      // Dispatch asynchronously so Square doesn't time out waiting
      dispatchSquareEvent(eventType, data).catch((e) => {
        console.error("[square.webhook] dispatch error:", e?.message || String(e));
      });
    }
  );
}

module.exports = { registerSquareWebhookRoute };
