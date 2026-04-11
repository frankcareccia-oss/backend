/**
 * src/events/event.delivery.service.js
 *
 * Per-consumer delivery tracking for outbox events.
 * Each consumer gets its own delivery record per event.
 * Prevents duplicate processing and enables posted-vs-processed auditing.
 *
 * Usage in publisher:
 *   const delivery = await createDelivery(prisma, event, "notification");
 *   try {
 *     await markProcessing(prisma, delivery.id);
 *     await handler(event);
 *     await markProcessed(prisma, delivery.id, result);
 *   } catch (err) {
 *     await markDeliveryFailed(prisma, delivery.id, err);
 *   }
 */

"use strict";

/**
 * Create a delivery record for a consumer.
 * Returns null if delivery already exists (idempotent).
 */
async function createDelivery(prisma, outboxEvent, consumerName) {
  try {
    return await prisma.eventDelivery.create({
      data: {
        outboxEventId: outboxEvent.id,
        eventId: outboxEvent.eventId,
        consumerName,
        status: "pending",
      },
    });
  } catch (err) {
    // Unique constraint violation — delivery already exists
    if (err?.code === "P2002") {
      return prisma.eventDelivery.findFirst({
        where: { outboxEventId: outboxEvent.id, consumerName },
      });
    }
    throw err;
  }
}

/**
 * Check if a consumer has already processed this event.
 * Use this for idempotency before doing work.
 */
async function isAlreadyProcessed(prisma, outboxEventId, consumerName) {
  const delivery = await prisma.eventDelivery.findFirst({
    where: { outboxEventId, consumerName, status: "processed" },
    select: { id: true },
  });
  return Boolean(delivery);
}

/**
 * Mark delivery as processing (work started).
 */
async function markProcessing(prisma, deliveryId) {
  return prisma.eventDelivery.update({
    where: { id: deliveryId },
    data: {
      status: "processing",
      startedAt: new Date(),
    },
  });
}

/**
 * Mark delivery as processed (work completed successfully).
 */
async function markProcessed(prisma, deliveryId, result = null) {
  return prisma.eventDelivery.update({
    where: { id: deliveryId },
    data: {
      status: "processed",
      completedAt: new Date(),
      resultJson: result || undefined,
    },
  });
}

/**
 * Mark delivery as failed with retry or dead-letter.
 */
async function markDeliveryFailed(prisma, deliveryId, error) {
  const delivery = await prisma.eventDelivery.findUnique({
    where: { id: deliveryId },
    select: { attempts: true, maxAttempts: true },
  });

  const newAttempts = (delivery?.attempts || 0) + 1;
  const isDead = newAttempts >= (delivery?.maxAttempts || 3);
  const backoffMs = Math.pow(5, Math.min(newAttempts, 4)) * 1000;

  return prisma.eventDelivery.update({
    where: { id: deliveryId },
    data: {
      status: isDead ? "dead_lettered" : "failed",
      attempts: newAttempts,
      lastError: String(error?.message || error || "").slice(0, 1000),
      nextRetryAt: isDead ? undefined : new Date(Date.now() + backoffMs),
    },
  });
}

/**
 * Get delivery stats for monitoring.
 */
async function getDeliveryStats(prisma, { consumerName } = {}) {
  const where = consumerName ? { consumerName } : {};
  const rows = await prisma.eventDelivery.groupBy({
    by: ["status"],
    where,
    _count: true,
  });
  const stats = { pending: 0, processing: 0, processed: 0, failed: 0, dead_lettered: 0 };
  for (const r of rows) {
    stats[r.status] = r._count;
  }
  return stats;
}

/**
 * Get dead-lettered deliveries for a consumer (for recovery/replay).
 */
async function getDeadLetters(prisma, { consumerName, limit = 50 } = {}) {
  const where = { status: "dead_lettered" };
  if (consumerName) where.consumerName = consumerName;

  return prisma.eventDelivery.findMany({
    where,
    include: { outbox: true },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
}

/**
 * Get posted-vs-processed gap for a consumer.
 * Returns events that were posted to outbox but not yet processed by this consumer.
 */
async function getProcessingGap(prisma, consumerName, { eventType, limit = 50 } = {}) {
  // Events in outbox that this consumer hasn't processed
  const outboxWhere = { status: "published" };
  if (eventType) outboxWhere.eventType = eventType;

  const published = await prisma.eventOutbox.findMany({
    where: outboxWhere,
    select: { id: true, eventId: true, eventType: true, createdAt: true },
    orderBy: { createdAt: "desc" },
    take: limit,
  });

  const gaps = [];
  for (const event of published) {
    const delivery = await prisma.eventDelivery.findFirst({
      where: { outboxEventId: event.id, consumerName, status: "processed" },
      select: { id: true },
    });
    if (!delivery) {
      gaps.push(event);
    }
  }

  return gaps;
}

module.exports = {
  createDelivery,
  isAlreadyProcessed,
  markProcessing,
  markProcessed,
  markDeliveryFailed,
  getDeliveryStats,
  getDeadLetters,
  getProcessingGap,
};
