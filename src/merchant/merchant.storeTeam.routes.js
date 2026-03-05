/**
 * Merchant Store Team Routes (Option 2 extraction)
 *
 * Purpose:
 * - Back the Merchant UI "Team & Access" tab for a store
 * - Keep index.js stable: mount router and pass deps
 *
 * Endpoints:
 * - GET   /merchant/stores/:storeId/team
 * - POST  /merchant/stores/:storeId/team/assign
 * - PATCH /merchant/stores/:storeId/team/primary-contact
 *
 * Notes:
 * - Current schema.prisma (as uploaded) has User fields: id/email/passwordHash/systemRole/etc (no firstName/phone).
 * - So this module returns employee identity primarily via email (and ids).
 */

const express = require("express");

/** Parse storeId safely */
function parseStoreId(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.trunc(n);
}

/**
 * Resolve merchantIds the current user belongs to via MerchantUser.
 * Returns [] if the user is not associated to any merchant.
 */
async function resolveMerchantIdsForUser(prisma, userId) {
  if (!Number.isFinite(Number(userId))) return [];
  const rows = await prisma.merchantUser.findMany({
    where: { userId: Number(userId), status: "active" },
    select: { merchantId: true },
  });
  return Array.from(new Set(rows.map((r) => r.merchantId)));
}

function safeHandlePrismaError(handlePrismaError, err, res) {
  try {
    if (typeof handlePrismaError === "function") {
      // expected signature in this repo is (err, res)
      return handlePrismaError(err, res);
    }
  } catch {
    // fall through
  }
  return res.status(500).json({ code: "SERVER_ERROR", message: "Database error" });
}

