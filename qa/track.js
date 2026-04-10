/**
 * qa/track.js — Run Jest, parse results, upsert QA cases into perkvalet_qa.
 *
 * Usage:  node qa/track.js            (runs full suite)
 *         node qa/track.js auth       (runs tests matching "auth")
 *
 * Case lifecycle:
 *   - New failure         → open   (case created, case # assigned)
 *   - Was open, still fails → open  (last_seen_at updated)
 *   - Was fixed, now fails  → regressed
 *   - Was open, now passes  → verified
 *   - Was regressed, passes → verified
 */

"use strict";

const { execSync } = require("child_process");
const path = require("path");
const pool = require("./db");

const BACKEND_DIR = path.resolve(__dirname, "..");

function detectFeature(filePath) {
  const f = filePath.toLowerCase();
  if (f.includes("auth")) return "auth";
  if (f.includes("consumer") || f.includes("wallet")) return "consumer";
  if (f.includes("products") || f.includes("catalog") || f.includes("categories")) return "catalog";
  if (f.includes("promotions") || f.includes("promo")) return "promotions";
  if (f.includes("growth") || f.includes("advisor") || f.includes("outcome")) return "growth";
  if (f.includes("payments") || f.includes("billing") || f.includes("invoice")) return "payments";
  if (f.includes("pos") || f.includes("loyalty")) return "pos";
  if (f.includes("webhook") || f.includes("square")) return "integrations";
  return "other";
}

