/**
 * Merchant Store Profile Routes (Option 2 extraction)
 *
 * Contract (locked):
 * - GET   /merchant/stores/:storeId
 * - PATCH /merchant/stores/:storeId/profile
 *
 * Notes:
 * - Extraction-only with stabilization:
 *   - Preserve route shapes and response payloads (returns Store record; GET includes primary contact)
 *   - Keep auth semantics (requireJwt)
 *   - Keep merchant scoping (store must belong to one of the user's merchant memberships)
 *   - Always return JSON errors via sendError
 *
 * Deps (required):
 * - prisma
 * - requireJwt
 * - sendError(res, httpStatus, code, message, extras?)
 * - handlePrismaError(res, err)
 */
const express = require("express");

function parseStoreId(param) {
  const n = Number(param);
  return Number.isFinite(n) ? n : null;
}

/**
 * Resolve merchantIds for a userId.
 * NOTE: requireJwt sets req.userId (not req.user), so callers must pass userId.
 */
async function resolveMerchantIdsForUser(prisma, userId) {
  const u = await prisma.user.findUnique({
    where: { id: userId },
    select: { systemRole: true, merchantUsers: { select: { merchantId: true } } },
  });
  if (!u) return [];
  if (u.systemRole === "pv_admin") return []; // pv_admin should use admin routes, not merchant routes
  return (u.merchantUsers || []).map((mu) => mu.merchantId).filter(Boolean);
}

function buildMerchantStoreProfileRouter(deps) {
  if (!deps) throw new Error("buildMerchantStoreProfileRouter: deps is required");

  const { prisma, requireJwt, sendError, handlePrismaError } = deps;

  if (!prisma) throw new Error("buildMerchantStoreProfileRouter: prisma is required");
  if (typeof requireJwt !== "function") throw new Error("buildMerchantStoreProfileRouter: requireJwt is required");
  if (typeof sendError !== "function") throw new Error("buildMerchantStoreProfileRouter: sendError is required");
  if (typeof handlePrismaError !== "function")
    throw new Error("buildMerchantStoreProfileRouter: handlePrismaError is required");

  const router = express.Router();

  // GET store detail for merchant UI
  router.get("/merchant/stores/:storeId", requireJwt, async (req, res) => {
    try {
      const storeId = parseStoreId(req.params.storeId);
      if (!storeId) return sendError(res, 400, "VALIDATION_ERROR", "Invalid storeId");

      const merchantIds = await resolveMerchantIdsForUser(prisma, req.userId);
      if (!merchantIds.length) return sendError(res, 403, "FORBIDDEN", "Not authorized");

      const store = await prisma.store.findFirst({
        where: { id: storeId, merchantId: { in: merchantIds } },
        include: {
          // Allow UI to render the assigned primary contact (employee) if it uses this relation.
          primaryContactStoreUser: {
            include: {
              merchantUser: {
                include: {
                  user: { select: { id: true, email: true } },
                },
              },
            },
          },
        },
      });

      if (!store) return sendError(res, 404, "NOT_FOUND", "Store not found");
      return res.json(store);
    } catch (e) {
      return handlePrismaError(res, e);
    }
  });

  // PATCH store profile (merchant store settings)
  router.patch("/merchant/stores/:storeId/profile", requireJwt, async (req, res) => {
    try {
      const storeId = parseStoreId(req.params.storeId);
      if (!storeId) return sendError(res, 400, "VALIDATION_ERROR", "Invalid storeId");

      const merchantIds = await resolveMerchantIdsForUser(prisma, req.userId);
      if (!merchantIds.length) return sendError(res, 403, "FORBIDDEN", "Not authorized");

      const existing = await prisma.store.findFirst({
        where: { id: storeId, merchantId: { in: merchantIds } },
        select: { id: true },
      });
      if (!existing) return sendError(res, 404, "NOT_FOUND", "Store not found");

      const b = req.body || {};
      const data = {};

      // Store profile fields (allow-list)
      if (typeof b.name === "string") data.name = b.name.trim();
      if (typeof b.address1 === "string") data.address1 = b.address1.trim();
      if (typeof b.city === "string") data.city = b.city.trim();
      if (typeof b.state === "string") data.state = b.state;
      if (typeof b.postal === "string") data.postal = b.postal.trim();
      if (typeof b.status === "string") data.status = b.status;

      // Location phone (Store.*)
      if (typeof b.phoneCountry === "string") data.phoneCountry = b.phoneCountry;
      if (typeof b.phoneRaw === "string") data.phoneRaw = b.phoneRaw;

      // Back-office phone (we map UI "contact phone" here for now; schema supports it)
      if (typeof b.contactPhoneCountry === "string") data.backOfficePhoneCountry = b.contactPhoneCountry;
      if (typeof b.contactPhoneRaw === "string") data.backOfficePhoneRaw = b.contactPhoneRaw;

      /**
       * Primary contact assignment (employee link) — schema-backed.
       * Store.primaryContactStoreUserId -> StoreUser.id
       *
       * Accepts:
       * - primaryContactStoreUserId: number | string-number | null
       *
       * Validation:
       * - the StoreUser must belong to THIS store
       * - and its MerchantUser must belong to an allowed merchantId for this user
       */
      let pcId = b.primaryContactStoreUserId;

      if (pcId === null) {
        data.primaryContactStoreUserId = null;
      } else if (pcId !== undefined && pcId !== "") {
        const pcNum = Number(pcId);
        if (!Number.isInteger(pcNum) || pcNum <= 0) {
          return sendError(res, 400, "VALIDATION_ERROR", "primaryContactStoreUserId must be an integer or null");
        }

        const su = await prisma.storeUser.findFirst({
          where: {
            id: pcNum,
            storeId,
            merchantUser: { merchantId: { in: merchantIds } },
          },
          select: { id: true },
        });

        if (!su) return sendError(res, 400, "VALIDATION_ERROR", "primaryContactStoreUserId is not valid for this store");
        data.primaryContactStoreUserId = pcNum;
      }

      const updated = await prisma.store.update({
        where: { id: storeId },
        data,
      });

      return res.json(updated);
    } catch (e) {
      return handlePrismaError(res, e);
    }
  });

  return router;
}

module.exports = { buildMerchantStoreProfileRouter };
