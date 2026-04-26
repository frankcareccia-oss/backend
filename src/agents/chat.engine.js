/**
 * chat.engine.js — Three-layer merchant support chatbot
 *
 * Layer 1: Rule-based intent matching against knowledge graph + page manifests (FREE)
 * Layer 2: Claude Haiku with rich merchant context (PAY PER CALL)
 * Layer 3: Ticket escalation with full conversation + attempt history (FREE)
 *
 * Every L2/L3 interaction is stored for admin review and pattern promotion.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { prisma } = require("../db/prisma");
const { emitPvHook } = require("../utils/hooks");
const { t } = require("../i18n/t");

// ── Knowledge loading ────────────────────────────────────────────────────────

function loadPageManifests() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, "output", "page-manifests.json"), "utf8"));
  } catch { return {}; }
}

function loadKnowledgeRaw() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, "output", "knowledge-raw.json"), "utf8"));
  } catch { return {}; }
}

// ── Layer 1: Rule-based intent engine ────────────────────────────────────────

// Intent patterns — keyword groups mapped to structured answers
const INTENT_PATTERNS = [
  // HOW TO — Promotions
  { keywords: ["add promotion", "create promotion", "new promotion", "set up promotion", "make promotion", "start promotion", "launch promotion"],
    intent: "howto_create_promotion", page: "merchant_promotions", requiredRole: ["owner", "merchant_admin"],
    tKey: "chat.howto_create_promotion",
    action: { labelKey: "chat.actionLabel_promotions", to: "/merchant/promotions" } },

  // HOW TO — Products
  { keywords: ["add product", "create product", "new product", "add item", "add menu"],
    intent: "howto_create_product", page: "merchant_products", requiredRole: ["owner", "merchant_admin"],
    tKey: "chat.howto_create_product",
    action: { labelKey: "chat.actionLabel_products", to: "/merchant/products" } },

  // HOW TO — Stores
  { keywords: ["add store", "new store", "add location", "new location"],
    intent: "howto_add_store", page: "merchant_stores", requiredRole: ["owner", "merchant_admin"],
    tKey: "chat.howto_add_store",
    action: { labelKey: "chat.actionLabel_stores", to: "/merchant/stores" } },

  // HOW TO — Team
  { keywords: ["add user", "invite user", "add staff", "add employee", "invite team", "add team member"],
    intent: "howto_add_user", page: "merchant_users", requiredRole: ["owner", "merchant_admin"],
    tKey: "chat.howto_add_user",
    action: { labelKey: "chat.actionLabel_team", to: "/merchant/users" } },

  // HOW TO — QR Codes
  { keywords: ["qr code", "print qr", "get qr", "generate qr", "download qr"],
    intent: "howto_qr_code", page: "merchant_stores",
    tKey: "chat.howto_qr_code",
    action: { labelKey: "chat.actionLabel_stores", to: "/merchant/stores" } },

  // HOW TO — Bundles
  { keywords: ["create bundle", "add bundle", "make bundle", "new bundle"],
    intent: "howto_create_bundle", page: "merchant_bundles", requiredRole: ["owner", "merchant_admin"],
    tKey: "chat.howto_create_bundle",
    action: { labelKey: "chat.actionLabel_bundles", to: "/merchant/bundles" },
    requiresTier: "value_added", tierTKey: "chat.tierBlocked_bundle" },

  // WHERE TO — Navigation
  { keywords: ["where is", "find", "how do i get to", "navigate to", "go to"],
    intent: "where_to", isPrefix: true },

  { keywords: ["settings", "password", "change password", "profile"],
    intent: "where_settings",
    tKey: "chat.where_settings",
    action: { labelKey: "chat.actionLabel_settings", to: "/merchant/settings" } },

  { keywords: ["analytics", "reports", "stats", "performance", "numbers", "data"],
    intent: "where_analytics",
    tKey: "chat.where_analytics",
    action: { labelKey: "chat.actionLabel_analytics", to: "/merchant/analytics" } },

  { keywords: ["invoice", "bill", "billing", "payment", "pay"],
    intent: "where_billing",
    tKey: "chat.where_billing",
    action: { labelKey: "chat.actionLabel_plan", to: "/merchant/plan" } },

  // FEATURE QUESTIONS
  { keywords: ["growth advisor", "growth studio", "recommendation"],
    intent: "feature_growth_advisor",
    tKey: "chat.feature_growth_advisor",
    action: { labelKey: "chat.actionLabel_growthAdvisor", to: "/merchant/growth-studio" },
    requiresTier: "value_added", tierTKey: "chat.tierBlocked_growth_advisor" },

  { keywords: ["weekly summary", "weekly briefing", "weekly report", "monday report"],
    intent: "feature_weekly",
    tKey: "chat.feature_weekly",
    action: { labelKey: "chat.actionLabel_weekly", to: "/merchant/weekly" } },

  { keywords: ["simulator", "simulate", "projection", "roi", "what if"],
    intent: "feature_simulator",
    tKey: "chat.feature_simulator",
    requiresTier: "value_added", tierTKey: "chat.tierBlocked_simulator" },

  // PLAN / UPGRADE
  { keywords: ["upgrade", "value added", "value-added", "plan", "pricing", "cost", "price"],
    intent: "plan_upgrade",
    tKey: "chat.plan_upgrade",
    action: { labelKey: "chat.actionLabel_plan", to: "/merchant/plan" } },

  // TROUBLESHOOTING
  { keywords: ["not working", "broken", "error", "problem", "issue", "bug", "wrong", "stuck", "can't", "won't"],
    intent: "troubleshoot_generic",
    tKey: null }, // Falls through to Layer 2

  { keywords: ["stamps not", "stamp not", "stamps aren't", "stamps are not", "not earning stamps", "not accumulating", "not getting stamps", "stamps missing", "stamps not showing", "no stamps"],
    intent: "troubleshoot_stamps",
    tKey: "chat.troubleshoot_stamps" },

  { keywords: ["can't login", "can't log in", "login problem", "password not working", "locked out"],
    intent: "troubleshoot_login",
    tKey: "chat.troubleshoot_login" },
];

/**
 * Resolve an action object, translating labelKey → label for the given locale.
 */