async function run() {
  const filter = process.argv[2] || "";
  const jestArgs = ["--json", "--verbose", "--runInBand"];
  if (filter) jestArgs.push("--testPathPatterns", filter);

  const cmdDisplay = "npx jest " + jestArgs.join(" ");
  console.log("Running: " + cmdDisplay);
  console.log("");

  let raw;
  try {
    raw = execSync("npx jest " + jestArgs.join(" "), {
      cwd: BACKEND_DIR,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (err) {
    // Jest exits non-zero when tests fail — that's expected
    // JSON may be in stdout or stderr depending on Jest version
    raw = err.stdout || err.stderr || "";
    if (!raw) {
      console.error("Jest produced no output");
      process.exit(1);
    }
  }

  // Strip any non-JSON lines before the opening brace
  const jsonStart = raw.indexOf("{");
  if (jsonStart < 0) {
    // Try stderr output if stdout had no JSON
    console.error("No JSON found in Jest output. Raw length:", raw.length);
    console.error("First 200 chars:", raw.slice(0, 200));
    process.exit(1);
  }

  const data = JSON.parse(raw.slice(jsonStart));

  const totalTests = data.numTotalTests || 0;
  const passed = data.numPassedTests || 0;
  const failed = data.numFailedTests || 0;
  const durationMs = Math.round((data.testResults || []).reduce(
    (sum, s) => sum + (s.endTime - s.startTime), 0
  ));

  console.log(`Results: ${passed} passed, ${failed} failed, ${totalTests} total (${durationMs}ms)`);
  console.log("");

  // 1. Capture git state
  let gitCommit = null, gitBranch = null, gitMessage = null;
  try {
    gitCommit = execSync("git rev-parse --short HEAD", { cwd: BACKEND_DIR, encoding: "utf8" }).trim();
    gitBranch = execSync("git rev-parse --abbrev-ref HEAD", { cwd: BACKEND_DIR, encoding: "utf8" }).trim();
    gitMessage = execSync("git log -1 --format=%s", { cwd: BACKEND_DIR, encoding: "utf8" }).trim();
  } catch (_) { /* not a git repo or git not available */ }

  // 2. Record the run
  const runRow = await pool.query(
    `INSERT INTO qa_runs (total_tests, passed, failed, duration_ms, git_commit, git_branch, git_message)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, ran_at`,
    [totalTests, passed, failed, durationMs, gitCommit, gitBranch, gitMessage]
  );
  const runId = runRow.rows[0].id;
  const ranAt = runRow.rows[0].ran_at;

  // 2. Collect all test results
  const results = [];
  for (const suite of data.testResults || []) {
    const file = path.relative(BACKEND_DIR, suite.name).replace(/\\/g, "/");
    for (const t of suite.assertionResults || []) {
      results.push({
        file,
        suite: (t.ancestorTitles || []).join(" > "),
        name: t.title,
        status: t.status === "passed" ? "passed" : "failed",
        durationMs: t.duration || 0,
        error: t.status !== "passed"
          ? (t.failureMessages || []).join("\n").replace(/\x1b\[[0-9;]*m/g, "").slice(0, 2000)
          : null,
      });
    }
  }

  // 3. Get next case number per repo prefix
  const repoPrefix = process.env.QA_REPO_PREFIX || "BE";
  const maxCase = await pool.query(
    "SELECT case_number FROM qa_cases WHERE case_number LIKE $1 ORDER BY id DESC LIMIT 1",
    [repoPrefix + "-%"]
  );
  let nextNum = 1;
  if (maxCase.rows.length) {
    const m = maxCase.rows[0].case_number.match(/-(\d+)$/);
    if (m) nextNum = parseInt(m[1], 10) + 1;
  }

  let newCases = 0;
  let regressions = 0;
  let verified = 0;

  // 4. Process each test result
  for (const r of results) {
    let caseId = null;

    // Check if a case exists for this test
    const existing = await pool.query(
      "SELECT id, case_number, status FROM qa_cases WHERE test_file = $1 AND test_name = $2",
      [r.file, r.name]
    );

    if (r.status === "failed") {
      if (existing.rows.length === 0) {
        // New failure — create case
        const caseNumber = `${repoPrefix}-${String(nextNum++).padStart(4, "0")}`;
        const repoName = process.env.QA_REPO_NAME || "backend";
        const feature = detectFeature(r.file);
        const ins = await pool.query(
          `INSERT INTO qa_cases (case_number, test_file, test_name, suite_name, error_message, status, repo, feature)
           VALUES ($1, $2, $3, $4, $5, 'open', $6, $7) RETURNING id`,
          [caseNumber, r.file, r.name, r.suite, r.error, repoName, feature]
        );
        caseId = ins.rows[0].id;
        newCases++;
        console.log(`  NEW  ${caseNumber}  ${r.file} > ${r.name}`);
      } else {
        const c = existing.rows[0];
        caseId = c.id;

        if (c.status === "verified" || c.status === "fixed") {
          // Regression!
          await pool.query(
            `UPDATE qa_cases SET status = 'regressed', last_seen_at = NOW(), error_message = $2 WHERE id = $1`,
            [c.id, r.error]
          );
          regressions++;
          console.log(`  REGR ${c.case_number}  ${r.file} > ${r.name}`);
        } else {
          // Still failing — update last_seen and error
          await pool.query(
            `UPDATE qa_cases SET last_seen_at = NOW(), error_message = $2 WHERE id = $1`,
            [c.id, r.error]
          );
        }
      }
    } else if (r.status === "passed" && existing.rows.length > 0) {
      const c = existing.rows[0];
      caseId = c.id;

      if (c.status === "open" || c.status === "regressed" || c.status === "fixed") {
        // Was failing, now passes — verified
        await pool.query(
          `UPDATE qa_cases SET status = 'verified', verified_at = NOW(), last_seen_at = NOW(), error_message = NULL WHERE id = $1`,
          [c.id]
        );
        verified++;
        console.log(`  PASS ${c.case_number}  ${r.file} > ${r.name}`);
      }
    }

    // 5. Record the run result
    await pool.query(
      `INSERT INTO qa_run_results (run_id, case_id, test_file, test_name, suite_name, status, duration_ms, error_message)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [runId, caseId, r.file, r.name, r.suite, r.status, r.durationMs, r.error]
    );
  }

  console.log("");
  console.log(`Run #${runId} recorded at ${ranAt}`);
  console.log(`  New cases: ${newCases}`);
  console.log(`  Regressions: ${regressions}`);
  console.log(`  Verified (now passing): ${verified}`);

  await pool.end();
}

run().catch((err) => {
  console.error("Track failed:", err);
  process.exit(1);
});
