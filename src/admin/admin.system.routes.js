/**
 * admin.system.routes.js — System admin panel (pv_admin only)
 *
 * GET /admin/system/cron-logs — recent cron job execution history
 */

"use strict";

const express = require("express");
const { prisma } = require("../db/prisma");
const { sendError } = require("../utils/errors");

const router = express.Router();

// ──────────────────────────────────────────────
// GET /admin/system/cron-logs
// ──────────────────────────────────────────────
router.get("/admin/system/cron-logs", async (req, res) => {
  try {
    // Only pv_admin
    if (req.systemRole !== "pv_admin") {
      return sendError(res, 403, "FORBIDDEN", "Platform admin only");
    }

    const { jobName, limit: limitParam } = req.query;
    const limit = Math.min(parseInt(limitParam) || 50, 200);

    const where = {};
    if (jobName) where.jobName = jobName;

    const logs = await prisma.cronJobLog.findMany({
      where,
      orderBy: { startedAt: "desc" },
      take: limit,
    });

    // Also get latest run per job name for the summary view
    const jobNames = ["growth-advisor", "gift-card-reconcile", "reward-expiry", "seed-morning", "seed-afternoon", "reporting"];
    const latest = [];
    for (const name of jobNames) {
      const last = await prisma.cronJobLog.findFirst({
        where: { jobName: name },
        orderBy: { startedAt: "desc" },
      });
      if (last) {
        latest.push({
          jobName: name,
          status: last.status,
          lastRun: last.startedAt,
          durationMs: last.durationMs,
          summary: last.summary,
          error: last.error,
        });
      } else {
        latest.push({ jobName: name, status: "never", lastRun: null, durationMs: null, summary: null, error: null });
      }
    }

    return res.json({ latest, logs });
  } catch (err) {
    return sendError(res, 500, "SERVER_ERROR", err.message);
  }
});

// ──────────────────────────────────────────────
// GET /admin/system/test-health
// Test suite health summary
// ──────────────────────────────────────────────
router.get("/admin/system/test-health", async (req, res) => {
  try {
    if (req.systemRole !== "pv_admin") {
      return sendError(res, 403, "FORBIDDEN", "Platform admin only");
    }

    const fs = require("fs");
    const path = require("path");

    // Count test files by category
    const testDir = path.join(__dirname, "../../test");
    let testFiles = [];
    try {
      testFiles = fs.readdirSync(testDir).filter(f => f.endsWith(".test.js"));
    } catch { /* test dir may not exist on prod */ }

    const categories = {};
    for (const file of testFiles) {
      const name = file.replace(".test.js", "");
      // Categorize by prefix
      let category = "other";
      if (name.includes("simulator") || name.includes("ai-")) category = "ai-engine";
      else if (name.includes("precedence") || name.includes("tiered") || name.includes("conditional") || name.includes("referral")) category = "promo-engine";
      else if (name.includes("growth") || name.includes("validation") || name.includes("oversight")) category = "analytics";
      else if (name.includes("square") || name.includes("clover") || name.includes("toast") || name.includes("pos") || name.includes("webhook")) category = "pos-integration";
      else if (name.includes("auth") || name.includes("hardening")) category = "security";
      else if (name.includes("consumer")) category = "consumer";
      else if (name.includes("merchant")) category = "merchant";
      else if (name.includes("reporting") || name.includes("onboarding")) category = "merchant";

      if (!categories[category]) categories[category] = [];
      categories[category].push(name);
    }

    // Check for last test run results file
    let lastRun = null;
    try {
      const resultsPath = path.join(__dirname, "../../jest-results.json");
      if (fs.existsSync(resultsPath)) {
        const results = JSON.parse(fs.readFileSync(resultsPath, "utf8"));
        lastRun = {
          timestamp: results.startTime ? new Date(results.startTime).toISOString() : null,
          totalSuites: results.numTotalTestSuites,
          passedSuites: results.numPassedTestSuites,
          failedSuites: results.numFailedTestSuites,
          totalTests: results.numTotalTests,
          passedTests: results.numPassedTests,
          failedTests: results.numFailedTests,
          duration: results.testResults?.reduce((s, r) => s + (r.perfStats?.runtime || 0), 0),
        };
      }
    } catch { /* no results file */ }

    return res.json({
      totalTestFiles: testFiles.length,
      categories,
      lastRun,
      environment: process.env.NODE_ENV || "development",
    });
  } catch (err) {
    return sendError(res, 500, "SERVER_ERROR", err.message);
  }
});

// ──────────────────────────────────────────────
// POST /admin/system/test-run
// Trigger a test run (development only)
// ──────────────────────────────────────────────
router.post("/admin/system/test-run", async (req, res) => {
  try {
    if (req.systemRole !== "pv_admin") {
      return sendError(res, 403, "FORBIDDEN", "Platform admin only");
    }

    if (process.env.NODE_ENV === "production") {
      return sendError(res, 403, "FORBIDDEN", "Test runs are not available in production. Use the local QA dashboard at localhost:4100.");
    }

    const { execSync } = require("child_process");
    const path = require("path");
    const rootDir = path.join(__dirname, "../..");

    try {
      execSync("npx jest --no-coverage --json --outputFile=jest-results.json --runInBand 2>jest-stderr.txt", {
        cwd: rootDir,
        timeout: 120000,
        stdio: "pipe",
      });
    } catch (e) {
      // Jest exits with code 1 when tests fail — still produces results
    }

    // Read results
    const fs = require("fs");
    const resultsPath = path.join(rootDir, "jest-results.json");
    if (fs.existsSync(resultsPath)) {
      const results = JSON.parse(fs.readFileSync(resultsPath, "utf8"));
      return res.json({
        success: results.numFailedTests === 0,
        totalTests: results.numTotalTests,
        passed: results.numPassedTests,
        failed: results.numFailedTests,
        duration: results.testResults?.reduce((s, r) => s + (r.perfStats?.runtime || 0), 0),
        failures: results.testResults
          ?.filter(r => r.status === "failed")
          .map(r => ({ file: r.testFilePath?.split(/[/\\]/).pop(), message: r.message?.slice(0, 200) })),
      });
    }

    return res.json({ success: false, message: "No results file generated" });
  } catch (err) {
    return sendError(res, 500, "SERVER_ERROR", err.message);
  }
});

module.exports = router;
