/**
 * src/events/event.replay.service.js
 *
 * Replay failed/dead-lettered events safely.
 * Preserves event identity lineage (same eventId, new delivery attempts).
 *
 * Usage:
 *   await replayEvent(prisma, eventId);           // replay one event
 *   await replayDeadLetters(prisma, { limit: 10 }); // replay all dead-lettered
 *   await getEventTrace(prisma, correlationId);    // trace full event chain
 */

"use strict";

/**
 * Replay a single outbox event by resetting it to pending.
 * Does NOT create a new event — reuses the original eventId.
 * Delivery records for failed/dead-lettered consumers are reset to pending.
 *
 * @param {object} prisma
 * @param {string} eventId — the UUID eventId (not the auto-increment id)
 * @param {function} [emitHook]
 * @returns {Promise<{ replayed, event, deliveriesReset }>}
 */
async function replayEvent(prisma, eventId, emitHook = null) {
  const event = await prisma.eventOutbox.findFirst({
    where: { eventId },
  });

  if (!event) {
    return { replayed: false, reason: "event not found" };
  }

  if (event.status === "published") {
    return { replayed: false, reason: "event already published — check delivery records" };
  }

  // Reset outbox event to pending
  await prisma.eventOutbox.update({
    where: { id: event.id },
    data: {
      status: "pending",
      publishAttempts: 0,
      lastError: null,
      nextAttemptAt: new Date(),
    },
  });

  // Reset failed/dead-lettered deliveries for this event
  const resetResult = await prisma.eventDelivery.updateMany({
    where: {
      outboxEventId: event.id,
      status: { in: ["failed", "dead_lettered"] },
    },
    data: {
      status: "pending",
      attempts: 0,
      lastError: null,
      nextRetryAt: null,
      startedAt: null,
      completedAt: null,
    },
  });

  if (typeof emitHook === "function") {
    emitHook("event.replay.executed", {
      tc: "TC-EV-06",
      sev: "info",
      stable: "replay:" + eventId,
      eventId,
      eventType: event.eventType,
      deliveriesReset: resetResult.count,
    });
  }

  return { replayed: true, event, deliveriesReset: resetResult.count };
}

/**
 * Replay all dead-lettered outbox events.
 */
async function replayDeadLetters(prisma, { limit = 50, emitHook = null } = {}) {
  const deadEvents = await prisma.eventOutbox.findMany({
    where: { status: "dead_lettered" },
    orderBy: { createdAt: "asc" },
    take: limit,
  });

  const results = [];
  for (const event of deadEvents) {
    const result = await replayEvent(prisma, event.eventId, emitHook);
    results.push({ eventId: event.eventId, ...result });
  }

  return { replayed: results.filter(r => r.replayed).length, total: deadEvents.length, results };
}

/**
 * Trace an event chain by correlationId.
 * Returns all outbox events + their deliveries sharing this correlationId.
 */
async function getEventTrace(prisma, correlationId) {
  const events = await prisma.eventOutbox.findMany({
    where: { correlationId },
    orderBy: { createdAt: "asc" },
    include: {
      deliveries: {
        orderBy: { createdAt: "asc" },
      },
    },
  });

  return events;
}

/**
 * Get operational health dashboard data.
 */
async function getOpsHealth(prisma) {
  // Outbox stats
  const outboxRows = await prisma.eventOutbox.groupBy({
    by: ["status"],
    _count: true,
  });
  const outbox = { pending: 0, published: 0, failed: 0, dead_lettered: 0 };
  for (const r of outboxRows) outbox[r.status] = r._count;

  // Delivery stats
  const deliveryRows = await prisma.eventDelivery.groupBy({
    by: ["status"],
    _count: true,
  });
  const delivery = { pending: 0, processing: 0, processed: 0, failed: 0, dead_lettered: 0 };
  for (const r of deliveryRows) delivery[r.status] = r._count;

  // Failed consumers breakdown
  const failedConsumers = await prisma.eventDelivery.groupBy({
    by: ["consumerName"],
    where: { status: { in: ["failed", "dead_lettered"] } },
    _count: true,
  });

  // Oldest pending event (backlog age)
  const oldestPending = await prisma.eventOutbox.findFirst({
    where: { status: "pending" },
    orderBy: { createdAt: "asc" },
    select: { createdAt: true, eventType: true },
  });

  return {
    outbox,
    delivery,
    failedConsumers: failedConsumers.map(r => ({ consumerName: r.consumerName, count: r._count })),
    backlogAge: oldestPending ? {
      since: oldestPending.createdAt,
      ageMs: Date.now() - oldestPending.createdAt.getTime(),
      eventType: oldestPending.eventType,
    } : null,
  };
}

/**
 * Get dead-lettered events with their delivery details.
 */
async function getDeadLetterReport(prisma, { limit = 50 } = {}) {
  const events = await prisma.eventOutbox.findMany({
    where: { status: "dead_lettered" },
    orderBy: { createdAt: "desc" },
    take: limit,
    include: {
      deliveries: {
        where: { status: "dead_lettered" },
      },
    },
  });

  return events.map(e => ({
    eventId: e.eventId,
    eventType: e.eventType,
    aggregateType: e.aggregateType,
    aggregateId: e.aggregateId,
    merchantId: e.merchantId,
    publishAttempts: e.publishAttempts,
    lastError: e.lastError,
    createdAt: e.createdAt,
    deadConsumers: e.deliveries.map(d => ({
      consumerName: d.consumerName,
      attempts: d.attempts,
      lastError: d.lastError,
    })),
  }));
}

module.exports = {
  replayEvent,
  replayDeadLetters,
  getEventTrace,
  getOpsHealth,
  getDeadLetterReport,
};
