/**
 * backfill-reporting.js — Backfill reporting summary tables from earliest transaction.
 *
 * Usage: node scripts/backfill-reporting.js
 * Or with external DB: DATABASE_URL="..." node scripts/backfill-reporting.js
 *
 * Safe to re-run — all writes are upserts.
 */

"use strict";

require("dotenv").config();

const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

async function backfill() {
  const { runReportingAggregation } = require("../src/cron/reporting.aggregate.cron");

  const earliest = await prisma.visit.findFirst({
    orderBy: { createdAt: "asc" },
    select: { createdAt: true },
  });

  if (!earliest) {
    console.log("[Backfill] No transactions found — nothing to backfill.");
    return;
  }

  const fromDate = new Date(earliest.createdAt);
  fromDate.setUTCHours(0, 0, 0, 0);

  const toDate = new Date();
  toDate.setUTCDate(toDate.getUTCDate() - 1);
  toDate.setUTCHours(0, 0, 0, 0);

  if (fromDate > toDate) {
    console.log("[Backfill] Earliest transaction is today — nothing to backfill yet.");
    return;
  }

  console.log(`[Backfill] Processing from ${fromDate.toISOString().slice(0, 10)} to ${toDate.toISOString().slice(0, 10)}`);

  const result = await runReportingAggregation({ fromDate, toDate });
  console.log("[Backfill] Complete:", result);
}

backfill()
  .catch((e) => {
    console.error("[Backfill] Failed:", e.message);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
