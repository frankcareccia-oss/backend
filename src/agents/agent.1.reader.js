/**
 * agent.1.reader.js — Code Reader Agent
 *
 * Scans the PerkValet codebase and extracts structured knowledge:
 *   - Routes (method, path, auth requirements)
 *   - Prisma schema (models, fields, relations)
 *   - pvHook events (name, file, payload shape)
 *   - Error codes (status, message, file)
 *   - Cron jobs (schedule, name, timezone)
 *   - Form fields (from admin UI)
 *
 * Output: src/agents/output/knowledge-raw.json
 * Trigger: deploy hook or manual
 * Runtime: ~5 seconds (pure filesystem reads, no API calls)
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { prisma } = require("../db/prisma");

const ROOT = path.join(__dirname, "../..");
const OUTPUT_PATH = path.join(__dirname, "output", "knowledge-raw.json");

/**
 * Recursively find files matching a pattern.
 */
function findFiles(dir, extensions, results = []) {
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules") {
      findFiles(full, extensions, results);
    } else if (entry.isFile() && extensions.some(ext => entry.name.endsWith(ext))) {
      results.push(full);
    }
  }
  return results;
}

/**
 * Extract route definitions from Express router files.
 */
function extractRoutes() {
  const srcDir = path.join(ROOT, "src");
  const files = findFiles(srcDir, [".js"]);
  const routes = [];

  const routePattern = /router\.(get|post|patch|put|delete)\(\s*["'`]([^"'`]+)["'`]/gi;

  for (const file of files) {
    const content = fs.readFileSync(file, "utf8");
    let match;
    while ((match = routePattern.exec(content)) !== null) {
      const method = match[1].toUpperCase();
      const routePath = match[2];
      const relPath = path.relative(ROOT, file).replace(/\\/g, "/");

      // Check for auth middleware
      const lineStart = content.lastIndexOf("\n", match.index) + 1;
      const lineEnd = content.indexOf("\n", match.index + match[0].length + 200);
      const context = content.slice(lineStart, lineEnd);
      const requiresJwt = /requireJwt|requireConsumerJwt/.test(context);
      const requiresAdmin = /requireAdmin/.test(context);
      const requiresMerchant = /requireMerchantRole/.test(context);

      routes.push({
        method, path: routePath, file: relPath,
        auth: requiresJwt ? (requiresAdmin ? "admin" : requiresMerchant ? "merchant" : "jwt") : "none",
      });
    }
  }

  return routes;
}

/**
 * Extract Prisma model definitions from schema.
 */
function extractModels() {
  const schemaPath = path.join(ROOT, "prisma", "schema.prisma");
  if (!fs.existsSync(schemaPath)) return [];

  const content = fs.readFileSync(schemaPath, "utf8");
  const models = [];
  const modelPattern = /model\s+(\w+)\s*\{([^}]+)\}/g;

  let match;
  while ((match = modelPattern.exec(content)) !== null) {
    const name = match[1];
    const body = match[2];
    const fields = [];

    for (const line of body.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("@@") || trimmed.startsWith("///")) continue;
      const fieldMatch = trimmed.match(/^(\w+)\s+(\S+)/);
      if (fieldMatch) {
        fields.push({ name: fieldMatch[1], type: fieldMatch[2] });
      }
    }

    models.push({ name, fieldCount: fields.length, fields: fields.slice(0, 20) }); // limit for size
  }

  return models;
}

/**
 * Extract pvHook event emissions.
 */
function extractPvHooks() {
  const srcDir = path.join(ROOT, "src");
  const files = findFiles(srcDir, [".js"]);
  const hooks = [];

  const hookPattern = /emitPvHook\(\s*["'`]([^"'`]+)["'`]/g;

  for (const file of files) {
    const content = fs.readFileSync(file, "utf8");
    let match;
    while ((match = hookPattern.exec(content)) !== null) {
      const relPath = path.relative(ROOT, file).replace(/\\/g, "/");
      hooks.push({ event: match[1], file: relPath });
    }
  }

  // Deduplicate by event name
  const unique = new Map();
  for (const h of hooks) {
    if (!unique.has(h.event)) unique.set(h.event, []);
    unique.get(h.event).push(h.file);
  }

  return [...unique.entries()].map(([event, files]) => ({ event, files: [...new Set(files)] }));
}

/**
 * Extract error response patterns.
 */
function extractErrors() {
  const srcDir = path.join(ROOT, "src");
  const files = findFiles(srcDir, [".js"]);
  const errors = [];

  const errorPattern = /sendError\(\s*\w+\s*,\s*(\d{3})\s*,\s*["'`]([^"'`]+)["'`]\s*,\s*["'`]([^"'`]+)["'`]/g;

  for (const file of files) {
    const content = fs.readFileSync(file, "utf8");
    let match;
    while ((match = errorPattern.exec(content)) !== null) {
      const relPath = path.relative(ROOT, file).replace(/\\/g, "/");
      errors.push({
        status: parseInt(match[1], 10),
        code: match[2],
        message: match[3],
        file: relPath,
      });
    }
  }

  // Deduplicate by code
  const byCode = new Map();
  for (const e of errors) {
    if (!byCode.has(e.code)) byCode.set(e.code, { status: e.status, code: e.code, message: e.message, files: [] });
    byCode.get(e.code).files.push(e.file);
  }

  return [...byCode.values()].map(e => ({ ...e, files: [...new Set(e.files)] }));
}

/**
 * Extract cron job registrations.
 */
function extractCronJobs() {
  const indexPath = path.join(ROOT, "index.js");
  if (!fs.existsSync(indexPath)) return [];

  const content = fs.readFileSync(indexPath, "utf8");
  const crons = [];

  const cronPattern = /cron\.schedule\(\s*["'`]([^"'`]+)["'`]\s*,\s*withCronLog\(\s*["'`]([^"'`]+)["'`]/g;

  let match;
  while ((match = cronPattern.exec(content)) !== null) {
    // Look for timezone
    const context = content.slice(match.index, match.index + 200);
    const tzMatch = context.match(/timezone:\s*["'`]([^"'`]+)["'`]/);

    crons.push({
      schedule: match[1],
      name: match[2],
      timezone: tzMatch ? tzMatch[1] : "UTC",
    });
  }

  return crons;
}

/**
 * Get database stats for context.
 */
async function getDbStats() {
  try {
    const [merchants, stores, consumers, promotions, visits] = await Promise.all([
      prisma.merchant.count(),
      prisma.store.count(),
      prisma.consumer.count(),
      prisma.promotion.count(),
      prisma.visit.count(),
    ]);
    return { merchants, stores, consumers, promotions, visits };
  } catch {
    return null;
  }
}

/**
 * Run Agent 1 — scan codebase, output knowledge-raw.json.
 */
async function runAgent1() {
  console.log("[Agent 1] Starting codebase scan...");
  const start = Date.now();

  const routes = extractRoutes();
  const models = extractModels();
  const pvHooks = extractPvHooks();
  const errors = extractErrors();
  const cronJobs = extractCronJobs();
  const dbStats = await getDbStats();

  const output = {
    generated_at: new Date().toISOString(),
    build_version: process.env.RENDER_GIT_COMMIT || "local",
    agent: "agent.1.reader",
    stats: {
      routes: routes.length,
      models: models.length,
      pvHooks: pvHooks.length,
      errorCodes: errors.length,
      cronJobs: cronJobs.length,
    },
    dbStats,
    routes,
    models,
    pvHooks,
    errors,
    cronJobs,
  };

  // Ensure output directory exists
  const outputDir = path.dirname(OUTPUT_PATH);
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));

  const durationMs = Date.now() - start;
  console.log(`[Agent 1] Complete — ${routes.length} routes, ${models.length} models, ${pvHooks.length} hooks, ${errors.length} errors, ${cronJobs.length} crons (${durationMs}ms)`);

  return { durationMs, stats: output.stats };
}

module.exports = { runAgent1, OUTPUT_PATH };