function resolveAction(action, locale) {
  if (!action) return null;
  return { label: t(action.labelKey, locale), to: action.to };
}

/**
 * Score a merchant's message against intent patterns.
 * Returns { matched, intent, answer, action, confidence, tierBlocked } or null.
 */
function matchIntent(message, merchantContext, locale = "en") {
  // Strip articles and filler so "add a promotion" matches "add promotion"
  const msg = message.toLowerCase().trim().replace(/\b(a|an|the|my|our|some)\b/g, " ").replace(/\s+/g, " ").trim();
  let bestMatch = null;
  let bestScore = 0;

  for (const pattern of INTENT_PATTERNS) {
    if (pattern.isPrefix) continue; // prefix patterns are handled separately

    let score = 0;
    for (const kw of pattern.keywords) {
      if (msg.includes(kw)) {
        score += kw.split(" ").length; // longer keyword matches = higher score
      }
    }

    if (score > bestScore) {
      bestScore = score;
      bestMatch = pattern;
    }
  }

  if (!bestMatch || bestScore === 0) return null;

  // Check role access
  if (bestMatch.requiredRole && merchantContext?.merchantRole) {
    if (!bestMatch.requiredRole.includes(merchantContext.merchantRole)) {
      return {
        matched: true,
        intent: bestMatch.intent,
        confidence: 0.9,
        answer: t("chat.roleBlocked", locale, { roles: bestMatch.requiredRole.join(" or ") }),
        action: null,
        tierBlocked: false,
        layer: 1,
      };
    }
  }

  // Check tier access
  if (bestMatch.requiresTier && merchantContext?.planTier !== bestMatch.requiresTier) {
    return {
      matched: true,
      intent: bestMatch.intent,
      confidence: 0.85,
      answer: t(bestMatch.tierTKey, locale),
      action: resolveAction({ labelKey: "chat.actionLabel_viewPlan", to: "/merchant/plan" }, locale),
      tierBlocked: true,
      layer: 1,
    };
  }

  // No tKey = fall through to Layer 2
  if (!bestMatch.tKey) return null;

  return {
    matched: true,
    intent: bestMatch.intent,
    confidence: bestScore >= 2 ? 0.9 : 0.7,
    answer: t(bestMatch.tKey, locale),
    action: resolveAction(bestMatch.action, locale),
    tierBlocked: false,
    layer: 1,
  };
}

/**
 * Try page-context matching — if the merchant is on a specific page,
 * check the manifest for relevant answers.
 */
