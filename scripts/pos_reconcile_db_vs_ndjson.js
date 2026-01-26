// scripts/pos_reconcile_db_vs_ndjson.js
// POS-6: Reconcile NDJSON log vs DB (READ-ONLY).
//
// Default input: .pos-events.ndjson.backup
//
// Usage:
//   node scripts/pos_reconcile_db_vs_ndjson.js
//   node scripts/pos_reconcile_db_vs_ndjson.js --ndjson .pos-events.ndjson.backup
//   node scripts/pos_reconcile_db_vs_ndjson.js --limit 1000
//
// Notes:
// - Best-effort parsing (one JSON object per line)
// - Infers kind (visit/reward) conservatively
// - Emits hooks (console) when ENABLE_QA_HOOKS=1
// - Does NOT mutate DB or logs

const fs = require("fs");
const readline = require("readline");
require("dotenv").config();

const { prisma } = require("../src/db/prisma");

function argValue(flag, def = null) {
  const i = process.argv.indexOf(flag);
  if (i === -1) return def;
  return process.argv[i + 1] || def;
}

function makeHook() {
  const enabled = String(process.env.ENABLE_QA_HOOKS || "") === "1";
  return (event, fields = {}) => {
    try {
      if (!enabled) return;
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
  };
}

// Treat these as possible event name carriers
function getEventType(obj) {
  return String(obj?.type || obj?.kind || obj?.event || obj?.eventType || "").toLowerCase();
}

function inferKind(obj) {
  const t = getEventType(obj);

  if (t.includes("reward")) return "reward";
  if (t.includes("visit")) return "visit";

  // fallback: presence of likely IDs
  const rid =
    obj?.rewardId ||
    obj?.data?.rewardId ||
    (obj?.id && String(obj.id).startsWith("rew_") ? obj.id : null);

  if (rid) return "reward";

  const vid =
    obj?.posVisitId ||
    obj?.visitId ||
    obj?.data?.posVisitId ||
    obj?.data?.visitId ||
    null;

  if (vid) return "visit";

  return "unknown";
}

function extractVisitId(obj) {
  // POS visit id is vis_* and is persisted to Visit.posVisitId
  const v =
    obj?.posVisitId ||
    obj?.visitId ||
    obj?.data?.posVisitId ||
    obj?.data?.visitId ||
    null;

  return v ? String(v) : null;
}

function extractRewardId(obj) {
  const r =
    obj?.rewardId ||
    obj?.data?.rewardId ||
    (obj?.id && String(obj.id).startsWith("rew_") ? obj.id : null);

  return r ? String(r) : null;
}

async function main() {
  const hook = makeHook();
  const ndjsonPath = argValue("--ndjson", ".pos-events.ndjson.backup");
  const limit = Number(argValue("--limit", "0")) || 0;

  hook("pos.reconcile.started", { ndjsonPath, limit: limit || null });

  if (!fs.existsSync(ndjsonPath)) {
    hook("pos.reconcile.completed", {
      ok: false,
      reason: "ndjson_not_found",
      ndjsonPath,
    });
    console.error(`NDJSON not found: ${ndjsonPath}`);
    process.exit(2);
  }

  const ndVisits = new Set();   // vis_* (Visit.posVisitId)
  const ndRewards = new Set();  // rew_* (PosReward.id)
  let lines = 0;
  let parsed = 0;
  let skipped = 0;

  const rl = readline.createInterface({
    input: fs.createReadStream(ndjsonPath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    lines++;
    if (!line.trim()) continue;

    let obj;
    try {
      obj = JSON.parse(line);
      parsed++;
    } catch {
      skipped++;
      continue;
    }

    const kind = inferKind(obj);

    if (kind === "visit") {
      const vid = extractVisitId(obj);
      if (vid) ndVisits.add(vid);
    } else if (kind === "reward") {
      const rid = extractRewardId(obj);
      if (rid) ndRewards.add(rid);
    }

    if (limit && parsed >= limit) break;
  }

  // DB side
  const dbVisits = await prisma.visit.findMany({
    where: { posVisitId: { not: null } },
    select: { posVisitId: true },
  });

  const dbRewards = await prisma.posReward.findMany({
    select: { id: true },
  });

  const dbVisitSet = new Set(dbVisits.map((v) => String(v.posVisitId)));
  const dbRewardSet = new Set(dbRewards.map((r) => String(r.id)));

  const missingVisitsInDb = [];
  for (const id of ndVisits) if (!dbVisitSet.has(id)) missingVisitsInDb.push(id);

  const missingRewardsInDb = [];
  for (const id of ndRewards) if (!dbRewardSet.has(id)) missingRewardsInDb.push(id);

  const missingVisitsInLog = [];
  for (const id of dbVisitSet) if (!ndVisits.has(id)) missingVisitsInLog.push(id);

  const missingRewardsInLog = [];
  for (const id of dbRewardSet) if (!ndRewards.has(id)) missingRewardsInLog.push(id);

  const summary = {
    ndjson: {
      lines,
      parsed,
      skipped,
      visits: ndVisits.size,
      rewards: ndRewards.size,
    },
    db: {
      visits: dbVisitSet.size,
      rewards: dbRewardSet.size,
    },
    missing_in_db: {
      visits: missingVisitsInDb.length,
      rewards: missingRewardsInDb.length,
    },
    missing_in_log: {
      visits: missingVisitsInLog.length,
      rewards: missingRewardsInLog.length,
    },
  };

  hook("pos.reconcile.summary", summary);

  const cap = 50;
  if (missingVisitsInDb.length)
    hook("pos.reconcile.missing_in_db", {
      kind: "visit",
      sample: missingVisitsInDb.slice(0, cap),
    });
  if (missingRewardsInDb.length)
    hook("pos.reconcile.missing_in_db", {
      kind: "reward",
      sample: missingRewardsInDb.slice(0, cap),
    });
  if (missingVisitsInLog.length)
    hook("pos.reconcile.missing_in_log", {
      kind: "visit",
      sample: missingVisitsInLog.slice(0, cap),
    });
  if (missingRewardsInLog.length)
    hook("pos.reconcile.missing_in_log", {
      kind: "reward",
      sample: missingRewardsInLog.slice(0, cap),
    });

  hook("pos.reconcile.completed", { ok: true });

  console.log(JSON.stringify(summary, null, 2));
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
