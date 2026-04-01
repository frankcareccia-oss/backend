/**
 * seed_report_data.js
 *
 * Generates realistic dummy data for Thread R reporting:
 *   - Consumers (with phones, MerchantConsumer, StoreConsumer links)
 *   - Visits spread over the last 90 days (mix of identified + anonymous)
 *   - ConsumerPromoProgress (stamp accumulation per consumer/promotion)
 *   - PromoRedemption (granted rewards)
 *   - Entitlement (active outstanding rewards)
 *
 * Safe to run multiple times — uses phone number uniqueness as the
 * idempotency key for consumers, skips existing records.
 *
 * Usage:
 *   node scripts/seed_report_data.js
 *   node scripts/seed_report_data.js --merchant 1    (scope to one merchant)
 *   node scripts/seed_report_data.js --dry-run       (print plan, no writes)
 */

"use strict";

require("dotenv").config();
const { prisma } = require("../src/db/prisma");

// ── CLI flags ─────────────────────────────────────────────────
const args = process.argv.slice(2);
const DRY_RUN     = args.includes("--dry-run");
const SCOPE_ARG   = args.indexOf("--merchant");
const SCOPE_MID   = SCOPE_ARG !== -1 ? parseInt(args[SCOPE_ARG + 1], 10) : null;

// ── Config ────────────────────────────────────────────────────
const CONSUMER_COUNT     = 35;   // fake consumers to create
const DAYS_BACK          = 90;   // spread visits over this window
const VISITS_PER_STORE   = 120;  // visits per store total
const ANON_RATE          = 0.25; // 25% of visits stay anonymous

// ── Fake name pool ────────────────────────────────────────────
const FIRST_NAMES = [
  "Ava","Liam","Emma","Noah","Olivia","Ethan","Sophia","Mason",
  "Isabella","Lucas","Mia","Aiden","Charlotte","Jackson","Amelia",
  "Logan","Harper","Sebastian","Evelyn","Mateo","Abigail","James",
  "Emily","Alexander","Elizabeth","Benjamin","Mila","Elijah","Ella",
  "Oliver","Scarlett","Daniel","Madison","Henry","Luna","Michael",
];
const LAST_NAMES = [
  "Smith","Johnson","Williams","Brown","Jones","Garcia","Miller",
  "Davis","Martinez","Wilson","Anderson","Taylor","Thomas","Moore",
  "Jackson","Martin","Lee","Perez","Thompson","White","Harris",
  "Sanchez","Clark","Ramirez","Lewis","Robinson","Walker","Young",
];

// ── Helpers ───────────────────────────────────────────────────
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function rInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

function randomDate(daysBack) {
  const now = Date.now();
  const earliest = now - daysBack * 24 * 60 * 60 * 1000;
  return new Date(earliest + Math.random() * (now - earliest));
}

function fakePhone(index) {
  // Generates unique non-real US numbers in +1555xxxxxxx range
  const suffix = String(index + 1000).padStart(7, "0");
  return `+1555${suffix}`;
}

function log(msg) { console.log(`[seed-report] ${msg}`); }

