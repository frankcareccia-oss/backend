/**
 * toast.oauth.routes.js — Toast POS connection management
 *
 * Routes:
 *   POST /pos/connect/toast           — connect with client credentials
 *   GET  /pos/connect/toast/status    — connection status
 *   GET  /pos/connect/toast/locations — list Toast locations + existing maps
 *   POST /pos/connect/toast/map-location — map a Toast location to a PV store
 *   POST /pos/connect/toast/sync-catalog — trigger catalog sync
 *   DELETE /pos/connect/toast         — revoke connection
 *
 * Toast uses client-credentials OAuth (no redirect flow):
 *   1. Merchant provides client ID + client secret + restaurant GUID
 *   2. We exchange for a bearer token via POST /authentication/v1/authentication/login
 *   3. Store encrypted token in PosConnection
 */

"use strict";

const express = require("express");
const { prisma } = require("../db/prisma");
const { syncCatalogFromPos } = require("./pos.catalog.sync");
const { encrypt } = require("../utils/encrypt");

const TOAST_API_BASE = process.env.TOAST_API_BASE || "https://ws-sandbox-api.eng.toasttab.com";
const TOAST_AUTH_URL = process.env.TOAST_AUTH_URL || `${TOAST_API_BASE}/authentication/v1/authentication/login`;

