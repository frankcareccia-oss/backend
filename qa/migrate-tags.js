/**
 * qa/migrate-tags.js — Add repo + feature columns, backfill from file paths.
 */

"use strict";

const pool = require("./db");

// Map test file paths to feature tags
function detectFeature(filePath) {
  const f = filePath.toLowerCase();
  if (f.includes("auth")) return "auth";
  if (f.includes("consumer")) return "consumer";
  if (f.includes("wallet")) return "consumer";
  if (f.includes("products") || f.includes("catalog") || f.includes("categories")) return "catalog";
  if (f.includes("promotions") || f.includes("promo")) return "promotions";
  if (f.includes("growth") || f.includes("advisor") || f.includes("outcome")) return "growth";
  if (f.includes("payments") || f.includes("billing") || f.includes("invoice")) return "payments";
  if (f.includes("pos") || f.includes("loyalty")) return "pos";
  if (f.includes("webhook") || f.includes("square")) return "integrations";
  return "other";
}

async function run() {
  // Add columns
  await pool.query("ALTER TABLE qa_cases ADD COLUMN IF NOT EXISTS repo TEXT NOT NULL DEFAULT 'backend'");
  await pool.query("ALTER TABLE qa_cases ADD COLUMN IF NOT EXISTS feature TEXT NOT NULL DEFAULT 'unknown'");
  await pool.query("CREATE INDEX IF NOT EXISTS idx_qa_cases_repo ON qa_cases(repo)");
  await pool.query("CREATE INDEX IF NOT EXISTS idx_qa_cases_feature ON qa_cases(feature)");
  console.log("Columns added");

  // Backfill feature from existing test_file paths
  const { rows } = await pool.query("SELECT id, test_file FROM qa_cases");
  for (const r of rows) {
    const feature = detectFeature(r.test_file);
    await pool.query("UPDATE qa_cases SET feature = $1 WHERE id = $2", [feature, r.id]);
  }
  console.log("Backfilled", rows.length, "cases");

  await pool.end();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
