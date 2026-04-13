/**
 * clover.oauth.routes.js — Clover OAuth flow + connection management
 *
 * Routes:
 *   GET  /pos/connect/clover           — initiate OAuth redirect
 *   GET  /pos/connect/clover/callback  — exchange code for tokens
 *   GET  /pos/connect/clover/status    — connection status
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

  /**
   * GET /pos/connect/clover/callback — exchange code for token
   */
  router.get("/pos/connect/clover/callback", async (req, res) => {
    try {
      const { code, merchant_id: cloverMerchantId, state } = req.query;

      if (!code || !cloverMerchantId) {
        return res.status(400).send("Missing code or merchant_id from Clover");
      }

      // Decode state to get PV merchantId
      let pvMerchantId;
      try {
        const decoded = JSON.parse(Buffer.from(state, "base64").toString("utf8"));
        pvMerchantId = decoded.merchantId;
      } catch {
        return res.status(400).send("Invalid OAuth state");
      }

      // Exchange code for access token
      const tokenUrl = `${CLOVER_API_BASE}/oauth/token?client_id=${CLOVER_APP_ID}&client_secret=${CLOVER_APP_SECRET}&code=${code}`;
      const tokenRes = await fetch(tokenUrl);
      const tokenData = await tokenRes.json();

      if (!tokenData.access_token) {
        console.error("[clover.oauth] token exchange failed:", tokenData);
        return res.status(400).send("Token exchange failed: " + JSON.stringify(tokenData));
      }

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
          accessTokenEnc: tokenData.access_token, // TODO: encrypt in production
          status: "active",
        },
        create: {
          merchantId: pvMerchantId,
          posType: "clover",
          externalMerchantId: cloverMerchantId,
          accessTokenEnc: tokenData.access_token,
          status: "active",
        },
      });

      // Auto-create location map (Clover merchant = location)
      await prisma.posLocationMap.upsert({
        where: {
          posConnectionId_externalLocationId: {
            posConnectionId: conn.id,
            externalLocationId: cloverMerchantId,
          },
        },
        update: { active: true },
        create: {
          posConnectionId: conn.id,
          externalLocationId: cloverMerchantId,
          externalLocationName: "Clover Merchant " + cloverMerchantId,
          pvStoreId: 0, // Will be mapped manually
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
      return res.status(500).send("Connection failed: " + (err?.message || ""));
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
