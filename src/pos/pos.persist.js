// src/pos/pos.persist.js
// POS: Prisma persistence for POS events + NDJSON append for dashboard reads
//
// - /pos/visit  -> creates Visit row (stores vis_* in Visit.posVisitId)
// - /pos/reward -> creates PosReward row (id = rew_*)
// - Uses ctx.pvHook (passed from routes) for hooks
//
// IMPORTANT:
// The POS dashboard endpoints in pos.routes.js currently compute Today/Recent from NDJSON.
// Therefore, on successful Prisma writes we must ALSO append an event line to NDJSON
// (no-migrations mode). This keeps reads and writes consistent.
//
// NOTE: POS-3 idempotency/replay remains enforced by middleware upstream.
// This module is called only on "first write" (not replay) when middleware is correct.

const fs = require("fs");
const path = require("path");

const { prisma } = require("../db/prisma");
const { eventId, visitId, rewardId } = require("./pos.ids");
const { writeEventLog } = require("../eventlog/eventlog");

function emit(ctx, event, fields) {
  try {
    const fn = ctx && typeof ctx.pvHook === "function" ? ctx.pvHook : null;
    if (fn) fn(event, fields);
  } catch {
    // never throw from hooks
  }
}

function resolveNdjsonPath(kind /* "visits" | "rewards" | "events" */) {
  // Explicit override (best)
  if (process.env.POS_EVENTS_NDJSON) return process.env.POS_EVENTS_NDJSON;

  // Existing dashboard env keys (pos.routes.js looks at these)
  if (kind === "visits" && process.env.POS_VISITS_NDJSON) return process.env.POS_VISITS_NDJSON;
  if (kind === "rewards" && process.env.POS_REWARDS_NDJSON) return process.env.POS_REWARDS_NDJSON;

  // Fallback: repo root .pos-events.ndjson
  return path.resolve(process.cwd(), ".pos-events.ndjson");
}

function safeEnsureDir(filePath) {
  try {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    // ignore
  }
}

function appendNdjsonLine(filePath, obj) {
  const line = JSON.stringify(obj) + "\n";
  safeEnsureDir(filePath);
  fs.appendFileSync(filePath, line, { encoding: "utf8" });
}

function buildVisitEventLine({ evtId, visId, storeId, userId, body, idempotencyKey }) {
  return {
    eventType: "pos.visit",
    eventId: evtId,
    visitId: visId,
    rewardId: null,
    storeId,
    userId,
    payload: body || null,
    idempotencyKey: idempotencyKey || null,
    timestamp: new Date().toISOString(),
    source: "pos",
  };
}

function buildRewardEventLine({ evtId, rewId, storeId, userId, body, idempotencyKey }) {
  return {
    eventType: "pos.reward",
    eventId: evtId,
    visitId: null,
    rewardId: rewId,
    storeId,
    userId,
    payload: body || null,
    idempotencyKey: idempotencyKey || null,
    timestamp: new Date().toISOString(),
    source: "pos",
  };
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
      body && (body.identifier || body.email) ? String(body.identifier || body.email) : null;

    const consumerId = body?.consumerId ? Number(body.consumerId) : null;

    const createdVisit = await prisma.visit.create({
      data: {
        storeId: store.id,
        merchantId: store.merchantId,
        consumerId,
        qrId: null,
        source: "pos_integrated",
        status: consumerId ? "identified" : "pending_identity",
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
      select: { id: true },
    });

    // EventLog — fire-and-forget audit write
    writeEventLog(prisma, {
      eventType: "visit.registered",
      merchantId: store.merchantId,
      storeId: store.id,
      consumerId: consumerId || null,
      visitId: createdVisit.id,
      associateUserId: ctx.userId ? Number(ctx.userId) : null,
      source: "pos_integrated",
      outcome: "success",
      payloadJson: { posVisitId: visId, posEventId: evtId, idempotencyKey },
    });

    // Hooks (QA/Support/Doc/Chatbot surfaced via pvHook naming conventions)
    emit(ctx, "pos.visit.persisted", {
      eventId: evtId,
      visitId: visId,
      storeId: ctx.storeId,
      userId: ctx.userId,
      idempotencyKey,
      timestamp: new Date().toISOString(),
      sink: "prisma",
    });

    // NDJSON append for dashboard reads
    try {
      const ndjsonPath = resolveNdjsonPath("visits");
      const lineObj = buildVisitEventLine({
        evtId,
        visId,
        storeId: ctx.storeId,
        userId: ctx.userId,
        body,
        idempotencyKey,
      });
      appendNdjsonLine(ndjsonPath, lineObj);

      emit(ctx, "pos.ndjson.appended", {
        eventType: "pos.visit",
        eventId: evtId,
        visitId: visId,
        storeId: ctx.storeId,
        userId: ctx.userId,
        file: path.basename(ndjsonPath),
      });
    } catch (e) {
      // Do NOT fail the API if NDJSON append fails (Prisma write already succeeded)
      emit(ctx, "pos.ndjson.append_failed", {
        eventType: "pos.visit",
        eventId: evtId,
        visitId: visId,
        storeId: ctx.storeId,
        userId: ctx.userId,
        error: e?.message || String(e),
      });
    }

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
      body && (body.identifier || body.email) ? String(body.identifier || body.email) : null;

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

    // EventLog — fire-and-forget audit write
    writeEventLog(prisma, {
      eventType: "reward.granted",
      merchantId: store.merchantId,
      storeId: store.id,
      consumerId: body?.consumerId ? Number(body.consumerId) : null,
      associateUserId: ctx.userId ? Number(ctx.userId) : null,
      source: "pos_integrated",
      outcome: "success",
      payloadJson: { posRewardId: rewId, posEventId: evtId, idempotencyKey },
    });

    emit(ctx, "pos.reward.persisted", {
      eventId: evtId,
      rewardId: rewId,
      storeId: ctx.storeId,
      userId: ctx.userId,
      idempotencyKey,
      timestamp: new Date().toISOString(),
      sink: "prisma",
    });

    // NDJSON append for dashboard reads
    try {
      const ndjsonPath = resolveNdjsonPath("rewards");
      const lineObj = buildRewardEventLine({
        evtId,
        rewId,
        storeId: ctx.storeId,
        userId: ctx.userId,
        body,
        idempotencyKey,
      });
      appendNdjsonLine(ndjsonPath, lineObj);

      emit(ctx, "pos.ndjson.appended", {
        eventType: "pos.reward",
        eventId: evtId,
        rewardId: rewId,
        storeId: ctx.storeId,
        userId: ctx.userId,
        file: path.basename(ndjsonPath),
      });
    } catch (e) {
      emit(ctx, "pos.ndjson.append_failed", {
        eventType: "pos.reward",
        eventId: evtId,
        rewardId: rewId,
        storeId: ctx.storeId,
        userId: ctx.userId,
        error: e?.message || String(e),
      });
    }

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
