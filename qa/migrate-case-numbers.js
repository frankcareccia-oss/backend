/**
 * qa/migrate-case-numbers.js — Migrate QA-XXX to BE-XXXX for backend cases.
 * Run once: node qa/migrate-case-numbers.js
 */

"use strict";

const pool = require("./db");

async function run() {
  const { rows } = await pool.query("SELECT id, case_number FROM qa_cases ORDER BY id");

  let count = 0;
  for (const row of rows) {
    const match = row.case_number.match(/^QA-(\d+)$/);
    if (match) {
      const num = String(match[1]).padStart(4, "0");
      const newNumber = "BE-" + num;
      await pool.query("UPDATE qa_cases SET case_number = $1 WHERE id = $2", [newNumber, row.id]);
      count++;
    }
  }

  console.log("Migrated", count, "cases from QA-XXX to BE-XXXX");
  await pool.end();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
