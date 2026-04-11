/**
 * src/payments/paymentEvent.service.js
 *
 * Append-only payment event ledger.
 * All writes are immutable — no updates or deletes.
 * Used by: Square webhooks, Stripe webhooks, Grocery subsidy, manual entries.
 */

"use strict";

const { prisma } = require("../db/prisma");

/**
 * Record a payment event (immutable insert).
 *
 * @param {object} params
 * @param {string} params.eventType    - PaymentEventType enum value
 * @param {string} params.source       - PaymentEventSource enum value (square|stripe|grocery|manual)
 * @param {number} params.merchantId   - required
 * @param {number} [params.storeId]
 * @param {number} [params.consumerId]
 * @param {string} [params.phone]
 * @param {number} [params.amountCents]
 * @param {string} [params.currency]
 * @param {string} [params.providerEventId]  - Square payment ID, Stripe PI ID, etc.
 * @param {string} [params.providerOrderId]  - Square order ID, invoice ID, etc.
 * @param {number} [params.promotionId]
 * @param {string} [params.transactionId]    - logical grouping (e.g. grocery basket)
 * @param {string} [params.upc]
 * @param {string} [params.productName]
 * @param {object} [params.metadata]         - arbitrary JSON payload
 * @param {function} [params.emitHook]       - pvHook emitter function
 * @returns {Promise<object>}  the created PaymentEvent record
 */
async function recordPaymentEvent({
  eventType,
  source,
  merchantId,
  storeId = null,
  consumerId = null,
  phone = null,
  amountCents = 0,
  currency = "usd",
  providerEventId = null,
  providerOrderId = null,
  promotionId = null,
  transactionId = null,
  upc = null,
  productName = null,
  metadata = null,
  emitHook = null,
}) {
  const event = await prisma.paymentEvent.create({
    data: {
      eventType,
      source,
      merchantId,
      storeId,
      consumerId,
      phone: phone ? String(phone).trim() : null,
      amountCents,
      currency,
      providerEventId: providerEventId ? String(providerEventId) : null,
      providerOrderId: providerOrderId ? String(providerOrderId) : null,
      promotionId,
      transactionId: transactionId ? String(transactionId) : null,
      upc: upc ? String(upc).trim() : null,
      productName: productName ? String(productName).trim() : null,
      metadataJson: metadata || undefined,
    },
  });

  if (typeof emitHook === "function") {
    emitHook("payment.event.recorded", {
      tc: "TC-PE-01",
      sev: "info",
      stable: "payment_event:" + event.id,
      paymentEventId: event.id,
      eventType,
      source,
      merchantId,
      storeId,
      amountCents,
      providerEventId,
      transactionId,
    });
  }

  return event;
}

/**
 * Query payment events (read-only).
 */
async function queryPaymentEvents({
  source,
  merchantId,
  storeId,
  eventType,
  transactionId,
  startDate,
  endDate,
  limit = 200,
} = {}) {
  const where = {};
  if (source) where.source = source;
  if (merchantId) where.merchantId = merchantId;
  if (storeId) where.storeId = storeId;
  if (eventType) where.eventType = eventType;
  if (transactionId) where.transactionId = transactionId;
  if (startDate || endDate) {
    where.createdAt = {};
    if (startDate) where.createdAt.gte = new Date(startDate);
    if (endDate) where.createdAt.lte = new Date(endDate);
  }

  return prisma.paymentEvent.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: limit,
  });
}

/**
 * Settlement report: aggregate subsidies by merchant and promotion.
 */
async function getSettlementReport({ merchantId, startDate, endDate } = {}) {
  const where = { eventType: "subsidy_applied" };
  if (merchantId) where.merchantId = merchantId;
  if (startDate || endDate) {
    where.createdAt = {};
    if (startDate) where.createdAt.gte = new Date(startDate);
    if (endDate) where.createdAt.lte = new Date(endDate);
  }

  const events = await prisma.paymentEvent.findMany({ where });

  // Aggregate by merchant
  const byMerchant = {};
  const byPromotion = {};

  for (const e of events) {
    const mk = e.merchantId;
    byMerchant[mk] = (byMerchant[mk] || 0) + e.amountCents;

    const pk = e.promotionId || "none";
    byPromotion[pk] = (byPromotion[pk] || 0) + e.amountCents;
  }

  return {
    totalSubsidyCents: events.reduce((s, e) => s + e.amountCents, 0),
    eventCount: events.length,
    byMerchant: Object.entries(byMerchant).map(([merchantId, totalCents]) => ({
      merchantId: Number(merchantId),
      totalCents,
    })),
    byPromotion: Object.entries(byPromotion).map(([promotionId, totalCents]) => ({
      promotionId: promotionId === "none" ? null : Number(promotionId),
      totalCents,
    })),
  };
}

module.exports = {
  recordPaymentEvent,
  queryPaymentEvents,
  getSettlementReport,
};
