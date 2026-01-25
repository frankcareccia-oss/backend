// src/pos/pos.persist.js
// POS-5A: Prisma persistence for POS events with hooks
//
// - /pos/visit  -> creates Visit row (stores vis_* in Visit.posVisitId)
// - /pos/reward -> creates PosReward row (id = rew_*)
// - Uses ctx.pvHook (passed from routes) for hooks
//
// NOTE: POS-3 idempotency/replay remains enforced by middleware upstream.
// This module is called only on "first write" (not replay) when middleware is correct.

const { prisma } = require("../db/prisma");
const { eventId, visitId, rewardId } = require("./pos.ids");

function emit(ctx, event, fields) {
  try {
    const fn = ctx && typeof ctx.pvHook === "function" ? ctx.pvHook : null;
    if (fn) fn(event, fields);
  } catch {
    // never throw from hooks
  }
}

async function persistVisit({ ctx, body, idempotencyKey }) {
  const evtId = eventId();
  const visId = visitId();

  try {
    // derive merchantId from storeId (authoritative)
    const store = await prisma.store.findUnique({
      where: { id: ctx.storeId },
      select: { id: true, merchantId: true },
    });
    if (!store) {
      throw new Error(`Store not found for storeId=${ctx.storeId}`);
    }

    const identifier =
      (body && (body.identifier || body.email)) ? String(body.identifier || body.email) : null;

    await prisma.visit.create({
      data: {
        storeId: store.id,
        merchantId: store.merchantId,
        consumerId: null,
        qrId: null,
        source: "manual",
        metadata: {
          pos: true,
          eventType: "pos.visit",
          eventId: evtId,
          idempotencyKey,
          payload: body || null,
          source: "pos",
        },

        posVisitId: visId,
        posEventId: evtId,
        posIdempotencyKey: idempotencyKey,
        posIdentifier: identifier,
      },
    });

    emit(ctx, "pos.visit.persisted", {
      eventId: evtId,
      visitId: visId,
      storeId: ctx.storeId,
      userId: ctx.userId,
      idempotencyKey,
      timestamp: new Date().toISOString(),
    });

    return { visitId: visId };
  } catch (err) {
    emit(ctx, "pos.persist.failed", {
      eventType: "pos.visit",
      storeId: ctx.storeId,
      userId: ctx.userId,
      idempotencyKey,
      error: String(err),
    });
    throw err;
  }
}

async function persistReward({ ctx, body, idempotencyKey }) {
  const evtId = eventId();
  const rewId = rewardId();

  try {
    const store = await prisma.store.findUnique({
      where: { id: ctx.storeId },
      select: { id: true, merchantId: true },
    });
    if (!store) {
      throw new Error(`Store not found for storeId=${ctx.storeId}`);
    }

    const identifier =
      (body && (body.identifier || body.email)) ? String(body.identifier || body.email) : null;

    if (!identifier) {
      throw new Error("identifier is required");
    }

    const posVisitId = body && body.visitId ? String(body.visitId) : null;

    await prisma.posReward.create({
      data: {
        id: rewId,
        posVisitId,
        eventId: evtId,
        idempotencyKey,
        merchantId: store.merchantId,
        storeId: store.id,
        userId: ctx.userId,
        identifier,
        payloadJson: body || null,
      },
    });

    emit(ctx, "pos.reward.persisted", {
      eventId: evtId,
      rewardId: rewId,
      storeId: ctx.storeId,
      userId: ctx.userId,
      idempotencyKey,
      timestamp: new Date().toISOString(),
    });

    return { rewardId: rewId };
  } catch (err) {
    emit(ctx, "pos.persist.failed", {
      eventType: "pos.reward",
      storeId: ctx.storeId,
      userId: ctx.userId,
      idempotencyKey,
      error: String(err),
    });
    throw err;
  }
}

module.exports = {
  persistVisit,
  persistReward,
};
