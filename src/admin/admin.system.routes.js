/**
 * admin.system.routes.js — System admin panel (pv_admin only)
 *
 * GET /admin/system/cron-logs — recent cron job execution history
 */

"use strict";

const express = require("express");
const { prisma } = require("../db/prisma");
const { sendError } = require("../utils/errors");

const router = express.Router();

// ──────────────────────────────────────────────
// GET /admin/system/cron-logs
// ──────────────────────────────────────────────
router.get("/admin/system/cron-logs", async (req, res) => {
  try {
    // Only pv_admin
    if (req.systemRole !== "pv_admin") {
      return sendError(res, 403, "FORBIDDEN", "Platform admin only");
    }

    const { jobName, limit: limitParam } = req.query;
    const limit = Math.min(parseInt(limitParam) || 50, 200);

    const where = {};
    if (jobName) where.jobName = jobName;

    const logs = await prisma.cronJobLog.findMany({
      where,
      orderBy: { startedAt: "desc" },
      take: limit,
    });

    // Also get latest run per job name for the summary view
    const jobNames = ["growth-advisor", "gift-card-reconcile", "reward-expiry", "seed-morning", "seed-afternoon", "reporting"];
    const latest = [];
    for (const name of jobNames) {
      const last = await prisma.cronJobLog.findFirst({
        where: { jobName: name },
        orderBy: { startedAt: "desc" },
      });
      if (last) {
        latest.push({
          jobName: name,
          status: last.status,
          lastRun: last.startedAt,
          durationMs: last.durationMs,
          summary: last.summary,
          error: last.error,
        });
      } else {
        latest.push({ jobName: name, status: "never", lastRun: null, durationMs: null, summary: null, error: null });
      }
    }

    return res.json({ latest, logs });
  } catch (err) {
    return sendError(res, 500, "SERVER_ERROR", err.message);
  }
});

module.exports = router;
