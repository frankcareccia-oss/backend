// src/bundles/bundle.routes.js
//
// Bundle (Prepaid Credit) management — v1 Phase A (lifecycle v2)
//
// Status lifecycle: wip → staged → live → suspended → archived
//   staged can revert to wip; suspended can resume to live; archived can revert to wip.
// Quantity: editable only in wip or staged.
// Category: immutable always.
// Audit: every change written to BundleAuditLog (never deleted).
//
// Merchant routes:  requireJwt + requireMerchantRole(owner, merchant_admin)
// Admin routes:     requireJwt + requireAdmin

const express = require("express");
const { prisma } = require("../db/prisma");
const { sendError, handlePrismaError } = require("../utils/errors");
const { parseIntParam } = require("../utils/helpers");
const { requireJwt, requireAdmin, requireMerchantRole } = require("../middleware/auth");
const { emitPvHook } = require("../utils/hooks");

const router = express.Router();

// ── Constants ──────────────────────────────────────────────────

// States where quantity may still be edited
const MUTABLE_QTY_STATES = ["wip", "staged"];

// Valid status transitions (from → allowed tos)
// wip/staged are deleted (not archived) to remove them.
// Archived bundles do not transition — they are cloned via /duplicate.
const VALID_TRANSITIONS = {
  wip:       ["staged"],
  staged:    ["wip", "live"],
  live:      ["suspended", "archived"],
  suspended: ["live", "archived"],
  archived:  [],
};

// ── Helpers ────────────────────────────────────────────────────

function formatBundle(b) {
  return {
    ...b,
    price: b.price !== undefined && b.price !== null ? Number(b.price) : null,
  };
}

async function verifyCategoryMerchant(categoryId, merchantId) {
  return prisma.productCategory.findFirst({
    where: { id: categoryId, merchantId, status: "active" },
  });
}

async function logBundleAudit(bundleId, actorUserId, action, changes) {
  try {
    await prisma.bundleAuditLog.create({
      data: { bundleId, actorUserId: actorUserId || null, action, changes: changes || null },
    });
  } catch (e) {
    // Audit log failure must never break the main operation
    console.error("[bundle.audit] Failed to write audit log:", e?.message);
  }
}

function buildBundlePatch(body, existing) {
  const { name, price, quantity, startAt, endAt, status } = body || {};
  const errors = [];
  const data = {};
  const auditChanges = [];

  if (name !== undefined) {
    if (!String(name).trim()) { errors.push("name cannot be empty"); }
    else if (name !== existing.name) {
      data.name = String(name).trim();
      auditChanges.push({ field: "name", from: existing.name, to: data.name });
    }
  }

  if (price !== undefined) {
    if (isNaN(Number(price)) || Number(price) < 0) {
      errors.push("price must be a non-negative number");
    } else {
      const newPrice = Number(price);
      if (newPrice !== Number(existing.price)) {
        data.price = newPrice;
        auditChanges.push({ field: "price", from: Number(existing.price), to: newPrice });
      }
    }
  }

  if (quantity !== undefined) {
    if (!MUTABLE_QTY_STATES.includes(existing.status)) {
      errors.push(`quantity cannot be changed once a bundle is ${existing.status}`);
    } else {
      const qty = parseInt(quantity, 10);
      if (!Number.isInteger(qty) || qty < 1) {
        errors.push("quantity must be a positive integer");
      } else if (qty !== existing.quantity) {
        data.quantity = qty;
        auditChanges.push({ field: "quantity", from: existing.quantity, to: qty });
      }
    }
  }

  if (startAt !== undefined) {
    const newVal = startAt ? new Date(startAt) : null;
    if (startAt && (isNaN(newVal.getTime()) || newVal.getFullYear() < 2000 || newVal.getFullYear() > 2099)) {
      errors.push("Start Date must be a valid date between 2000 and 2099 (e.g. 2026-06-01)");
    } else {
      data.startAt = newVal;
      auditChanges.push({ field: "startAt", from: existing.startAt, to: newVal });
    }
  }

  if (endAt !== undefined) {
    const newVal = endAt ? new Date(endAt) : null;
    if (endAt && (isNaN(newVal.getTime()) || newVal.getFullYear() < 2000 || newVal.getFullYear() > 2099)) {
      errors.push("End Date must be a valid date between 2000 and 2099 (e.g. 2026-12-31)");
    } else {
      data.endAt = newVal;
      auditChanges.push({ field: "endAt", from: existing.endAt, to: newVal });
    }
  }

  // Cross-field: end date must not precede start date
  if (!errors.length) {
    const effectiveStart = data.startAt !== undefined ? data.startAt : existing.startAt;
    const effectiveEnd   = data.endAt   !== undefined ? data.endAt   : existing.endAt;
    if (effectiveStart && effectiveEnd && effectiveEnd < effectiveStart) {
      errors.push("End Date cannot be before Start Date");
    }
  }

  if (status !== undefined && status !== existing.status) {
    const allowed = VALID_TRANSITIONS[existing.status] || [];
    if (!allowed.includes(status)) {
      errors.push(`Cannot transition from ${existing.status} to ${status}`);
    } else {
      // staged requires startAt
      if (status === "staged" && !data.startAt && !existing.startAt) {
        errors.push("Start Date is required before staging a bundle");
      } else {
        data.status = status;
        auditChanges.push({ field: "status", from: existing.status, to: status });
      }
    }
  }

  return { data, auditChanges, errors };
}