function matchPageContext(message, pageId, manifests) {
  const manifest = manifests[pageId];
  if (!manifest) return null;

  const msg = message.toLowerCase();

  // Check if any section label matches
  for (const section of manifest.sections || []) {
    const labelWords = section.label.toLowerCase().split(/\s+/);
    const matchCount = labelWords.filter(w => msg.includes(w)).length;
    if (matchCount >= Math.ceil(labelWords.length / 2)) {
      return {
        matched: true,
        intent: `page_section_${section.id}`,
        confidence: 0.75,
        answer: section.plain_description,
        action: null,
        tierBlocked: false,
        layer: 1,
      };
    }
  }

  return null;
}

// ── Layer 2: Claude Haiku with merchant context ──────────────────────────────

async function layer2Response(message, merchantContext, conversationHistory, layer1Attempt, locale = "en") {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  // Get model from PlatformConfig or default
  let model = "claude-haiku-4-5-20251001";
  try {
    const configRow = await prisma.platformConfig.findUnique({ where: { key: "chat_model" } });
    if (configRow?.value) model = configRow.value;
  } catch {}

  const manifests = loadPageManifests();
  const pageManifest = manifests[merchantContext.pageId] || null;

  const systemPrompt = `You are PerkValet's support assistant — a helpful, warm chatbot built into the merchant dashboard.

WHO YOU'RE TALKING TO:
- Name: ${merchantContext.merchantName || "Merchant"}
- Business: ${merchantContext.businessType || "Small business"}
- Role: ${merchantContext.merchantRole || "owner"}
- Plan: ${merchantContext.planTier || "base"} tier
- POS: ${merchantContext.posType || "none"}
- Locations: ${merchantContext.locationCount || 1}
- Currently viewing: ${merchantContext.currentPage || "dashboard"}

PAGE CONTEXT:
${pageManifest ? `Page: ${pageManifest.title}\n${pageManifest.summary}\nSections: ${pageManifest.sections?.map(s => s.label).join(", ")}` : "Unknown page"}

RULES:
- Write for a non-technical small business owner. No jargon.
- Keep answers to 2-4 sentences. Be warm but get to the point.
- If they ask about a Value-Added feature and they're on Base, explain what it does AND mention it's available with Value-Added. Don't just say "upgrade" — make them want it.
- If you can point them to a specific page, include the path like **Go to Promotions** or **Check My Stores**.
- If you genuinely can't help, say so honestly and offer to create a support request.
- Never make up features that don't exist.
- Never discuss technical implementation (APIs, webhooks, databases).
${layer1Attempt ? `\nLayer 1 tried to answer but wasn't confident enough. Its best guess was intent "${layer1Attempt.intent}" with confidence ${layer1Attempt.confidence}. Build on that context if relevant.` : ""}

Respond naturally — no JSON, no markdown headers. Just a helpful answer like a knowledgeable colleague would give.
${locale !== "en" ? `\nIMPORTANT: The merchant's language is set to "${locale}". Respond entirely in that language.` : ""}`;

  try {
    const Anthropic = require("@anthropic-ai/sdk");
    const client = new Anthropic({ apiKey });

    const messages = [];
    for (const turn of conversationHistory.slice(-6)) { // last 6 turns for context
      messages.push({ role: turn.role, content: turn.content });
    }
    messages.push({ role: "user", content: message });

    const resp = await client.messages.create({
      model,
      max_tokens: 300,
      system: systemPrompt,
      messages,
    });

    return resp.content?.[0]?.text || null;
  } catch (e) {
    console.error("[chat.engine] Layer 2 failed:", e?.message);
    return null;
  }
}

// ── Main chat handler ────────────────────────────────────────────────────────

/**
 * Process a chat message through the three-layer engine.
 *
 * @param {string} message - The merchant's message
 * @param {object} merchantContext - { merchantId, merchantName, merchantRole, planTier, posType, locationCount, businessType, currentPage, pageId }
 * @param {Array} conversationHistory - Previous turns [{ role: "user"|"assistant", content }]
 * @param {string} locale - Language code (default "en")
 * @returns {object} { answer, action?, layer, intent?, confidence?, escalate? }
 */
async function processChat(message, merchantContext, conversationHistory, locale = "en") {
  const manifests = loadPageManifests();
  const startTime = Date.now();

  // ── Layer 1: Rule-based ──
  let layer1Result = matchIntent(message, merchantContext, locale);

  // Try page-context matching if intent match failed
  if (!layer1Result) {
    layer1Result = matchPageContext(message, merchantContext.pageId, manifests);
  }

  if (layer1Result && layer1Result.confidence >= 0.7) {
    emitPvHook("chat.answered", {
      tc: "TC-CHAT-01", sev: "info",
      stable: `chat:${merchantContext.merchantId}`,
      merchantId: merchantContext.merchantId,
      layer: 1, intent: layer1Result.intent,
      confidence: layer1Result.confidence,
      durationMs: Date.now() - startTime,
    });
    return layer1Result;
  }

  // ── Layer 2: Claude Haiku ──
  const l2Answer = await layer2Response(message, merchantContext, conversationHistory, layer1Result, locale);

  if (l2Answer) {
    // Store L2 interaction for admin review + promotion potential
    try {
      await prisma.chatInteraction.create({
        data: {
          merchantId: merchantContext.merchantId,
          layer: 2,
          userMessage: message,
          botResponse: l2Answer,
          page: merchantContext.currentPage,
          role: merchantContext.merchantRole,
          planTier: merchantContext.planTier,
          intent: layer1Result?.intent || null,
          l1Confidence: layer1Result?.confidence || null,
          resolved: null, // merchant feedback later
        },
      });
    } catch (e) {
      console.warn("[chat.engine] failed to store L2 interaction:", e?.message);
    }

    emitPvHook("chat.answered", {
      tc: "TC-CHAT-02", sev: "info",
      stable: `chat:${merchantContext.merchantId}`,
      merchantId: merchantContext.merchantId,
      layer: 2, intent: layer1Result?.intent || "unknown",
      durationMs: Date.now() - startTime,
    });

    return {
      matched: true,
      answer: l2Answer,
      layer: 2,
      intent: layer1Result?.intent || "ai_response",
      confidence: 0.6,
      action: null,
    };
  }

  // ── Layer 3: Escalation offer ──
  emitPvHook("chat.escalation_offered", {
    tc: "TC-CHAT-03", sev: "info",
    stable: `chat:${merchantContext.merchantId}`,
    merchantId: merchantContext.merchantId,
    intent: layer1Result?.intent || "unknown",
  });

  return {
    matched: false,
    answer: t("chat.escalationOffer", locale),
    layer: 3,
    intent: layer1Result?.intent || "unknown",
    confidence: 0,
    escalate: true,
    action: null,
  };
}

/**
 * Create an escalation ticket with full conversation context + layer attempts.
 */
async function createEscalationTicket(merchantContext, conversationHistory, layerAttempts) {
  const ticket = await prisma.supportTicket.create({
    data: {
      merchantId: merchantContext.merchantId,
      page: merchantContext.currentPage || "unknown",
      action: "chatbot_escalation",
      aiDiagnosis: layerAttempts.map(a => `Layer ${a.layer}: ${a.intent || "unknown"} (confidence: ${a.confidence || 0})`).join("; "),
      aiConfidence: "low",
      resolutionAttempted: layerAttempts.map(a => a.answer).filter(Boolean),
      platformSnapshot: {
        merchantRole: merchantContext.merchantRole,
        planTier: merchantContext.planTier,
        posType: merchantContext.posType,
        locationCount: merchantContext.locationCount,
        conversationHistory: conversationHistory.slice(-10),
      },
      eventLog: conversationHistory.map((turn, i) => ({
        seq: i, role: turn.role, content: turn.content, ts: turn.ts || new Date().toISOString(),
      })),
      priority: "normal",
    },
  });

  // Store L3 interaction
  try {
    const lastUserMsg = conversationHistory.filter(t => t.role === "user").pop()?.content || "";
    await prisma.chatInteraction.create({
      data: {
        merchantId: merchantContext.merchantId,
        layer: 3,
        userMessage: lastUserMsg,
        botResponse: "Escalated to support ticket #" + ticket.id,
        page: merchantContext.currentPage,
        role: merchantContext.merchantRole,
        planTier: merchantContext.planTier,
        intent: layerAttempts[0]?.intent || null,
        l1Confidence: layerAttempts.find(a => a.layer === 1)?.confidence || null,
        resolved: false,
        ticketId: ticket.id,
      },
    });
  } catch (e) {
    console.warn("[chat.engine] failed to store L3 interaction:", e?.message);
  }

  emitPvHook("chat.ticket_created", {
    tc: "TC-CHAT-04", sev: "info",
    stable: `chat:ticket:${ticket.id}`,
    merchantId: merchantContext.merchantId,
    ticketId: ticket.id,
    layerAttempts: layerAttempts.length,
  });

  return ticket;
}

module.exports = { processChat, createEscalationTicket, matchIntent };
