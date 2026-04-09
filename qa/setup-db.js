/**
 * qa/setup-db.js — Create perkvalet_qa database and tables.
 *
 * Run once:  node qa/setup-db.js
 */

"use strict";

const { Client } = require("pg");

const PG_USER = "perkvalet";
const PG_PASS = "perkvalet";
const PG_HOST = "localhost";
const PG_PORT = 5432;
const QA_DB = "perkvalet_qa";

async function run() {
  // 1. Connect to default 'postgres' DB to create the QA database
  const root = new Client({
    host: PG_HOST,
    port: PG_PORT,
    user: PG_USER,
    password: PG_PASS,
    database: "postgres",
  });

  await root.connect();

  const exists = await root.query(
    "SELECT 1 FROM pg_database WHERE datname = $1",
    [QA_DB]
  );

  if (exists.rows.length === 0) {
    await root.query(`CREATE DATABASE ${QA_DB}`);
    console.log(`Created database: ${QA_DB}`);
  } else {
    console.log(`Database ${QA_DB} already exists`);
  }

  await root.end();

  // 2. Connect to perkvalet_qa and create tables
  const qa = new Client({
    host: PG_HOST,
    port: PG_PORT,
    user: PG_USER,
    password: PG_PASS,
    database: QA_DB,
  });

  await qa.connect();

  await qa.query(`
    CREATE TABLE IF NOT EXISTS qa_runs (
      id            SERIAL PRIMARY KEY,
      ran_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      total_tests   INT NOT NULL DEFAULT 0,
      passed        INT NOT NULL DEFAULT 0,
      failed        INT NOT NULL DEFAULT 0,
      duration_ms   INT NOT NULL DEFAULT 0
    );
  `);

  await qa.query(`
    CREATE TABLE IF NOT EXISTS qa_cases (
      id            SERIAL PRIMARY KEY,
      case_number   TEXT NOT NULL UNIQUE,
      test_file     TEXT NOT NULL,
      test_name     TEXT NOT NULL,
      suite_name    TEXT NOT NULL DEFAULT '',
      error_message TEXT,
      status        TEXT NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open','fixed','verified','regressed')),
      first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      fixed_at      TIMESTAMPTZ,
      verified_at   TIMESTAMPTZ,
      notes         TEXT,
      UNIQUE(test_file, test_name)
    );
  `);

  await qa.query(`
    CREATE TABLE IF NOT EXISTS qa_run_results (
      id            SERIAL PRIMARY KEY,
      run_id        INT NOT NULL REFERENCES qa_runs(id),
      case_id       INT REFERENCES qa_cases(id),
      test_file     TEXT NOT NULL,
      test_name     TEXT NOT NULL,
      suite_name    TEXT NOT NULL DEFAULT '',
      status        TEXT NOT NULL CHECK (status IN ('passed','failed')),
      duration_ms   INT NOT NULL DEFAULT 0,
      error_message TEXT
    );
  `);

  // Index for fast lookups
  await qa.query(`
    CREATE INDEX IF NOT EXISTS idx_qa_cases_status ON qa_cases(status);
    CREATE INDEX IF NOT EXISTS idx_qa_run_results_run ON qa_run_results(run_id);
    CREATE INDEX IF NOT EXISTS idx_qa_run_results_case ON qa_run_results(case_id);
  `);

  console.log("Tables created: qa_runs, qa_cases, qa_run_results");

  await qa.end();
  console.log("Done.");
}

run().catch((err) => {
  console.error("Setup failed:", err.message);
  process.exit(1);
});
