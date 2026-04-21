/**
 * clover.oauth.routes.js — Clover OAuth flow + connection management
 *
 * Routes:
 *   GET  /pos/connect/clover           — initiate OAuth redirect
 *   GET  /pos/connect/clover/callback  — exchange code for tokens
 *   GET  /pos/connect/clover/status    — connection status
 *   GET  /pos/connect/clover/locations — list Clover locations + existing maps
 *   POST /pos/connect/clover/map-location — map a Clover location to a PV store
 *   POST /pos/connect/clover/sync-catalog — trigger catalog sync
 *   DELETE /pos/connect/clover         — revoke connection
 *
 * Clover OAuth flow:
 *   1. Redirect to https://sandbox.dev.clover.com/oauth/authorize (or clover.com for prod)
 *   2. Clover redirects back with ?code=...&merchant_id=...
 *   3. Exchange code for access token via POST /oauth/token
 *   4. Store token in PosConnection (encrypted)
 */

"use strict";

const express = require("express");
const crypto = require("crypto");
const { prisma } = require("../db/prisma");
const { syncCatalogFromPos } = require("./pos.catalog.sync");
const { encrypt } = require("../utils/encrypt");

const CLOVER_APP_ID = process.env.CLOVER_APP_ID || "JBPK5P5GQE5GT";
const CLOVER_APP_SECRET = process.env.CLOVER_APP_SECRET || "38cb52bd-a6c5-c160-fc74-357c9d8ee16f";
const CLOVER_BASE = process.env.CLOVER_BASE || "https://sandbox.dev.clover.com";
const CLOVER_API_BASE = process.env.CLOVER_API_BASE || "https://apisandbox.dev.clover.com";
const ADMIN_APP_URL = process.env.ADMIN_APP_URL || process.env.ADMIN_WEB_BASE_URL || "http://localhost:5173";

