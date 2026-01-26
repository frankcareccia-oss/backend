// backend/src/pos/pos.routes.js
const express = require("express");
const { requireFreshTimestamp } = require("./pos.replay");
const { requireIdempotency } = require("./pos.idempotency");
const { persistVisit, persistReward } = require("./pos.persist");
const { getVisitByPosVisitId, getRewardById } = require("./pos.read");

/**
 * POS routes (NO-MIGRATIONS MODE)
 *
 * Endpoints:
 * - POST /pos/visit
 * - POST /pos/reward
 * - GET  /pos/visit/:posVisitId         (POS-6)
 * - GET  /pos/reward/:rewardId          (POS-6)
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
 * POS-6 Hooks:
 * - pos.read.visit.requested.api / succeeded.api / not_found.api / failed.api
 * - pos.read.reward.requested.api / succeeded.api / not_found.api / failed.api
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

  // -----------------------------
  // POS-6: READ endpoints (GET)
  // -----------------------------

  router.get("/pos/visit/:posVisitId", requireAuth, async (req, res) => {
    const { posVisitId } = req.params;

    pvHook("pos.read.visit.requested.api", {
      tc: "TC-POS-READ-01",
      sev: "info",
      stable: "pos:read:visit",
      posVisitId: String(posVisitId),
    });

    try {
      const ctx = await requirePosContext(req, res);
      if (!ctx) return;

      const visit = await getVisitByPosVisitId(String(posVisitId), {
        pvHook,
      });

      if (!visit) {
        pvHook("pos.read.visit.not_found.api", {
          tc: "TC-POS-READ-02",
          sev: "info",
          stable: `store:${ctx.storeId}`,
          merchantId: ctx.merchantId,
          storeId: ctx.storeId,
          posVisitId: String(posVisitId),
        });
        return sendError(res, 404, "NOT_FOUND", "Visit not found");
      }

      // Enforce store scoping (POS associate must only see their own store)
      if (String(visit.storeId) !== String(ctx.storeId)) {
        pvHook("pos.read.visit.failed.api", {
          tc: "TC-POS-READ-03",
          sev: "warn",
          stable: "pos:read:visit:forbidden",
          reason: "store_scope_mismatch",
          posVisitId: String(posVisitId),
          storeId: ctx.storeId,
        });
        return sendError(res, 403, "FORBIDDEN", "Forbidden");
      }

      pvHook("pos.read.visit.succeeded.api", {
        tc: "TC-POS-READ-04",
        sev: "info",
        stable: `store:${ctx.storeId}`,
        merchantId: ctx.merchantId,
        storeId: ctx.storeId,
        posVisitId: String(posVisitId),
        visitPk: visit.id,
        identifierMasked: maskIdentifier(visit.posIdentifier),
      });

      // Return the record (internal use); still avoid extra computed leakage.
      return res.json({ ok: true, visit });
    } catch (e) {
      pvHook("pos.read.visit.failed.api", {
        tc: "TC-POS-READ-05",
        sev: "error",
        stable: "pos:read:visit:error",
        posVisitId: String(posVisitId),
        error: e?.message || String(e),
      });
      return sendError(res, 500, "SERVER_ERROR", "Error");
    }
  });

  router.get("/pos/reward/:rewardId", requireAuth, async (req, res) => {
    const { rewardId } = req.params;

    pvHook("pos.read.reward.requested.api", {
      tc: "TC-POS-READ-06",
      sev: "info",
      stable: "pos:read:reward",
      rewardId: String(rewardId),
    });

    try {
      const ctx = await requirePosContext(req, res);
      if (!ctx) return;

      const reward = await getRewardById(String(rewardId), { pvHook });

      if (!reward) {
        pvHook("pos.read.reward.not_found.api", {
          tc: "TC-POS-READ-07",
          sev: "info",
          stable: `store:${ctx.storeId}`,
          merchantId: ctx.merchantId,
          storeId: ctx.storeId,
          rewardId: String(rewardId),
        });
        return sendError(res, 404, "NOT_FOUND", "Reward not found");
      }

      // Enforce store scoping
      if (String(reward.storeId) !== String(ctx.storeId)) {
        pvHook("pos.read.reward.failed.api", {
          tc: "TC-POS-READ-08",
          sev: "warn",
          stable: "pos:read:reward:forbidden",
          reason: "store_scope_mismatch",
          rewardId: String(rewardId),
          storeId: ctx.storeId,
        });
        return sendError(res, 403, "FORBIDDEN", "Forbidden");
      }

      pvHook("pos.read.reward.succeeded.api", {
        tc: "TC-POS-READ-09",
        sev: "info",
        stable: `store:${ctx.storeId}`,
        merchantId: ctx.merchantId,
        storeId: ctx.storeId,
        rewardId: String(rewardId),
        posVisitId: reward.posVisitId || null,
        identifierMasked: maskIdentifier(reward.identifier),
      });

      return res.json({ ok: true, reward });
    } catch (e) {
      pvHook("pos.read.reward.failed.api", {
        tc: "TC-POS-READ-10",
        sev: "error",
        stable: "pos:read:reward:error",
        rewardId: String(rewardId),
        error: e?.message || String(e),
      });
      return sendError(res, 500, "SERVER_ERROR", "Error");
    }
  });

  // -----------------------------
  // Existing POS-4A/5A: WRITE endpoints (POST)
  // -----------------------------

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
