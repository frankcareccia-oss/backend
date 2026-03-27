/// ============================================================================
/// MODULE: merchant.storeTeam.routes.js
/// PURPOSE: Merchant store Team & Access routes aligned to Role/Permission Model v2.00
/// AUTHOR: ChatGPT + Frank Careccia
/// DATE: 2026-03-27
/// NOTES:
/// - Merchant role and store permission are separate concepts
/// - Store permissions are: store_admin, store_subadmin, pos_access
/// - Auth is owned by requireJwt; do not decode JWT separately in this module
/// - GET now enforces the same manager authorization model as write routes
/// - employees includes assignment info for easier UI consumption
/// ============================================================================

const express = require("express");

/** Parse positive integer safely */
function parsePositiveInt(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.trunc(n);
}

/** Normalize incoming store permission to v2.00 contract */
function normalizeStorePermission(raw) {
  const value = String(raw || "").trim().toLowerCase();

  if (!value) return null;

  if (value === "store_admin" || value === "admin") return "store_admin";
  if (value === "store_subadmin" || value === "subadmin") return "store_subadmin";
  if (value === "pos_access" || value === "pos_employee") return "pos_access";

  return null;
}

/**
 * Resolve merchantIds the current user belongs to via MerchantUser.
 * Returns [] if the user is not associated to any merchant.
 */
async function resolveMerchantIdsForUser(prisma, userId) {
  const normalizedUserId = Number(userId);
  if (!Number.isFinite(normalizedUserId) || normalizedUserId <= 0) return [];

  const rows = await prisma.merchantUser.findMany({
    where: { userId: normalizedUserId, status: "active" },
    select: { merchantId: true },
  });

  return Array.from(new Set(rows.map((r) => r.merchantId)));
}

function safeHandlePrismaError(handlePrismaError, err, res) {
  try {
    if (typeof handlePrismaError === "function") {
      return handlePrismaError(err, res);
    }
  } catch {
    // fall through
  }
  return res.status(500).json({ code: "SERVER_ERROR", message: "Database error" });
}

const USER_SELECT = {
  id: true,
  email: true,
  firstName: true,
  lastName: true,
  phoneCountry: true,
  phoneRaw: true,
  phoneE164: true,
};

function mapMerchantUser(mu, assignedStoreUser = null) {
  return {
    merchantUserId: mu.id,
    userId: mu.userId,
    email: mu.user?.email || null,
    role: mu.role,
    status: mu.status,
    firstName: mu.user?.firstName || null,
    lastName: mu.user?.lastName || null,
    phoneCountry: mu.user?.phoneCountry || null,
    phoneRaw: mu.user?.phoneRaw || null,
    phoneE164: mu.user?.phoneE164 || null,

    // Unified assignment fields for easier UI consumption
    assigned: Boolean(assignedStoreUser),
    storeUserId: assignedStoreUser?.id || null,
    permissionLevel: assignedStoreUser?.permissionLevel || null,
    storeAssignmentStatus: assignedStoreUser?.status || null,
  };
}

function mapStoreUser(su) {
  return {
    storeUserId: su.id,
    merchantUserId: su.merchantUserId,
    userId: su.merchantUser?.userId || null,
    email: su.merchantUser?.user?.email || null,
    permissionLevel: su.permissionLevel,
    status: su.status,
    firstName: su.merchantUser?.user?.firstName || null,
    lastName: su.merchantUser?.user?.lastName || null,
    phoneCountry: su.merchantUser?.user?.phoneCountry || null,
    phoneRaw: su.merchantUser?.user?.phoneRaw || null,
    phoneE164: su.merchantUser?.user?.phoneE164 || null,
  };
}

