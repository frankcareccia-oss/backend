/**
 * seed_promotions.js
 *
 * Adds realistic sample promotions across merchants so the consumer
 * Promotions screen has meaningful data.
 *
 * Idempotent — skips any promotion whose name already exists for that merchant.
 *
 * Usage:  node scripts/seed_promotions.js
 */

"use strict";

require("dotenv").config();
const { prisma } = require("../src/db/prisma");

const PROMOS = [
  // Acme Markets (id:1) — categories: Coffee(1), Espresso(2), Pastry(3), Food(4), StoreVisit(5)
  {
    merchantId: 1, name: "Coffee Stamp Card",
    description: "Buy 9 coffees, get the 10th free.",
    mechanic: "stamps", threshold: 9, earnPerUnit: 1,
    rewardType: "free_item", rewardSku: "COFFEE-SM",
    categoryId: 1,
  },
  {
    merchantId: 1, name: "Espresso Lover",
    description: "Earn a stamp for every espresso drink. 5 stamps = $3 off.",
    mechanic: "stamps", threshold: 5, earnPerUnit: 1,
    rewardType: "discount_fixed", rewardValue: 300,
    categoryId: 2,
  },
  {
    merchantId: 1, name: "Pastry Club",
    description: "Buy any 4 pastries, get 20% off your next pastry purchase.",
    mechanic: "stamps", threshold: 4, earnPerUnit: 1,
    rewardType: "discount_pct", rewardValue: 20,
    categoryId: 3,
  },
  {
    merchantId: 1, name: "Loyal Shopper",
    description: "Visit 10 times this month and earn a $5 store credit.",
    mechanic: "stamps", threshold: 10, earnPerUnit: 1,
    rewardType: "discount_fixed", rewardValue: 500,
    categoryId: 5, // Store Visit
    timeframeDays: 30,
  },

  // The Bean (id:6) — only Store Visit category (id:6)
  {
    merchantId: 6, name: "Morning Regular",
    description: "Stop in 7 times, get a free coffee of your choice.",
    mechanic: "stamps", threshold: 7, earnPerUnit: 1,
    rewardType: "custom", rewardNote: "Free coffee of your choice",
    categoryId: 6,
  },
  {
    merchantId: 6, name: "Bean Points",
    description: "Earn 10 points per visit. 100 points = $5 off any order.",
    mechanic: "points", threshold: 100, earnPerUnit: 10,
    rewardType: "discount_fixed", rewardValue: 500,
    categoryId: 6,
  },

  // Central Perk (id:2) — Store Visit(7)
  {
    merchantId: 2, name: "Regulars Club",
    description: "Visit 5 times, enjoy a complimentary drink on us.",
    mechanic: "stamps", threshold: 5, earnPerUnit: 1,
    rewardType: "custom", rewardNote: "Complimentary drink of your choice",
    categoryId: 7,
  },
  {
    merchantId: 2, name: "Friend Discount",
    description: "Come in 3 times in a week and get 15% off your next order.",
    mechanic: "stamps", threshold: 3, earnPerUnit: 1,
    rewardType: "discount_pct", rewardValue: 15,
    categoryId: 7, timeframeDays: 7,
  },

  // Test Bakery (id:4) — Store Visit(8)
  {
    merchantId: 4, name: "Baker's Dozen",
    description: "Visit 12 times and receive a free dozen assorted pastries.",
    mechanic: "stamps", threshold: 12, earnPerUnit: 1,
    rewardType: "custom", rewardNote: "Free dozen assorted pastries",
    categoryId: 8,
  },
];

async function main() {
  console.log(`[seed-promotions] Seeding ${PROMOS.length} promotions...`);

  let created = 0;
  let skipped = 0;

  for (const p of PROMOS) {
    const existing = await prisma.promotion.findFirst({
      where: { merchantId: p.merchantId, name: p.name },
    });
    if (existing) {
      console.log(`  SKIP   — [merchant:${p.merchantId}] "${p.name}"`);
      skipped++;
      continue;
    }

    await prisma.promotion.create({
      data: {
        merchantId: p.merchantId,
        name: p.name,
        description: p.description || null,
        mechanic: p.mechanic,
        threshold: p.threshold,
        earnPerUnit: p.earnPerUnit || 1,
        rewardType: p.rewardType,
        rewardValue: p.rewardValue || null,
        rewardSku: p.rewardSku || null,
        rewardNote: p.rewardNote || null,
        categoryId: p.categoryId || null,
        timeframeDays: p.timeframeDays || null,
        status: "active",
      },
    });
    console.log(`  CREATE — [merchant:${p.merchantId}] "${p.name}"`);
    created++;
  }

  console.log(`[seed-promotions] Done. Created: ${created}, Skipped: ${skipped}`);
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
