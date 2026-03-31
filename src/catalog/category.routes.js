// src/catalog/category.routes.js
//
// Product Category CRUD — v3.5 model
// Merchant routes:  requireJwt + requireMerchantRole(owner, merchant_admin)
// Admin routes:     requireJwt + requireAdmin

const express = require("express");
const { prisma } = require("../db/prisma");
const { sendError, handlePrismaError } = require("../utils/errors");
const { parseIntParam } = require("../utils/helpers");
const { requireJwt, requireAdmin, requireMerchantRole } = require("../middleware/auth");
const { emitPvHook } = require("../utils/hooks");

const router = express.Router();

// ══════════════════════════════════════════════════════════════
//  MERCHANT ROUTES
// ══════════════════════════════════════════════════════════════

// GET /merchant/categories
router.get(
  "/merchant/categories",
  requireJwt,
  requireMerchantRole("owner", "merchant_admin"),
  async (req, res) => {
    try {
      const { status } = req.query;
      const where = { merchantId: req.merchantId };
      if (status === "active" || status === "inactive") where.status = status;

      const categories = await prisma.productCategory.findMany({
        where,
        orderBy: { name: "asc" },
        include: { _count: { select: { products: true } } },
      });

      emitPvHook("catalog.category.list", {
        tc: "TC-CAT-CAT-LIST-01", sev: "info", stable: "catalog:category:list",
        merchantId: req.merchantId, actorUserId: req.userId, actorRole: req.merchantRole,
        count: categories.length, statusFilter: status || "all",
      });

      return res.json({ categories });
    } catch (err) {
      return handlePrismaError(err, res);
    }
  }
);

// POST /merchant/categories
router.post(
  "/merchant/categories",
  requireJwt,
  requireMerchantRole("owner", "merchant_admin"),
  async (req, res) => {
    try {
      const { name } = req.body || {};
      if (!name || !String(name).trim())
        return sendError(res, 400, "VALIDATION_ERROR", "name is required");

      const trimmed = String(name).trim();

      // Reject duplicate names within this merchant
      const existing = await prisma.productCategory.findFirst({
        where: { merchantId: req.merchantId, name: trimmed },
      });
      if (existing)
        return sendError(res, 409, "DUPLICATE", `A category named "${trimmed}" already exists`);

      const category = await prisma.productCategory.create({
        data: { merchantId: req.merchantId, name: trimmed },
        include: { _count: { select: { products: true } } },
      });

      emitPvHook("catalog.category.created", {
        tc: "TC-CAT-CAT-CREATE-01", sev: "info", stable: "catalog:category:created",
        merchantId: req.merchantId, categoryId: category.id, categoryName: category.name,
        actorUserId: req.userId, actorRole: req.merchantRole,
      });

      return res.status(201).json({ category });
    } catch (err) {
      return handlePrismaError(err, res);
    }
  }
);

// PATCH /merchant/categories/:categoryId
router.patch(
  "/merchant/categories/:categoryId",
  requireJwt,
  requireMerchantRole("owner", "merchant_admin"),
  async (req, res) => {
    try {
      const categoryId = parseIntParam(req.params.categoryId);
      if (!categoryId) return sendError(res, 400, "VALIDATION_ERROR", "Invalid categoryId");

      const existing = await prisma.productCategory.findFirst({
        where: { id: categoryId, merchantId: req.merchantId },
      });
      if (!existing) return sendError(res, 404, "NOT_FOUND", "Category not found");
      if (existing.status === "inactive")
        return sendError(res, 409, "INACTIVE", "Cannot update an inactive category");

      const { name, status } = req.body || {};
      const data = {};

      if (name !== undefined) {
        const trimmed = String(name).trim();
        if (!trimmed) return sendError(res, 400, "VALIDATION_ERROR", "name cannot be empty");
        // Check for duplicate name (excluding self)
        const dup = await prisma.productCategory.findFirst({
          where: { merchantId: req.merchantId, name: trimmed, id: { not: categoryId } },
        });
        if (dup) return sendError(res, 409, "DUPLICATE", `A category named "${trimmed}" already exists`);
        data.name = trimmed;
      }
      if (status !== undefined) {
        if (status !== "active" && status !== "inactive")
          return sendError(res, 400, "VALIDATION_ERROR", "status must be active or inactive");
        data.status = status;
      }

      if (!Object.keys(data).length)
        return sendError(res, 400, "VALIDATION_ERROR", "No updatable fields provided");

      const category = await prisma.productCategory.update({
        where: { id: categoryId },
        data,
        include: { _count: { select: { products: true } } },
      });

      emitPvHook("catalog.category.updated", {
        tc: "TC-CAT-CAT-UPDATE-01", sev: "info", stable: "catalog:category:updated",
        merchantId: req.merchantId, categoryId: category.id, categoryName: category.name,
        changedFields: Object.keys(data), actorUserId: req.userId, actorRole: req.merchantRole,
      });

      return res.json({ category });
    } catch (err) {
      return handlePrismaError(err, res);
    }
  }
);