const BUNDLE_INCLUDE = { category: true };

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
      const { status } = req.query;
      const VALID_STATUSES = ["wip", "staged", "live", "suspended", "archived"];
      const where = { merchantId: req.merchantId };
      if (status && VALID_STATUSES.includes(status)) where.status = status;

      const bundles = await prisma.bundle.findMany({
        where,
        include: BUNDLE_INCLUDE,
        orderBy: { createdAt: "desc" },
      });

      emitPvHook("catalog.bundle.list", {
        tc: "TC-BUNDLE-LIST-01", sev: "info", stable: "catalog:bundle:list",
        merchantId: req.merchantId, count: bundles.length,
        actorUserId: req.userId, actorRole: req.merchantRole,
      });

      return res.json({ bundles: bundles.map(formatBundle) });
    } catch (err) {
      return handlePrismaError(err, res);
    }
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

      const bundle = await prisma.bundle.findFirst({ where: { id: bundleId, merchantId: req.merchantId } });
      if (!bundle) return sendError(res, 404, "NOT_FOUND", "Bundle not found");

      const logs = await prisma.bundleAuditLog.findMany({
        where: { bundleId },
        orderBy: { createdAt: "desc" },
      });

      return res.json({ logs });
    } catch (err) {
      return handlePrismaError(err, res);
    }
  }
);

