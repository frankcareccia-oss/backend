/**
 * src/events/event.publisher.job.js
 *
 * Polls the event_outbox table for pending events and dispatches them
 * to registered consumer functions.
 *
 * For MVP: consumers are in-process functions. Later, this could push
 * to a real broker (RabbitMQ, Redis Streams, etc.) without changing
 * the outbox write pattern.
 *
 * Usage:
 *   const publisher = createPublisher(prisma, emitPvHook);
 *   publisher.register("reward_granted", async (event) => { ... });
 *   publisher.start(5000); // poll every 5 seconds
 *   publisher.stop();
 */

"use strict";

const { fetchPendingEvents, markPublished, markFailed } = require("./event.outbox.service");

function createPublisher(prisma, emitPvHook) {
  const consumers = new Map(); // eventType → [handler, handler, ...]
  let interval = null;
  let running = false;

  /**
   * Register a consumer function for an event type.
   * Multiple consumers can be registered per event type.
   */
  function register(eventType, handler) {
    if (!consumers.has(eventType)) {
      consumers.set(eventType, []);
    }
    consumers.get(eventType).push(handler);
  }

  /**
   * Process one batch of pending events.
   */
  async function publishBatch() {
    if (running) return; // prevent overlapping runs
    running = true;

    try {
      const events = await fetchPendingEvents(prisma, 50);
      if (events.length === 0) {
        running = false;
        return;
      }

      for (const event of events) {
        const handlers = consumers.get(event.eventType) || [];

        if (handlers.length === 0) {
          // No consumers registered — mark published anyway (event was recorded)
          await markPublished(prisma, event.id);

          if (typeof emitPvHook === "function") {
            emitPvHook("event.published.no_consumers", {
              tc: "TC-EV-02",
              sev: "debug",
              stable: "outbox:" + event.id,
              eventId: event.eventId,
              eventType: event.eventType,
            });
          }
          continue;
        }

        try {
          // Run all consumers for this event type
          for (const handler of handlers) {
            await handler(event);
          }

          await markPublished(prisma, event.id);

          if (typeof emitPvHook === "function") {
            emitPvHook("event.published", {
              tc: "TC-EV-01",
              sev: "info",
              stable: "outbox:" + event.id,
              eventId: event.eventId,
              eventType: event.eventType,
              aggregateType: event.aggregateType,
              aggregateId: event.aggregateId,
              consumerCount: handlers.length,
            });
          }
        } catch (err) {
          await markFailed(
            prisma,
            event.id,
            err?.message || String(err),
            event.publishAttempts,
            event.maxAttempts
          );

          if (typeof emitPvHook === "function") {
            emitPvHook("event.publish.failed", {
              tc: "TC-EV-03",
              sev: "warn",
              stable: "outbox:" + event.id,
              eventId: event.eventId,
              eventType: event.eventType,
              attempt: event.publishAttempts + 1,
              maxAttempts: event.maxAttempts,
              error: (err?.message || "").slice(0, 200),
            });
          }
        }
      }
    } catch (err) {
      console.error("[event.publisher] batch error:", err?.message || String(err));
    } finally {
      running = false;
    }
  }

  /**
   * Start polling at the given interval (ms).
   */
  function start(pollIntervalMs = 5000) {
    if (interval) return;
    console.log("[event.publisher] started, polling every " + pollIntervalMs + "ms");
    interval = setInterval(publishBatch, pollIntervalMs);
    // Run immediately on start
    publishBatch();
  }

  /**
   * Stop polling.
   */
  function stop() {
    if (interval) {
      clearInterval(interval);
      interval = null;
      console.log("[event.publisher] stopped");
    }
  }

  /**
   * Run one batch manually (for testing).
   */
  async function runOnce() {
    return publishBatch();
  }

  return { register, start, stop, runOnce };
}

module.exports = { createPublisher };
