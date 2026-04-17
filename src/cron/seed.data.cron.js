/**
 * seed.data.cron.js — Generate realistic seed transaction data for staging merchants.
 *
 * Runs twice daily (noon + 5pm Pacific). Creates visits with realistic traffic
 * patterns, attribution rates, and triggers the normal stamp/milestone pipeline.
 *
 * Safety: Only touches merchants where isSeedMerchant = true.
 * Idempotency: Skips if this window has already been seeded today.
 */

"use strict";

const { prisma } = require("../db/prisma");
const { accumulateStamps } = require("../pos/pos.stamps");

// ── First name pool for seed consumers ──
const FIRST_NAMES = [
  "Emma","Liam","Olivia","Noah","Ava","James","Sophia","William","Isabella","Oliver",
  "Mia","Benjamin","Charlotte","Elijah","Amelia","Lucas","Harper","Mason","Evelyn","Logan",
  "Luna","Alexander","Ella","Ethan","Chloe","Jacob","Penelope","Michael","Layla","Daniel",
  "Riley","Henry","Zoey","Jackson","Nora","Sebastian","Lily","Aiden","Eleanor","Matthew",
  "Hannah","Samuel","Lillian","David","Addison","Joseph","Aubrey","Carter","Ellie","Owen",
  "Stella","Wyatt","Natalie","John","Zoe","Jack","Leah","Luke","Hazel","Jayden",
  "Violet","Dylan","Aurora","Grayson","Savannah","Levi","Audrey","Isaac","Brooklyn","Gabriel",
  "Bella","Julian","Claire","Mateo","Skylar","Anthony","Lucy","Jaxon","Paisley","Lincoln",
  "Anna","Joshua","Caroline","Christopher","Genesis","Andrew","Aaliyah","Theodore","Kennedy","Caleb",
  "Kinsley","Ryan","Allison","Asher","Maya","Nathan","Sarah","Thomas","Madelyn","Leo",
];

const LAST_NAMES = [
  "Smith","Johnson","Williams","Brown","Jones","Garcia","Miller","Davis","Rodriguez","Martinez",
  "Hernandez","Lopez","Wilson","Anderson","Thomas","Taylor","Moore","Jackson","Martin","Lee",
  "Perez","Thompson","White","Harris","Sanchez","Clark","Ramirez","Lewis","Robinson","Walker",
  "Young","Allen","King","Wright","Scott","Torres","Nguyen","Hill","Flores","Green",
  "Adams","Nelson","Baker","Hall","Rivera","Campbell","Mitchell","Carter","Roberts","Gomez",
];

const TRAFFIC_PATTERNS = {
  cafe: {
    morning: [
      { hour: 7, weight: 0.08 },
      { hour: 8, weight: 0.22 },
      { hour: 9, weight: 0.20 },
      { hour: 10, weight: 0.12 },
      { hour: 11, weight: 0.10 },
    ],
    afternoon: [
      { hour: 12, weight: 0.18 },
      { hour: 13, weight: 0.14 },
      { hour: 14, weight: 0.10 },
      { hour: 15, weight: 0.08 },
      { hour: 16, weight: 0.06 },
    ],
  },
  fitness: {
    morning: [
      { hour: 6, weight: 0.20 },
      { hour: 7, weight: 0.18 },
      { hour: 8, weight: 0.12 },
      { hour: 9, weight: 0.08 },
      { hour: 10, weight: 0.06 },
      { hour: 11, weight: 0.06 },
    ],
    afternoon: [
      { hour: 12, weight: 0.14 },
      { hour: 13, weight: 0.10 },
      { hour: 14, weight: 0.08 },
      { hour: 15, weight: 0.06 },
      { hour: 16, weight: 0.06 },
    ],
  },
};

const ORDER_VALUE_RANGES = {
  cafe: { min: 450, max: 1850 },
  fitness: { min: 1500, max: 8500 },
};

const ATTRIBUTION_RATES = {
  default: 0.72,
};

const CONSUMER_POOL_SIZE = 120;

// ── Helpers ──

function getDailyVariance() {
  return 0.55 + Math.random() * 0.90;
}

function randomTimestampInHour(hour, baseDate) {
  const d = new Date(baseDate);
  d.setHours(hour, Math.floor(Math.random() * 60), Math.floor(Math.random() * 60), 0);
  return d;
}

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function weightedConsumerPick(consumers) {
  const cutoff = Math.max(1, Math.floor(consumers.length * 0.2));
  const regulars = consumers.slice(0, cutoff);
  const occasionals = consumers.slice(cutoff);

  if (Math.random() < 0.60 && regulars.length > 0) {
    return pickRandom(regulars);
  }
  return pickRandom(occasionals);
}

// ── Consumer Pool ──

async function getOrCreateSeedConsumers(merchant) {
  const existing = await prisma.consumer.findMany({
    where: { isSeedConsumer: true, seedMerchantId: merchant.id },
    orderBy: { id: "asc" },
  });

  if (existing.length >= 20) return existing;

  const toCreate = CONSUMER_POOL_SIZE - existing.length;
  const newConsumers = [];

  for (let i = 0; i < toCreate; i++) {
    const idx = existing.length + i;
    const consumer = await prisma.consumer.create({
      data: {
        phoneE164: `+1555${String(merchant.id).padStart(3, "0")}${String(idx).padStart(4, "0")}`,
        phoneCountry: "US",
        firstName: FIRST_NAMES[idx % FIRST_NAMES.length],
        lastName: LAST_NAMES[idx % LAST_NAMES.length],
        isSeedConsumer: true,
        seedMerchantId: merchant.id,
      },
    });
    newConsumers.push(consumer);
  }

  return [...existing, ...newConsumers];
}

