// scripts/pos_backfill_from_ndjson.js
// POS-5A backfill: reads .pos-events.ndjson.backup and inserts into Prisma
//
// - pos.visit  -> Visit (using posVisitId/posIdempotencyKey/posIdentifier, metadata stores payload)
// - pos.reward -> PosReward (id = rewardId)
//
// Safe to re-run: uses unique constraints to skip duplicates.

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { prisma } = require("../src/db/prisma");

function pvHook(event, fields = {}) {
  try {
    console.log(
      JSON.stringify({
        pvHook: event,
        ts: new Date().toISOString(),
        ...fields,
      })
    );
  } catch {
    // never throw from hooks
  }
}

const BACKUP_FILE = path.join(process.cwd(), ".pos-events.ndjson.backup");

function readLines(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

async function upsertVisitFromEvent(evt) {
  // evt fields we expect:
  // eventId, visitId, storeId, userId, payload.identifier, idempotencyKey, timestamp, source
  const identifier =
    (evt.payload && (evt.payload.identifier || evt.payload.email)) ||
    null;

  // We must write a Visit row that keeps existing schema intact:
  // - Visit.id is Int autoincrement => we store vis_* in posVisitId
  // - merchantId/storeId required by Visit model
  // - consumerId/qrId are null for POS
  // - source: use 'manual' (existing enum) for POS backfill
  // - metadata: store original payload + eventId for audit

  // merchantId is not in NDJSON; derive from Store relation (required)
  const store = await prisma.store.findUnique({
    where: { id: evt.storeId },
    select: { id: true, merchantId: true },
  });
  if (!store) {
    throw new Error(`Backfill: Store not found for storeId=${evt.storeId}`);
  }

  const createdAt = evt.timestamp ? new Date(evt.timestamp) : new Date();

  try {
    await prisma.visit.create({
      data: {
        storeId: store.id,
        merchantId: store.merchantId,
        consumerId: null,
        qrId: null,
        source: "manual",
        createdAt,
        metadata: {
          pos: true,
          eventType: evt.eventType,
          eventId: evt.eventId,
          idempotencyKey: evt.idempotencyKey,
          payload: evt.payload || null,
          source: evt.source || "pos",
        },

        posVisitId: evt.visitId,
        posEventId: evt.eventId,
        posIdempotencyKey: evt.idempotencyKey,
        posIdentifier: identifier,
      },
    });

    pvHook("pos.backfill.inserted.visit", {
      visitId: evt.visitId,
      eventId: evt.eventId,
      storeId: evt.storeId,
      idempotencyKey: evt.idempotencyKey,
    });

    return { inserted: true, skipped: false };
  } catch (e) {
    // Unique constraint => already backfilled
    const msg = String(e && e.message ? e.message : e);
    if (msg.includes("Unique constraint failed")) {
      pvHook("pos.backfill.skipped.visit", {
        visitId: evt.visitId,
        eventId: evt.eventId,
        storeId: evt.storeId,
        idempotencyKey: evt.idempotencyKey,
        reason: "duplicate",
      });
      return { inserted: false, skipped: true };
    }
    throw e;
  }
}

async function upsertRewardFromEvent(evt) {
  const identifier =
    (evt.payload && (evt.payload.identifier || evt.payload.email)) ||
    null;

  if (!identifier) {
    throw new Error(
      `Backfill: reward missing identifier (eventId=${evt.eventId})`
    );
  }

  // merchantId is not in NDJSON; derive from Store relation (required)
  const store = await prisma.store.findUnique({
    where: { id: evt.storeId },
    select: { id: true, merchantId: true },
  });
  if (!store) {
    throw new Error(`Backfill: Store not found for storeId=${evt.storeId}`);
  }

  const createdAt = evt.timestamp ? new Date(evt.timestamp) : new Date();

  try {
    await prisma.posReward.create({
      data: {
        id: evt.rewardId,
        posVisitId: evt.visitId || null,
        eventId: evt.eventId || null,
        idempotencyKey: evt.idempotencyKey,
        merchantId: store.merchantId,
        storeId: store.id,
        userId: evt.userId,
        identifier,
        payloadJson: evt.payload || null,
        createdAt,
      },
    });

    pvHook("pos.backfill.inserted.reward", {
      rewardId: evt.rewardId,
      eventId: evt.eventId,
      storeId: evt.storeId,
      idempotencyKey: evt.idempotencyKey,
    });

    return { inserted: true, skipped: false };
  } catch (e) {
    const msg = String(e && e.message ? e.message : e);
    if (msg.includes("Unique constraint failed")) {
      pvHook("pos.backfill.skipped.reward", {
        rewardId: evt.rewardId,
        eventId: evt.eventId,
        storeId: evt.storeId,
        idempotencyKey: evt.idempotencyKey,
        reason: "duplicate",
      });
      return { inserted: false, skipped: true };
    }
    throw e;
  }
}

async function main() {
  pvHook("pos.backfill.started", { file: BACKUP_FILE });

  if (!fs.existsSync(BACKUP_FILE)) {
    throw new Error(`Backup file not found: ${BACKUP_FILE}`);
  }

  const lines = readLines(BACKUP_FILE);

  let visitsInserted = 0;
  let visitsSkipped = 0;
  let rewardsInserted = 0;
  let rewardsSkipped = 0;

  for (const line of lines) {
    const evt = JSON.parse(line);

    if (evt.eventType === "pos.visit") {
      const r = await upsertVisitFromEvent(evt);
      if (r.inserted) visitsInserted++;
      else visitsSkipped++;
      continue;
    }

    if (evt.eventType === "pos.reward") {
      const r = await upsertRewardFromEvent(evt);
      if (r.inserted) rewardsInserted++;
      else rewardsSkipped++;
      continue;
    }

    pvHook("pos.backfill.skipped.unknown", {
      eventType: evt.eventType || "unknown",
      eventId: evt.eventId || null,
    });
  }

  pvHook("pos.backfill.completed", {
    visitsInserted,
    visitsSkipped,
    rewardsInserted,
    rewardsSkipped,
  });

  console.log(
    JSON.stringify(
      { visitsInserted, visitsSkipped, rewardsInserted, rewardsSkipped },
      null,
      2
    )
  );
}

main()
  .catch((e) => {
    pvHook("pos.backfill.failed", { error: String(e && e.message ? e.message : e) });
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