// DELETE /merchant/categories/:categoryId  (deactivate — soft delete)
router.delete(
  "/merchant/categories/:categoryId",
  requireJwt,
  requireMerchantRole("owner", "merchant_admin"),
  async (req, res) => {
    try {
      const categoryId = parseIntParam(req.params.categoryId);
      if (!categoryId) return sendError(res, 400, "VALIDATION_ERROR", "Invalid categoryId");

      const existing = await prisma.productCategory.findFirst({
        where: { id: categoryId, merchantId: req.merchantId },
        include: { _count: { select: { products: true } } },
      });
      if (!existing) return sendError(res, 404, "NOT_FOUND", "Category not found");
      if (existing.status === "inactive")
        return sendError(res, 409, "ALREADY_INACTIVE", "Category is already inactive");

      // Warn if products are still assigned — allow but note it
      const category = await prisma.productCategory.update({
        where: { id: categoryId },
        data: { status: "inactive" },
        include: { _count: { select: { products: true } } },
      });

      emitPvHook("catalog.category.deactivated", {
        tc: "TC-CAT-CAT-DEACTIVATE-01", sev: "info", stable: "catalog:category:deactivated",
        merchantId: req.merchantId, categoryId: category.id, categoryName: category.name,
        productCount: existing._count.products,
        actorUserId: req.userId, actorRole: req.merchantRole,
      });

      return res.json({ category });
    } catch (err) {
      return handlePrismaError(err, res);
    }
  }
);

// ══════════════════════════════════════════════════════════════
//  ADMIN ROUTES
// ══════════════════════════════════════════════════════════════

// GET /admin/merchants/:merchantId/categories
router.get(
  "/admin/merchants/:merchantId/categories",
  requireJwt,
  requireAdmin,
  async (req, res) => {
    try {
      const merchantId = parseIntParam(req.params.merchantId);
      if (!merchantId) return sendError(res, 400, "VALIDATION_ERROR", "Invalid merchantId");

      const { status } = req.query;
      const where = { merchantId };
      if (status === "active" || status === "inactive") where.status = status;

      const categories = await prisma.productCategory.findMany({
        where,
        orderBy: { name: "asc" },
        include: { _count: { select: { products: true } } },
      });

      emitPvHook("catalog.category.admin.list", {
        tc: "TC-CAT-CAT-ADMIN-LIST-01", sev: "info", stable: "catalog:category:admin:list",
        merchantId, actorUserId: req.userId, count: categories.length,
      });

      return res.json({ categories });
    } catch (err) {
      return handlePrismaError(err, res);
    }
  }
);

// POST /admin/merchants/:merchantId/categories
router.post(
  "/admin/merchants/:merchantId/categories",
  requireJwt,
  requireAdmin,
  async (req, res) => {
    try {
      const merchantId = parseIntParam(req.params.merchantId);
      if (!merchantId) return sendError(res, 400, "VALIDATION_ERROR", "Invalid merchantId");

      const { name } = req.body || {};
      if (!name || !String(name).trim())
        return sendError(res, 400, "VALIDATION_ERROR", "name is required");

      const trimmed = String(name).trim();
      const dup = await prisma.productCategory.findFirst({
        where: { merchantId, name: trimmed },
      });
      if (dup)
        return sendError(res, 409, "DUPLICATE", `A category named "${trimmed}" already exists`);

      const category = await prisma.productCategory.create({
        data: { merchantId, name: trimmed },
        include: { _count: { select: { products: true } } },
      });

      emitPvHook("catalog.category.admin.created", {
        tc: "TC-CAT-CAT-ADMIN-CREATE-01", sev: "info", stable: "catalog:category:admin:created",
        merchantId, categoryId: category.id, actorUserId: req.userId,
      });

      return res.status(201).json({ category });
    } catch (err) {
      return handlePrismaError(err, res);
    }
  }
);

// PATCH /admin/merchants/:merchantId/categories/:categoryId
router.patch(
  "/admin/merchants/:merchantId/categories/:categoryId",
  requireJwt,
  requireAdmin,
  async (req, res) => {
    try {
      const merchantId = parseIntParam(req.params.merchantId);
      const categoryId = parseIntParam(req.params.categoryId);
      if (!merchantId || !categoryId)
        return sendError(res, 400, "VALIDATION_ERROR", "Invalid merchantId or categoryId");

      const existing = await prisma.productCategory.findFirst({
        where: { id: categoryId, merchantId },
      });
      if (!existing) return sendError(res, 404, "NOT_FOUND", "Category not found");

      const { name, status } = req.body || {};
      const data = {};

      if (name !== undefined) {
        const trimmed = String(name).trim();
        if (!trimmed) return sendError(res, 400, "VALIDATION_ERROR", "name cannot be empty");
        const dup = await prisma.productCategory.findFirst({
          where: { merchantId, name: trimmed, id: { not: categoryId } },
        });
        if (dup) return sendError(res, 409, "DUPLICATE", `A category named "${trimmed}" already exists`);
        data.name = trimmed;
      }
      if (status !== undefined) {
        if (status !== "active" && status !== "inactive")
          return sendError(res, 400, "VALIDATION_ERROR", "status must be active or inactive");
        data.status = status;
      }

      if (!Object.keys(data).length)
        return sendError(res, 400, "VALIDATION_ERROR", "No updatable fields provided");

      const category = await prisma.productCategory.update({
        where: { id: categoryId },
        data,
        include: { _count: { select: { products: true } } },
      });

      emitPvHook("catalog.category.admin.updated", {
        tc: "TC-CAT-CAT-ADMIN-UPDATE-01", sev: "info", stable: "catalog:category:admin:updated",
        merchantId, categoryId: category.id, changedFields: Object.keys(data), actorUserId: req.userId,
      });

      return res.json({ category });
    } catch (err) {
      return handlePrismaError(err, res);
    }
  }
);

module.exports = router;
