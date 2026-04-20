// test/agent-pipeline.test.js — Agent pipeline (code reader, gate, snapshot)

"use strict";

const fs = require("fs");
const path = require("path");

// ── Agent 1: Code Reader ─────────────────────────────────────

describe("Agent 1 — Code Reader", () => {
  const { runAgent1, OUTPUT_PATH } = require("../src/agents/agent.1.reader");

  test("scans codebase and produces knowledge-raw.json", async () => {
    const result = await runAgent1();

    expect(result.durationMs).toBeDefined();
    expect(result.stats.routes).toBeGreaterThan(50);
    expect(result.stats.models).toBeGreaterThan(20);
    expect(result.stats.pvHooks).toBeGreaterThan(10);
    expect(result.stats.errorCodes).toBeGreaterThan(10);
    expect(result.stats.cronJobs).toBeGreaterThanOrEqual(7);
  });

  test("output file is valid JSON", () => {
    const content = fs.readFileSync(OUTPUT_PATH, "utf8");
    const data = JSON.parse(content);

    expect(data.generated_at).toBeDefined();
    expect(data.agent).toBe("agent.1.reader");
    expect(Array.isArray(data.routes)).toBe(true);
    expect(Array.isArray(data.models)).toBe(true);
    expect(Array.isArray(data.pvHooks)).toBe(true);
    expect(Array.isArray(data.errors)).toBe(true);
    expect(Array.isArray(data.cronJobs)).toBe(true);
  });

  test("extracts routes with auth info", () => {
    const content = JSON.parse(fs.readFileSync(OUTPUT_PATH, "utf8"));
    const merchantRoute = content.routes.find(r => r.path.includes("/merchant/dashboard"));
    expect(merchantRoute).toBeDefined();
    expect(merchantRoute.auth).toBeTruthy();
  });

  test("extracts Prisma models with fields", () => {
    const content = JSON.parse(fs.readFileSync(OUTPUT_PATH, "utf8"));
    const merchantModel = content.models.find(m => m.name === "Merchant");
    expect(merchantModel).toBeDefined();
    expect(merchantModel.fieldCount).toBeGreaterThan(5);
  });

  test("extracts pvHook events", () => {
    const content = JSON.parse(fs.readFileSync(OUTPUT_PATH, "utf8"));
    const promoHook = content.pvHooks.find(h => h.event.includes("promo"));
    expect(promoHook).toBeDefined();
    expect(promoHook.files.length).toBeGreaterThan(0);
  });

  test("extracts cron jobs with schedules", () => {
    const content = JSON.parse(fs.readFileSync(OUTPUT_PATH, "utf8"));
    const reportingCron = content.cronJobs.find(c => c.name === "reporting");
    expect(reportingCron).toBeDefined();
    expect(reportingCron.schedule).toBe("0 2 * * *");
  });
});

// ── Gate Logic ───────────────────────────────────────────────

describe("Gate logic", () => {
  const { gate, hashFile } = require("../src/agents/lib/gate");
  const tmpFile = path.join(__dirname, "__gate_test_tmp.json");

  afterAll(() => {
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
  });

  test("detects when output changes", async () => {
    fs.writeFileSync(tmpFile, '{"v": 1}');
    const result = await gate(tmpFile, async () => {
      fs.writeFileSync(tmpFile, '{"v": 2}');
    });
    expect(result.changed).toBe(true);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("detects when output unchanged", async () => {
    fs.writeFileSync(tmpFile, '{"v": 2}');
    const result = await gate(tmpFile, async () => {
      // Don't change the file
    });
    expect(result.changed).toBe(false);
  });

  test("detects new file creation", async () => {
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
    const result = await gate(tmpFile, async () => {
      fs.writeFileSync(tmpFile, '{"new": true}');
    });
    expect(result.changed).toBe(true);
    expect(result.hashBefore).toBeNull();
    expect(result.hashAfter).toBeTruthy();
  });
});

// ── Agent 4: Snapshot ────────────────────────────────────────

describe("Agent 4 — Snapshot", () => {
  const { runSnapshot } = require("../src/agents/agent.4.validator");

  test("creates snapshot directory with today's date", async () => {
    const result = await runSnapshot();
    const today = new Date().toISOString().slice(0, 10);

    expect(result.date).toBe(today);
    expect(result.filesSnapshotted).toBeGreaterThanOrEqual(1);

    const snapshotDir = path.join(__dirname, "../src/agents/output/snapshots", today);
    expect(fs.existsSync(snapshotDir)).toBe(true);
  });

  test("retains max 7 days of snapshots", async () => {
    const result = await runSnapshot();
    expect(result.daysRetained).toBeLessThanOrEqual(7);
  });
});
