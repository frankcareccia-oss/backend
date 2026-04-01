// src/consumers/consumers.routes.js
// POST /consumers/lookup  — phone → consumer or not-found
// POST /consumers         — create consumer + merchant/store links

const express = require("express");
const { lookupByPhone, createConsumer } = require("./consumers.service");

function registerConsumersRoutes(app, { prisma, sendError, requireJwt, emitPvHook }) {
  if (!app) throw new Error("registerConsumersRoutes: app required");
  if (!prisma) throw new Error("registerConsumersRoutes: prisma required");
  if (typeof sendError !== "function") throw new Error("registerConsumersRoutes: sendError required");
  if (typeof requireJwt !== "function") throw new Error("registerConsumersRoutes: requireJwt required");

  const router = express.Router();

  // ── POST /consumers/lookup ────────────────────────────────────────────────
  // Body: { phone }
  // Returns: { found: true, consumer: {...} } | { found: false }
  router.post("/consumers/lookup", requireJwt, async (req, res) => {
    emitPvHook("consumer.lookup.requested.api", {
      tc: "TC-CONS-01",
      sev: "info",
      stable: "consumer:lookup",
    });

    const { phone } = req.body || {};
    if (!phone) return sendError(res, 400, "VALIDATION_ERROR", "phone is required");

    try {
      const result = await lookupByPhone(prisma, phone);

      if (result.error === "invalid_phone") {
        return sendError(res, 400, "VALIDATION_ERROR", "Invalid phone number");
      }

      if (!result.found) {
        emitPvHook("consumer.lookup.not_found.api", {
          tc: "TC-CONS-02",
          sev: "info",
          stable: "consumer:lookup",
        });
        return res.json({ found: false });
      }

      emitPvHook("consumer.lookup.found.api", {
        tc: "TC-CONS-03",
        sev: "info",
        stable: "consumer:lookup",
        consumerId: result.consumer.id,
      });

      return res.json({ found: true, consumer: result.consumer });
    } catch (e) {
      emitPvHook("consumer.lookup.failed.api", {
        tc: "TC-CONS-04",
        sev: "error",
        stable: "consumer:lookup:error",
        error: e?.message || String(e),
      });
      return sendError(res, 500, "SERVER_ERROR", "Consumer lookup failed");
    }
  });

  // ── POST /consumers ───────────────────────────────────────────────────────
  // Body: { phone, firstName, lastName, email?, merchantId, storeId? }
  // Returns: { consumer: {...}, created: bool }
  router.post("/consumers", requireJwt, async (req, res) => {
    emitPvHook("consumer.create.requested.api", {
      tc: "TC-CONS-05",
      sev: "info",
      stable: "consumer:create",
    });

    const { phone, firstName, lastName, email, merchantId, storeId } = req.body || {};

    if (!phone) return sendError(res, 400, "VALIDATION_ERROR", "phone is required");
    if (!firstName || !String(firstName).trim()) return sendError(res, 400, "VALIDATION_ERROR", "firstName is required");
    if (!lastName || !String(lastName).trim()) return sendError(res, 400, "VALIDATION_ERROR", "lastName is required");
    if (!merchantId) return sendError(res, 400, "VALIDATION_ERROR", "merchantId is required");

    try {
      const result = await createConsumer(prisma, {
        phone,
        firstName,
        lastName,
        email,
        merchantId: Number(merchantId),
        storeId: storeId ? Number(storeId) : null,
      });

      if (result.error === "invalid_phone") {
        return sendError(res, 400, "VALIDATION_ERROR", "Invalid phone number");
      }

      emitPvHook("consumer.create.succeeded.api", {
        tc: "TC-CONS-06",
        sev: "info",
        stable: "consumer:create",
        consumerId: result.consumer.id,
        created: result.created,
      });

      return res.status(result.created ? 201 : 200).json({
        consumer: result.consumer,
        created: result.created,
      });
    } catch (e) {
      emitPvHook("consumer.create.failed.api", {
        tc: "TC-CONS-07",
        sev: "error",
        stable: "consumer:create:error",
        error: e?.message || String(e),
      });
      return sendError(res, 500, "SERVER_ERROR", "Consumer creation failed");
    }
  });

  app.use(router);
  return { router };
}

module.exports = { registerConsumersRoutes };
