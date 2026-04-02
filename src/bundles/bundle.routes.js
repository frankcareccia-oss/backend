// src/bundles/bundle.routes.js
//
// HTTP layer only — parse params, call service, map to response.
// All business logic lives in bundle.service.js → bundle.engine.js / bundle.normalizer.js.
//
// Merchant routes:  requireJwt + requireMerchantRole(owner, merchant_admin)
// Admin routes:     requireJwt + requireAdmin

const express = require("express");
const { sendError, handlePrismaError } = require("../utils/errors");
const { parseIntParam } = require("../utils/helpers");
const { requireJwt, requireAdmin, requireMerchantRole } = require("../middleware/auth");
const { prisma } = require("../db/prisma");
const { draftBundleTerms } = require("../utils/aiDraft");
const service = require("./bundle.service");

const router = express.Router();

// Maps a service result to an HTTP error response.
// Returns true if an error was sent (caller should return immediately).
function handleResult(res, result) {
  if (result.notFound)     return sendError(res, 404, "NOT_FOUND",      "Bundle not found") || true;
  if (result.invalidState) return sendError(res, 409, "INVALID_STATE",  result.invalidState) || true;
  if (result.errors)       return sendError(res, 400, "VALIDATION_ERROR", result.errors.join("; ")) || true;
  return false;
}

// ══════════════════════════════════════════════════════════════
//  MERCHANT ROUTES
// ══════════════════════════════════════════════════════════════

// GET /merchant/bundles[?status=wip|staged|live|suspended|archived]
router.get(
  "/merchant/bundles",
  requireJwt,
  requireMerchantRole("owner", "merchant_admin"),
  async (req, res) => {
    try {
      const result = await service.listBundles(req.merchantId, req.query);
      return res.json(result);
    } catch (err) { return handlePrismaError(err, res); }
  }
);

// GET /merchant/bundles/:bundleId/audit
router.get(
  "/merchant/bundles/:bundleId/audit",
  requireJwt,
  requireMerchantRole("owner", "merchant_admin"),
  async (req, res) => {
    try {
      const bundleId = parseIntParam(req.params.bundleId);
      if (!bundleId) return sendError(res, 400, "VALIDATION_ERROR", "Invalid bundleId");
      const result = await service.getAuditLog(req.merchantId, bundleId);
      if (handleResult(res, result)) return;
      return res.json(result);
    } catch (err) { return handlePrismaError(err, res); }
  }
);

// POST /merchant/bundles
router.post(
  "/merchant/bundles",
  requireJwt,
  requireMerchantRole("owner", "merchant_admin"),
  async (req, res) => {
    try {
      const result = await service.createBundle(req.merchantId, req.body, req.userId, req.merchantRole);
      if (handleResult(res, result)) return;
      return res.status(201).json(result);
    } catch (err) { return handlePrismaError(err, res); }
  }
);

// PATCH /merchant/bundles/:bundleId
router.patch(
  "/merchant/bundles/:bundleId",
  requireJwt,
  requireMerchantRole("owner", "merchant_admin"),
  async (req, res) => {
    try {
      const bundleId = parseIntParam(req.params.bundleId);
      if (!bundleId) return sendError(res, 400, "VALIDATION_ERROR", "Invalid bundleId");
      const result = await service.updateBundle(req.merchantId, bundleId, req.body, req.userId, req.merchantRole);
      if (handleResult(res, result)) return;
      return res.json(result);
    } catch (err) { return handlePrismaError(err, res); }
  }
);

// DELETE /merchant/bundles/:bundleId — WIP only
router.delete(
  "/merchant/bundles/:bundleId",
  requireJwt,
  requireMerchantRole("owner", "merchant_admin"),
  async (req, res) => {
    try {
      const bundleId = parseIntParam(req.params.bundleId);
      if (!bundleId) return sendError(res, 400, "VALIDATION_ERROR", "Invalid bundleId");
      const result = await service.deleteBundle(req.merchantId, bundleId, req.userId, req.merchantRole);
      if (handleResult(res, result)) return;
      return res.json(result);
    } catch (err) { return handlePrismaError(err, res); }
  }
);

// POST /merchant/bundles/:bundleId/duplicate — archived only; creates new WIP clone
router.post(
  "/merchant/bundles/:bundleId/duplicate",
  requireJwt,
  requireMerchantRole("owner", "merchant_admin"),
  async (req, res) => {
    try {
      const bundleId = parseIntParam(req.params.bundleId);
      if (!bundleId) return sendError(res, 400, "VALIDATION_ERROR", "Invalid bundleId");
      const result = await service.duplicateBundle(req.merchantId, bundleId, req.userId, req.merchantRole);
      if (handleResult(res, result)) return;
      return res.status(201).json(result);
    } catch (err) { return handlePrismaError(err, res); }
  }
);

// POST /merchant/bundles/generate-terms
// Calls Claude to draft T&C text based on bundle parameters.
// Merchant reviews and edits before saving with the bundle.
router.post(
  "/merchant/bundles/generate-terms",
  requireJwt,
  requireMerchantRole("owner", "merchant_admin"),
  async (req, res) => {
    try {
      const { name, price, componentsDesc, startAt, endAt } = req.body || {};
      if (!name) return sendError(res, 400, "VALIDATION_ERROR", "name is required");

      const merchant = await prisma.merchant.findUnique({
        where: { id: req.merchantId },
        select: { name: true },
      });

      const draft = await draftBundleTerms({
        merchantName: merchant?.name || null,
        name, price, componentsDesc, startAt, endAt,
      });

      return res.json({ draft });
    } catch (err) {
      if (err.code === "AI_UNAVAILABLE") return sendError(res, 503, "AI_UNAVAILABLE", err.message);
      console.error("[bundle generate-terms]", err?.message || err);
      return sendError(res, 500, "AI_ERROR", "Failed to generate terms draft");
    }
  }
);