function buildMerchantStoreTeamRouter(deps) {
  if (!deps) throw new Error("buildMerchantStoreTeamRouter: deps is required");
  const { prisma, requireJwt, sendError, handlePrismaError } = deps;

  if (!prisma) throw new Error("buildMerchantStoreTeamRouter: prisma is required");
  if (typeof requireJwt !== "function") throw new Error("buildMerchantStoreTeamRouter: requireJwt is required");
  if (typeof sendError !== "function") throw new Error("buildMerchantStoreTeamRouter: sendError is required");

  const router = express.Router();

  /**
   * GET /merchant/stores/:storeId/team
   */
  router.get("/merchant/stores/:storeId/team", requireJwt, async (req, res) => {
    try {
      if (!req.userId) return sendError(res, 401, "UNAUTHORIZED", "Missing user");

      const storeId = parseStoreId(req.params.storeId);
      if (!storeId) return sendError(res, 400, "VALIDATION_ERROR", "Invalid storeId");

      const merchantIds = await resolveMerchantIdsForUser(prisma, req.userId);

      const store = await prisma.store.findFirst({
        where: { id: storeId, merchantId: { in: merchantIds } },
        select: { id: true, merchantId: true, primaryContactStoreUserId: true },
      });
      if (!store) return sendError(res, 404, "NOT_FOUND", "Store not found");

      const merchantUsers = await prisma.merchantUser.findMany({
        where: { merchantId: store.merchantId, status: "active" },
        include: {
          user: { select: { id: true, email: true } },
        },
        orderBy: [{ id: "asc" }],
      });

      const storeUsers = await prisma.storeUser.findMany({
        where: { storeId: storeId, status: "active" },
        include: {
          merchantUser: {
            include: { user: { select: { id: true, email: true } } },
          },
        },
        orderBy: [{ id: "asc" }],
      });

      const employees = merchantUsers.map((mu) => ({
        merchantUserId: mu.id,
        userId: mu.userId,
        email: mu.user?.email || null,
        role: mu.role,
        status: mu.status,
        firstName: null,
        lastName: null,
        phoneCountry: null,
        phoneRaw: null,
        phoneE164: null,
      }));

      const assigned = storeUsers.map((su) => ({
        storeUserId: su.id,
        merchantUserId: su.merchantUserId,
        userId: su.merchantUser?.userId || null,
        email: su.merchantUser?.user?.email || null,
        permissionLevel: su.permissionLevel,
        status: su.status,
        firstName: null,
        lastName: null,
        phoneCountry: null,
        phoneRaw: null,
        phoneE164: null,
      }));

      return res.json({
        storeId: store.id,
        merchantId: store.merchantId,
        primaryContactStoreUserId: store.primaryContactStoreUserId || null,
        employees,
        assigned,
      });
    } catch (err) {
      return safeHandlePrismaError(handlePrismaError, err, res);
    }
  });

  /**
   * POST /merchant/stores/:storeId/team/assign
   * Body: { merchantUserId, permissionLevel }
   */
  router.post("/merchant/stores/:storeId/team/assign", requireJwt, async (req, res) => {
    try {
      if (!req.userId) return sendError(res, 401, "UNAUTHORIZED", "Missing user");

      const storeId = parseStoreId(req.params.storeId);
      if (!storeId) return sendError(res, 400, "VALIDATION_ERROR", "Invalid storeId");

      const merchantUserId = Number(req.body?.merchantUserId);
      if (!Number.isFinite(merchantUserId) || merchantUserId <= 0) {
        return sendError(res, 400, "VALIDATION_ERROR", "Invalid merchantUserId");
      }

      const permissionLevel = String(req.body?.permissionLevel || "admin");
      const allowed = new Set(["admin", "clerk", "viewer"]);
      const nextPerm = allowed.has(permissionLevel) ? permissionLevel : "admin";

      const merchantIds = await resolveMerchantIdsForUser(prisma, req.userId);

      const store = await prisma.store.findFirst({
        where: { id: storeId, merchantId: { in: merchantIds } },
        select: { id: true, merchantId: true },
      });
      if (!store) return sendError(res, 404, "NOT_FOUND", "Store not found");

      const mu = await prisma.merchantUser.findFirst({
        where: { id: merchantUserId, merchantId: store.merchantId },
        select: { id: true },
      });
      if (!mu) return sendError(res, 404, "NOT_FOUND", "Employee not found");

      const upserted = await prisma.storeUser.upsert({
        where: { storeId_merchantUserId: { storeId: storeId, merchantUserId: merchantUserId } },
        update: { permissionLevel: nextPerm, status: "active" },
        create: { storeId: storeId, merchantUserId: merchantUserId, permissionLevel: nextPerm, status: "active" },
        select: { id: true, storeId: true, merchantUserId: true, permissionLevel: true, status: true },
      });

      return res.json({ ok: true, storeUser: upserted });
    } catch (err) {
      return safeHandlePrismaError(handlePrismaError, err, res);
    }
  });

  /**
   * PATCH /merchant/stores/:storeId/team/primary-contact
   * Body: { primaryContactStoreUserId }
   */
  router.patch("/merchant/stores/:storeId/team/primary-contact", requireJwt, async (req, res) => {
    try {
      if (!req.userId) return sendError(res, 401, "UNAUTHORIZED", "Missing user");

      const storeId = parseStoreId(req.params.storeId);
      if (!storeId) return sendError(res, 400, "VALIDATION_ERROR", "Invalid storeId");

      const raw = req.body?.primaryContactStoreUserId;
      const nextId = raw === null || raw === "" ? null : Number(raw);
      if (nextId !== null && (!Number.isFinite(nextId) || nextId <= 0)) {
        return sendError(res, 400, "VALIDATION_ERROR", "Invalid primaryContactStoreUserId");
      }

      const merchantIds = await resolveMerchantIdsForUser(prisma, req.userId);

      const store = await prisma.store.findFirst({
        where: { id: storeId, merchantId: { in: merchantIds } },
        select: { id: true },
      });
      if (!store) return sendError(res, 404, "NOT_FOUND", "Store not found");

      if (nextId !== null) {
        const su = await prisma.storeUser.findFirst({
          where: { id: nextId, storeId: storeId, status: "active" },
          select: { id: true },
        });
        if (!su) return sendError(res, 400, "VALIDATION_ERROR", "Primary contact must be assigned to this store");
      }

      const updated = await prisma.store.update({
        where: { id: storeId },
        data: { primaryContactStoreUserId: nextId },
        select: { id: true, primaryContactStoreUserId: true },
      });

      return res.json({ ok: true, storeId: updated.id, primaryContactStoreUserId: updated.primaryContactStoreUserId || null });
    } catch (err) {
      return safeHandlePrismaError(handlePrismaError, err, res);
    }
  });

  return router;
}

module.exports = { buildMerchantStoreTeamRouter };
