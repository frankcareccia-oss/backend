// src/pos/pos.read.js
// POS-6: Read/query helpers for POS persistence (Prisma) with hooks.
// - All hooks are best-effort (never throw)
// - ctx.pvHook is passed from routes

const { prisma } = require("../db/prisma");

function getHook(ctx) {
  const fn = ctx && typeof ctx.pvHook === "function" ? ctx.pvHook : null;
  return (event, payload) => {
    try {
      if (fn) fn(event, payload);
    } catch (_) {
      // never throw from hooks
    }
  };
}

/**
 * Fetch a Visit by posVisitId (string).
 * Returns null if not found.
 */
async function getVisitByPosVisitId(posVisitId, ctx = {}) {
  const hook = getHook(ctx);
  const id = String(posVisitId);

  hook("pos.read.visit.requested", { posVisitId: id });

  const visit = await prisma.visit.findUnique({
    where: { posVisitId: id },
  });

  if (!visit) {
    hook("pos.read.visit.not_found", { posVisitId: id });
    return null;
  }

  hook("pos.read.visit.found", {
    posVisitId: id,
    visitPk: visit.id,
    storeId: visit.storeId,
    merchantId: visit.merchantId,
    posIdentifier: visit.posIdentifier || null,
  });

  return visit;
}

/**
 * Fetch a PosReward by rewardId (rew_<ulid>).
 * Returns null if not found.
 */
async function getRewardById(rewardId, ctx = {}) {
  const hook = getHook(ctx);
  const id = String(rewardId);

  hook("pos.read.reward.requested", { rewardId: id });

  const reward = await prisma.posReward.findUnique({
    where: { id },
  });

  if (!reward) {
    hook("pos.read.reward.not_found", { rewardId: id });
    return null;
  }

  // NOTE: PosReward uses `identifier` (not `posIdentifier`) per pos.persist.js.
  hook("pos.read.reward.found", {
    rewardId: id,
    storeId: reward.storeId,
    merchantId: reward.merchantId,
    identifier: reward.identifier || null,
    posVisitId: reward.posVisitId || null,
  });

  return reward;
}

module.exports = {
  getVisitByPosVisitId,
  getRewardById,
};