// POST /merchant/bundles
router.post(
  "/merchant/bundles",
  requireJwt,
  requireMerchantRole("owner", "merchant_admin"),
  async (req, res) => {
    try {
      const { name, categoryId, quantity, price, startAt, endAt } = req.body || {};

      if (!name || !String(name).trim())
        return sendError(res, 400, "VALIDATION_ERROR", "name is required");
      if (!categoryId || !Number.isInteger(Number(categoryId)))
        return sendError(res, 400, "VALIDATION_ERROR", "categoryId is required");
      if (!quantity || !Number.isInteger(Number(quantity)) || Number(quantity) < 1)
        return sendError(res, 400, "VALIDATION_ERROR", "quantity must be a positive integer");
      if (price === undefined || price === null || isNaN(Number(price)) || Number(price) < 0)
        return sendError(res, 400, "VALIDATION_ERROR", "price must be a non-negative number");

      const catId = parseInt(categoryId, 10);
      const cat = await verifyCategoryMerchant(catId, req.merchantId);
      if (!cat) return sendError(res, 404, "NOT_FOUND", "Category not found or inactive");

      const parsedStartAt = startAt ? new Date(startAt) : null;
      const parsedEndAt   = endAt   ? new Date(endAt)   : null;
      if (parsedStartAt && (isNaN(parsedStartAt.getTime()) || parsedStartAt.getFullYear() < 2000 || parsedStartAt.getFullYear() > 2099))
        return sendError(res, 400, "VALIDATION_ERROR", "Start Date must be a valid date between 2000 and 2099");
      if (parsedEndAt && (isNaN(parsedEndAt.getTime()) || parsedEndAt.getFullYear() < 2000 || parsedEndAt.getFullYear() > 2099))
        return sendError(res, 400, "VALIDATION_ERROR", "End Date must be a valid date between 2000 and 2099");
      if (parsedStartAt && parsedEndAt && parsedEndAt < parsedStartAt)
        return sendError(res, 400, "VALIDATION_ERROR", "End Date cannot be before Start Date");

      const bundle = await prisma.bundle.create({
        data: {
          merchantId: req.merchantId,
          categoryId: catId,
          name: String(name).trim(),
          quantity: parseInt(quantity, 10),
          price: Number(price),
          startAt: parsedStartAt,
          endAt: parsedEndAt,
          status: "wip",
        },
        include: BUNDLE_INCLUDE,
      });

      await logBundleAudit(bundle.id, req.userId, "created", {
        name: bundle.name, categoryId: catId, quantity: bundle.quantity,
        price: Number(bundle.price), startAt, endAt, status: "wip",
      });

      emitPvHook("catalog.bundle.created", {
        tc: "TC-BUNDLE-CREATE-01", sev: "info", stable: "catalog:bundle:created",
        merchantId: req.merchantId, bundleId: bundle.id,
        actorUserId: req.userId, actorRole: req.merchantRole,
      });

      return res.status(201).json({ bundle: formatBundle(bundle) });
    } catch (err) {
      return handlePrismaError(err, res);
    }
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

      const existing = await prisma.bundle.findFirst({
        where: { id: bundleId, merchantId: req.merchantId },
      });
      if (!existing) return sendError(res, 404, "NOT_FOUND", "Bundle not found");

      const { data, auditChanges, errors } = buildBundlePatch(req.body, existing);
      if (errors.length) return sendError(res, 400, "VALIDATION_ERROR", errors.join("; "));
      if (Object.keys(data).length === 0) {
        return res.json({ bundle: formatBundle(existing) });
      }

      const bundle = await prisma.bundle.update({
        where: { id: bundleId },
        data,
        include: BUNDLE_INCLUDE,
      });

      await logBundleAudit(bundleId, req.userId, "updated", auditChanges);

      emitPvHook("catalog.bundle.updated", {
        tc: "TC-BUNDLE-UPDATE-01", sev: "info", stable: "catalog:bundle:updated",
        merchantId: req.merchantId, bundleId, changes: auditChanges.map(c => c.field),
        actorUserId: req.userId, actorRole: req.merchantRole,
      });

      return res.json({ bundle: formatBundle(bundle) });
    } catch (err) {
      return handlePrismaError(err, res);
    }
  }
);

// DELETE /merchant/bundles/:bundleId — wip or staged only
router.delete(
  "/merchant/bundles/:bundleId",
  requireJwt,
  requireMerchantRole("owner", "merchant_admin"),
  async (req, res) => {
    try {
      const bundleId = parseIntParam(req.params.bundleId);
      if (!bundleId) return sendError(res, 400, "VALIDATION_ERROR", "Invalid bundleId");

      const existing = await prisma.bundle.findFirst({
        where: { id: bundleId, merchantId: req.merchantId },
      });
      if (!existing) return sendError(res, 404, "NOT_FOUND", "Bundle not found");
      if (!["wip", "staged"].includes(existing.status))
        return sendError(res, 409, "INVALID_STATE", `Only WIP or Staged bundles can be deleted (current: ${existing.status})`);

      await prisma.bundleAuditLog.deleteMany({ where: { bundleId } });
      await prisma.bundle.delete({ where: { id: bundleId } });

      emitPvHook("catalog.bundle.deleted", {
        tc: "TC-BUNDLE-DELETE-01", sev: "info", stable: "catalog:bundle:deleted",
        merchantId: req.merchantId, bundleId,
        actorUserId: req.userId, actorRole: req.merchantRole,
      });

      return res.json({ ok: true });
    } catch (err) {
      return handlePrismaError(err, res);
    }
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

      const existing = await prisma.bundle.findFirst({
        where: { id: bundleId, merchantId: req.merchantId },
        include: { category: true },
      });
      if (!existing) return sendError(res, 404, "NOT_FOUND", "Bundle not found");
      if (existing.status !== "archived")
        return sendError(res, 409, "INVALID_STATE", "Only archived bundles can be duplicated");

      const clone = await prisma.bundle.create({
        data: {
          merchantId: req.merchantId,
          categoryId: existing.categoryId,
          name: existing.name,
          quantity: existing.quantity,
          price: existing.price,
          startAt: null,
          endAt: null,
          status: "wip",
        },
        include: { category: true },
      });

      await logBundleAudit(clone.id, req.userId, "created", {
        duplicatedFromBundleId: bundleId, name: clone.name,
        categoryId: clone.categoryId, quantity: clone.quantity,
        price: Number(clone.price), status: "wip",
      });

      emitPvHook("catalog.bundle.duplicated", {
        tc: "TC-BUNDLE-DUP-01", sev: "info", stable: "catalog:bundle:duplicated",
        merchantId: req.merchantId, sourceBundleId: bundleId, newBundleId: clone.id,
        actorUserId: req.userId, actorRole: req.merchantRole,
      });

      return res.status(201).json({ bundle: formatBundle(clone) });
    } catch (err) {
      return handlePrismaError(err, res);
    }
  }
);