function buildToastOAuthRouter({ requireJwt, sendError, emitPvHook }) {
  const router = express.Router();

  /**
   * Resolve merchant context from JWT.
   */
  async function resolveMerchant(req) {
    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      select: {
        id: true,
        systemRole: true,
        merchantUsers: {
          where: { status: "active" },
          select: { merchantId: true, role: true },
        },
      },
    });

    if (!user) return null;

    if (user.systemRole === "pv_admin" && req.query.merchantId) {
      return { merchantId: Number(req.query.merchantId), role: "pv_admin" };
    }

    const mu = user.merchantUsers.find(m =>
      m.role === "owner" || m.role === "merchant_admin"
    );
    if (!mu) return null;

    return { merchantId: mu.merchantId, role: mu.role };
  }

  // ─── POST /pos/connect/toast — connect with client credentials ────────────

  router.post("/pos/connect/toast", requireJwt, express.json(), async (req, res) => {
    try {
      const merchant = await resolveMerchant(req);
      if (!merchant) return sendError(res, 403, "FORBIDDEN", "Merchant owner or admin role required");

      const { clientId, clientSecret, restaurantGuid } = req.body;
      if (!clientId || !clientSecret || !restaurantGuid) {
        return sendError(res, 400, "BAD_REQUEST", "clientId, clientSecret, and restaurantGuid are required");
      }

      // Exchange client credentials for bearer token
      const tokenRes = await fetch(TOAST_AUTH_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientId, clientSecret, userScope: "API" }),
      });

      const tokenData = await tokenRes.json();

      if (!tokenData.token?.accessToken) {
        console.error("[toast.oauth] token exchange failed:", tokenData);
        return sendError(res, 400, "AUTH_FAILED", "Toast authentication failed");
      }

      const accessToken = tokenData.token.accessToken;

      // Upsert PosConnection
      const conn = await prisma.posConnection.upsert({
        where: {
          merchantId_posType: {
            merchantId: merchant.merchantId,
            posType: "toast",
          },
        },
        update: {
          externalMerchantId: restaurantGuid,
          accessTokenEnc: encrypt(accessToken),
          refreshTokenEnc: encrypt(JSON.stringify({ clientId, clientSecret })),
          status: "active",
        },
        create: {
          merchantId: merchant.merchantId,
          posType: "toast",
          externalMerchantId: restaurantGuid,
          accessTokenEnc: encrypt(accessToken),
          refreshTokenEnc: encrypt(JSON.stringify({ clientId, clientSecret })),
          status: "active",
        },
      });

      // Auto-create location map — Toast restaurant = location
      const stores = await prisma.store.findMany({
        where: { merchantId: merchant.merchantId },
        select: { id: true, name: true },
        take: 2,
      });
      const autoStore = stores.length === 1 ? stores[0] : null;

      await prisma.posLocationMap.upsert({
        where: {
          posConnectionId_externalLocationId: {
            posConnectionId: conn.id,
            externalLocationId: restaurantGuid,
          },
        },
        update: {
          active: true,
          pvStoreId: autoStore ? autoStore.id : undefined,
          pvStoreName: autoStore ? autoStore.name : undefined,
        },
        create: {
          posConnectionId: conn.id,
          externalLocationId: restaurantGuid,
          externalLocationName: "Toast Restaurant " + restaurantGuid,
          pvStoreId: autoStore ? autoStore.id : 0,
          pvStoreName: autoStore ? autoStore.name : null,
          active: true,
        },
      });

      emitPvHook("toast.connected", {
        tc: "TC-TST-01",
        sev: "info",
        stable: "toast:oauth:" + merchant.merchantId,
        merchantId: merchant.merchantId,
        restaurantGuid,
        posConnectionId: conn.id,
      });

      // Fire-and-forget catalog sync
      const { ToastAdapter } = require("./adapters/toast.adapter");
      const adapter = new ToastAdapter(conn);
      syncCatalogFromPos(prisma, adapter, {
        merchantId: merchant.merchantId,
        posConnectionId: conn.id,
        trigger: "oauth_connect",
      }).catch(e => {
        console.error("[toast.oauth] catalog sync error:", e?.message);
      });

      return res.json({ ok: true, connectionId: conn.id, restaurantGuid });
    } catch (err) {
      return sendError(res, 500, "SERVER_ERROR", err?.message || "Connection failed");
    }
  });

  // ─── GET /pos/connect/toast/status ─────────────────────────────────────────

  router.get("/pos/connect/toast/status", requireJwt, async (req, res) => {
    try {
      const merchant = await resolveMerchant(req);
      if (!merchant) return sendError(res, 403, "FORBIDDEN", "Merchant owner or admin role required");

      const conn = await prisma.posConnection.findFirst({
        where: { merchantId: merchant.merchantId, posType: "toast", status: "active" },
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

  // ─── GET /pos/connect/toast/locations ──────────────────────────────────────

  router.get("/pos/connect/toast/locations", requireJwt, async (req, res) => {
    try {
      const merchant = await resolveMerchant(req);
      if (!merchant) return sendError(res, 403, "FORBIDDEN", "Merchant owner or admin role required");

      const conn = await prisma.posConnection.findFirst({
        where: { merchantId: merchant.merchantId, posType: "toast", status: "active" },
      });
      if (!conn) return sendError(res, 404, "NOT_FOUND", "No active Toast connection");

      const { ToastAdapter } = require("./adapters/toast.adapter");
      const adapter = new ToastAdapter(conn);
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

  // ─── POST /pos/connect/toast/map-location ─────────────────────────────────

  router.post("/pos/connect/toast/map-location", requireJwt, express.json(), async (req, res) => {
    try {
      const merchant = await resolveMerchant(req);
      if (!merchant) return sendError(res, 403, "FORBIDDEN", "Merchant owner or admin role required");

      const { externalLocationId, externalLocationName, pvStoreId } = req.body;
      if (!externalLocationId || !pvStoreId) {
        return sendError(res, 400, "BAD_REQUEST", "externalLocationId and pvStoreId required");
      }

      const conn = await prisma.posConnection.findFirst({
        where: { merchantId: merchant.merchantId, posType: "toast", status: "active" },
      });
      if (!conn) return sendError(res, 404, "NOT_FOUND", "No active Toast connection");

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

      emitPvHook("toast.location.mapped", {
        tc: "TC-TST-05",
        sev: "info",
        stable: "toast:location:" + merchant.merchantId,
        merchantId: merchant.merchantId,
        externalLocationId,
        pvStoreId: store.id,
      });

      return res.json({ ok: true, map });
    } catch (err) {
      return sendError(res, 500, "SERVER_ERROR", err?.message || "Failed to map location");
    }
  });

  // ─── POST /pos/connect/toast/sync-catalog ─────────────────────────────────

  router.post("/pos/connect/toast/sync-catalog", requireJwt, async (req, res) => {
    try {
      const merchant = await resolveMerchant(req);
      if (!merchant) return sendError(res, 403, "FORBIDDEN", "Merchant owner or admin role required");

      const conn = await prisma.posConnection.findFirst({
        where: { merchantId: merchant.merchantId, posType: "toast", status: "active" },
      });
      if (!conn) return sendError(res, 404, "NOT_FOUND", "No active Toast connection");

      const { ToastAdapter } = require("./adapters/toast.adapter");
      const adapter = new ToastAdapter(conn);
      const result = await syncCatalogFromPos(prisma, adapter, {
        merchantId: merchant.merchantId,
        posConnectionId: conn.id,
        trigger: "manual",
      });

      emitPvHook("toast.catalog.synced", {
        tc: "TC-TST-03",
        sev: "info",
        stable: "toast:catalog:" + merchant.merchantId,
        merchantId: merchant.merchantId,
        summary: result?.summary || null,
      });

      return res.json({ ok: true, summary: result?.summary || null });
    } catch (err) {
      return sendError(res, 500, "SERVER_ERROR", err?.message || "Sync failed");
    }
  });

  // ─── DELETE /pos/connect/toast — revoke connection ────────────────────────

  router.delete("/pos/connect/toast", requireJwt, async (req, res) => {
    try {
      const merchant = await resolveMerchant(req);
      if (!merchant) return sendError(res, 403, "FORBIDDEN", "Merchant owner or admin role required");

      await prisma.posConnection.updateMany({
        where: { merchantId: merchant.merchantId, posType: "toast" },
        data: { status: "revoked" },
      });

      emitPvHook("toast.disconnected", {
        tc: "TC-TST-04",
        sev: "info",
        stable: "toast:oauth:" + merchant.merchantId,
        merchantId: merchant.merchantId,
        userId: req.userId,
      });

      return res.json({ ok: true, message: "Toast connection revoked" });
    } catch (err) {
      return sendError(res, 500, "SERVER_ERROR", err?.message || "Disconnect failed");
    }
  });

  return router;
}

module.exports = { buildToastOAuthRouter };
