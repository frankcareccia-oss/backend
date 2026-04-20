/**
 * support.ai.handler.js — Real-time AI diagnosis for merchant support
 *
 * Takes the support context snapshot (what the merchant sees, what failed,
 * recent events) and queries the knowledge graph for a diagnosis.
 *
 * Uses Claude Haiku for sub-3-second response. Falls back to deterministic
 * diagnosis when AI is unavailable.
 *
 * POST /api/support/diagnose
 * POST /api/support/ticket
 */

"use strict";

const express = require("express");
const fs = require("fs");
const path = require("path");
const { prisma } = require("../db/prisma");
const { sendError } = require("../utils/errors");
const { requireJwt } = require("../middleware/auth");
const { emitPvHook } = require("../utils/hooks");

const router = express.Router();

// Load knowledge graph
function loadKnowledgeGraph() {
  try {
    const kgPath = path.join(__dirname, "output", "knowledge-graph.json");
    return JSON.parse(fs.readFileSync(kgPath, "utf8"));
  } catch {
    return null;
  }
}

// Find relevant knowledge graph sections based on the current page/error
function findRelevantKnowledge(kg, context) {
  if (!kg) return null;

  const results = { pages: [], flows: [], errors: [] };
  const currentPath = context.session?.pathname || context.session?.route || "";

  // Match pages
  for (const page of kg.pages || []) {
    if (currentPath.includes(page.route?.replace(/:\w+/g, "")) || page.id === context.session?.page) {
      results.pages.push(page);
    }
  }

  // Match error codes
  if (context.api?.lastError || context.lastApiError) {
    const errorStatus = context.api?.lastRequest?.match(/HTTP (\d+)/)?.[1] || context.lastApiError?.statusCode;
    if (errorStatus) {
      const match = (kg.error_codes || []).find(e => String(e.code) === String(errorStatus));
      if (match) results.errors.push(match);
    }
  }

  // Always include POS connection states if relevant
  if (currentPath.includes("onboarding") || currentPath.includes("setup") || currentPath.includes("pos")) {
    results.posStates = kg.pos_connection_states;
  }

  // Include precedence engine explanation if on promotions
  if (currentPath.includes("promotion")) {
    results.precedenceEngine = kg.precedence_engine;
  }

  return results;
}

// Deterministic diagnosis (fallback when AI unavailable)
function deterministicDiagnosis(context, relevantKg) {
  // Check for specific error patterns
  const lastStatus = context.apiEvents?.filter(e => e.direction === "in").pop()?.status;

  if (lastStatus === 401) {
    return {
      diagnosis: "Your session has expired. This happens after being inactive for a while.",
      confidence: "high",
      resolution_steps: ["Log out using the Logout button", "Log back in with your email and password"],
      requires_pv_support: false,
    };
  }

  if (lastStatus === 403) {
    return {
      diagnosis: "You don't have permission for this action. This usually means you need the account owner to do this step.",
      confidence: "high",
      resolution_steps: ["Check with the person who set up your PerkValet account", "They may need to log in and perform this action", "Or they can upgrade your access level in Team settings"],
      requires_pv_support: false,
    };
  }

  if (lastStatus >= 500) {
    return {
      diagnosis: "Something went wrong on our end. This is usually temporary.",
      confidence: "medium",
      resolution_steps: ["Refresh the page and try again", "If it keeps happening, we'll look into it"],
      requires_pv_support: lastStatus >= 500,
      escalation_message: "We've captured the details — our team will investigate.",
    };
  }

  // Check for page-specific issues from knowledge graph
  if (relevantKg?.pages?.length > 0) {
    const page = relevantKg.pages[0];
    if (page.common_issues?.length > 0) {
      const issue = page.common_issues[0];
      return {
        diagnosis: issue.cause,
        confidence: "medium",
        resolution_steps: issue.resolution,
        requires_pv_support: !issue.merchant_fixable,
      };
    }
  }

  // Generic
  return {
    diagnosis: "We noticed something didn't work as expected. Here are some things to try.",
    confidence: "low",
    resolution_steps: ["Refresh the page", "Log out and log back in", "If the issue continues, tap the button below to contact support"],
    requires_pv_support: false,
  };
}

// AI-powered diagnosis
async function aiDiagnosis(context, relevantKg) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return deterministicDiagnosis(context, relevantKg);
  }

  try {
    const Anthropic = require("@anthropic-ai/sdk");
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const prompt = `You are PerkValet's support AI. A merchant needs help right now.

Rules:
- One sentence diagnosis. One to three numbered resolution steps.
- Write for a non-technical small business owner.
- Never mention OAuth, tokens, webhooks, API, or database.
- Be warm but direct. They're busy. Get to the point.
- If the issue requires our support team, say so clearly.

Knowledge base:
${JSON.stringify(relevantKg, null, 2)}

Merchant context right now:
${JSON.stringify(context, null, 2)}

Respond in JSON only, no markdown:
{"diagnosis": "...", "confidence": "high|medium|low", "resolution_steps": ["Step 1", "Step 2"], "requires_pv_support": true|false, "escalation_message": "..." }`;

    const msg = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 200,
      messages: [{ role: "user", content: prompt }],
    });

    const raw = (msg.content?.[0]?.text || "").trim().replace(/^```json?\s*/i, "").replace(/\s*```$/, "");

    try {
      return JSON.parse(raw);
    } catch {
      return { diagnosis: raw, confidence: "medium", resolution_steps: [], requires_pv_support: false };
    }
  } catch (e) {
    console.error("[support.ai] AI diagnosis failed, using fallback:", e?.message);
    return deterministicDiagnosis(context, relevantKg);
  }
}

