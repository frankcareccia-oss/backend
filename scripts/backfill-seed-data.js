/**
 * backfill-seed-data.js — Seed 30 days of historical transaction data.
 *
 * Usage: node scripts/backfill-seed-data.js
 * Or: DATABASE_URL="..." node scripts/backfill-seed-data.js
 *
 * Run once. Idempotent — skips already-seeded windows.
 */

"use strict";

require("dotenv").config();

const { runSeedCron } = require("../src/cron/seed.data.cron");

async function backfill({ daysBack = 30 } = {}) {
  const today = new Date();
  let totalTransactions = 0;

  for (let d = daysBack; d >= 1; d--) {
    const date = new Date(today);
    date.setDate(date.getDate() - d);

    console.log(`[Backfill] Seeding ${date.toDateString()}`);

    const morningResult = await runSeedCron({ window: "morning", overrideDate: date });
    const afternoonResult = await runSeedCron({ window: "afternoon", overrideDate: date });

    totalTransactions += (morningResult?.totalTransactions || 0) + (afternoonResult?.totalTransactions || 0);
  }

  console.log(`\n[Backfill] Complete — ${totalTransactions} total transactions over ${daysBack} days`);
}

backfill({ daysBack: 30 }).catch((e) => {
  console.error("[Backfill] Failed:", e.message);
  process.exit(1);
});
