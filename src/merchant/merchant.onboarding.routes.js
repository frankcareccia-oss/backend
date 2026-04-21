/**
 * merchant.onboarding.routes.js — Guided merchant onboarding flow
 *
 * GET  /merchant/onboarding          — get or create session, resume logic
 * PATCH /merchant/onboarding         — update session (step answers, progress)
 * POST /merchant/onboarding/help     — escalate stuck request
 * POST /merchant/onboarding/connect  — initiate OAuth redirect
 * GET  /merchant/onboarding/callback — OAuth callback handler
 */

"use strict";

const express = require("express");
const { prisma } = require("../db/prisma");
const { sendError } = require("../utils/errors");
const { requireJwt } = require("../middleware/auth");
const { encrypt } = require("../utils/encrypt");

const router = express.Router();

// Apply auth to all onboarding routes
router.use("/merchant/onboarding", requireJwt);

// Clover OAuth config
const CLOVER_APP_ID = process.env.CLOVER_APP_ID || "";
const CLOVER_APP_SECRET = process.env.CLOVER_APP_SECRET || "";
const CLOVER_BASE = process.env.CLOVER_BASE || "https://www.clover.com";

// Square OAuth config
const SQUARE_APP_ID = process.env.SQUARE_APP_ID || "";
const SQUARE_APP_SECRET = process.env.SQUARE_APP_SECRET || "";
const SQUARE_API_BASE = (SQUARE_APP_ID || "").startsWith("sandbox-")
  ? "https://connect.squareupsandbox.com"
  : "https://connect.squareup.com";

async function resolveMerchantId(req) {
  if (!req.userId) return null;
  const mu = await prisma.merchantUser.findFirst({
    where: { userId: req.userId, status: "active" },
    select: { merchantId: true, id: true },
  });
  return mu || null;
}

// ──────────────────────────────────────────────
// GET /merchant/onboarding — get or create session
// ──────────────────────────────────────────────
router.get("/merchant/onboarding", async (req, res) => {
  try {
    const mu = await resolveMerchantId(req);
    if (!mu) return sendError(res, 403, "FORBIDDEN", "Not authorized");

    // Get or create session
    let session = await prisma.onboardingSession.findUnique({
      where: { merchantId: mu.merchantId },
    });

    if (!session) {
      session = await prisma.onboardingSession.create({
        data: {
          merchantId: mu.merchantId,
          merchantUserId: mu.id,
        },
      });
    }

    // Check if already completed
    const isComplete = session.completedAt !== null;

    // Check for existing POS connection
    const existingConnection = await prisma.posConnection.findFirst({
      where: { merchantId: mu.merchantId, status: "active" },
      select: { id: true, posType: true, externalMerchantId: true },
    });

    // Check stores
    const stores = await prisma.store.findMany({
      where: { merchantId: mu.merchantId, status: "active" },
      select: { id: true, name: true, address1: true, city: true, state: true, postal: true, phoneRaw: true, latitude: true, longitude: true },
    });

    // Check promotions
    const promotions = await prisma.promotion.findMany({
      where: { merchantId: mu.merchantId },
      select: { id: true, name: true, status: true, rewardType: true },
    });

    return res.json({
      session,
      isComplete,
      existingConnection,
      stores,
      promotions,
      merchantId: mu.merchantId,
    });
  } catch (err) {
    console.error("[onboarding] get error:", err);
    return sendError(res, 500, "SERVER_ERROR", "Could not load onboarding");
  }
});

