/**
 * backfill_visit_categories.js
 *
 * Creates one "Store Visit" category (categoryType: visit) for every active
 * merchant that doesn't already have one.
 *
 * Safe to run multiple times — idempotent.
 *
 * Usage:  node scripts/backfill_visit_categories.js
 */

"use strict";

require("dotenv").config();
const { prisma } = require("../src/db/prisma");

async function ensureVisitCategory(merchantId) {
  const existing = await prisma.productCategory.findFirst({
    where: { merchantId, categoryType: "visit" },
  });
  if (existing) return { created: false, category: existing };

  const category = await prisma.productCategory.create({
    data: {
      merchantId,
      name: "Store Visit",
      categoryType: "visit",
      status: "active",
    },
  });
  return { created: true, category };
}

async function main() {
  const merchants = await prisma.merchant.findMany({
    where: { status: "active" },
    select: { id: true, name: true },
  });

  console.log(`[backfill-visit-cat] Found ${merchants.length} active merchants.`);

  for (const m of merchants) {
    const { created, category } = await ensureVisitCategory(m.id);
    console.log(`  ${created ? "CREATED" : "EXISTS "} — ${m.name} (id:${m.id}) → category id:${category.id}`);
  }

  console.log("[backfill-visit-cat] Done.");
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
