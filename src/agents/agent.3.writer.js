/**
 * agent.3.writer.js — Doc Writer Agent
 *
 * Takes the knowledge graph and generates human-readable help docs:
 *   - merchant-help.md — for store owners (plain language, short steps)
 *   - consumer-help.md — for app users (simplest possible language)
 *
 * Two Claude API calls with audience-specific prompts.
 *
 * Input: knowledge-graph.json
 * Output: docs/generated/merchant-help.md + consumer-help.md
 * Runtime: ~90 seconds
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { prisma } = require("../db/prisma");

const GRAPH_PATH = path.join(__dirname, "output", "knowledge-graph.json");
const OUTPUT_DIR = path.join(__dirname, "../../docs/generated");

/**
 * Run Agent 3 — generate help documentation from knowledge graph.
 */
async function runAgent3() {
  console.log("[Agent 3] Starting doc generation...");

  if (!process.env.ANTHROPIC_API_KEY) {
    console.log("[Agent 3] No ANTHROPIC_API_KEY — skipping");
    return { skipped: true, reason: "no_api_key" };
  }

  if (!fs.existsSync(GRAPH_PATH)) {
    console.log("[Agent 3] No knowledge-graph.json — run Agent 2 first");
    return { skipped: true, reason: "no_graph_input" };
  }

  const graph = JSON.parse(fs.readFileSync(GRAPH_PATH, "utf8"));
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const Anthropic = require("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const graphSummary = JSON.stringify(graph, null, 2).slice(0, 8000);
  const start = Date.now();

  // ── Merchant help ─────────────────────────────────────────

  const merchantPrompt = `You are writing help documentation for PerkValet merchants.
Merchants are small business owners — coffee shops, gyms, retail. Most are not technical.
They are busy. They do not read long documents.

Write in plain, direct language. Second person ("you", "your"). Short sentences.
Numbered steps for procedures. Never mention OAuth, webhooks, API tokens, or database.

Write help content organized by topic. Each topic has:
- A plain-language title (what the merchant is trying to do)
- One sentence describing what this feature does
- Step-by-step instructions for the most common task
- A "Something went wrong?" section with the top 2-3 issues and fixes
- A "Still stuck?" line directing to the ? help button

Cover these topics based on the knowledge graph:
1. Getting started (connecting POS, setting up stores)
2. Creating promotions (stamp cards, tiered, referrals, bundles)
3. Understanding your analytics (weekly summary, KPIs)
4. Managing rewards (how stamps work, how rewards are delivered)
5. Common issues and fixes

Knowledge graph:
${graphSummary}

Write the complete merchant help document now in Markdown:`;

  const merchantMsg = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 3000,
    messages: [{ role: "user", content: merchantPrompt }],
  });

  const merchantHelp = merchantMsg.content?.[0]?.text?.trim() || "";
  fs.writeFileSync(path.join(OUTPUT_DIR, "merchant-help.md"), merchantHelp);
  console.log(`[Agent 3] Merchant help: ${merchantHelp.length} chars`);

  // ── Consumer help ─────────────────────────────────────────

  const consumerPrompt = `You are writing help content for PerkValet consumers.
Consumers are customers of small businesses — coffee shop regulars, gym members.
They just want their loyalty rewards to work. They use a mobile app.
They have very low patience for technical issues.

Write in the simplest possible language. Very short sentences. Second person.
Focus on what they're trying to do, not how it works.
Never mention merchant, POS, webhook, or any technical concept.

Cover these topics:
1. How stamps work (you buy, you earn, you get rewarded)
2. How to check your progress (stamp dots, tier badges)
3. How to use a reward (it appears on your next visit)
4. How to find new places (Discover tab)
5. Why something might not be working

Knowledge graph:
${graphSummary}

Write the complete consumer help document in Markdown. Keep it SHORT:`;

  const consumerMsg = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 2000,
    messages: [{ role: "user", content: consumerPrompt }],
  });

  const consumerHelp = consumerMsg.content?.[0]?.text?.trim() || "";
  fs.writeFileSync(path.join(OUTPUT_DIR, "consumer-help.md"), consumerHelp);
  console.log(`[Agent 3] Consumer help: ${consumerHelp.length} chars`);

  // ── Per-page help articles ──────────────────────────────────

  const HELP_DIR = path.join(OUTPUT_DIR, "help");
  if (!fs.existsSync(HELP_DIR)) fs.mkdirSync(HELP_DIR, { recursive: true });

  // Load page manifests
  const manifestPath = path.join(__dirname, "output", "page-manifests.json");
  let manifests = {};
  try { manifests = JSON.parse(fs.readFileSync(manifestPath, "utf8")); } catch {}

  let pagesGenerated = 0;

  for (const [pageId, manifest] of Object.entries(manifests)) {
    if (!manifest.sections?.length) continue;

    const sectionsText = manifest.sections.map(s => {
      let text = `Section: ${s.label}\nDescription: ${s.plain_description}`;
      if (s.what_to_do_if_red) text += `\nTroubleshooting: ${s.what_to_do_if_red}`;
      if (s.what_to_do_if_failing) text += `\nTroubleshooting: ${s.what_to_do_if_failing}`;
      if (s.additional) text += `\nNote: ${s.additional}`;
      return text;
    }).join("\n\n");

    const audience = manifest.intended_roles?.includes("pv_admin") ? "PerkValet platform administrator" : "small business owner using PerkValet";

    const pagePrompt = `You are writing a complete help guide for the "${manifest.title}" page in PerkValet.
The reader is a ${audience}. They want step-by-step instructions.

Write in plain, direct language. Second person ("you", "your"). Short sentences.
Use numbered steps for procedures. Use ## for section headings.
Never use technical terms without explaining them.
Never mention OAuth, webhooks, API tokens, or database.

Page: ${manifest.title}
Overview: ${manifest.summary}

Sections to cover:
${sectionsText}

For each section write:
1. A clear heading (## Section Name)
2. What this section does (1-2 sentences)
3. Step-by-step instructions for the most common task
4. A "Something wrong?" subsection with the top 2-3 issues and plain-language fixes
5. End each section with "Still stuck? Tap the ? button for instant help."

Start with a brief overview paragraph, then cover each section.
Write the complete help article in Markdown:`;

    try {
      const pageMsg = await client.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 2000,
        messages: [{ role: "user", content: pagePrompt }],
      });

      const pageHelp = pageMsg.content?.[0]?.text?.trim() || "";
      if (pageHelp.length > 100) {
        // Write to filesystem (local dev) + database (persists on Render)
        fs.writeFileSync(path.join(HELP_DIR, `${pageId}.md`), pageHelp);
        await prisma.generatedHelpPage.upsert({
          where: { pageId },
          create: { pageId, content: pageHelp, charCount: pageHelp.length },
          update: { content: pageHelp, charCount: pageHelp.length },
        });
        pagesGenerated++;
        console.log(`[Agent 3] Help page: ${pageId} (${pageHelp.length} chars)`);
      }
    } catch (e) {
      console.error(`[Agent 3] Failed to generate help for ${pageId}:`, e?.message);
    }
  }

  const durationMs = Date.now() - start;
  console.log(`[Agent 3] Complete — merchant: ${merchantHelp.length} chars, consumer: ${consumerHelp.length} chars, ${pagesGenerated} help pages (${durationMs}ms)`);

  return {
    durationMs,
    merchantHelpChars: merchantHelp.length,
    consumerHelpChars: consumerHelp.length,
    helpPagesGenerated: pagesGenerated,
  };
}

module.exports = { runAgent3 };