// ──────────────────────────────────────────────
// PATCH /merchant/onboarding — update session
// ──────────────────────────────────────────────
router.patch("/merchant/onboarding", async (req, res) => {
  try {
    const mu = await resolveMerchantId(req);
    if (!mu) return sendError(res, 403, "FORBIDDEN", "Not authorized");

    const session = await prisma.onboardingSession.findUnique({
      where: { merchantId: mu.merchantId },
    });
    if (!session) return sendError(res, 404, "NOT_FOUND", "No onboarding session");

    const { currentStage, currentStep, posType, setupPersona, credentialStatus,
            storesFound, storesMapped, firstPromoId, firstPromoStatus,
            completedSteps, stuckAtStep, stuckReason, teamSetupMode } = req.body || {};

    const data = { lastActivityAt: new Date() };

    if (currentStage) data.currentStage = currentStage;
    if (currentStep) data.currentStep = currentStep;
    if (posType) data.posType = posType;
    if (setupPersona) data.setupPersona = setupPersona;
    if (credentialStatus) data.credentialStatus = credentialStatus;
    if (storesFound != null) data.storesFound = storesFound;
    if (storesMapped != null) data.storesMapped = storesMapped;
    if (firstPromoId) data.firstPromoId = firstPromoId;
    if (firstPromoStatus) data.firstPromoStatus = firstPromoStatus;
    if (completedSteps) data.completedSteps = completedSteps;

    // Save team setup mode to merchant record
    if (teamSetupMode && ["individual", "shared", "solo", "external"].includes(teamSetupMode)) {
      await prisma.merchant.update({
        where: { id: mu.merchantId },
        data: {
          teamSetupMode,
          teamSetupComplete: true,
          // Enable nightly sync only for individual mode with POS
          teamSyncEnabled: teamSetupMode === "individual",
        },
      });
    }

    // Mark stuck
    if (stuckAtStep) {
      data.stuckAtStep = stuckAtStep;
      data.stuckReason = stuckReason || null;
      data.stuckAt = new Date();
    }

    // Mark completed if stage is "live"
    if (currentStage === "live") {
      data.completedAt = new Date();
    }

    const updated = await prisma.onboardingSession.update({
      where: { id: session.id },
      data,
    });

    console.log(JSON.stringify({
      pvHook: "onboarding.step.updated",
      ts: new Date().toISOString(),
      tc: "TC-ONBOARD-01",
      sev: "info",
      merchantId: mu.merchantId,
      currentStage: updated.currentStage,
      currentStep: updated.currentStep,
    }));

    return res.json({ session: updated });
  } catch (err) {
    console.error("[onboarding] update error:", err);
    return sendError(res, 500, "SERVER_ERROR", "Could not update onboarding");
  }
});

// ──────────────────────────────────────────────
// POST /merchant/onboarding/help — escalate stuck request
// ──────────────────────────────────────────────
router.post("/merchant/onboarding/help", async (req, res) => {
  try {
    const mu = await resolveMerchantId(req);
    if (!mu) return sendError(res, 403, "FORBIDDEN", "Not authorized");

    const session = await prisma.onboardingSession.findUnique({
      where: { merchantId: mu.merchantId },
    });
    if (!session) return sendError(res, 404, "NOT_FOUND", "No onboarding session");

    const { step, message, screenshot } = req.body || {};

    // Add help message to history
    const helpMessages = Array.isArray(session.helpMessages) ? session.helpMessages : [];
    helpMessages.push({
      step: step || session.currentStep,
      message: message || "Merchant needs help",
      screenshot: screenshot || null,
      timestamp: new Date().toISOString(),
      from: "merchant",
    });

    await prisma.onboardingSession.update({
      where: { id: session.id },
      data: {
        stuckAtStep: step || session.currentStep,
        stuckReason: message || "Help requested",
        stuckAt: new Date(),
        helpMessages,
      },
    });

    console.log(JSON.stringify({
      pvHook: "onboarding.help.requested",
      ts: new Date().toISOString(),
      tc: "TC-ONBOARD-02",
      sev: "warn",
      merchantId: mu.merchantId,
      step: step || session.currentStep,
      message,
    }));

    // TODO: Wire Claude API for contextual response
    // For now, return a generic helpful message
    const autoResponse = getAutoHelpResponse(session, step);

    return res.json({
      ok: true,
      response: autoResponse,
    });
  } catch (err) {
    return sendError(res, 500, "SERVER_ERROR", "Could not process help request");
  }
});

function getAutoHelpResponse(session, step) {
  const posType = session.posType || "your POS";
  const posName = posType === "clover" ? "Clover" : posType === "square" ? "Square" : "your POS";

  const responses = {
    "2.3": `Try checking your email for messages from ${posName} — the email they sent to is likely your login email.`,
    "2.4": `If the password reset email didn't arrive, check your spam folder. If still nothing, try other email addresses you use for business.`,
    "2.5": `Call ${posName} support directly — Clover: (855) 853-8340, Square: (855) 700-6000. Tell them you're the business owner and need admin access.`,
    "3.1": `Make sure you're signing in with your ${posName} business credentials, not your PerkValet login. If you're already logged into ${posName} in another tab, try opening a fresh browser tab.`,
    "3.2": `The connection attempt didn't go through. This can happen if you used the wrong account or don't have admin access. Try again with the owner-level login.`,
    "4.1": `If some locations aren't showing, they may be on a separate ${posName} account. You can connect additional accounts after this setup.`,
  };

  return responses[step] || `We've logged your request. A PerkValet team member will get back to you shortly. In the meantime, you can try refreshing the page or coming back in a few minutes.`;
}