// ══════════════════════════════════════════════════════════════
//  ADMIN ROUTES
// ══════════════════════════════════════════════════════════════

// POST /admin/merchants/:merchantId/bundles/generate-terms
router.post(
  "/admin/merchants/:merchantId/bundles/generate-terms",
  requireJwt,
  requireAdmin,
  async (req, res) => {
    try {
      const merchantId = parseIntParam(req.params.merchantId);
      if (!merchantId) return sendError(res, 400, "VALIDATION_ERROR", "Invalid merchantId");
      const { name, price, componentsDesc, startAt, endAt } = req.body || {};
      if (!name) return sendError(res, 400, "VALIDATION_ERROR", "name is required");

      const merchant = await prisma.merchant.findUnique({
        where: { id: merchantId },
        select: { name: true },
      });

      const draft = await draftBundleTerms({
        merchantName: merchant?.name || null,
        name, price, componentsDesc, startAt, endAt,
      });

      return res.json({ draft });
    } catch (err) {
      if (err.code === "AI_UNAVAILABLE") return sendError(res, 503, "AI_UNAVAILABLE", err.message);
      console.error("[admin bundle generate-terms]", err?.message || err);
      return sendError(res, 500, "AI_ERROR", "Failed to generate terms draft");
    }
  }
);

// GET /admin/merchants/:merchantId/bundles[?status=...]
router.get(
  "/admin/merchants/:merchantId/bundles",
  requireJwt,
  requireAdmin,
  async (req, res) => {
    try {
      const merchantId = parseIntParam(req.params.merchantId);
      if (!merchantId) return sendError(res, 400, "VALIDATION_ERROR", "Invalid merchantId");
      const result = await service.listBundles(merchantId, req.query);
      return res.json(result);
    } catch (err) { return handlePrismaError(err, res); }
  }
);

// GET /admin/merchants/:merchantId/bundles/:bundleId/audit
router.get(
  "/admin/merchants/:merchantId/bundles/:bundleId/audit",
  requireJwt,
  requireAdmin,
  async (req, res) => {
    try {
      const merchantId = parseIntParam(req.params.merchantId);
      const bundleId   = parseIntParam(req.params.bundleId);
      if (!merchantId || !bundleId) return sendError(res, 400, "VALIDATION_ERROR", "Invalid params");
      const result = await service.getAuditLog(merchantId, bundleId);
      if (handleResult(res, result)) return;
      return res.json(result);
    } catch (err) { return handlePrismaError(err, res); }
  }
);

// POST /admin/merchants/:merchantId/bundles
router.post(
  "/admin/merchants/:merchantId/bundles",
  requireJwt,
  requireAdmin,
  async (req, res) => {
    try {
      const merchantId = parseIntParam(req.params.merchantId);
      if (!merchantId) return sendError(res, 400, "VALIDATION_ERROR", "Invalid merchantId");
      const result = await service.createBundle(merchantId, req.body, req.userId, "pv_admin");
      if (handleResult(res, result)) return;
      return res.status(201).json(result);
    } catch (err) { return handlePrismaError(err, res); }
  }
);

// PATCH /admin/merchants/:merchantId/bundles/:bundleId
router.patch(
  "/admin/merchants/:merchantId/bundles/:bundleId",
  requireJwt,
  requireAdmin,
  async (req, res) => {
    try {
      const merchantId = parseIntParam(req.params.merchantId);
      const bundleId   = parseIntParam(req.params.bundleId);
      if (!merchantId || !bundleId) return sendError(res, 400, "VALIDATION_ERROR", "Invalid params");
      const result = await service.updateBundle(merchantId, bundleId, req.body, req.userId, "pv_admin");
      if (handleResult(res, result)) return;
      return res.json(result);
    } catch (err) { return handlePrismaError(err, res); }
  }
);

// DELETE /admin/merchants/:merchantId/bundles/:bundleId
router.delete(
  "/admin/merchants/:merchantId/bundles/:bundleId",
  requireJwt,
  requireAdmin,
  async (req, res) => {
    try {
      const merchantId = parseIntParam(req.params.merchantId);
      const bundleId   = parseIntParam(req.params.bundleId);
      if (!merchantId || !bundleId) return sendError(res, 400, "VALIDATION_ERROR", "Invalid params");
      const result = await service.deleteBundle(merchantId, bundleId, req.userId, "pv_admin");
      if (handleResult(res, result)) return;
      return res.json(result);
    } catch (err) { return handlePrismaError(err, res); }
  }
);

// POST /admin/merchants/:merchantId/bundles/:bundleId/duplicate
router.post(
  "/admin/merchants/:merchantId/bundles/:bundleId/duplicate",
  requireJwt,
  requireAdmin,
  async (req, res) => {
    try {
      const merchantId = parseIntParam(req.params.merchantId);
      const bundleId   = parseIntParam(req.params.bundleId);
      if (!merchantId || !bundleId) return sendError(res, 400, "VALIDATION_ERROR", "Invalid params");
      const result = await service.duplicateBundle(merchantId, bundleId, req.userId, "pv_admin");
      if (handleResult(res, result)) return;
      return res.status(201).json(result);
    } catch (err) { return handlePrismaError(err, res); }
  }
);

module.exports = router;
