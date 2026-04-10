/**
 * qa/track-playwright.js — Parse Playwright JSON results and upsert QA cases.
 *
 * Usage: QA_REPO_PREFIX=CA QA_REPO_NAME=consumer-app node qa/track-playwright.js <path-to-results.json>
 *
 * Reads Playwright's JSON reporter output and feeds it into the same QA tracker
 * database used by Jest/backend tests.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const pool = require("./db");

const BACKEND_DIR = path.resolve(__dirname, "..");

function detectFeature(filePath) {
  const f = filePath.toLowerCase();
  if (f.includes("auth") || f.includes("login") || f.includes("otp")) return "auth";
  if (f.includes("wallet")) return "consumer";
  if (f.includes("promo")) return "promotions";
  if (f.includes("scan")) return "pos";
  if (f.includes("redeem")) return "consumer";
  if (f.includes("nav") || f.includes("layout")) return "ui";
  return "other";
}

async function run() {
  const resultsFile = process.argv[2];
  if (!resultsFile || !fs.existsSync(resultsFile)) {
    console.error("Usage: node qa/track-playwright.js <path-to-e2e-results.json>");
    process.exit(1);
  }

  const raw = fs.readFileSync(resultsFile, "utf8");
  const data = JSON.parse(raw);

  const repoPrefix = process.env.QA_REPO_PREFIX || "CA";
  const repoName = process.env.QA_REPO_NAME || "consumer-app";

  // Collect results from Playwright JSON format
  const results = [];
  for (const suite of data.suites || []) {
    collectResults(suite, [], results);
  }

  const totalTests = results.length;
  const passed = results.filter(r => r.status === "passed").length;
  const failed = results.filter(r => r.status === "failed").length;
  const durationMs = Math.round(data.stats?.duration || 0);

  console.log("Results: " + passed + " passed, " + failed + " failed, " + totalTests + " total (" + durationMs + "ms)");
  console.log("");

  // 1. Capture git state
  let gitCommit = null, gitBranch = null, gitMessage = null;
  try {
    gitCommit = execSync("git rev-parse --short HEAD", { cwd: BACKEND_DIR, encoding: "utf8" }).trim();
    gitBranch = execSync("git rev-parse --abbrev-ref HEAD", { cwd: BACKEND_DIR, encoding: "utf8" }).trim();
    gitMessage = execSync("git log -1 --format=%s", { cwd: BACKEND_DIR, encoding: "utf8" }).trim();
  } catch (_) {}

  // 2. Record the run
  const runRow = await pool.query(
    "INSERT INTO qa_runs (total_tests, passed, failed, duration_ms, git_commit, git_branch, git_message) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, ran_at",
    [totalTests, passed, failed, durationMs, gitCommit, gitBranch, gitMessage]
  );
  const runId = runRow.rows[0].id;
  const ranAt = runRow.rows[0].ran_at;

  // 3. Get next case number
  const maxCase = await pool.query(
    "SELECT case_number FROM qa_cases WHERE case_number LIKE $1 ORDER BY id DESC LIMIT 1",
    [repoPrefix + "-%"]
  );
  let nextNum = 1;
  if (maxCase.rows.length) {
    const m = maxCase.rows[0].case_number.match(/-(\d+)$/);
    if (m) nextNum = parseInt(m[1], 10) + 1;
  }

  let newCases = 0, regressions = 0, verified = 0;

  // 4. Process each result
  for (const r of results) {
    let caseId = null;

    const existing = await pool.query(
      "SELECT id, case_number, status FROM qa_cases WHERE test_file = $1 AND test_name = $2",
      [r.file, r.name]
    );

    if (r.status === "failed") {
      if (existing.rows.length === 0) {
        const caseNumber = repoPrefix + "-" + String(nextNum++).padStart(4, "0");
        const feature = detectFeature(r.file);
        const ins = await pool.query(
          "INSERT INTO qa_cases (case_number, test_file, test_name, suite_name, error_message, status, repo, feature) VALUES ($1, $2, $3, $4, $5, 'open', $6, $7) RETURNING id",
          [caseNumber, r.file, r.name, r.suite, r.error, repoName, feature]
        );
        caseId = ins.rows[0].id;
        newCases++;
        console.log("  NEW  " + caseNumber + "  " + r.file + " > " + r.name);
      } else {
        const c = existing.rows[0];
        caseId = c.id;
        if (c.status === "verified" || c.status === "fixed") {
          await pool.query("UPDATE qa_cases SET status = 'regressed', last_seen_at = NOW(), error_message = $2 WHERE id = $1", [c.id, r.error]);
          regressions++;
          console.log("  REGR " + c.case_number + "  " + r.file + " > " + r.name);
        } else {
          await pool.query("UPDATE qa_cases SET last_seen_at = NOW(), error_message = $2 WHERE id = $1", [c.id, r.error]);
        }
      }
    } else if (r.status === "passed" && existing.rows.length > 0) {
      const c = existing.rows[0];
      caseId = c.id;
      if (c.status === "open" || c.status === "regressed" || c.status === "fixed") {
        await pool.query("UPDATE qa_cases SET status = 'verified', verified_at = NOW(), last_seen_at = NOW(), error_message = NULL WHERE id = $1", [c.id]);
        verified++;
        console.log("  PASS " + c.case_number + "  " + r.file + " > " + r.name);
      }
    } else if (r.status === "passed" && existing.rows.length === 0) {
      // New passing test — create case as verified (full inventory)
      const caseNumber = repoPrefix + "-" + String(nextNum++).padStart(4, "0");
      const feature = detectFeature(r.file);
      const ins = await pool.query(
        "INSERT INTO qa_cases (case_number, test_file, test_name, suite_name, error_message, status, repo, feature, verified_at) VALUES ($1, $2, $3, $4, NULL, 'verified', $5, $6, NOW()) RETURNING id",
        [caseNumber, r.file, r.name, r.suite, repoName, feature]
      );
      caseId = ins.rows[0].id;
      newCases++;
    }

    await pool.query(
      "INSERT INTO qa_run_results (run_id, case_id, test_file, test_name, suite_name, status, duration_ms, error_message) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
      [runId, caseId, r.file, r.name, r.suite, r.status, r.durationMs, r.error]
    );
  }

  console.log("");
  console.log("Run #" + runId + " recorded at " + ranAt);
  console.log("  New cases: " + newCases);
  console.log("  Regressions: " + regressions);
  console.log("  Verified (now passing): " + verified);

  await pool.end();
}

function collectResults(suite, ancestors, results) {
  const suiteName = [...ancestors, suite.title].filter(Boolean).join(" > ");

  for (const spec of suite.specs || []) {
    for (const test of spec.tests || []) {
      const result = test.results?.[0];
      const status = test.status === "expected" ? "passed" : "failed";
      results.push({
        file: suite.file || spec.file || "unknown",
        suite: suiteName,
        name: spec.title,
        status,
        durationMs: result?.duration || 0,
        error: status === "failed"
          ? (result?.errors || []).map(e => e.message || e.stack || "").join("\n").slice(0, 2000)
          : null,
      });
    }
  }

  for (const child of suite.suites || []) {
    collectResults(child, [...ancestors, suite.title], results);
  }
}

run().catch((err) => {
  console.error("Track failed:", err);
  process.exit(1);
});
