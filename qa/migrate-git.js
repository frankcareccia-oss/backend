/**
 * qa/migrate-git.js — Add git commit + branch columns to qa_runs.
 */

"use strict";

const pool = require("./db");

async function run() {
  await pool.query("ALTER TABLE qa_runs ADD COLUMN IF NOT EXISTS git_commit TEXT");
  await pool.query("ALTER TABLE qa_runs ADD COLUMN IF NOT EXISTS git_branch TEXT");
  await pool.query("ALTER TABLE qa_runs ADD COLUMN IF NOT EXISTS git_message TEXT");
  console.log("Added git columns to qa_runs");
  await pool.end();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
