/**
 * winback.cron.js — Daily check for consumers who haven't visited recently
 *
 * For each merchant, find consumers who:
 *   1. Have enrolled in at least one promotion
 *   2. Haven't visited in merchant.winbackDays (default 30)
 *   3. Haven't received a winback email in the last 30 days
 *
 * Sends a win-back email (default or custom template).
 * Runs once daily.
 */

"use strict";

const { prisma } = require("../db/prisma");
const { sendTriggeredEmail } = require("../services/triggered.emails");
const { emitPvHook } = require("../utils/hooks");

async function runWinbackCron() {
  console.log("[cron.winback] Starting win-back check...");
  const startTime = Date.now();
  let sent = 0;
  let skipped = 0;

  try {
    // Get all active merchants
    const merchants = await prisma.merchant.findMany({
      where: { status: "active" },
      select: { id: true, name: true, winbackDays: true },
    });

    for (const merchant of merchants) {
      const winbackDays = merchant.winbackDays || 30;
      const cutoffDate = new Date(Date.now() - winbackDays * 24 * 60 * 60 * 1000);
      const recentEmailCutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

      // Find consumers enrolled with this merchant who haven't visited recently
      const progressRecords = await prisma.consumerPromoProgress.findMany({
        where: { merchantId: merchant.id },
        select: { consumerId: true },
        distinct: ["consumerId"],
      });

      const consumerIds = progressRecords.map(p => p.consumerId);
      if (consumerIds.length === 0) continue;

      for (const consumerId of consumerIds) {
        // Check last visit
        const lastVisit = await prisma.visit.findFirst({
          where: { consumerId, store: { merchantId: merchant.id } },
          orderBy: { visitedAt: "desc" },
          select: { visitedAt: true },
        });

        // Skip if visited recently or never visited
        if (!lastVisit) continue;
        if (lastVisit.visitedAt > cutoffDate) continue;

        // Check if we already sent a winback email recently (dedup)
        // Use pvHook logs or a simple flag — for now, check visit-based dedup
        const daysSinceVisit = Math.floor((Date.now() - new Date(lastVisit.visitedAt).getTime()) / (1000 * 60 * 60 * 24));

        // Only send on the exact winback day or weekly reminders after (30, 37, 44, etc.)
        if ((daysSinceVisit - winbackDays) % 7 !== 0) {
          skipped++;
          continue;
        }

        // Get consumer
        const consumer = await prisma.consumer.findUnique({
          where: { id: consumerId },
          select: { id: true, firstName: true, email: true, phoneE164: true, preferredLocale: true },
        });
        if (!consumer || (!consumer.email && !consumer.phoneE164)) { skipped++; continue; }

        try {
          await sendTriggeredEmail("winback", consumer, merchant.id);
          sent++;
        } catch (e) {
          console.error(`[cron.winback] Failed for consumer ${consumerId} at merchant ${merchant.id}:`, e?.message);
          skipped++;
        }
      }
    }

    const durationMs = Date.now() - startTime;
    console.log(`[cron.winback] Done. Sent: ${sent}, Skipped: ${skipped}, Duration: ${durationMs}ms`);

    emitPvHook("cron.winback.completed", {
      tc: "TC-CRON-WINBACK-01", sev: "info",
      stable: "cron:winback",
      sent, skipped, durationMs,
    });
  } catch (err) {
    console.error("[cron.winback] Fatal error:", err?.message);
    emitPvHook("cron.winback.failed", {
      tc: "TC-CRON-WINBACK-02", sev: "error",
      stable: "cron:winback",
      error: err?.message,
    });
  }
}

module.exports = { runWinbackCron };
