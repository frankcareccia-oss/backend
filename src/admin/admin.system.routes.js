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
    const jobNames = ["growth-advisor", "gift-card-reconcile", "reward-expiry", "seed-morning", "seed-afternoon", "reporting", "stamp-expiry", "knowledge-snapshot"];
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

// ──────────────────────────────────────────────
// POST /admin/system/deploy-hook
// Trigger Agent 1 (code reader) after deploy
// Can also be called manually by pv_admin
// ──────────────────────────────────────────────
router.post("/admin/system/deploy-hook", async (req, res) => {
  try {
    // Allow unauthenticated calls from Render deploy hook (with secret)
    // Or authenticated pv_admin calls
    const deploySecret = req.headers["x-deploy-secret"] || req.query.secret;
    const isAdmin = req.systemRole === "pv_admin";
    const isDeployHook = deploySecret === (process.env.DEPLOY_HOOK_SECRET || "pv-deploy-2026");

    if (!isAdmin && !isDeployHook) {
      return sendError(res, 403, "FORBIDDEN", "Unauthorized");
    }

    const { runAgent1 } = require("../agents/agent.1.reader");
    const { runAgent2 } = require("../agents/agent.2.structurer");
    const { runAgent3 } = require("../agents/agent.3.writer");
    const { gate } = require("../agents/lib/gate");
    const { runSnapshot } = require("../agents/agent.4.validator");
    const path = require("path");

    const rawPath = path.join(__dirname, "../agents/output/knowledge-raw.json");
    const graphPath = path.join(__dirname, "../agents/output/knowledge-graph.json");
    const triggeredBy = isDeployHook ? "deploy" : "manual";
    const results = { agents: [] };

    // ── Step 1: Code Reader ─────────────────────────────────
    const step1 = await gate(rawPath, runAgent1);
    await prisma.platformAgentLog.create({
      data: {
        agentName: "agent.1.reader", triggeredBy, status: "complete",
        outputChanged: step1.changed, durationMs: step1.durationMs,
        buildVersion: process.env.RENDER_GIT_COMMIT || null,
      },
    });
    results.agents.push({ agent: "agent.1.reader", changed: step1.changed, durationMs: step1.durationMs });

    if (!step1.changed) {
      return res.json({ ...results, message: "No code changes detected — pipeline stopped at Agent 1" });
    }

    // ── Step 2: Knowledge Structurer ────────────────────────
    const step2 = await gate(graphPath, runAgent2);
    await prisma.platformAgentLog.create({
      data: {
        agentName: "agent.2.structurer", triggeredBy: "agent1", status: step2.changed ? "complete" : "skipped",
        outputChanged: step2.changed, durationMs: step2.durationMs,
        buildVersion: process.env.RENDER_GIT_COMMIT || null,
      },
    });
    results.agents.push({ agent: "agent.2.structurer", changed: step2.changed, durationMs: step2.durationMs });

    // ── Step 3: Doc Writer ──────────────────────────────────
    if (step2.changed) {
      const start3 = Date.now();
      const step3Result = await runAgent3();
      const duration3 = Date.now() - start3;
      await prisma.platformAgentLog.create({
        data: {
          agentName: "agent.3.writer", triggeredBy: "agent2", status: step3Result.skipped ? "skipped" : "complete",
          outputChanged: !step3Result.skipped, durationMs: duration3,
          buildVersion: process.env.RENDER_GIT_COMMIT || null,
        },
      });
      results.agents.push({ agent: "agent.3.writer", changed: !step3Result.skipped, durationMs: duration3 });
    }

    // ── Step 4: Snapshot ────────────────────────────────────
    await runSnapshot();
    await prisma.platformAgentLog.create({
      data: {
        agentName: "agent.4.validator", triggeredBy: "agent1", status: "complete",
        outputChanged: true, buildVersion: process.env.RENDER_GIT_COMMIT || null,
      },
    });
    results.agents.push({ agent: "agent.4.validator", changed: true });

    return res.json({ ...results, message: "Full pipeline complete — knowledge base + docs updated" });
  } catch (err) {
    console.error("[deploy-hook] error:", err?.message || err);
    return sendError(res, 500, "SERVER_ERROR", err.message);
  }
});

// ──────────────────────────────────────────────
// GET /admin/system/agent-logs
// View agent pipeline run history
// ──────────────────────────────────────────────
router.get("/admin/system/agent-logs", async (req, res) => {
  try {
    if (req.systemRole !== "pv_admin") return sendError(res, 403, "FORBIDDEN", "Admin only");

    const logs = await prisma.platformAgentLog.findMany({
      orderBy: { createdAt: "desc" },
      take: 50,
    });

    return res.json({ logs });
  } catch (err) {
    return sendError(res, 500, "SERVER_ERROR", err.message);
  }
});

// ──────────────────────────────────────────────
// GET /admin/system/generated-docs
// View generated help documentation
// ──────────────────────────────────────────────
router.get("/admin/system/generated-docs", async (req, res) => {
  try {
    if (req.systemRole !== "pv_admin") return sendError(res, 403, "FORBIDDEN", "Admin only");

    const fs = require("fs");
    const path = require("path");
    const docsDir = path.join(__dirname, "../../docs/generated");

    const docs = {};
    if (fs.existsSync(docsDir)) {
      for (const file of fs.readdirSync(docsDir)) {
        if (file.endsWith(".md")) {
          docs[file] = fs.readFileSync(path.join(docsDir, file), "utf8");
        }
      }
    }

    // Knowledge graph stats
    const kgPath = path.join(__dirname, "../agents/output/knowledge-graph.json");
    let kgStats = null;
    if (fs.existsSync(kgPath)) {
      const kg = JSON.parse(fs.readFileSync(kgPath, "utf8"));
      kgStats = {
        generatedAt: kg.generated_at,
        version: kg.version,
        source: kg.source,
        pages: kg.pages?.length || 0,
        flows: kg.flows?.length || 0,
        errorCodes: kg.error_codes?.length || 0,
      };
    }

    // Snapshot history
    const snapshotDir = path.join(__dirname, "../agents/output/snapshots");
    let snapshots = [];
    if (fs.existsSync(snapshotDir)) {
      snapshots = fs.readdirSync(snapshotDir)
        .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d))
        .sort()
        .reverse();
    }

    return res.json({ docs, kgStats, snapshots });
  } catch (err) {
    return sendError(res, 500, "SERVER_ERROR", err.message);
  }
});

module.exports = router;
