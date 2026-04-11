/**
 * src/settlement/settlement.batch.service.js
 *
 * Groups open settlement accruals into payable batches.
 * One batch per CPG per settlement window.
 */

"use strict";

const { prisma } = require("../db/prisma");

/**
 * Create a settlement batch by grouping open accruals for a CPG.
 *
 * @param {object} params
 * @param {number} params.cpgId
 * @param {Date} params.periodStart
 * @param {Date} params.periodEnd
 * @param {string} [params.cadence] — weekly, net_15, etc.
 * @param {number} [params.createdBy] — admin userId
 * @param {function} [params.emitHook]
 * @returns {Promise<{ batch, itemCount }>}
 */
async function createBatch({
  cpgId,
  periodStart,
  periodEnd,
  cadence = "weekly",
  createdBy = null,
  emitHook = null,
}) {
  // Find all open accruals for this CPG within the period
  const accruals = await prisma.settlementAccrual.findMany({
    where: {
      cpgId,
      status: "open",
      effectiveAt: {
        gte: new Date(periodStart),
        lte: new Date(periodEnd),
      },
    },
    orderBy: { effectiveAt: "asc" },
  });

  if (accruals.length === 0) {
    return { batch: null, itemCount: 0, reason: "no open accruals in period" };
  }

  // Calculate totals
  const totalGrossCents = accruals.reduce((s, a) => s + a.grossAmountCents, 0);
  const totalFeeCents = accruals.reduce((s, a) => s + a.feeAmountCents, 0);
  const totalNetCents = accruals.reduce((s, a) => s + a.netAmountCents, 0);

  // Create batch + items in a transaction
  const result = await prisma.$transaction(async (tx) => {
    const batch = await tx.settlementBatch.create({
      data: {
        cpgId,
        periodStart: new Date(periodStart),
        periodEnd: new Date(periodEnd),
        cadence,
        totalGrossCents,
        totalFeeCents,
        totalNetCents,
        itemCount: accruals.length,
        status: "open",
        createdBy,
      },
    });

    // Create batch items
    for (const accrual of accruals) {
      await tx.settlementBatchItem.create({
        data: {
          batchId: batch.id,
          accrualId: accrual.id,
          merchantId: accrual.merchantId,
          grossAmountCents: accrual.grossAmountCents,
          feeAmountCents: accrual.feeAmountCents,
          netAmountCents: accrual.netAmountCents,
        },
      });

      // Mark accrual as batched
      await tx.settlementAccrual.update({
        where: { id: accrual.id },
        data: { status: "batched", batchId: batch.id },
      });
    }

    return batch;
  });

  if (typeof emitHook === "function") {
    emitHook("settlement.batch.created", {
      tc: "TC-SET-02",
      sev: "info",
      stable: "batch:" + result.id,
      batchId: result.id,
      cpgId,
      itemCount: accruals.length,
      totalGrossCents,
      totalFeeCents,
      totalNetCents,
      periodStart: new Date(periodStart).toISOString(),
      periodEnd: new Date(periodEnd).toISOString(),
    });
  }

  return { batch: result, itemCount: accruals.length };
}

/**
 * Finalize a batch — lock it for payout.
 */
async function finalizeBatch(batchId, emitHook = null) {
  const batch = await prisma.settlementBatch.update({
    where: { id: batchId },
    data: { status: "finalized", finalizedAt: new Date() },
  });

  if (typeof emitHook === "function") {
    emitHook("settlement.batch.finalized", {
      tc: "TC-SET-03",
      sev: "info",
      stable: "batch:" + batchId,
      batchId,
      totalNetCents: batch.totalNetCents,
    });
  }

  return batch;
}

/**
 * Mark a batch as paid.
 */
async function markBatchPaid(batchId, paymentReference, emitHook = null) {
  const batch = await prisma.settlementBatch.update({
    where: { id: batchId },
    data: {
      status: "paid",
      paidAt: new Date(),
      paymentReference: paymentReference || null,
    },
  });

  // Mark all linked accruals as paid
  await prisma.settlementAccrual.updateMany({
    where: { batchId },
    data: { status: "paid" },
  });

  if (typeof emitHook === "function") {
    emitHook("settlement.batch.paid", {
      tc: "TC-SET-04",
      sev: "info",
      stable: "batch:" + batchId,
      batchId,
      totalNetCents: batch.totalNetCents,
      paymentReference,
    });
  }

  return batch;
}

/**
 * Get batch with items and merchant breakdown.
 */
async function getBatchDetail(batchId) {
  const batch = await prisma.settlementBatch.findUnique({
    where: { id: batchId },
    include: {
      items: true,
      cpg: { select: { id: true, name: true } },
    },
  });

  if (!batch) return null;

  // Group items by merchant
  const byMerchant = {};
  for (const item of batch.items) {
    if (!byMerchant[item.merchantId]) {
      byMerchant[item.merchantId] = { merchantId: item.merchantId, grossCents: 0, feeCents: 0, netCents: 0, count: 0 };
    }
    byMerchant[item.merchantId].grossCents += item.grossAmountCents;
    byMerchant[item.merchantId].feeCents += item.feeAmountCents;
    byMerchant[item.merchantId].netCents += item.netAmountCents;
    byMerchant[item.merchantId].count++;
  }

  return {
    ...batch,
    merchantBreakdown: Object.values(byMerchant),
  };
}

/**
 * List batches for a CPG.
 */
async function listBatches({ cpgId, status, limit = 50 } = {}) {
  const where = {};
  if (cpgId) where.cpgId = cpgId;
  if (status) where.status = status;

  return prisma.settlementBatch.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: limit,
    include: { cpg: { select: { id: true, name: true } } },
  });
}

module.exports = {
  createBatch,
  finalizeBatch,
  markBatchPaid,
  getBatchDetail,
  listBatches,
};