// ──────────────────────────────────────────────
// POST /merchant/onboarding/connect — initiate OAuth
// ──────────────────────────────────────────────
router.post("/merchant/onboarding/connect", async (req, res) => {
  try {
    const mu = await resolveMerchantId(req);
    if (!mu) return sendError(res, 403, "FORBIDDEN", "Not authorized");

    const session = await prisma.onboardingSession.findUnique({
      where: { merchantId: mu.merchantId },
    });
    if (!session) return sendError(res, 404, "NOT_FOUND", "No onboarding session");

    const posType = session.posType;

    // Increment OAuth attempt counter
    await prisma.onboardingSession.update({
      where: { id: session.id },
      data: { oauthAttempts: { increment: 1 }, lastActivityAt: new Date() },
    });

    if (posType === "clover") {
      const state = Buffer.from(JSON.stringify({
        merchantId: mu.merchantId,
        onboarding: true,
      })).toString("base64url");

      // ALWAYS use production Clover URL for merchants — NEVER sandbox
      const authUrl = `${CLOVER_BASE}/oauth/authorize?client_id=${CLOVER_APP_ID}&state=${state}`;

      return res.json({ redirectUrl: authUrl });

    } else if (posType === "square") {
      const state = Buffer.from(JSON.stringify({
        merchantId: mu.merchantId,
        onboarding: true,
      })).toString("base64url");

      const redirectUri = process.env.SQUARE_REDIRECT_URI || `${req.protocol}://${req.get("host")}/pos/connect/square/callback`;
      const authUrl = `${SQUARE_API_BASE}/oauth2/authorize?client_id=${SQUARE_APP_ID}&scope=CUSTOMERS_READ+CUSTOMERS_WRITE+MERCHANT_PROFILE_READ+ITEMS_READ+ITEMS_WRITE+ORDERS_READ+ORDERS_WRITE+PAYMENTS_READ+PAYMENTS_WRITE+GIFTCARDS_READ+GIFTCARDS_WRITE&state=${state}&redirect_uri=${encodeURIComponent(redirectUri)}`;

      return res.json({ redirectUrl: authUrl });

    } else {
      return sendError(res, 400, "UNSUPPORTED", `POS type ${posType} not supported for OAuth`);
    }
  } catch (err) {
    return sendError(res, 500, "SERVER_ERROR", "Could not initiate connection");
  }
});

// ──────────────────────────────────────────────
// POST /merchant/onboarding/complete-connection — called after OAuth callback
// Detects connection status and updates onboarding session
// ──────────────────────────────────────────────
router.post("/merchant/onboarding/complete-connection", async (req, res) => {
  try {
    const mu = await resolveMerchantId(req);
    if (!mu) return sendError(res, 403, "FORBIDDEN", "Not authorized");

    const session = await prisma.onboardingSession.findUnique({
      where: { merchantId: mu.merchantId },
    });
    if (!session) return sendError(res, 404, "NOT_FOUND", "No onboarding session");

    // Check if a POS connection now exists
    const conn = await prisma.posConnection.findFirst({
      where: { merchantId: mu.merchantId, status: "active" },
    });

    if (!conn) {
      return res.json({
        connected: false,
        error: "No active connection found. The authorization may not have completed.",
      });
    }

    // Validate Clover merchant ID format (13 chars alphanumeric)
    let posEnvironment = "production";
    if (conn.posType === "clover" && conn.externalMerchantId) {
      const mid = conn.externalMerchantId;
      if (!/^[A-Z0-9]{13}$/i.test(mid)) {
        posEnvironment = "sandbox"; // likely a sandbox ID
      }
    }

    // Fetch locations
    let stores = [];
    try {
      if (conn.posType === "clover") {
        const { CloverAdapter } = require("../pos/adapters/clover.adapter");
        const adapter = new CloverAdapter(conn);
        // Clover: merchant ID IS the location
        stores = [{ id: conn.externalMerchantId, name: conn.externalMerchantId }];
      } else if (conn.posType === "square") {
        const { SquareAdapter } = require("../pos/adapters/square.adapter");
        const adapter = new SquareAdapter(conn);
        stores = await adapter.listLocations();
      }
    } catch (e) {
      console.warn("[onboarding] location fetch error:", e?.message);
    }

    // Update session
    await prisma.onboardingSession.update({
      where: { id: session.id },
      data: {
        posConnectionId: conn.id,
        externalMerchantId: conn.externalMerchantId,
        posEnvironment,
        storesFound: stores.length,
        currentStage: "map-stores",
        currentStep: "4.1",
        lastActivityAt: new Date(),
      },
    });

    console.log(JSON.stringify({
      pvHook: "onboarding.connected",
      ts: new Date().toISOString(),
      tc: "TC-ONBOARD-03",
      sev: "info",
      merchantId: mu.merchantId,
      posType: conn.posType,
      externalMerchantId: conn.externalMerchantId,
      posEnvironment,
      storesFound: stores.length,
    }));

    return res.json({
      connected: true,
      posType: conn.posType,
      posEnvironment,
      stores,
    });
  } catch (err) {
    return sendError(res, 500, "SERVER_ERROR", "Could not verify connection");
  }
});

