/**
 * src/settlement/settlement.accrual.service.js
 *
 * Creates durable financial obligation entries from qualifying business events.
 * Idempotent: uses sourceEventId (UUID from outbox) to prevent duplicates.
 *
 * Accrual = "CPG X owes Merchant Y $Z because of event E"
 */

"use strict";

const { prisma } = require("../db/prisma");

/**
 * Create a settlement accrual from a subsidy event.
 * Idempotent — skips if an accrual with this sourceEventId already exists.
 *
 * @param {object} params
 * @param {string} params.sourceEventId — eventId from outbox (UUID)
 * @param {string} [params.correlationId]
 * @param {number} params.cpgId
 * @param {number} params.merchantId
 * @param {number} [params.storeId]
 * @param {number} [params.consumerId]
 * @param {number} [params.promotionId]
 * @param {number} params.grossAmountCents — subsidy amount
 * @param {number} [params.feeAmountCents] — PV platform fee
 * @param {string} [params.currency]
 * @param {string} [params.upc]
 * @param {string} [params.transactionId]
 * @param {function} [params.emitHook]
 * @returns {Promise<{ accrual, created }>}
 */
async function createAccrual({
  sourceEventId,
  correlationId = null,
  cpgId,
  merchantId,
  storeId = null,
  consumerId = null,
  promotionId = null,
  grossAmountCents,
  feeAmountCents = 0,
  currency = "usd",
  upc = null,
  transactionId = null,
  emitHook = null,
}) {
  // Idempotency check
  const existing = await prisma.settlementAccrual.findUnique({
    where: { sourceEventId },
  });
  if (existing) {
    return { accrual: existing, created: false };
  }

  const netAmountCents = grossAmountCents - feeAmountCents;

  const accrual = await prisma.settlementAccrual.create({
    data: {
      sourceEventId,
      correlationId,
      cpgId,
      merchantId,
      storeId,
      consumerId,
      promotionId,
      grossAmountCents,
      feeAmountCents,
      netAmountCents,
      currency,
      upc,
      transactionId,
      status: "open",
    },
  });

  if (typeof emitHook === "function") {
    emitHook("settlement.accrual.created", {
      tc: "TC-SET-01",
      sev: "info",
      stable: "accrual:" + accrual.id,
      accrualId: accrual.id,
      sourceEventId,
      cpgId,
      merchantId,
      grossAmountCents,
      feeAmountCents,
      netAmountCents,
    });
  }

  return { accrual, created: true };
}

/**
 * Query open accruals for a CPG, optionally filtered by merchant.
 */
async function getOpenAccruals({ cpgId, merchantId, limit = 200 } = {}) {
  const where = { status: "open" };
  if (cpgId) where.cpgId = cpgId;
  if (merchantId) where.merchantId = merchantId;

  return prisma.settlementAccrual.findMany({
    where,
    orderBy: { effectiveAt: "asc" },
    take: limit,
  });
}

/**
 * Get accrual summary for a CPG (totals by merchant).
 */
async function getAccrualSummary({ cpgId, status = "open" } = {}) {
  const where = {};
  if (cpgId) where.cpgId = cpgId;
  if (status) where.status = status;

  const accruals = await prisma.settlementAccrual.findMany({ where });

  const byMerchant = {};
  for (const a of accruals) {
    if (!byMerchant[a.merchantId]) {
      byMerchant[a.merchantId] = { merchantId: a.merchantId, grossCents: 0, feeCents: 0, netCents: 0, count: 0 };
    }
    byMerchant[a.merchantId].grossCents += a.grossAmountCents;
    byMerchant[a.merchantId].feeCents += a.feeAmountCents;
    byMerchant[a.merchantId].netCents += a.netAmountCents;
    byMerchant[a.merchantId].count++;
  }

  return {
    totalGrossCents: accruals.reduce((s, a) => s + a.grossAmountCents, 0),
    totalFeeCents: accruals.reduce((s, a) => s + a.feeAmountCents, 0),
    totalNetCents: accruals.reduce((s, a) => s + a.netAmountCents, 0),
    accrualCount: accruals.length,
    byMerchant: Object.values(byMerchant),
  };
}

module.exports = {
  createAccrual,
  getOpenAccruals,
  getAccrualSummary,
};
