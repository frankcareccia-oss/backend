#!/usr/bin/env node
/**
 * backfill-marketplace-fields.js
 *
 * One-time backfill for existing merchants:
 *   planTier       → "value_added"  (grandfather existing merchants into full features)
 *   acquisitionPath → "manual"       (they predate marketplace)
 *   billingSource  → "none"          (no billing set up yet — free for 3 months)
 *   trialStartedAt → now
 *   trialEndsAt    → now + 90 days
 *
 * Safe to run multiple times — only updates merchants still on defaults
 * (planTier = "base" and billingSource = "stripe").
 *
 * Usage:
 *   DATABASE_URL="postgresql://..." node scripts/backfill-marketplace-fields.js
 *   node scripts/backfill-marketplace-fields.js          # uses .env
 */

"use strict";

const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

async function main() {
  const now = new Date();
  const trialEnd = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000); // 90 days

  // Only touch merchants that are still on the schema defaults
  // (planTier = "base", billingSource = "stripe") — these are pre-existing merchants
  // that haven't been touched by OAuth or manual setup yet.
  const result = await prisma.merchant.updateMany({
    where: {
      planTier: "base",
      billingSource: "stripe",
      trialStartedAt: null,
    },
    data: {
      planTier: "value_added",
      acquisitionPath: "manual",
      billingSource: "none",
      trialStartedAt: now,
      trialEndsAt: trialEnd,
    },
  });

  console.log(`[backfill] Updated ${result.count} merchants → value_added + manual + none + 90-day trial`);
  console.log(`[backfill] Trial ends: ${trialEnd.toISOString()}`);
}

main()
  .catch((e) => {
    console.error("[backfill] Error:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
