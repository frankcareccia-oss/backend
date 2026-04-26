/**
 * merchant.voice.routes.js — Your Voice API endpoints
 *
 * GET    /merchant/voice/templates     — list all templates for this merchant
 * POST   /merchant/voice/generate      — AI-generate a custom template
 * POST   /merchant/voice/translate     — generate Spanish from English
 * PATCH  /merchant/voice/template      — save a template (custom or revert to default)
 */

"use strict";

const express = require("express");
const { prisma } = require("../db/prisma");
const { sendError } = require("../utils/errors");
const { requireJwt } = require("../middleware/auth");
const { emitPvHook } = require("../utils/hooks");
const { generateVoiceEmail, generateSpanishVersion } = require("../services/voice.generator");
const { DEFAULT_TEMPLATES } = require("../services/triggered.emails");

const router = express.Router();

const EVENT_TYPES = ["welcome", "first_reward", "milestone", "winback", "expiry_warning"];

// Resolve merchantId from JWT
async function getMerchantId(req) {
  if (!req.userId) return null;
  const mu = await prisma.merchantUser.findFirst({
    where: { userId: req.userId, status: "active" },
    select: { merchantId: true },
  });
  return mu?.merchantId || null;
}

// Get owner name
async function getOwnerName(merchantId) {
  const mu = await prisma.merchantUser.findFirst({
    where: { merchantId, role: "owner", status: "active" },
    include: { user: { select: { firstName: true } } },
  });
  return mu?.user?.firstName || "The Team";
}

// ──────────────────────────────────────────────
// GET /merchant/voice/templates
// ──────────────────────────────────────────────
router.get("/merchant/voice/templates", requireJwt, async (req, res) => {
  try {
    const merchantId = await getMerchantId(req);
    if (!merchantId) return sendError(res, 400, "VALIDATION_ERROR", "Merchant context required");

    // Get any custom templates
    const customs = await prisma.emailTemplate.findMany({
      where: { merchantId },
      orderBy: [{ eventType: "asc" }, { language: "asc" }],
    });

    // Build response: for each event type, show default + custom status
    const templates = EVENT_TYPES.map(eventType => {
      const enCustom = customs.find(c => c.eventType === eventType && c.language === "en" && c.isCustom);
      const esCustom = customs.find(c => c.eventType === eventType && c.language === "es" && c.isCustom);
      const defaultEn = DEFAULT_TEMPLATES[eventType]?.en || null;
      const defaultEs = DEFAULT_TEMPLATES[eventType]?.es || null;

      return {
        eventType,
        isCustomized: !!(enCustom || esCustom),
        en: {
          subject: enCustom?.subject || defaultEn?.subject || "",
          body: enCustom?.body || defaultEn?.body || "",
          isCustom: !!enCustom,
          styleChoice: enCustom?.styleChoice || null,
        },
        es: {
          subject: esCustom?.subject || defaultEs?.subject || "",
          body: esCustom?.body || defaultEs?.body || "",
          isCustom: !!esCustom,
        },
        defaultEn: defaultEn || null,
        defaultEs: defaultEs || null,
      };
    });

    const customizedCount = templates.filter(t => t.isCustomized).length;

    return res.json({ templates, customizedCount, total: EVENT_TYPES.length });
  } catch (err) {
    return sendError(res, 500, "SERVER_ERROR", err.message);
  }
});