// ── Idempotency ──

async function hasWindowBeenSeeded(merchantId, window, baseDate) {
  const d = new Date(baseDate);
  d.setHours(0, 0, 0, 0);

  const windowStart = new Date(d);
  const windowEnd = new Date(d);

  if (window === "morning") {
    windowStart.setHours(7, 0, 0, 0);
    windowEnd.setHours(12, 0, 0, 0);
  } else {
    windowStart.setHours(12, 0, 0, 0);
    windowEnd.setHours(17, 0, 0, 0);
  }

  const count = await prisma.visit.count({
    where: {
      merchantId,
      isSeedData: true,
      createdAt: { gte: windowStart, lt: windowEnd },
    },
  });

  return count > 0;
}

// ── Per-Merchant Seeder ──

async function seedMerchant(merchant, window, baseDate) {
  if (await hasWindowBeenSeeded(merchant.id, window, baseDate)) {
    console.log(`[Seed] skipping ${merchant.name} — ${window} already seeded`);
    return 0;
  }

  const variance = getDailyVariance();
  const baseline = merchant.seedBaselineDaily || 80;
  const windowPct = window === "morning" ? 0.60 : 0.40;
  const totalCount = Math.round(baseline * windowPct * variance);

  const category = merchant.merchantType || "cafe";
  const pattern = (TRAFFIC_PATTERNS[category] || TRAFFIC_PATTERNS.cafe)[window];
  const orderRange = ORDER_VALUE_RANGES[category] || ORDER_VALUE_RANGES.cafe;

  const consumers = await getOrCreateSeedConsumers(merchant);
  const stores = merchant.stores || [];
  const promotions = merchant.promotions || [];

  if (stores.length === 0) return 0;

  let generated = 0;

  for (const { hour, weight } of pattern) {
    if (weight === 0) continue;
    const hourCount = Math.round(totalCount * weight);

    for (let i = 0; i < hourCount; i++) {
      const store = pickRandom(stores);
      const isAttributed = Math.random() < (ATTRIBUTION_RATES.default);
      const consumer = isAttributed ? weightedConsumerPick(consumers) : null;
      const timestamp = randomTimestampInHour(hour, baseDate);
      const orderValue = Math.floor(Math.random() * (orderRange.max - orderRange.min) + orderRange.min);

      // Create visit
      const visit = await prisma.visit.create({
        data: {
          merchantId: merchant.id,
          storeId: store.id,
          consumerId: consumer?.id || null,
          source: "pos_integrated",
          status: consumer ? "identified" : "pending_identity",
          isSeedData: true,
          createdAt: timestamp,
          metadata: { seedGenerated: true, orderValueCents: orderValue },
        },
      });

      // Stamp accumulation for attributed visits
      if (consumer && promotions.length > 0) {
        // Auto-enroll if not enrolled
        for (const promo of promotions) {
          const enrolled = await prisma.consumerPromoProgress.findUnique({
            where: { consumerId_promotionId: { consumerId: consumer.id, promotionId: promo.id } },
          });
          if (!enrolled && Math.random() < 0.6) {
            await prisma.consumerPromoProgress.create({
              data: {
                consumerId: consumer.id,
                promotionId: promo.id,
                merchantId: merchant.id,
                stampCount: 0,
                lifetimeEarned: 0,
                lastEarnedAt: timestamp,
              },
            });
          }
        }

        // Accumulate stamps through normal pipeline
        try {
          await accumulateStamps(prisma, {
            consumerId: consumer.id,
            merchantId: merchant.id,
            storeId: store.id,
            visitId: visit.id,
          });
        } catch (e) {
          // Non-blocking — log and continue
        }
      }

      generated++;
    }
  }

  return generated;
}

// ── Main Entry Point ──

async function runSeedCron({ window, overrideDate } = {}) {
  const startTime = Date.now();
  const baseDate = overrideDate || new Date();

  const merchants = await prisma.merchant.findMany({
    where: { isSeedMerchant: true },
    include: {
      stores: { where: { status: "active" }, select: { id: true, name: true } },
      promotions: { where: { status: "active" }, select: { id: true, name: true, threshold: true, rewardType: true, rewardValue: true, rewardSku: true, rewardNote: true, rewardExpiryDays: true } },
    },
  });

  if (merchants.length === 0) {
    console.log("[Seed] No seed merchants found — skipping");
    return { totalTransactions: 0, results: [] };
  }

  console.log(`[Seed] Starting ${window} run for ${merchants.length} merchants (date: ${baseDate.toISOString().slice(0, 10)})`);

  let totalTransactions = 0;
  const results = [];

  for (const merchant of merchants) {
    try {
      const count = await seedMerchant(merchant, window, baseDate);
      totalTransactions += count;
      results.push({ merchantId: merchant.id, merchantName: merchant.name, transactionsGenerated: count });
    } catch (e) {
      console.error(`[Seed] Failed for ${merchant.name}:`, e.message);
      results.push({ merchantId: merchant.id, merchantName: merchant.name, error: e.message });
    }
  }

  const duration = Date.now() - startTime;
  console.log(`[Seed] ${window} run complete — ${totalTransactions} transactions in ${duration}ms`);
  console.log(JSON.stringify({
    pvHook: "seed.run.complete",
    ts: new Date().toISOString(),
    tc: "TC-SEED-01",
    sev: "info",
    window,
    totalTransactions,
    duration,
    merchants: results,
  }));

  return { totalTransactions, results };
}

module.exports = { runSeedCron };
