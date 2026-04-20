/**
 * agent.2.structurer.js — Knowledge Structurer
 *
 * Takes Agent 1's raw technical extraction + spec documents and
 * calls Claude API to build a structured knowledge graph.
 *
 * The knowledge graph maps:
 *   - Pages → what can go wrong, how to fix it
 *   - Error codes → plain-language cause, resolution steps
 *   - Flows → prerequisites, happy path, failure branches
 *   - POS states → what's working, what's broken
 *
 * Input: knowledge-raw.json + docs/*.md
 * Output: knowledge-graph.json
 * Runtime: ~60 seconds (one Claude API call)
 */

"use strict";

const fs = require("fs");
const path = require("path");

const OUTPUT_DIR = path.join(__dirname, "output");
const RAW_PATH = path.join(OUTPUT_DIR, "knowledge-raw.json");
const GRAPH_PATH = path.join(OUTPUT_DIR, "knowledge-graph.json");
const DOCS_DIR = path.join(__dirname, "../../docs");

/**
 * Load spec documents from docs/ directory.
 */
function loadSpecDocs() {
  const specs = [];
  if (!fs.existsSync(DOCS_DIR)) return specs;

  for (const file of fs.readdirSync(DOCS_DIR)) {
    if (!file.endsWith(".md")) continue;
    const content = fs.readFileSync(path.join(DOCS_DIR, file), "utf8");
    // Truncate large specs to keep within context limits
    specs.push({ name: file, content: content.slice(0, 3000) });
  }
  return specs;
}

/**
 * Run Agent 2 — structure raw knowledge into a queryable graph.
 */
async function runAgent2() {
  console.log("[Agent 2] Starting knowledge structuring...");

  if (!process.env.ANTHROPIC_API_KEY) {
    console.log("[Agent 2] No ANTHROPIC_API_KEY — skipping (use manually seeded knowledge-graph.json)");
    return { skipped: true, reason: "no_api_key" };
  }

  // Load inputs
  if (!fs.existsSync(RAW_PATH)) {
    console.log("[Agent 2] No knowledge-raw.json — run Agent 1 first");
    return { skipped: true, reason: "no_raw_input" };
  }

  const raw = JSON.parse(fs.readFileSync(RAW_PATH, "utf8"));
  const specs = loadSpecDocs();

  // Load existing knowledge graph for merging
  let existingGraph = null;
  if (fs.existsSync(GRAPH_PATH)) {
    try { existingGraph = JSON.parse(fs.readFileSync(GRAPH_PATH, "utf8")); } catch {}
  }

  const Anthropic = require("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  // Build a summary of raw data (not the full thing — too large for prompt)
  const rawSummary = {
    stats: raw.stats,
    sampleRoutes: raw.routes.slice(0, 30),
    models: raw.models.map(m => ({ name: m.name, fieldCount: m.fieldCount })),
    pvHooks: raw.pvHooks.slice(0, 30),
    errors: raw.errors.slice(0, 20),
    cronJobs: raw.cronJobs,
  };

  const specSummary = specs.map(s => `### ${s.name}\n${s.content.slice(0, 1500)}`).join("\n\n");

  const prompt = `You are building a knowledge graph for PerkValet's AI support system.
PerkValet is a loyalty platform for small businesses — coffee shops, gyms, retail.
Merchants are non-technical small business owners. Consumers are their customers.

You will receive a technical extraction of the codebase and product spec summaries.

Produce a structured knowledge graph in JSON that maps:
- Every major page → what it does, what can go wrong, how to fix it (merchant-friendly language)
- Every error code → plain-language cause and resolution steps
- Every major flow → prerequisites, steps, failure points
- POS connection states and what to do about each
- Promotion types and how they work

Rules:
- Resolution steps must be actionable by a non-technical merchant
- Never use technical jargon (no OAuth, webhooks, API tokens, database)
- Every failure must have at least one resolution step
- Be concise — this graph will be queried in real-time

${existingGraph ? "IMPORTANT: Merge with and improve the existing knowledge graph. Keep existing resolution steps that are good. Add new pages/flows/errors from the raw extraction." : ""}

Technical extraction:
${JSON.stringify(rawSummary, null, 2)}

Spec documents:
${specSummary}

${existingGraph ? `Existing knowledge graph to merge with:\n${JSON.stringify(existingGraph, null, 2).slice(0, 5000)}` : ""}

Return ONLY valid JSON, no markdown fences. Use this structure:
{
  "generated_at": "...",
  "version": "auto-v1",
  "pages": [{ "id": "...", "route": "...", "description": "...", "common_issues": [{ "id": "...", "trigger": "...", "cause": "...", "resolution": ["..."], "merchant_fixable": true }] }],
  "flows": [{ "id": "...", "description": "...", "steps": ["..."], "failure_points": ["..."] }],
  "error_codes": [{ "code": 401, "cause": "...", "merchant_fixable": true }],
  "pos_connection_states": [{ "state": "...", "description": "...", "action_needed": false }],
  "promotion_types": [{ "type": "...", "description": "...", "display": "..." }],
  "precedence_engine": { "description": "...", "levels": ["..."] }
}`;

  const start = Date.now();

  const msg = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 4000,
    messages: [{ role: "user", content: prompt }],
  });

  const responseText = (msg.content?.[0]?.text || "").trim()
    .replace(/^```json?\s*/i, "").replace(/\s*```$/, "");

  let graph;
  try {
    graph = JSON.parse(responseText);
  } catch (e) {
    console.error("[Agent 2] Failed to parse AI response as JSON:", e.message);
    console.error("[Agent 2] Raw response (first 500 chars):", responseText.slice(0, 500));
    return { skipped: true, reason: "parse_error" };
  }

  // Add metadata
  graph.generated_at = new Date().toISOString();
  graph.version = "auto-v" + Date.now();
  graph.source = "agent.2.structurer — Claude Sonnet";

  // Write output
  fs.writeFileSync(GRAPH_PATH, JSON.stringify(graph, null, 2));

  const durationMs = Date.now() - start;
  console.log(`[Agent 2] Complete — ${graph.pages?.length || 0} pages, ${graph.flows?.length || 0} flows, ${graph.error_codes?.length || 0} errors (${durationMs}ms)`);

  return { durationMs, pages: graph.pages?.length, flows: graph.flows?.length, errors: graph.error_codes?.length };
}

module.exports = { runAgent2, GRAPH_PATH };