// ──────────────────────────────────────────────
// POST /merchant/voice/generate
// AI-generate a custom template version
// ──────────────────────────────────────────────
router.post("/merchant/voice/generate", requireJwt, async (req, res) => {
  try {
    const merchantId = await getMerchantId(req);
    if (!merchantId) return sendError(res, 400, "VALIDATION_ERROR", "Merchant context required");

    // Feature gate: VA only
    const merchant = await prisma.merchant.findUnique({
      where: { id: merchantId },
      select: { id: true, name: true, merchantType: true, planTier: true },
    });
    if (merchant?.planTier !== "value_added") {
      return sendError(res, 403, "UPGRADE_REQUIRED", "Custom email voices require the Value-Added plan");
    }

    const { eventType, styleChoice, personalNote } = req.body || {};
    if (!eventType || !EVENT_TYPES.includes(eventType)) {
      return sendError(res, 400, "VALIDATION_ERROR", "Invalid eventType");
    }
    if (!styleChoice) {
      return sendError(res, 400, "VALIDATION_ERROR", "styleChoice is required");
    }

    const ownerName = await getOwnerName(merchantId);
    const defaultTemplate = DEFAULT_TEMPLATES[eventType]?.en?.body || "";

    const generated = await generateVoiceEmail({
      merchant: { id: merchantId, name: merchant.name, businessType: merchant.merchantType, ownerName },
      eventType,
      styleChoice,
      personalNote: personalNote || null,
      defaultTemplate,
      language: "en",
    });

    return res.json({ body: generated, eventType, styleChoice });
  } catch (err) {
    return sendError(res, 500, "SERVER_ERROR", err.message);
  }
});

// ──────────────────────────────────────────────
// POST /merchant/voice/translate
// Generate Spanish version from English
// ──────────────────────────────────────────────
router.post("/merchant/voice/translate", requireJwt, async (req, res) => {
  try {
    const merchantId = await getMerchantId(req);
    if (!merchantId) return sendError(res, 400, "VALIDATION_ERROR", "Merchant context required");

    const merchant = await prisma.merchant.findUnique({
      where: { id: merchantId },
      select: { id: true, name: true, planTier: true },
    });
    if (merchant?.planTier !== "value_added") {
      return sendError(res, 403, "UPGRADE_REQUIRED", "Custom email voices require the Value-Added plan");
    }

    const { englishBody, styleChoice } = req.body || {};
    if (!englishBody) return sendError(res, 400, "VALIDATION_ERROR", "englishBody is required");

    const ownerName = await getOwnerName(merchantId);

    const spanishBody = await generateSpanishVersion({
      englishTemplate: englishBody,
      merchant: { id: merchantId, name: merchant.name, ownerName },
      styleChoice: styleChoice || "warm_neighborly",
    });

    return res.json({ body: spanishBody });
  } catch (err) {
    return sendError(res, 500, "SERVER_ERROR", err.message);
  }
});

// ──────────────────────────────────────────────
// PATCH /merchant/voice/template
// Save a custom template or revert to default
// ──────────────────────────────────────────────
router.patch("/merchant/voice/template", requireJwt, async (req, res) => {
  try {
    const merchantId = await getMerchantId(req);
    if (!merchantId) return sendError(res, 400, "VALIDATION_ERROR", "Merchant context required");

    const { eventType, language, subject, body, styleChoice, personalNote, revertToDefault } = req.body || {};
    if (!eventType || !EVENT_TYPES.includes(eventType)) {
      return sendError(res, 400, "VALIDATION_ERROR", "Invalid eventType");
    }
    const lang = language || "en";

    if (revertToDefault) {
      // Delete custom template — system falls back to default
      await prisma.emailTemplate.deleteMany({
        where: { merchantId, eventType, language: lang },
      });

      emitPvHook("voice.template.reverted", {
        tc: "TC-VOICE-05", sev: "info",
        stable: `voice:${merchantId}:${eventType}:revert`,
        merchantId, eventType, language: lang,
      });

      return res.json({ reverted: true, eventType, language: lang });
    }

    // Save custom template
    if (!subject || !body) {
      return sendError(res, 400, "VALIDATION_ERROR", "subject and body are required");
    }

    const template = await prisma.emailTemplate.upsert({
      where: { merchantId_eventType_language: { merchantId, eventType, language: lang } },
      create: { merchantId, eventType, language: lang, subject, body, styleChoice, personalNote, isCustom: true },
      update: { subject, body, styleChoice, personalNote, isCustom: true, generatedAt: new Date() },
    });

    emitPvHook("voice.template.saved", {
      tc: "TC-VOICE-04", sev: "info",
      stable: `voice:${merchantId}:${eventType}:save`,
      merchantId, eventType, language: lang,
    });

    return res.json({ saved: true, template });
  } catch (err) {
    return sendError(res, 500, "SERVER_ERROR", err.message);
  }
});

module.exports = router;
