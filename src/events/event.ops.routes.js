/**
 * src/events/event.ops.routes.js
 *
 * Admin operational routes for the event system.
 * Dead-letter visibility, replay, health dashboard, event trace.
 */

"use strict";

const express = require("express");
const {
  replayEvent,
  replayDeadLetters,
  getEventTrace,
  getOpsHealth,
  getDeadLetterReport,
} = require("./event.replay.service");

function buildEventOpsRouter({ prisma, requireJwt, requireAdmin, sendError, emitPvHook }) {
  const router = express.Router();

  /**
   * GET /admin/events/health — operational health dashboard
   */
  router.get("/admin/events/health", requireJwt, requireAdmin, async (_req, res) => {
    try {
      const health = await getOpsHealth(prisma);

      emitPvHook("event.ops.health_queried", {
        tc: "TC-EV-07",
        sev: "info",
        stable: "event:ops:health",
      });

      return res.json(health);
    } catch (err) {
      return sendError(res, 500, "SERVER_ERROR", err?.message || "Health check failed");
    }
  });

  /**
   * GET /admin/events/dead-letters — dead-lettered events report
   */
  router.get("/admin/events/dead-letters", requireJwt, requireAdmin, async (req, res) => {
    try {
      const limit = Math.min(Number(req.query.limit) || 50, 200);
      const report = await getDeadLetterReport(prisma, { limit });
      return res.json({ items: report });
    } catch (err) {
      return sendError(res, 500, "SERVER_ERROR", err?.message || "Dead letter query failed");
    }
  });

  /**
   * GET /admin/events/trace/:correlationId — trace event chain
   */
  router.get("/admin/events/trace/:correlationId", requireJwt, requireAdmin, async (req, res) => {
    try {
      const events = await getEventTrace(prisma, req.params.correlationId);

      emitPvHook("event.ops.trace_queried", {
        tc: "TC-EV-08",
        sev: "info",
        stable: "event:trace:" + req.params.correlationId,
        correlationId: req.params.correlationId,
        eventCount: events.length,
      });

      return res.json({ correlationId: req.params.correlationId, events });
    } catch (err) {
      return sendError(res, 500, "SERVER_ERROR", err?.message || "Trace failed");
    }
  });

  /**
   * POST /admin/events/replay/:eventId — replay a single event
   */
  router.post("/admin/events/replay/:eventId", requireJwt, requireAdmin, async (req, res) => {
    try {
      const result = await replayEvent(prisma, req.params.eventId, emitPvHook);
      return res.json(result);
    } catch (err) {
      return sendError(res, 500, "SERVER_ERROR", err?.message || "Replay failed");
    }
  });

  /**
   * POST /admin/events/replay-dead-letters — replay all dead-lettered events
   */
  router.post("/admin/events/replay-dead-letters", requireJwt, requireAdmin, async (req, res) => {
    try {
      const limit = Math.min(Number(req.query.limit) || 50, 200);
      const result = await replayDeadLetters(prisma, { limit, emitHook: emitPvHook });
      return res.json(result);
    } catch (err) {
      return sendError(res, 500, "SERVER_ERROR", err?.message || "Replay failed");
    }
  });

  return router;
}

module.exports = { buildEventOpsRouter };
