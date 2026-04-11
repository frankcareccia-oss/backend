/**
 * src/consumers/settlementAccrual.consumer.js
 *
 * Handles subsidy_applied events from the grocery flow.
 * Creates a SettlementAccrual entry for each qualifying subsidy,
 * linking it to the CPG and merchant.
 */

"use strict";

const { prisma } = require("../db/prisma");
const { createAccrual } = require("../settlement/settlement.accrual.service");

function createSettlementAccrualConsumer({ emitPvHook }) {
  return async function handleSettlementAccrual(event) {
    const payload = event.payloadJson || {};
    const merchantId = event.merchantId || payload.merchantId;
    const storeId = event.storeId || payload.storeId;
    const amountCents = payload.amountCents || payload.subsidyCents || 0;

    if (!merchantId || amountCents <= 0) {
      return { skipped: true, reason: "missing merchantId or zero amount" };
    }

    // Find the CPG that this merchant participates in
    // For now, use the first active CPG participation for this merchant.
    // In production, the subsidy event would carry the cpgId directly.
    const participation = await prisma.cpgParticipation.findFirst({
      where: { merchantId, status: "active" },
      include: { cpg: { select: { id: true, platformFeeCents: true } } },
    });

    if (!participation) {
      return { skipped: true, reason: "no active CPG participation for merchant " + merchantId };
    }

    const cpg = participation.cpg;
    const feeAmountCents = cpg.platformFeeCents || 0;

    const { accrual, created } = await createAccrual({
      sourceEventId: event.eventId,
      correlationId: event.correlationId || null,
      cpgId: cpg.id,
      merchantId,
      storeId,
      consumerId: event.consumerId || null,
      grossAmountCents: amountCents,
      feeAmountCents,
      upc: payload.upc || null,
      transactionId: payload.transactionId || null,
      emitHook: emitPvHook,
    });

    if (!created) {
      return { skipped: true, reason: "duplicate — accrual already exists", accrualId: accrual.id };
    }

    return { accrualId: accrual.id, cpgId: cpg.id, grossAmountCents: amountCents, netAmountCents: accrual.netAmountCents };
  };
}

module.exports = { createSettlementAccrualConsumer };
