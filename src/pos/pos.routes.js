// backend/src/pos/pos.routes.js
const express = require("express");
const { requireFreshTimestamp } = require("./pos.replay");
const { requireIdempotency } = require("./pos.idempotency");
const { persistVisit, persistReward } = require("./pos.persist");

/**
 * POS routes (NO-MIGRATIONS MODE)
 *
 * Endpoints:
 * - POST /pos/visit
 * - POST /pos/reward
 *
 * Auth:
 * - requireJwt (passed in as requireAuth)
 * - merchant systemRole only
 * - POS associate only (store_subadmin + store permission subadmin)
 *
 * Hooks (server-side, safe, structured):
 * - pos.visit.requested.api / succeeded.api / failed.api
 * - pos.reward.requested.api / succeeded.api / failed.api
 *
 * POS-3 (safety hardening):
 * - Requires X-POS-Timestamp (replay protection)
 * - Requires X-POS-Idempotency-Key (idempotency)
 * - Hooks: pos.replay.reject, pos.idempotency.accept/replay/conflict
 */

function pvHook(event, fields = {}) {
  try {
    console.log(
      JSON.stringify({
        pvHook: event,
        ts: new Date().toISOString(),
        ...fields,
      })
    );
  } catch {
    // never throw from hooks
  }
}

function maskIdentifier(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  if (s.includes("@")) {
    const [u, d] = s.split("@");
    const uMasked = u ? `${u.slice(0, 2)}***` : "***";
    return `${uMasked}@${d || "***"}`;
  }
  const digits = s.replace(/[^\d]/g, "");
  if (digits.length >= 10 && digits.length <= 15) {
    const last4 = digits.slice(-4);
    return `***-***-${last4 || "****"}`;
  }
  return s.length <= 6 ? "***" : `${s.slice(0, 3)}***${s.slice(-2)}`;
}

function registerPosRoutes(app, { prisma, sendError, requireAuth }) {
  if (!app) throw new Error("registerPosRoutes: app required");
  if (!prisma) throw new Error("registerPosRoutes: prisma required");
  if (!sendError) throw new Error("registerPosRoutes: sendError required");
  if (typeof requireAuth !== "function")
    throw new Error("registerPosRoutes: requireAuth middleware required");

  const router = express.Router();
  router.use(express.json());

  // POS-3 wiring: make hooks + sendError visible to middleware
  router.use((req, res, next) => {
    req.pvHook = pvHook;
    res.locals.sendError = sendError;
    next();
  });

  async function requirePosContext(req, res) {
    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      select: {
        id: true,
        systemRole: true,
        merchantUsers: {
          where: { status: "active" },
          select: {
            id: true,
            role: true,
            merchantId: true,
            storeUsers: {
              where: { status: "active" },
              select: { storeId: true, permissionLevel: true },
            },
          },
        },
      },
    });

    if (!user) {
      sendError(res, 404, "NOT_FOUND", "User not found");
      return null;
    }

    if (user.systemRole === "pv_admin") {
      sendError(res, 403, "FORBIDDEN", "pv_admin does not use POS");
      return null;
    }

    // POS must be store_subadmin AND have a subadmin store permission
    let storeId = null;
    let merchantId = null;

    for (const mu of user.merchantUsers || []) {
      if (mu.role !== "store_subadmin") continue;
      const su = (mu.storeUsers || []).find(
        (s) => s.permissionLevel === "subadmin"
      );
      if (su) {
        storeId = su.storeId;
        merchantId = mu.merchantId;
        break;
      }
    }

    if (!storeId || !merchantId) {
      sendError(res, 403, "FORBIDDEN", "POS associate required");
      return null;
    }

    return { userId: user.id, merchantId, storeId };
  }

  router.post(
    "/pos/visit",
    requireAuth,
    requireFreshTimestamp,
    requireIdempotency,
    async (req, res) => {
      const identifier = req.body?.identifier;

      pvHook("pos.visit.requested.api", {
        tc: "TC-POS-API-01",
        sev: "info",
        stable: "pos:visit",
        identifierMasked: maskIdentifier(identifier),
      });

      if (!identifier) {
        pvHook("pos.visit.failed.api", {
          tc: "TC-POS-API-02",
          sev: "warn",
          stable: "pos:visit:validation",
          reason: "identifier_required",
        });
        return sendError(res, 400, "VALIDATION_ERROR", "identifier is required");
      }

      try {
        const ctx = await requirePosContext(req, res);
        if (!ctx) return;

        // POS-4A: persistence (append-only NDJSON) + stable visitId
        const result = await persistVisit({
          ctx: { ...ctx, pvHook },
          body: req.body,
          idempotencyKey: req.headers["x-pos-idempotency-key"],
        });

        pvHook("pos.visit.succeeded.api", {
          tc: "TC-POS-API-03",
          sev: "info",
          stable: `store:${ctx.storeId}`,
          merchantId: ctx.merchantId,
          storeId: ctx.storeId,
          visitId: result.visitId,
        });

        return res.json({
          ok: true,
          visitId: result.visitId,
          identifier: String(identifier),
        });
      } catch (e) {
        pvHook("pos.visit.failed.api", {
          tc: "TC-POS-API-04",
          sev: "error",
          stable: "pos:visit:error",
          error: e?.message || String(e),
        });
        return sendError(res, 500, "SERVER_ERROR", "Error");
      }
    }
  );

  router.post(
    "/pos/reward",
    requireAuth,
    requireFreshTimestamp,
    requireIdempotency,
    async (req, res) => {
      const identifier = req.body?.identifier;

      pvHook("pos.reward.requested.api", {
        tc: "TC-POS-API-05",
        sev: "info",
        stable: "pos:reward",
        identifierMasked: maskIdentifier(identifier),
      });

      if (!identifier) {
        pvHook("pos.reward.failed.api", {
          tc: "TC-POS-API-06",
          sev: "warn",
          stable: "pos:reward:validation",
          reason: "identifier_required",
        });
        return sendError(res, 400, "VALIDATION_ERROR", "identifier is required");
      }

      try {
        const ctx = await requirePosContext(req, res);
        if (!ctx) return;

        // POS-4A: persistence (append-only NDJSON) + stable rewardId
        const result = await persistReward({
          ctx: { ...ctx, pvHook },
          body: req.body,
          idempotencyKey: req.headers["x-pos-idempotency-key"],
        });

        pvHook("pos.reward.succeeded.api", {
          tc: "TC-POS-API-07",
          sev: "info",
          stable: `store:${ctx.storeId}`,
          merchantId: ctx.merchantId,
          storeId: ctx.storeId,
          rewardId: result.rewardId,
        });

        return res.json({
          ok: true,
          rewardId: result.rewardId,
          identifier: String(identifier),
        });
      } catch (e) {
        pvHook("pos.reward.failed.api", {
          tc: "TC-POS-API-08",
          sev: "error",
          stable: "pos:reward:error",
          error: e?.message || String(e),
        });
        return sendError(res, 500, "SERVER_ERROR", "Error");
      }
    }
  );

  return { router };
}

module.exports = { registerPosRoutes };
