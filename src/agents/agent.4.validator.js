/**
 * agent.4.validator.js — Nightly snapshot + diff validator
 *
 * Saves today's knowledge files as snapshots for future diffing.
 * When full diff report is built (future), compares today vs yesterday
 * and generates a change report.
 *
 * For now: just snapshot. The baseline is free to collect now and
 * painful to reconstruct later.
 */

"use strict";

const fs = require("fs");
const path = require("path");

const OUTPUT_DIR = path.join(__dirname, "output");
const SNAPSHOT_DIR = path.join(OUTPUT_DIR, "snapshots");

/**
 * Save snapshots of current knowledge files.
 * Keeps last 7 days of snapshots, auto-cleans older ones.
 */
async function runSnapshot() {
  console.log("[Agent 4] Starting nightly snapshot...");

  // Ensure snapshot dir exists
  if (!fs.existsSync(SNAPSHOT_DIR)) fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });

  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const dayDir = path.join(SNAPSHOT_DIR, today);
  if (!fs.existsSync(dayDir)) fs.mkdirSync(dayDir, { recursive: true });

  // Files to snapshot
  const filesToSnapshot = [
    "knowledge-raw.json",
    "knowledge-graph.json",
  ];

  let snapshotCount = 0;
  for (const fileName of filesToSnapshot) {
    const src = path.join(OUTPUT_DIR, fileName);
    if (fs.existsSync(src)) {
      const dest = path.join(dayDir, fileName);
      fs.copyFileSync(src, dest);
      snapshotCount++;
    }
  }

  // Clean old snapshots (keep last 7 days)
  const allDays = fs.readdirSync(SNAPSHOT_DIR)
    .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort();

  const toRemove = allDays.slice(0, Math.max(0, allDays.length - 7));
  for (const old of toRemove) {
    const oldDir = path.join(SNAPSHOT_DIR, old);
    fs.rmSync(oldDir, { recursive: true, force: true });
    console.log(`[Agent 4] Cleaned old snapshot: ${old}`);
  }

  // Basic diff: compare today's knowledge-raw stats with yesterday's
  let diff = null;
  const yesterday = allDays[allDays.length - 2]; // second to last after adding today
  if (yesterday) {
    try {
      const todayRaw = path.join(dayDir, "knowledge-raw.json");
      const yesterdayRaw = path.join(SNAPSHOT_DIR, yesterday, "knowledge-raw.json");

      if (fs.existsSync(todayRaw) && fs.existsSync(yesterdayRaw)) {
        const todayData = JSON.parse(fs.readFileSync(todayRaw, "utf8"));
        const yesterdayData = JSON.parse(fs.readFileSync(yesterdayRaw, "utf8"));

        diff = {
          date: today,
          comparedTo: yesterday,
          routesDelta: (todayData.stats?.routes || 0) - (yesterdayData.stats?.routes || 0),
          modelsDelta: (todayData.stats?.models || 0) - (yesterdayData.stats?.models || 0),
          hooksDelta: (todayData.stats?.pvHooks || 0) - (yesterdayData.stats?.pvHooks || 0),
          errorsDelta: (todayData.stats?.errorCodes || 0) - (yesterdayData.stats?.errorCodes || 0),
          cronsDelta: (todayData.stats?.cronJobs || 0) - (yesterdayData.stats?.cronJobs || 0),
        };

        const hasChanges = Object.values(diff).some(v => typeof v === "number" && v !== 0);
        diff.hasChanges = hasChanges;

        if (hasChanges) {
          console.log(`[Agent 4] Changes detected: routes ${diff.routesDelta > 0 ? "+" : ""}${diff.routesDelta}, models ${diff.modelsDelta > 0 ? "+" : ""}${diff.modelsDelta}, hooks ${diff.hooksDelta > 0 ? "+" : ""}${diff.hooksDelta}`);
        } else {
          console.log("[Agent 4] No changes from yesterday");
        }
      }
    } catch (e) {
      console.error("[Agent 4] Diff comparison failed:", e.message);
    }
  }

  console.log(`[Agent 4] Snapshot complete — ${snapshotCount} files saved to ${today}`);

  return { date: today, filesSnapshotted: snapshotCount, daysRetained: Math.min(allDays.length, 7), diff };
}

module.exports = { runSnapshot };
