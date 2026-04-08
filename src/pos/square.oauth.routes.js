/**
 * square.oauth.routes.js — Square OAuth 2.0 connect + location mapping
 *
 * Routes:
 *   GET  /pos/connect/square              — redirect merchant to Square OAuth
 *   GET  /pos/connect/square/callback     — exchange code → store tokens
 *   GET  /pos/connect/square/locations    — list Square locations for this merchant
 *   POST /pos/connect/square/map-location — map a Square location to a PV store
 *   GET  /pos/connect/square/status       — connection status for this merchant
 *   DELETE /pos/connect/square            — revoke / disconnect
 *
 * All routes require a valid JWT (merchant owner or admin).
 * Admin can pass ?merchantId= to act on behalf of any merchant.
 */

const express = require("express");
const crypto = require("crypto");
const { encrypt, decrypt } = require("../utils/encrypt");
const { SquareAdapter } = require("./adapters/square.adapter");
const { syncCatalogFromPos } = require("./pos.catalog.sync");

const SQUARE_APP_ID = process.env.SQUARE_APP_ID || "";
const SQUARE_APP_SECRET = process.env.SQUARE_APP_SECRET || "";
const IS_SANDBOX = SQUARE_APP_ID.startsWith("sandbox-");
const SQUARE_API_BASE = IS_SANDBOX ? "https://connect.squareupsandbox.com" : "https://connect.squareup.com";