function buildMerchantStoreTeamRouter(deps) {
  if (!deps) throw new Error("buildMerchantStoreTeamRouter: deps is required");

  const {
    prisma,
    requireJwt,
    sendError,
    handlePrismaError,
    requireMerchantUserManager,
  } = deps;

  if (!prisma) throw new Error("buildMerchantStoreTeamRouter: prisma is required");
  if (typeof requireJwt !== "function") {
    throw new Error("buildMerchantStoreTeamRouter: requireJwt is required");
  }
  if (typeof sendError !== "function") {
    throw new Error("buildMerchantStoreTeamRouter: sendError is required");
  }
  if (typeof requireMerchantUserManager !== "function") {
    throw new Error("buildMerchantStoreTeamRouter: requireMerchantUserManager is required");
  }

  const router = express.Router();

  /**
   * GET /merchant/stores/:storeId/team
   */
  router.get("/merchant/stores/:storeId/team", requireJwt, async (req, res) => {
    try {
      if (!req.userId) {
        return sendError(res, 401, "UNAUTHORIZED", "Missing user");
      }

      const storeId = parsePositiveInt(req.params.storeId);
      if (!storeId) {
        return sendError(res, 400, "VALIDATION_ERROR", "Invalid storeId");
      }

      const merchantIds = await resolveMerchantIdsForUser(prisma, req.userId);

      const store = await prisma.store.findFirst({
        where: { id: storeId, merchantId: { in: merchantIds } },
        select: {
          id: true,
          merchantId: true,
          primaryContactStoreUserId: true,
        },
      });

      if (!store) {
        return sendError(res, 404, "NOT_FOUND", "Store not found");
      }

      const acting = await requireMerchantUserManager(req, res, store.merchantId);
      if (!acting) return;

      const merchantUsers = await prisma.merchantUser.findMany({
        where: {
          merchantId: store.merchantId,
          status: "active",
        },
        include: {
          user: {
            select: USER_SELECT,
          },
        },
        orderBy: [{ id: "asc" }],
      });

      const storeUsers = await prisma.storeUser.findMany({
        where: {
          storeId,
          status: "active",
        },
        include: {
          merchantUser: {
            include: {
              user: {
                select: USER_SELECT,
              },
            },
          },
        },
        orderBy: [{ id: "asc" }],
      });

      const assignedByMerchantUserId = new Map(
        storeUsers.map((su) => [Number(su.merchantUserId), su])
      );

      const employees = merchantUsers.map((mu) =>
        mapMerchantUser(mu, assignedByMerchantUserId.get(Number(mu.id)) || null)
      );

      const assigned = storeUsers.map(mapStoreUser);

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
      if (!req.userId) {
        return sendError(res, 401, "UNAUTHORIZED", "Missing user");
      }

      const storeId = parsePositiveInt(req.params.storeId);
      if (!storeId) {
        return sendError(res, 400, "VALIDATION_ERROR", "Invalid storeId");
      }

      const merchantUserId = parsePositiveInt(req.body?.merchantUserId);
      if (!merchantUserId) {
        return sendError(res, 400, "VALIDATION_ERROR", "Invalid merchantUserId");
      }

      const permissionLevel = normalizeStorePermission(req.body?.permissionLevel);
      if (!permissionLevel) {
        return sendError(
          res,
          400,
          "VALIDATION_ERROR",
          "Invalid permissionLevel. Expected store_admin, store_subadmin, or pos_access"
        );
      }

      const merchantIds = await resolveMerchantIdsForUser(prisma, req.userId);

      const store = await prisma.store.findFirst({
        where: { id: storeId, merchantId: { in: merchantIds } },
        select: { id: true, merchantId: true },
      });

      if (!store) {
        return sendError(res, 404, "NOT_FOUND", "Store not found");
      }

      const acting = await requireMerchantUserManager(req, res, store.merchantId);
      if (!acting) return;

      const merchantUser = await prisma.merchantUser.findFirst({
        where: {
          id: merchantUserId,
          merchantId: store.merchantId,
          status: "active",
        },
        select: {
          id: true,
          userId: true,
          role: true,
          status: true,
        },
      });

      if (!merchantUser) {
        return sendError(res, 404, "NOT_FOUND", "Employee not found");
      }

      const upserted = await prisma.storeUser.upsert({
        where: {
          storeId_merchantUserId: {
            storeId,
            merchantUserId: merchantUser.id,
          },
        },
        update: {
          permissionLevel,
          status: "active",
        },
        create: {
          storeId,
          merchantUserId: merchantUser.id,
          permissionLevel,
          status: "active",
        },
        select: {
          id: true,
          storeId: true,
          merchantUserId: true,
          permissionLevel: true,
          status: true,
        },
      });

      return res.json({
        ok: true,
        storeUser: upserted,
      });
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
      if (!req.userId) {
        return sendError(res, 401, "UNAUTHORIZED", "Missing user");
      }

      const storeId = parsePositiveInt(req.params.storeId);
      if (!storeId) {
        return sendError(res, 400, "VALIDATION_ERROR", "Invalid storeId");
      }

      const raw = req.body?.primaryContactStoreUserId;
      const nextId = raw === null || raw === "" ? null : parsePositiveInt(raw);

      if (raw !== null && raw !== "" && !nextId) {
        return sendError(res, 400, "VALIDATION_ERROR", "Invalid primaryContactStoreUserId");
      }

      const merchantIds = await resolveMerchantIdsForUser(prisma, req.userId);

      const store = await prisma.store.findFirst({
        where: { id: storeId, merchantId: { in: merchantIds } },
        select: { id: true, merchantId: true },
      });

      if (!store) {
        return sendError(res, 404, "NOT_FOUND", "Store not found");
      }

      const acting = await requireMerchantUserManager(req, res, store.merchantId);
      if (!acting) return;

      if (nextId !== null) {
        const su = await prisma.storeUser.findFirst({
          where: {
            id: nextId,
            storeId,
            status: "active",
          },
          select: { id: true },
        });

        if (!su) {
          return sendError(
            res,
            400,
            "VALIDATION_ERROR",
            "Primary contact must be assigned to this store"
          );
        }
      }

      const updated = await prisma.store.update({
        where: { id: storeId },
        data: { primaryContactStoreUserId: nextId },
        select: { id: true, primaryContactStoreUserId: true },
      });

      return res.json({
        ok: true,
        storeId: updated.id,
        primaryContactStoreUserId: updated.primaryContactStoreUserId || null,
      });
    } catch (err) {
      return safeHandlePrismaError(handlePrismaError, err, res);
    }
  });

  /**
   * DELETE /merchant/stores/team/:storeUserId
   */
  router.delete("/merchant/stores/team/:storeUserId", requireJwt, async (req, res) => {
    const storeUserId = parsePositiveInt(req.params.storeUserId);
    if (!storeUserId) {
      return sendError(res, 400, "VALIDATION_ERROR", "Invalid storeUserId");
    }

    try {
      const existing = await prisma.storeUser.findUnique({
        where: { id: storeUserId },
        select: {
          id: true,
          storeId: true,
          merchantUserId: true,
        },
      });

      if (!existing) {
        return sendError(res, 404, "NOT_FOUND", "Store team member not found");
      }

      const store = await prisma.store.findUnique({
        where: { id: existing.storeId },
        select: {
          id: true,
          merchantId: true,
          primaryContactStoreUserId: true,
        },
      });

      if (!store) {
        return sendError(res, 404, "NOT_FOUND", "Store not found");
      }

      const acting = await requireMerchantUserManager(req, res, store.merchantId);
      if (!acting) return;

      await prisma.$transaction(async (tx) => {
        if (Number(store.primaryContactStoreUserId) === Number(storeUserId)) {
          await tx.store.update({
            where: { id: store.id },
            data: { primaryContactStoreUserId: null },
          });
        }

        await tx.storeUser.delete({
          where: { id: storeUserId },
        });
      });

      return res.json({
        ok: true,
        storeUserId,
        storeId: store.id,
      });
    } catch (err) {
      return safeHandlePrismaError(handlePrismaError, err, res);
    }
  });

  return router;
}

module.exports = { buildMerchantStoreTeamRouter };