// ── Main ──────────────────────────────────────────────────────
async function main() {
  log(`Starting${DRY_RUN ? " (DRY RUN)" : ""}…`);

  // 1. Load target merchants + stores + promotions
  const merchantWhere = SCOPE_MID ? { id: SCOPE_MID, status: "active" } : { status: "active" };
  const merchants = await prisma.merchant.findMany({
    where: merchantWhere,
    include: {
      stores:     { where: { status: "active" }, select: { id: true, name: true } },
      promotions: { where: { status: "active" }, select: { id: true, name: true, threshold: true } },
    },
  });

  if (!merchants.length) {
    log("No active merchants found. Run dev_seed.js first.");
    return;
  }

  log(`Targeting ${merchants.length} merchant(s):`);
  merchants.forEach(m => log(`  → ${m.name} (id:${m.id}) — ${m.stores.length} stores, ${m.promotions.length} promotions`));

  if (DRY_RUN) {
    log("Dry run — no writes performed.");
    return;
  }

  // 2. Create consumers (idempotent by phoneE164)
  log(`Creating up to ${CONSUMER_COUNT} consumers…`);
  const consumers = [];
  for (let i = 0; i < CONSUMER_COUNT; i++) {
    const phone = fakePhone(i);
    const firstName = pick(FIRST_NAMES);
    const lastName  = pick(LAST_NAMES);
    try {
      const existing = await prisma.consumer.findUnique({ where: { phoneE164: phone } });
      if (existing) {
        consumers.push(existing);
        continue;
      }
      const c = await prisma.consumer.create({
        data: {
          phoneE164:    phone,
          phoneRaw:     phone,
          phoneCountry: "US",
          firstName,
          lastName,
          status:       "active",
        },
      });
      consumers.push(c);
    } catch (e) {
      log(`  skip consumer ${i}: ${e.message}`);
    }
  }
  log(`  ${consumers.length} consumers ready.`);

  // 3. For each merchant: link consumers, create visits + progress + redemptions
  for (const merchant of merchants) {
    const { id: merchantId, stores, promotions } = merchant;
    if (!stores.length) { log(`  ${merchant.name}: no active stores, skipping.`); continue; }

    log(`\nProcessing: ${merchant.name} (id:${merchantId})`);

    // Ensure MerchantConsumer links (idempotent)
    for (const c of consumers) {
      await prisma.merchantConsumer.upsert({
        where:  { merchantId_consumerId: { merchantId, consumerId: c.id } },
        create: { merchantId, consumerId: c.id, status: "active", joinedAt: randomDate(90) },
        update: {},
      });
    }

    // 4. Visits per store
    for (const store of stores) {
      log(`  Store: ${store.name} (id:${store.id}) — generating ${VISITS_PER_STORE} visits…`);

      // Ensure StoreConsumer links for identified consumers
      for (const c of consumers) {
        await prisma.storeConsumer.upsert({
          where:  { storeId_consumerId: { storeId: store.id, consumerId: c.id } },
          create: { storeId: store.id, consumerId: c.id, status: "active" },
          update: {},
        });
      }

      // Generate visits spread over 90 days
      for (let v = 0; v < VISITS_PER_STORE; v++) {
        const isAnon = Math.random() < ANON_RATE;
        const consumer = isAnon ? null : pick(consumers);
        const visitDate = randomDate(DAYS_BACK);

        await prisma.visit.create({
          data: {
            merchantId,
            storeId:    store.id,
            consumerId: consumer?.id ?? null,
            source:     "pos_integrated",
            status:     consumer ? "identified" : "anonymous",
            createdAt:  visitDate,
          },
        });
      }

      log(`    ✓ ${VISITS_PER_STORE} visits created.`);
    }

    // 5. ConsumerPromoProgress + PromoRedemption + Entitlement
    for (const promo of promotions) {
      log(`  Promotion: "${promo.name}" (id:${promo.id}, threshold:${promo.threshold})`);

      for (const consumer of consumers) {
        // Each consumer has earned between 1 and 4× the threshold
        const lifetimeEarned = rInt(1, promo.threshold * 4);
        const redemptionCount = Math.floor(lifetimeEarned / promo.threshold);
        const currentStamps = lifetimeEarned - (redemptionCount * promo.threshold);
        const milestonesAvailable = currentStamps >= promo.threshold ? 1 : 0;

        // Upsert progress record
        const progress = await prisma.consumerPromoProgress.upsert({
          where:  { consumerId_promotionId: { consumerId: consumer.id, promotionId: promo.id } },
          create: {
            consumerId:          consumer.id,
            promotionId:         promo.id,
            merchantId,
            stampCount:          currentStamps,
            pointBalance:        currentStamps,
            milestonesAvailable,
            lifetimeEarned,
            lastEarnedAt:        randomDate(30),
          },
          update: {},
        });

        // Create granted redemptions for this consumer/promo
        for (let r = 0; r < redemptionCount; r++) {
          const balBefore = (r + 1) * promo.threshold;
          const balAfter  = balBefore - promo.threshold;
          const grantDate = randomDate(DAYS_BACK);
          const grantStore = pick(stores);

          // Check if we already have enough redemptions (avoid dupes on re-run)
          const existingCount = await prisma.promoRedemption.count({
            where: { progressId: progress.id },
          });
          if (existingCount >= redemptionCount) break;

          await prisma.promoRedemption.create({
            data: {
              progressId:       progress.id,
              promotionId:      promo.id,
              consumerId:       consumer.id,
              merchantId,
              pointsDecremented: promo.threshold,
              balanceBefore:    balBefore,
              balanceAfter:     balAfter,
              status:           "granted",
              grantedAt:        grantDate,
              grantedByStoreId: grantStore.id,
              createdAt:        grantDate,
            },
          });
        }

        // Create an active Entitlement for consumers with milestones available
        if (milestonesAvailable > 0) {
          const existing = await prisma.entitlement.findFirst({
            where: { consumerId: consumer.id, merchantId, sourceId: promo.id, status: "active", type: "reward" },
          });
          if (!existing) {
            await prisma.entitlement.create({
              data: {
                consumerId: consumer.id,
                merchantId,
                type:       "reward",
                sourceId:   promo.id,
                status:     "active",
                createdAt:  randomDate(15),
              },
            });
          }
        }
      }

      log(`    ✓ Progress + redemptions + entitlements seeded for ${consumers.length} consumers.`);
    }
  }

  // 6. Summary
  log("\n── Summary ──────────────────────────────────────────────");
  for (const merchant of merchants) {
    const mid = merchant.id;
    const [visits, identified, redemptions, entitlements, progress] = await Promise.all([
      prisma.visit.count({ where: { merchantId: mid } }),
      prisma.visit.count({ where: { merchantId: mid, consumerId: { not: null } } }),
      prisma.promoRedemption.count({ where: { merchantId: mid } }),
      prisma.entitlement.count({ where: { merchantId: mid, status: "active" } }),
      prisma.consumerPromoProgress.count({ where: { merchantId: mid } }),
    ]);
    log(`${merchant.name}:`);
    log(`  Visits: ${visits} (${identified} identified)`);
    log(`  Promo progress rows: ${progress}`);
    log(`  Redemptions: ${redemptions}`);
    log(`  Active entitlements: ${entitlements}`);
  }

  log("\nDone.");
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