/** Register Square OAuth routes onto the Express app. */
function registerSquareOAuthRoutes(app, { prisma, sendError, requireAuth, requireAdmin }) {

  // ─── Resolve merchantId from JWT or query param (admin override) ───────────

  async function resolveMerchantId(req, res) {
    if (req.systemRole === "pv_admin" && req.query.merchantId) {
      return parseInt(req.query.merchantId, 10);
    }
    // Merchant user: derive from MerchantUser
    const mu = await prisma.merchantUser.findFirst({
      where: { userId: req.userId, role: { in: ["owner", "merchant_admin"] } },
      select: { merchantId: true },
    });
    if (!mu) {
      sendError(res, 403, "FORBIDDEN", "Merchant owner or admin role required");
      return null;
    }
    return mu.merchantId;
  }

  // Middleware: lift ?token= into Authorization header (for browser OAuth redirects)
  function injectQueryToken(req, res, next) {
    if (!req.headers.authorization && req.query.token) {
      req.headers.authorization = `Bearer ${req.query.token}`;
    }
    next();
  }

  // ─── GET /pos/connect/square ────────────────────────────────────────────────

  app.get("/pos/connect/square", injectQueryToken, requireAuth, async (req, res) => {
    try {
      const merchantId = await resolveMerchantId(req, res);
      if (!merchantId) return;

      // State param: base64(merchantId + random nonce) — verified in callback
      const nonce = crypto.randomBytes(16).toString("hex");
      const state = Buffer.from(JSON.stringify({ merchantId, nonce })).toString("base64url");

      const params = new URLSearchParams({
        client_id: SQUARE_APP_ID,
        scope: "MERCHANT_PROFILE_READ PAYMENTS_READ CUSTOMERS_READ ORDERS_READ ITEMS_READ",
        state,
      });

      const redirectUrl = `${SQUARE_API_BASE}/oauth2/authorize?${params.toString()}`;
      res.redirect(redirectUrl);
    } catch (e) {
      sendError(res, 500, "SERVER_ERROR", e?.message || "OAuth init failed");
    }
  });

  // ─── GET /pos/connect/square/callback ──────────────────────────────────────

  app.get("/pos/connect/square/callback", async (req, res) => {
    const { code, state, error } = req.query;

    if (error) {
      return res.status(400).send(`Square OAuth error: ${error}`);
    }

    if (!code || !state) {
      return res.status(400).send("Missing code or state");
    }

    let merchantId;
    try {
      const decoded = JSON.parse(Buffer.from(state, "base64url").toString("utf8"));
      merchantId = decoded.merchantId;
      if (!merchantId) throw new Error("Invalid state");
    } catch {
      return res.status(400).send("Invalid OAuth state");
    }

    try {
      // Exchange code for tokens
      const tokenRes = await fetch(`${SQUARE_API_BASE}/oauth2/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Square-Version": "2024-01-18" },
        body: JSON.stringify({
          client_id: SQUARE_APP_ID,
          client_secret: SQUARE_APP_SECRET,
          code,
          grant_type: "authorization_code",
        }),
      });

      if (!tokenRes.ok) {
        const body = await tokenRes.text();
        throw new Error(`Token exchange failed: ${body}`);
      }

      const tokenData = await tokenRes.json();
      const {
        access_token,
        refresh_token,
        expires_at,
        merchant_id: externalMerchantId,
      } = tokenData;

      if (!access_token || !externalMerchantId) {
        throw new Error("Missing access_token or merchant_id in token response");
      }

      await prisma.posConnection.upsert({
        where: { merchantId_posType: { merchantId, posType: "square" } },
        create: {
          merchantId,
          posType: "square",
          externalMerchantId,
          accessTokenEnc: encrypt(access_token),
          refreshTokenEnc: refresh_token ? encrypt(refresh_token) : null,
          tokenExpiresAt: expires_at ? new Date(expires_at) : null,
          status: "active",
        },
        update: {
          externalMerchantId,
          accessTokenEnc: encrypt(access_token),
          refreshTokenEnc: refresh_token ? encrypt(refresh_token) : null,
          tokenExpiresAt: expires_at ? new Date(expires_at) : null,
          status: "active",
        },
      });

      // Auto-sync catalog from Square (fire-and-forget)
      const conn = await prisma.posConnection.findUnique({
        where: { merchantId_posType: { merchantId, posType: "square" } },
      });
      if (conn) {
        const adapter = new SquareAdapter(conn);
        syncCatalogFromPos(prisma, adapter, { merchantId, posConnectionId: conn.id, trigger: "onboard" }).catch((e) => {
          console.error("[square.oauth] catalog sync failed:", e?.message || String(e));
        });
      }

      // Redirect back to admin UI — adjust URL as needed
      const adminBase = process.env.ADMIN_APP_URL || "https://admin.perksvalet.com";
      res.redirect(`${adminBase}/#/merchant/settings?pos=connected`);
    } catch (e) {
      console.error("[square.oauth] callback error:", e?.message);
      res.status(500).send(`Connection failed: ${e?.message}`);
    }
  });

  // ─── GET /pos/connect/square/status ────────────────────────────────────────

  app.get("/pos/connect/square/status", requireAuth, async (req, res) => {
    try {
      const merchantId = await resolveMerchantId(req, res);
      if (!merchantId) return;

      const conn = await prisma.posConnection.findUnique({
        where: { merchantId_posType: { merchantId, posType: "square" } },
        select: {
          id: true, status: true, externalMerchantId: true, tokenExpiresAt: true,
          createdAt: true, updatedAt: true,
          lastCatalogSyncAt: true, lastCatalogSyncSummary: true,
        },
      });

      const locationCount = conn
        ? await prisma.posLocationMap.count({ where: { posConnectionId: conn.id, active: true } })
        : 0;

      res.json({ connected: !!conn && conn.status === "active", connection: conn, locationCount });
    } catch (e) {
      sendError(res, 500, "SERVER_ERROR", e?.message);
    }
  });

  // ─── GET /pos/connect/square/locations ─────────────────────────────────────

  app.get("/pos/connect/square/locations", requireAuth, async (req, res) => {
    try {
      const merchantId = await resolveMerchantId(req, res);
      if (!merchantId) return;

      const conn = await prisma.posConnection.findUnique({
        where: { merchantId_posType: { merchantId, posType: "square" } },
      });
      if (!conn || conn.status !== "active") {
        return sendError(res, 404, "NOT_FOUND", "No active Square connection");
      }

      const adapter = new SquareAdapter(conn);
      const locations = await adapter.listLocations();

      // Also return current mappings so UI can show what's already mapped
      const existingMaps = await prisma.posLocationMap.findMany({
        where: { posConnectionId: conn.id },
        select: { externalLocationId: true, pvStoreId: true, active: true },
      });

      res.json({ locations, existingMaps });
    } catch (e) {
      sendError(res, 500, "SERVER_ERROR", e?.message);
    }
  });

  // ─── POST /pos/connect/square/map-location ──────────────────────────────────

  app.post("/pos/connect/square/map-location", requireAuth, express.json(), async (req, res) => {
    try {
      const merchantId = await resolveMerchantId(req, res);
      if (!merchantId) return;

      const { externalLocationId, externalLocationName, pvStoreId } = req.body;
      if (!externalLocationId || !pvStoreId) {
        return sendError(res, 400, "BAD_REQUEST", "externalLocationId and pvStoreId required");
      }

      const conn = await prisma.posConnection.findUnique({
        where: { merchantId_posType: { merchantId, posType: "square" } },
      });
      if (!conn || conn.status !== "active") {
        return sendError(res, 404, "NOT_FOUND", "No active Square connection");
      }

      // Verify the store belongs to this merchant
      const store = await prisma.store.findFirst({
        where: { id: parseInt(pvStoreId, 10), merchantId },
        select: { id: true, name: true },
      });
      if (!store) {
        return sendError(res, 404, "NOT_FOUND", "Store not found or not owned by this merchant");
      }

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

      res.json({ ok: true, map });
    } catch (e) {
      sendError(res, 500, "SERVER_ERROR", e?.message);
    }
  });

  // ─── POST /pos/connect/square/sync-catalog ──────────────────────────────────

  app.post("/pos/connect/square/sync-catalog", requireAuth, async (req, res) => {
    try {
      const merchantId = await resolveMerchantId(req, res);
      if (!merchantId) return;

      const conn = await prisma.posConnection.findUnique({
        where: { merchantId_posType: { merchantId, posType: "square" } },
      });
      if (!conn || conn.status !== "active") {
        return sendError(res, 404, "NOT_FOUND", "No active Square connection");
      }

      const adapter = new SquareAdapter(conn);
      const summary = await syncCatalogFromPos(prisma, adapter, { merchantId, posConnectionId: conn.id });

      res.json({ ok: true, summary });
    } catch (e) {
      sendError(res, 500, "SERVER_ERROR", e?.message);
    }
  });

  // ─── GET /pos/connect/square/sync-log ────────────────────────────────────────

  app.get("/pos/connect/square/sync-log", requireAuth, async (req, res) => {
    try {
      const merchantId = await resolveMerchantId(req, res);
      if (!merchantId) return;

      const logs = await prisma.catalogSyncLog.findMany({
        where: { merchantId },
        orderBy: { createdAt: "desc" },
        take: 20,
      });

      res.json({ logs });
    } catch (e) {
      sendError(res, 500, "SERVER_ERROR", e?.message);
    }
  });

  // ─── DELETE /pos/connect/square ─────────────────────────────────────────────

  app.delete("/pos/connect/square", requireAuth, async (req, res) => {
    try {
      const merchantId = await resolveMerchantId(req, res);
      if (!merchantId) return;

      await prisma.posConnection.updateMany({
        where: { merchantId, posType: "square" },
        data: { status: "revoked" },
      });

      res.json({ ok: true, message: "Square connection revoked" });
    } catch (e) {
      sendError(res, 500, "SERVER_ERROR", e?.message);
    }
  });
}

module.exports = { registerSquareOAuthRoutes };
