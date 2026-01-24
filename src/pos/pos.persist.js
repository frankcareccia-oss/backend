// src/pos/pos.persist.js
// Append-only NDJSON persistence for POS events with hooks
// Uses ctx.pvHook (passed from routes) to emit hook events.

const fs = require("fs");
const path = require("path");
const { eventId, visitId, rewardId } = require("./pos.ids");

const EVENTS_FILE = path.join(process.cwd(), ".pos-events.ndjson");

function appendEvent(record) {
  fs.appendFileSync(EVENTS_FILE, JSON.stringify(record) + "\n", {
    encoding: "utf8",
    flag: "a",
  });
}

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

  const record = {
    eventType: "pos.visit",
    eventId: evtId,
    visitId: visId,
    rewardId: null,
    storeId: ctx.storeId,
    userId: ctx.userId,
    payload: body,
    idempotencyKey,
    timestamp: new Date().toISOString(),
    source: "pos",
  };

  try {
    appendEvent(record);

    emit(ctx, "pos.visit.persisted", {
      eventId: evtId,
      visitId: visId,
      storeId: ctx.storeId,
      userId: ctx.userId,
      idempotencyKey,
      timestamp: record.timestamp,
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

  const record = {
    eventType: "pos.reward",
    eventId: evtId,
    visitId: body && body.visitId ? body.visitId : null,
    rewardId: rewId,
    storeId: ctx.storeId,
    userId: ctx.userId,
    payload: body,
    idempotencyKey,
    timestamp: new Date().toISOString(),
    source: "pos",
  };

  try {
    appendEvent(record);

    emit(ctx, "pos.reward.persisted", {
      eventId: evtId,
      rewardId: rewId,
      storeId: ctx.storeId,
      userId: ctx.userId,
      idempotencyKey,
      timestamp: record.timestamp,
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
