/**
 * src/events/event.outbox.service.js
 *
 * Transactional outbox write helper.
 * Outbox rows MUST be written inside the same DB transaction as business truth.
 * This ensures: if the business write commits, the event is guaranteed to be published.
 * If the business write rolls back, the event is never seen.
 *
 * Usage:
 *   await prisma.$transaction(async (tx) => {
 *     // ... business logic ...
 *     await writeOutboxEvent(tx, { eventType: "reward_granted", ... });
 *   });
 */

"use strict";

const crypto = require("crypto");

/**
 * Generate a UUID v4 for event identity.
 */
function uuid() {
  return crypto.randomUUID();
}

/**
 * Write an outbox event inside an existing Prisma transaction.
 *
 * @param {object} tx                  — Prisma transaction client
 * @param {object} params
 * @param {string} params.eventType    — e.g. "reward_granted", "subsidy_applied"
 * @param {string} params.aggregateType — e.g. "reward", "visit", "promotion"
 * @param {string} params.aggregateId  — the business entity ID
 * @param {string} [params.correlationId] — groups related events
 * @param {string} [params.causationId]   — the eventId that caused this event
 * @param {string} [params.idempotencyKey] — unique key to prevent duplicates (auto-generated if omitted)
 * @param {number} [params.merchantId]
 * @param {number} [params.storeId]
 * @param {number} [params.consumerId]
 * @param {object} params.payload      — event data (JSON-serializable)
 * @returns {Promise<object>} the created EventOutbox row
 */
async function writeOutboxEvent(tx, {
  eventType,
  aggregateType,
  aggregateId,
  correlationId = null,
  causationId = null,
  idempotencyKey = null,
  merchantId = null,
  storeId = null,
  consumerId = null,
  payload = {},
}) {
  const eventId = uuid();
  const idemKey = idempotencyKey || `${eventType}:${aggregateType}:${aggregateId}:${eventId}`;

  return tx.eventOutbox.create({
    data: {
      eventId,
      eventType,
      aggregateType,
      aggregateId: String(aggregateId),
      correlationId,
      causationId,
      idempotencyKey: idemKey,
      merchantId,
      storeId,
      consumerId,
      payloadJson: payload,
      status: "pending",
    },
  });
}

/**
 * Write an outbox event using the default Prisma client (non-transactional).
 * Use this ONLY when you can't use a transaction (e.g. after-the-fact events).
 * Prefer writeOutboxEvent(tx, ...) inside transactions.
 */
async function writeOutboxEventDirect(prisma, params) {
  return writeOutboxEvent(prisma, params);
}

/**
 * Fetch pending outbox events ready for publishing.
 *
 * @param {object} prisma
 * @param {number} [limit=50]
 * @returns {Promise<object[]>}
 */
async function fetchPendingEvents(prisma, limit = 50) {
  return prisma.eventOutbox.findMany({
    where: {
      status: "pending",
      nextAttemptAt: { lte: new Date() },
    },
    orderBy: { createdAt: "asc" },
    take: limit,
  });
}

/**
 * Mark an outbox event as published.
 */
async function markPublished(prisma, id) {
  return prisma.eventOutbox.update({
    where: { id },
    data: {
      status: "published",
      publishedAt: new Date(),
    },
  });
}

/**
 * Mark an outbox event as failed with retry backoff.
 * After maxAttempts, marks as dead_lettered.
 */
async function markFailed(prisma, id, error, currentAttempts, maxAttempts) {
  const newAttempts = currentAttempts + 1;
  const isDead = newAttempts >= maxAttempts;

  // Exponential backoff: 5s, 25s, 125s, 625s, ...
  const backoffMs = Math.pow(5, Math.min(newAttempts, 5)) * 1000;
  const nextAttempt = new Date(Date.now() + backoffMs);

  return prisma.eventOutbox.update({
    where: { id },
    data: {
      status: isDead ? "dead_lettered" : "failed",
      publishAttempts: newAttempts,
      lastError: String(error || "").slice(0, 1000),
      nextAttemptAt: isDead ? undefined : nextAttempt,
    },
  });
}

/**
 * Get outbox stats for monitoring.
 */
async function getOutboxStats(prisma) {
  const rows = await prisma.eventOutbox.groupBy({
    by: ["status"],
    _count: true,
  });
  const stats = { pending: 0, published: 0, failed: 0, dead_lettered: 0 };
  for (const r of rows) {
    stats[r.status] = r._count;
  }
  return stats;
}

module.exports = {
  uuid,
  writeOutboxEvent,
  writeOutboxEventDirect,
  fetchPendingEvents,
  markPublished,
  markFailed,
  getOutboxStats,
};