// ──────────────────────────────────────────────
// POST /merchant/onboarding/ingest — pull existing POS promotions
// ──────────────────────────────────────────────
router.post("/merchant/onboarding/ingest", async (req, res) => {
  try {
    const mu = await resolveMerchantId(req);
    if (!mu) return sendError(res, 403, "FORBIDDEN", "Not authorized");

    const conn = await prisma.posConnection.findFirst({
      where: { merchantId: mu.merchantId, status: "active" },
    });
    if (!conn) return sendError(res, 400, "NO_CONNECTION", "No active POS connection");

    const { ingestPosPromotions, generateGapAnalysis } = require("../pos/pos.promotion.ingest");
    const ingested = await ingestPosPromotions(conn);

    // Get existing PV promotions for comparison
    const pvPromotions = await prisma.promotion.findMany({
      where: { merchantId: mu.merchantId },
      select: { id: true, name: true, rewardType: true, threshold: true, status: true },
    });

    const gapAnalysis = generateGapAnalysis(ingested.posPromotions, ingested.posDiscounts, pvPromotions);

    console.log(JSON.stringify({
      pvHook: "onboarding.ingest.complete",
      ts: new Date().toISOString(),
      tc: "TC-ONBOARD-04",
      sev: "info",
      merchantId: mu.merchantId,
      posPromotions: ingested.posPromotions.length,
      posDiscounts: ingested.posDiscounts.length,
      pvPromotions: pvPromotions.length,
    }));

    return res.json({
      ingested,
      gapAnalysis,
      pvPromotions,
    });
  } catch (err) {
    console.error("[onboarding] ingest error:", err);
    return sendError(res, 500, "SERVER_ERROR", "Could not ingest POS promotions");
  }
});

// ──────────────────────────────────────────────
// POST /merchant/onboarding/scan-promotion — flag & warn check
// ──────────────────────────────────────────────
router.post("/merchant/onboarding/scan-promotion", async (req, res) => {
  try {
    const mu = await resolveMerchantId(req);
    if (!mu) return sendError(res, 403, "FORBIDDEN", "Not authorized");

    const promoData = req.body;
    const { scanPromotion } = require("../promo/promo.legal.flags");
    const flags = scanPromotion(promoData);

    return res.json({ flags });
  } catch (err) {
    return sendError(res, 500, "SERVER_ERROR", err.message);
  }
});

// ──────────────────────────────────────────────
// POST /merchant/onboarding/acknowledge-flag — record risk acknowledgment
// ──────────────────────────────────────────────
router.post("/merchant/onboarding/acknowledge-flag", async (req, res) => {
  try {
    const mu = await resolveMerchantId(req);
    if (!mu) return sendError(res, 403, "FORBIDDEN", "Not authorized");

    const { promotionId, flagId, action } = req.body;
    if (!promotionId || !flagId) return sendError(res, 400, "VALIDATION_ERROR", "promotionId and flagId required");

    const { acknowledgeFlagRisk } = require("../promo/promo.legal.flags");
    await acknowledgeFlagRisk(promotionId, req.userId, flagId, action || "acknowledged");

    return res.json({ ok: true });
  } catch (err) {
    return sendError(res, 500, "SERVER_ERROR", err.message);
  }
});

module.exports = router;