function buildCloverOAuthRouter({ requireJwt, sendError, emitPvHook }) {
  const router = express.Router();

  /**
   * Resolve merchant context from JWT — must be owner or merchant_admin.
   */
  async function resolveMerchant(req) {
    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      select: {
        id: true,
        systemRole: true,
        merchantUsers: {
          where: { status: "active" },
          select: { merchantId: true, role: true, status: true },
        },
      },
    });

    if (!user) return null;

    // pv_admin can specify merchantId in query
    if (user.systemRole === "pv_admin" && req.query.merchantId) {
      return { merchantId: Number(req.query.merchantId), role: "pv_admin" };
    }

    const mu = user.merchantUsers.find(m =>
      m.role === "owner" || m.role === "merchant_admin"
    );
    if (!mu) return null;

    return { merchantId: mu.merchantId, role: mu.role };
  }

  /**
   * GET /pos/connect/clover — initiate OAuth
   */
  router.get("/pos/connect/clover", requireJwt, async (req, res) => {
    try {
      const merchant = await resolveMerchant(req);
      if (!merchant) return sendError(res, 403, "FORBIDDEN", "Merchant owner or admin role required");

      const state = Buffer.from(JSON.stringify({
        merchantId: merchant.merchantId,
        nonce: crypto.randomBytes(16).toString("hex"),
      })).toString("base64");

      const redirectUrl = `${CLOVER_BASE}/oauth/authorize?client_id=${CLOVER_APP_ID}&state=${state}`;

      emitPvHook("clover.oauth.initiated", {
        tc: "TC-CLO-01",
        sev: "info",
        stable: "clover:oauth",
        merchantId: merchant.merchantId,
        userId: req.userId,
      });

      return res.redirect(redirectUrl);
    } catch (err) {
      return sendError(res, 500, "SERVER_ERROR", "OAuth init failed: " + (err?.message || ""));
    }
  });

  // Detect environment from base URL
  const CLOVER_ENVIRONMENT = CLOVER_BASE.includes("sandbox") ? "sandbox" : "production";

  /**
   * Clover OAuth failure cases:
   *   A — User clicked Cancel on Clover consent screen
   *   B — Invalid/expired authorization code
   *   C — Wrong account type (staff login, not owner/admin)
   *   D — Clover API is down or token endpoint unreachable
   *   E — State parameter tampered or expired (session conflict)
   *   F — Merchant already connected to a different PV account
   */
  const CLOVER_ERROR_MESSAGES = {
    cancelled: "You cancelled the Clover connection. No problem — click Connect again when you're ready.",
    invalid_code: "The authorization expired. This happens if you take too long on the Clover page. Please try again.",
    wrong_account: "Clover returned an error that usually means a staff-level login was used. Please sign in with the owner or admin account.",
    clover_down: "Clover's servers didn't respond. This is on their end — wait a minute and try again.",
    invalid_state: "Your session expired or was opened in another tab. Please go back to the setup page and try again.",
    already_connected: "This Clover account is already connected to a different PerkValet merchant. Contact support if this is unexpected.",
    unknown: "Something went wrong connecting to Clover. Please try again. If it keeps happening, click 'I need help'.",
  };

  /**
   * Helper: record OAuth attempt on OnboardingSession (fire-and-forget).
   */
  async function recordOAuthAttempt(pvMerchantId, errorKey) {
    try {
      const session = await prisma.onboardingSession.findUnique({
        where: { merchantId: pvMerchantId },
      });
      if (session) {
        await prisma.onboardingSession.update({
          where: { id: session.id },
          data: {
            oauthAttempts: { increment: 1 },
            lastOAuthError: errorKey || null,
            posEnvironment: CLOVER_ENVIRONMENT,
          },
        });
      }
    } catch (e) {
      console.warn("[clover.oauth] could not update onboarding session:", e?.message);
    }
  }

  /**
   * GET /pos/connect/clover/callback — exchange code for token
   */
  router.get("/pos/connect/clover/callback", async (req, res) => {
    try {
      const { code, merchant_id: cloverMerchantId, state, error: oauthError } = req.query;

      // Case A: User clicked Cancel
      if (oauthError === "access_denied" || (!code && !cloverMerchantId)) {
        // Try to extract merchantId from state for tracking
        let pvMerchantId;
        try {
          const decoded = JSON.parse(Buffer.from(state || "", "base64").toString("utf8"));
          pvMerchantId = decoded.merchantId;
        } catch {}
        if (pvMerchantId) await recordOAuthAttempt(pvMerchantId, "cancelled");

        return res.redirect(`${ADMIN_APP_URL}/#/merchant/onboarding?oauth_error=cancelled`);
      }

      if (!code || !cloverMerchantId) {
        return res.redirect(`${ADMIN_APP_URL}/#/merchant/onboarding?oauth_error=invalid_code`);
      }

      // Case E: Decode state to get PV merchantId
      let pvMerchantId;
      try {
        const decoded = JSON.parse(Buffer.from(state, "base64").toString("utf8"));
        pvMerchantId = decoded.merchantId;
      } catch {
        return res.redirect(`${ADMIN_APP_URL}/#/merchant/onboarding?oauth_error=invalid_state`);
      }

      // Case F: Check if this Clover merchant is already connected to a DIFFERENT PV merchant
      const existingConn = await prisma.posConnection.findFirst({
        where: {
          posType: "clover",
          externalMerchantId: cloverMerchantId,
          status: "active",
          merchantId: { not: pvMerchantId },
        },
      });
      if (existingConn) {
        await recordOAuthAttempt(pvMerchantId, "already_connected");
        return res.redirect(`${ADMIN_APP_URL}/#/merchant/onboarding?oauth_error=already_connected`);
      }

      // Exchange code for access token
      const tokenUrl = `${CLOVER_API_BASE}/oauth/token?client_id=${CLOVER_APP_ID}&client_secret=${CLOVER_APP_SECRET}&code=${code}`;
      let tokenRes, tokenData;
      try {
        tokenRes = await fetch(tokenUrl);
        tokenData = await tokenRes.json();
      } catch (fetchErr) {
        // Case D: Clover API down
        console.error("[clover.oauth] token fetch failed:", fetchErr?.message);
        await recordOAuthAttempt(pvMerchantId, "clover_down");
        return res.redirect(`${ADMIN_APP_URL}/#/merchant/onboarding?oauth_error=clover_down`);
      }

      if (!tokenData.access_token) {
        // Case B or C: invalid code or wrong account
        console.error("[clover.oauth] token exchange failed:", tokenData);
        const errorKey = tokenData.message?.includes("invalid") ? "invalid_code" : "wrong_account";
        await recordOAuthAttempt(pvMerchantId, errorKey);
        return res.redirect(`${ADMIN_APP_URL}/#/merchant/onboarding?oauth_error=${errorKey}`);
      }

      // Success — record attempt and update environment
      await recordOAuthAttempt(pvMerchantId, null);

      // Upsert PosConnection
      const conn = await prisma.posConnection.upsert({
        where: {
          merchantId_posType: {
            merchantId: pvMerchantId,
            posType: "clover",
          },
        },
        update: {
          externalMerchantId: cloverMerchantId,
          accessTokenEnc: encrypt(tokenData.access_token),
          status: "active",
        },
        create: {
          merchantId: pvMerchantId,
          posType: "clover",
          externalMerchantId: cloverMerchantId,
          accessTokenEnc: encrypt(tokenData.access_token),
          status: "active",
        },
      });

      // Auto-create location map (Clover merchant = location)
      // If merchant has exactly one store, auto-map it; otherwise placeholder (0)
      const stores = await prisma.store.findMany({
        where: { merchantId: pvMerchantId },
        select: { id: true, name: true },
        take: 2,
      });
      const autoStore = stores.length === 1 ? stores[0] : null;

      await prisma.posLocationMap.upsert({
        where: {
          posConnectionId_externalLocationId: {
            posConnectionId: conn.id,
            externalLocationId: cloverMerchantId,
          },
        },
        update: {
          active: true,
          pvStoreId: autoStore ? autoStore.id : undefined,
          pvStoreName: autoStore ? autoStore.name : undefined,
        },
        create: {
          posConnectionId: conn.id,
          externalLocationId: cloverMerchantId,
          externalLocationName: "Clover Merchant " + cloverMerchantId,
          pvStoreId: autoStore ? autoStore.id : 0,
          pvStoreName: autoStore ? autoStore.name : null,
          active: true,
        },
      });

      emitPvHook("clover.oauth.connected", {
        tc: "TC-CLO-02",
        sev: "info",
        stable: "clover:oauth:" + pvMerchantId,
        merchantId: pvMerchantId,
        cloverMerchantId,
        posConnectionId: conn.id,
      });

      // Update onboarding session with connection details
      try {
        const obSession = await prisma.onboardingSession.findUnique({
          where: { merchantId: pvMerchantId },
        });
        if (obSession) {
          await prisma.onboardingSession.update({
            where: { id: obSession.id },
            data: {
              posConnectionId: conn.id,
              externalMerchantId: cloverMerchantId,
              posEnvironment: CLOVER_ENVIRONMENT,
              currentStage: "map-stores",
              currentStep: "4.1",
            },
          });
        }
      } catch (e) {
        console.warn("[clover.oauth] could not update onboarding:", e?.message);
      }

      // Trigger catalog sync (fire-and-forget)
      const { CloverAdapter } = require("./adapters/clover.adapter");
      const adapter = new CloverAdapter(conn);
      syncCatalogFromPos(prisma, adapter, {
        merchantId: pvMerchantId,
        posConnectionId: conn.id,
        trigger: "oauth_connect",
      }).catch(e => {
        console.error("[clover.oauth] catalog sync error:", e?.message);
      });

      // Redirect to admin settings
      return res.redirect(`${ADMIN_APP_URL}/#/merchant/settings?pos=clover_connected`);
    } catch (err) {
      console.error("[clover.oauth] callback error:", err);
      return res.redirect(`${ADMIN_APP_URL}/#/merchant/onboarding?oauth_error=unknown`);
    }
  });

  /**
   * GET /pos/connect/clover/status — connection status
   */
  router.get("/pos/connect/clover/status", requireJwt, async (req, res) => {
    try {
      const merchant = await resolveMerchant(req);
      if (!merchant) return sendError(res, 403, "FORBIDDEN", "Merchant owner or admin role required");

      const conn = await prisma.posConnection.findFirst({
        where: { merchantId: merchant.merchantId, posType: "clover", status: "active" },
        select: {
          id: true,
          status: true,
          externalMerchantId: true,
          createdAt: true,
          updatedAt: true,
          lastCatalogSyncAt: true,
          lastCatalogSyncSummary: true,
        },
      });

      const locationCount = conn ? await prisma.posLocationMap.count({
        where: { posConnectionId: conn.id, active: true },
      }) : 0;

      return res.json({
        connected: Boolean(conn),
        connection: conn || null,
        locationCount,
      });
    } catch (err) {
      return sendError(res, 500, "SERVER_ERROR", err?.message || "Status check failed");
    }
  });

  // ─── GET /pos/connect/clover/locations ─────────────────────────────────────

  router.get("/pos/connect/clover/locations", requireJwt, async (req, res) => {
    try {
      const merchant = await resolveMerchant(req);
      if (!merchant) return sendError(res, 403, "FORBIDDEN", "Merchant owner or admin role required");

      const conn = await prisma.posConnection.findFirst({
        where: { merchantId: merchant.merchantId, posType: "clover", status: "active" },
      });
      if (!conn) return sendError(res, 404, "NOT_FOUND", "No active Clover connection");

      const { CloverAdapter } = require("./adapters/clover.adapter");
      const adapter = new CloverAdapter(conn);
      const locations = await adapter.listLocations();

      const existingMaps = await prisma.posLocationMap.findMany({
        where: { posConnectionId: conn.id },
        select: { externalLocationId: true, pvStoreId: true, pvStoreName: true, active: true },
      });

      return res.json({ locations, existingMaps });
    } catch (err) {
      return sendError(res, 500, "SERVER_ERROR", err?.message || "Failed to list locations");
    }
  });

  // ─── POST /pos/connect/clover/map-location ──────────────────────────────────

  router.post("/pos/connect/clover/map-location", requireJwt, express.json(), async (req, res) => {
    try {
      const merchant = await resolveMerchant(req);
      if (!merchant) return sendError(res, 403, "FORBIDDEN", "Merchant owner or admin role required");

      const { externalLocationId, externalLocationName, pvStoreId } = req.body;
      if (!externalLocationId || !pvStoreId) {
        return sendError(res, 400, "BAD_REQUEST", "externalLocationId and pvStoreId required");
      }

      const conn = await prisma.posConnection.findFirst({
        where: { merchantId: merchant.merchantId, posType: "clover", status: "active" },
      });
      if (!conn) return sendError(res, 404, "NOT_FOUND", "No active Clover connection");

      // Verify the store belongs to this merchant
      const store = await prisma.store.findFirst({
        where: { id: parseInt(pvStoreId, 10), merchantId: merchant.merchantId },
        select: { id: true, name: true },
      });
      if (!store) return sendError(res, 404, "NOT_FOUND", "Store not found or not owned by this merchant");

      const map = await prisma.posLocationMap.upsert({
        where: { posConnectionId_externalLocationId: { posConnectionId: conn.id, externalLocationId } },
        create: {
          posConnectionId: conn.id,
          externalLocationId,
          externalLocationName: externalLocationName || null,
          pvStoreId: store.id,
          pvStoreName: store.name,
          active: true,
        },
        update: {
          externalLocationName: externalLocationName || null,
          pvStoreId: store.id,
          pvStoreName: store.name,
          active: true,
        },
      });

      emitPvHook("clover.location.mapped", {
        tc: "TC-CLO-05",
        sev: "info",
        stable: "clover:location:" + merchant.merchantId,
        merchantId: merchant.merchantId,
        externalLocationId,
        pvStoreId: store.id,
      });

      // Geocode store address for Discover/geofencing (fire-and-forget)
      const storeData = await prisma.store.findUnique({
        where: { id: store.id },
        select: { latitude: true, address1: true, city: true, state: true, postal: true },
      });
      if (!storeData?.latitude && storeData?.address1) {
        const { geocodeAndUpdateStore } = require("../utils/geocode");
        geocodeAndUpdateStore(prisma, store.id, storeData).catch(e => {
          console.warn("[clover.oauth] geocode failed:", e?.message);
        });
      }

      return res.json({ ok: true, map });
    } catch (err) {
      return sendError(res, 500, "SERVER_ERROR", err?.message || "Failed to map location");
    }
  });

  /**
   * POST /pos/connect/clover/sync-catalog — trigger catalog sync
   */
  router.post("/pos/connect/clover/sync-catalog", requireJwt, async (req, res) => {
    try {
      const merchant = await resolveMerchant(req);
      if (!merchant) return sendError(res, 403, "FORBIDDEN", "Merchant owner or admin role required");

      const conn = await prisma.posConnection.findFirst({
        where: { merchantId: merchant.merchantId, posType: "clover", status: "active" },
      });
      if (!conn) return sendError(res, 404, "NOT_FOUND", "No active Clover connection");

      const { CloverAdapter } = require("./adapters/clover.adapter");
      const adapter = new CloverAdapter(conn);
      const result = await syncCatalogFromPos(prisma, adapter, {
        merchantId: merchant.merchantId,
        posConnectionId: conn.id,
        trigger: "manual",
      });

      emitPvHook("clover.catalog.synced", {
        tc: "TC-CLO-03",
        sev: "info",
        stable: "clover:catalog:" + merchant.merchantId,
        merchantId: merchant.merchantId,
        summary: result?.summary || null,
      });

      return res.json({ ok: true, summary: result?.summary || null });
    } catch (err) {
      return sendError(res, 500, "SERVER_ERROR", err?.message || "Sync failed");
    }
  });

  /**
   * DELETE /pos/connect/clover — revoke connection
   */
  router.delete("/pos/connect/clover", requireJwt, async (req, res) => {
    try {
      const merchant = await resolveMerchant(req);
      if (!merchant) return sendError(res, 403, "FORBIDDEN", "Merchant owner or admin role required");

      await prisma.posConnection.updateMany({
        where: { merchantId: merchant.merchantId, posType: "clover" },
        data: { status: "revoked" },
      });

      emitPvHook("clover.oauth.disconnected", {
        tc: "TC-CLO-04",
        sev: "info",
        stable: "clover:oauth:" + merchant.merchantId,
        merchantId: merchant.merchantId,
        userId: req.userId,
      });

      return res.json({ ok: true, message: "Clover connection revoked" });
    } catch (err) {
      return sendError(res, 500, "SERVER_ERROR", err?.message || "Disconnect failed");
    }
  });

  return router;
}

module.exports = { buildCloverOAuthRouter };