// Resolve merchantId from JWT user
async function resolveMerchantId(userId) {
  if (!userId) return null;
  const mu = await prisma.merchantUser.findFirst({
    where: { userId, status: "active" },
    select: { merchantId: true },
  });
  return mu?.merchantId || null;
}

// ──────────────────────────────────────────────
// POST /api/support/diagnose
// ──────────────────────────────────────────────
router.post("/api/support/diagnose", requireJwt, async (req, res) => {
  try {
    const context = req.body || {};
    const kg = loadKnowledgeGraph();
    const relevantKg = findRelevantKnowledge(kg, context);

    const merchantId = req.merchantId || await resolveMerchantId(req.userId);

    emitPvHook("support.diagnosis.requested", {
      tc: "TC-SUPPORT-DIAG-01", sev: "info", stable: "support:diagnosis:requested",
      merchantId,
      page: context.session?.pathname,
      hasError: !!(context.api?.lastError && context.api.lastError !== "—"),
    });

    const result = await aiDiagnosis(context, relevantKg);

    emitPvHook("support.diagnosis.delivered", {
      tc: "TC-SUPPORT-DIAG-02", sev: "info", stable: "support:diagnosis:delivered",
      merchantId,
      confidence: result.confidence,
      requiresSupport: result.requires_pv_support,
    });

    return res.json(result);
  } catch (err) {
    console.error("[support.diagnose] error:", err?.message);
    return sendError(res, 500, "SERVER_ERROR", "Failed to diagnose issue");
  }
});

// ──────────────────────────────────────────────
// POST /api/support/ticket
// Create pre-populated support ticket
// ──────────────────────────────────────────────
router.post("/api/support/ticket", requireJwt, async (req, res) => {
  try {
    const { context, diagnosis } = req.body || {};
    const merchantId = req.merchantId || await resolveMerchantId(req.userId);

    if (!merchantId) return sendError(res, 400, "VALIDATION_ERROR", "Merchant context required");

    // Calculate days on platform
    const merchant = await prisma.merchant.findUnique({
      where: { id: merchantId },
      select: { createdAt: true },
    });
    const daysOnPlatform = merchant
      ? Math.floor((Date.now() - new Date(merchant.createdAt).getTime()) / 86400000)
      : null;

    // Determine priority
    let priority = "normal";
    const lastStatus = context?.apiEvents?.filter(e => e.direction === "in").pop()?.status;
    if (lastStatus >= 500) priority = "high";
    if (context?.session?.pathname?.includes("billing") || context?.session?.pathname?.includes("payment")) priority = "critical";

    const ticket = await prisma.supportTicket.create({
      data: {
        merchantId,
        page: context?.session?.pathname || "unknown",
        action: context?.session?.route || null,
        lastError: context?.api?.lastError ? { error: context.api.lastError, lastRequest: context.api.lastRequest } : null,
        aiDiagnosis: diagnosis?.diagnosis || null,
        aiConfidence: diagnosis?.confidence || null,
        resolutionAttempted: diagnosis?.resolution_steps || null,
        platformSnapshot: context || {},
        eventLog: context?.apiEvents || [],
        posType: null,
        daysOnPlatform,
        billingStage: null,
        priority,
      },
    });

    emitPvHook("support.ticket.created", {
      tc: "TC-SUPPORT-TICKET-01", sev: "info", stable: "support:ticket:created",
      ticketId: ticket.id, merchantId, priority, page: ticket.page,
      diagnosis: diagnosis?.diagnosis,
    });

    return res.json({
      ticketId: ticket.id,
      priority,
      message: "Your request is in — we'll follow up shortly.",
    });
  } catch (err) {
    console.error("[support.ticket] error:", err?.message);
    return sendError(res, 500, "SERVER_ERROR", "Failed to create support ticket");
  }
});

// ──────────────────────────────────────────────
// GET /admin/support/tickets
// List all tickets (pv_admin only)
// ──────────────────────────────────────────────
router.get("/admin/support/tickets", requireJwt, async (req, res) => {
  try {
    if (req.systemRole !== "pv_admin") return sendError(res, 403, "FORBIDDEN", "Admin only");

    const tickets = await prisma.supportTicket.findMany({
      orderBy: [{ status: "asc" }, { priority: "asc" }, { createdAt: "desc" }],
      include: { merchant: { select: { name: true } } },
    });

    return res.json({
      tickets: tickets.map(t => ({
        ...t,
        merchantName: t.merchant?.name,
        merchant: undefined,
      })),
    });
  } catch (err) {
    return sendError(res, 500, "SERVER_ERROR", err.message);
  }
});

// ──────────────────────────────────────────────
// PATCH /admin/support/tickets/:id
// Update ticket status (pv_admin only)
// ──────────────────────────────────────────────
router.patch("/admin/support/tickets/:id", requireJwt, async (req, res) => {
  try {
    if (req.systemRole !== "pv_admin") return sendError(res, 403, "FORBIDDEN", "Admin only");

    const id = parseInt(req.params.id, 10);
    if (!id) return sendError(res, 400, "VALIDATION_ERROR", "Invalid ticket ID");

    const { status, resolutionNote } = req.body || {};
    const data = {};
    if (status) data.status = status;
    if (resolutionNote) data.resolutionNote = resolutionNote;
    if (status === "resolved") data.resolvedAt = new Date();

    const ticket = await prisma.supportTicket.update({ where: { id }, data });

    emitPvHook("support.ticket.updated", {
      tc: "TC-SUPPORT-TICKET-02", sev: "info", stable: "support:ticket:updated",
      ticketId: id, status: ticket.status,
    });

    return res.json({ ticket });
  } catch (err) {
    return sendError(res, 500, "SERVER_ERROR", err.message);
  }
});

module.exports = router;
