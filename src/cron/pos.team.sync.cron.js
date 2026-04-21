/**
 * pos.team.sync.cron.js — Nightly POS employee sync
 *
 * Runs for all merchants with teamSyncEnabled=true.
 * Pulls employees from Clover/Square and syncs to PV Users.
 * Read-only — never writes back to POS.
 *
 * Schedule: 0 5 * * * (5:00 AM UTC daily)
 */

"use strict";

const { prisma } = require("../db/prisma");
const { syncTeamFromPos } = require("../pos/pos.team.sync");

async function runTeamSyncCron() {
  // Find all active POS connections where merchant has team sync enabled
  const connections = await prisma.posConnection.findMany({
    where: {
      status: "active",
      merchant: { teamSyncEnabled: true },
      posType: { in: ["clover", "square"] },
    },
    select: { id: true, merchantId: true, posType: true },
  });

  if (connections.length === 0) {
    return { merchants: 0, message: "No merchants with team sync enabled" };
  }

  const results = [];
  let succeeded = 0;
  let failed = 0;

  for (const conn of connections) {
    try {
      const stats = await syncTeamFromPos(conn.id);
      results.push({ posConnectionId: conn.id, merchantId: conn.merchantId, posType: conn.posType, ...stats });
      succeeded++;
    } catch (err) {
      console.error(`[team-sync-cron] Failed for PosConnection ${conn.id}:`, err?.message);
      results.push({ posConnectionId: conn.id, merchantId: conn.merchantId, posType: conn.posType, error: err?.message });
      failed++;

      // Record failure in sync summary
      try {
        await prisma.posConnection.update({
          where: { id: conn.id },
          data: {
            lastTeamSyncAt: new Date(),
            lastTeamSyncSummary: { error: err?.message },
          },
        });
      } catch {}
    }
  }

  console.log(JSON.stringify({
    pvHook: "cron.team_sync.complete",
    tc: "TC-TEAM-SYNC-CRON",
    merchants: connections.length,
    succeeded,
    failed,
    ts: new Date().toISOString(),
  }));

  return { merchants: connections.length, succeeded, failed, results };
}

module.exports = { runTeamSyncCron };