// ══════════════════════════════════════════════════════════════
//  ADMIN ROUTES
// ══════════════════════════════════════════════════════════════

// GET /admin/merchants/:merchantId/bundles[?status=...]
router.get(
  "/admin/merchants/:merchantId/bundles",
  requireJwt,
  requireAdmin,
  async (req, res) => {
    try {
      const merchantId = parseIntParam(req.params.merchantId);
      if (!merchantId) return sendError(res, 400, "VALIDATION_ERROR", "Invalid merchantId");

      const { status } = req.query;
      const VALID_STATUSES = ["wip", "staged", "live", "suspended", "archived"];
      const where = { merchantId };
      if (status && VALID_STATUSES.includes(status)) where.status = status;

      const bundles = await prisma.bundle.findMany({
        where,
        include: BUNDLE_INCLUDE,
        orderBy: { createdAt: "desc" },
      });

      emitPvHook("catalog.bundle.admin.list", {
        tc: "TC-BUNDLE-ADMIN-LIST-01", sev: "info", stable: "catalog:bundle:admin:list",
        merchantId, count: bundles.length, actorUserId: req.userId,
      });

      return res.json({ bundles: bundles.map(formatBundle) });
    } catch (err) {
      return handlePrismaError(err, res);
    }
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

      const bundle = await prisma.bundle.findFirst({ where: { id: bundleId, merchantId } });
      if (!bundle) return sendError(res, 404, "NOT_FOUND", "Bundle not found");

      const logs = await prisma.bundleAuditLog.findMany({
        where: { bundleId },
        orderBy: { createdAt: "desc" },
      });

      return res.json({ logs });
    } catch (err) {
      return handlePrismaError(err, res);
    }
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

      const { name, categoryId, quantity, price, startAt, endAt } = req.body || {};

      if (!name || !String(name).trim())
        return sendError(res, 400, "VALIDATION_ERROR", "name is required");
      if (!categoryId || !Number.isInteger(Number(categoryId)))
        return sendError(res, 400, "VALIDATION_ERROR", "categoryId is required");
      if (!quantity || !Number.isInteger(Number(quantity)) || Number(quantity) < 1)
        return sendError(res, 400, "VALIDATION_ERROR", "quantity must be a positive integer");
      if (price === undefined || price === null || isNaN(Number(price)) || Number(price) < 0)
        return sendError(res, 400, "VALIDATION_ERROR", "price must be a non-negative number");

      const catId = parseInt(categoryId, 10);
      const cat = await verifyCategoryMerchant(catId, merchantId);
      if (!cat) return sendError(res, 404, "NOT_FOUND", "Category not found or inactive");

      const parsedStartAt = startAt ? new Date(startAt) : null;
      const parsedEndAt   = endAt   ? new Date(endAt)   : null;
      if (parsedStartAt && (isNaN(parsedStartAt.getTime()) || parsedStartAt.getFullYear() < 2000 || parsedStartAt.getFullYear() > 2099))
        return sendError(res, 400, "VALIDATION_ERROR", "Start Date must be a valid date between 2000 and 2099");
      if (parsedEndAt && (isNaN(parsedEndAt.getTime()) || parsedEndAt.getFullYear() < 2000 || parsedEndAt.getFullYear() > 2099))
        return sendError(res, 400, "VALIDATION_ERROR", "End Date must be a valid date between 2000 and 2099");
      if (parsedStartAt && parsedEndAt && parsedEndAt < parsedStartAt)
        return sendError(res, 400, "VALIDATION_ERROR", "End Date cannot be before Start Date");

      const bundle = await prisma.bundle.create({
        data: {
          merchantId,
          categoryId: catId,
          name: String(name).trim(),
          quantity: parseInt(quantity, 10),
          price: Number(price),
          startAt: parsedStartAt,
          endAt: parsedEndAt,
          status: "wip",
        },
        include: BUNDLE_INCLUDE,
      });

      await logBundleAudit(bundle.id, req.userId, "created", {
        name: bundle.name, categoryId: catId, quantity: bundle.quantity,
        price: Number(bundle.price), startAt, endAt, status: "wip",
      });

      emitPvHook("catalog.bundle.admin.created", {
        tc: "TC-BUNDLE-ADMIN-CREATE-01", sev: "info", stable: "catalog:bundle:admin:created",
        merchantId, bundleId: bundle.id, actorUserId: req.userId,
      });

      return res.status(201).json({ bundle: formatBundle(bundle) });
    } catch (err) {
      return handlePrismaError(err, res);
    }
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
      if (!merchantId || !bundleId)
        return sendError(res, 400, "VALIDATION_ERROR", "Invalid params");

      const existing = await prisma.bundle.findFirst({ where: { id: bundleId, merchantId } });
      if (!existing) return sendError(res, 404, "NOT_FOUND", "Bundle not found");

      const { data, auditChanges, errors } = buildBundlePatch(req.body, existing);
      if (errors.length) return sendError(res, 400, "VALIDATION_ERROR", errors.join("; "));
      if (Object.keys(data).length === 0) {
        return res.json({ bundle: formatBundle(existing) });
      }

      const bundle = await prisma.bundle.update({
        where: { id: bundleId },
        data,
        include: BUNDLE_INCLUDE,
      });

      await logBundleAudit(bundleId, req.userId, "updated", auditChanges);

      emitPvHook("catalog.bundle.admin.updated", {
        tc: "TC-BUNDLE-ADMIN-UPDATE-01", sev: "info", stable: "catalog:bundle:admin:updated",
        merchantId, bundleId, changes: auditChanges.map(c => c.field), actorUserId: req.userId,
      });

      return res.json({ bundle: formatBundle(bundle) });
    } catch (err) {
      return handlePrismaError(err, res);
    }
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

      const existing = await prisma.bundle.findFirst({ where: { id: bundleId, merchantId } });
      if (!existing) return sendError(res, 404, "NOT_FOUND", "Bundle not found");
      if (!["wip", "staged"].includes(existing.status))
        return sendError(res, 409, "INVALID_STATE", `Only WIP or Staged bundles can be deleted (current: ${existing.status})`);

      await prisma.bundleAuditLog.deleteMany({ where: { bundleId } });
      await prisma.bundle.delete({ where: { id: bundleId } });

      emitPvHook("catalog.bundle.admin.deleted", {
        tc: "TC-BUNDLE-ADMIN-DELETE-01", sev: "info", stable: "catalog:bundle:admin:deleted",
        merchantId, bundleId, actorUserId: req.userId,
      });

      return res.json({ ok: true });
    } catch (err) {
      return handlePrismaError(err, res);
    }
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

      const existing = await prisma.bundle.findFirst({ where: { id: bundleId, merchantId } });
      if (!existing) return sendError(res, 404, "NOT_FOUND", "Bundle not found");
      if (existing.status !== "archived")
        return sendError(res, 409, "INVALID_STATE", "Only archived bundles can be duplicated");

      const clone = await prisma.bundle.create({
        data: {
          merchantId,
          categoryId: existing.categoryId,
          name: existing.name,
          quantity: existing.quantity,
          price: existing.price,
          startAt: null,
          endAt: null,
          status: "wip",
        },
        include: { category: true },
      });

      await logBundleAudit(clone.id, req.userId, "created", {
        duplicatedFromBundleId: bundleId, name: clone.name,
        categoryId: clone.categoryId, quantity: clone.quantity,
        price: Number(clone.price), status: "wip",
      });

      emitPvHook("catalog.bundle.admin.duplicated", {
        tc: "TC-BUNDLE-ADMIN-DUP-01", sev: "info", stable: "catalog:bundle:admin:duplicated",
        merchantId, sourceBundleId: bundleId, newBundleId: clone.id, actorUserId: req.userId,
      });

      return res.status(201).json({ bundle: formatBundle(clone) });
    } catch (err) {
      return handlePrismaError(err, res);
    }
  }
);

module.exports = router;
