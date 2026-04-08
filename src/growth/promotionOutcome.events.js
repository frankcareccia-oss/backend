// src/growth/promotionOutcome.events.js
//
// Fire-and-forget event recorder for the Promotion Outcomes analytical layer.
// Called from transactional flows (stamp, grant, redeem) — must never block POS.

"use strict";

/**
 * Record a PromotionEvent row.
 * Always fire-and-forget — errors are logged, never thrown.
 *
 * @param {object} prisma
 * @param {{ promotionId, merchantId, storeId?, consumerId?, eventType, posOrderId?, visitId?, valueCents?, payloadJson? }} data
 */
async function recordPromotionEvent(prisma, {
  promotionId,
  merchantId,
  storeId,
  consumerId,
  eventType,
  posOrderId,
  visitId,
  valueCents,
  payloadJson,
}) {
  try {
    await prisma.promotionEvent.create({
      data: {
        promotionId,
        merchantId,
        storeId: storeId || null,
        consumerId: consumerId || null,
        eventType,
        posOrderId: posOrderId || null,
        visitId: visitId || null,
        valueCents: valueCents || null,
        payloadJson: payloadJson || null,
      },
    });
  } catch (e) {
    console.error(`[promotionOutcome.events] failed to record ${eventType} for promo=${promotionId}:`, e?.message || String(e));
  }
}

module.exports = { recordPromotionEvent };
