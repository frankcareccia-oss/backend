// src/catalog/catalog.routes.js
const express = require("express");
const { prisma } = require("../db/prisma");
const { sendError, handlePrismaError } = require("../utils/errors");
const { parseIntParam } = require("../utils/helpers");
const { requireJwt, requireAdmin, requireMerchantRole } = require("../middleware/auth");
const { emitPvHook } = require("../utils/hooks");
const { generateSku } = require("./catalog.service");
const { draftProductInfo, draftProductDescription } = require("../utils/aiDraft");
const { pushProductToPos, pushCategoryToPos } = require("../pos/pos.catalog.push");

const router = express.Router();

/* ---------------------------------------------------------------
   Image URL validation — rejects data: URIs and enforces https/http.
   Returns an error string, or null if valid (or empty).
---------------------------------------------------------------- */
function validateImageUrl(raw) {
  if (!raw) return null;
  const url = String(raw).trim();
  if (!url) return null;
  if (url.startsWith("data:")) return "Image URL must be a hosted URL (https://…), not a base64 data URI. Please upload the image to an image host first.";
  if (!/^https?:\/\//i.test(url)) return "Image URL must start with https:// or http://";
  if (url.length > 2048) return "Image URL is too long (max 2048 characters)";
  return null;
}

/* ---------------------------------------------------------------
   Product status lifecycle: draft → active → inactive
   draft:    being configured; not visible to earn engine or consumers
   active:   live; qualifies for earn rules
   inactive: deactivated; reactivatable
---------------------------------------------------------------- */
const VALID_PRODUCT_TRANSITIONS = {
  draft:    ["active"],
  active:   ["inactive"],
  inactive: ["active"],
};

/* ---------------------------------------------------------------
   Resolve merchantId from JWT merchant membership.
   Caller must already have requireJwt + requireMerchantRole run.
---------------------------------------------------------------- */

// GET /merchant/products — list products for caller's merchant
router.get(
  "/merchant/products",
  requireJwt,
  requireMerchantRole("owner", "merchant_admin"),
  async (req, res) => {
    try {
      const { status } = req.query;
      const where = { merchantId: req.merchantId };
      if (status === "draft" || status === "active" || status === "inactive") where.status = status;

      const products = await prisma.product.findMany({
        where,
        orderBy: { id: "asc" },
        include: { category: true },
      });

      emitPvHook("catalog.product.list", {
        tc: "TC-CAT-PROD-LIST-01",
        sev: "info",
        stable: "catalog:product:list",
        merchantId: req.merchantId,
        actorUserId: req.userId,
        actorRole: req.merchantRole,
        count: products.length,
        statusFilter: status || "all",
      });

      return res.json({ items: products });
    } catch (err) {
      return handlePrismaError(err, res);
    }
  }
);

// POST /merchant/products — create product
router.post(
  "/merchant/products",
  requireJwt,
  requireMerchantRole("owner", "merchant_admin"),
  async (req, res) => {
    try {
      const { name, description, complianceText, sku: skuInput, imageUrl, categoryId: categoryIdRaw, startAt, endAt } = req.body || {};

      if (!name || !String(name).trim()) {
        return sendError(res, 400, "VALIDATION_ERROR", "name is required");
      }
      const imageUrlErr = validateImageUrl(imageUrl);
      if (imageUrlErr) return sendError(res, 400, "VALIDATION_ERROR", imageUrlErr);

      const skuProvided = skuInput && String(skuInput).trim();
      const sku = skuProvided || (await generateSku(req.merchantId));

      // Verify sku uniqueness within this merchant
      const existing = await prisma.product.findFirst({
        where: { merchantId: req.merchantId, sku },
      });
      if (existing) {
        return sendError(res, 409, "UNIQUE_VIOLATION", `SKU "${sku}" already exists for this merchant`);
      }

      // Validate categoryId if provided
      let categoryId = null;
      if (categoryIdRaw != null) {
        categoryId = parseInt(categoryIdRaw, 10);
        if (!categoryId) return sendError(res, 400, "VALIDATION_ERROR", "Invalid categoryId");
        const cat = await prisma.productCategory.findFirst({
          where: { id: categoryId, merchantId: req.merchantId, status: "active" },
        });
        if (!cat) return sendError(res, 422, "INVALID_CATEGORY", "Category not found or inactive");
      }

      const product = await prisma.product.create({
        data: {
          merchantId: req.merchantId,
          name: String(name).trim(),
          description: description ? String(description).trim() : null,
          complianceText: complianceText ? String(complianceText).trim() : null,
          imageUrl: imageUrl ? String(imageUrl).trim() : null,
          sku,
          status: "draft",
          categoryId,
          startAt: startAt ? new Date(startAt) : null,
          endAt: endAt ? new Date(endAt) : null,
        },
        include: { category: true },
      });

      emitPvHook("catalog.product.created", {
        tc: "TC-CAT-PROD-CREATE-01",
        sev: "info",
        stable: "catalog:product:created",
        merchantId: req.merchantId,
        productId: product.id,
        productName: product.name,
        sku: product.sku,
        skuAutoGenerated: !skuProvided,
        actorUserId: req.userId,
        actorRole: req.merchantRole,
      });

      // Push to POS catalog (fire-and-forget)
      pushProductToPos(prisma, { merchantId: req.merchantId, product });

      return res.status(201).json({ product });
    } catch (err) {
      return handlePrismaError(err, res);
    }
  }
);

// PATCH /merchant/products/:productId — update name/description/status
router.patch(
  "/merchant/products/:productId",
  requireJwt,
  requireMerchantRole("owner", "merchant_admin"),
  async (req, res) => {
    try {
      const productId = parseIntParam(req.params.productId);
      if (!productId) return sendError(res, 400, "VALIDATION_ERROR", "Invalid productId");

      const existing = await prisma.product.findFirst({
        where: { id: productId, merchantId: req.merchantId },
      });
      if (!existing) return sendError(res, 404, "NOT_FOUND", "Product not found");

      const { name, description, complianceText, imageUrl, categoryId: categoryIdRaw, startAt, endAt, timeframeDays } = req.body || {};
      const data = {};

      if (name !== undefined) {
        if (!String(name).trim()) return sendError(res, 400, "VALIDATION_ERROR", "name cannot be empty");
        data.name = String(name).trim();
      }
      if (description !== undefined) data.description = description ? String(description).trim() : null;
      if (complianceText !== undefined) data.complianceText = complianceText ? String(complianceText).trim() : null;
      if (imageUrl !== undefined) {
        const imageUrlErr = validateImageUrl(imageUrl);
        if (imageUrlErr) return sendError(res, 400, "VALIDATION_ERROR", imageUrlErr);
        data.imageUrl = imageUrl ? String(imageUrl).trim() : null;
      }
      if (categoryIdRaw !== undefined) {
        if (categoryIdRaw === null) {
          data.categoryId = null;
        } else {
          const catId = parseInt(categoryIdRaw, 10);
          if (!catId) return sendError(res, 400, "VALIDATION_ERROR", "Invalid categoryId");
          const cat = await prisma.productCategory.findFirst({
            where: { id: catId, merchantId: req.merchantId, status: "active" },
          });
          if (!cat) return sendError(res, 422, "INVALID_CATEGORY", "Category not found or inactive");
          data.categoryId = catId;
        }
      }
      if (startAt !== undefined) data.startAt = startAt ? new Date(startAt) : null;
      if (endAt !== undefined) data.endAt = endAt ? new Date(endAt) : null;
      if (timeframeDays !== undefined) data.timeframeDays = timeframeDays ? parseInt(timeframeDays, 10) : null;

      if (!Object.keys(data).length) {
        return sendError(res, 400, "VALIDATION_ERROR", "No updatable fields provided");
      }

      const product = await prisma.product.update({
        where: { id: productId },
        data,
        include: { category: true },
      });

      emitPvHook("catalog.product.updated", {
        tc: "TC-CAT-PROD-UPDATE-01",
        sev: "info",
        stable: "catalog:product:updated",
        merchantId: req.merchantId,
        productId: product.id,
        productName: product.name,
        sku: product.sku,
        changedFields: Object.keys(data),
        actorUserId: req.userId,
        actorRole: req.merchantRole,
      });

      // Push to POS catalog (fire-and-forget)
      pushProductToPos(prisma, { merchantId: req.merchantId, product });

      return res.json({ product });
    } catch (err) {
      return handlePrismaError(err, res);
    }
  }
);

// DELETE /merchant/products/:productId — soft delete (status=inactive)
router.delete(
  "/merchant/products/:productId",
  requireJwt,
  requireMerchantRole("owner", "merchant_admin"),
  async (req, res) => {
    try {
      const productId = parseIntParam(req.params.productId);
      if (!productId) return sendError(res, 400, "VALIDATION_ERROR", "Invalid productId");

      const existing = await prisma.product.findFirst({
        where: { id: productId, merchantId: req.merchantId },
      });
      if (!existing) return sendError(res, 404, "NOT_FOUND", "Product not found");

      const deactivateAllowed = VALID_PRODUCT_TRANSITIONS[existing.status] || [];
      if (!deactivateAllowed.includes("inactive"))
        return sendError(res, 409, "INVALID_STATE", `Cannot deactivate a product with status "${existing.status}"`);

      const product = await prisma.product.update({
        where: { id: productId },
        data: { status: "inactive" },
      });

      emitPvHook("catalog.product.deactivated", {
        tc: "TC-CAT-PROD-DEACTIVATE-01",
        sev: "info",
        stable: "catalog:product:deactivated",
        merchantId: req.merchantId,
        productId: product.id,
        productName: product.name,
        sku: product.sku,
        actorUserId: req.userId,
        actorRole: req.merchantRole,
      });

      return res.json({ product });
    } catch (err) {
      return handlePrismaError(err, res);
    }
  }
);

// POST /merchant/products/:productId/reactivate — restore inactive product
router.post(
  "/merchant/products/:productId/reactivate",
  requireJwt,
  requireMerchantRole("owner", "merchant_admin"),
  async (req, res) => {
    try {
      const productId = parseIntParam(req.params.productId);
      if (!productId) return sendError(res, 400, "VALIDATION_ERROR", "Invalid productId");

      const existing = await prisma.product.findFirst({
        where: { id: productId, merchantId: req.merchantId },
      });
      if (!existing) return sendError(res, 404, "NOT_FOUND", "Product not found");

      const reactivateAllowed = VALID_PRODUCT_TRANSITIONS[existing.status] || [];
      if (!reactivateAllowed.includes("active"))
        return sendError(res, 409, "INVALID_STATE", `Cannot reactivate a product with status "${existing.status}"`);

      const product = await prisma.product.update({
        where: { id: productId },
        data: { status: "active", firstActivatedAt: existing.firstActivatedAt ?? new Date() },
      });

      emitPvHook("catalog.product.reactivated", {
        tc: "TC-CAT-PROD-REACTIVATE-01",
        sev: "info",
        stable: "catalog:product:reactivated",
        merchantId: req.merchantId,
        productId: product.id,
        productName: product.name,
        sku: product.sku,
        actorUserId: req.userId,
        actorRole: req.merchantRole,
      });

      return res.json({ product });
    } catch (err) {
      return handlePrismaError(err, res);
    }
  }
);

// POST /merchant/products/:productId/activate — draft → active
router.post(
  "/merchant/products/:productId/activate",
  requireJwt,
  requireMerchantRole("owner", "merchant_admin"),
  async (req, res) => {
    try {
      const productId = parseIntParam(req.params.productId);
      if (!productId) return sendError(res, 400, "VALIDATION_ERROR", "Invalid productId");

      const existing = await prisma.product.findFirst({
        where: { id: productId, merchantId: req.merchantId },
      });
      if (!existing) return sendError(res, 404, "NOT_FOUND", "Product not found");
      if (existing.status !== "draft")
        return sendError(res, 409, "INVALID_STATE", `Only draft products can be activated (current: ${existing.status})`);

      const product = await prisma.product.update({
        where: { id: productId },
        data: { status: "active", firstActivatedAt: existing.firstActivatedAt ?? new Date() },
        include: { category: true },
      });

      emitPvHook("catalog.product.activated", {
        tc: "TC-CAT-PROD-ACTIVATE-01", sev: "info", stable: "catalog:product:activated",
        merchantId: req.merchantId, productId: product.id, productName: product.name, sku: product.sku,
        actorUserId: req.userId, actorRole: req.merchantRole,
      });

      return res.json({ product });
    } catch (err) {
      return handlePrismaError(err, res);
    }
  }
);

// POST /merchant/products/generate-info
// Calls Claude to draft a compliance blurb for a product.
// Merchant reviews and edits before saving.
router.post(
  "/merchant/products/generate-info",
  requireJwt,
  requireMerchantRole("owner", "merchant_admin"),
  async (req, res) => {
    try {
      const { productName, categoryName, description, allergens, dietaryFlags } = req.body || {};
      if (!productName) return sendError(res, 400, "VALIDATION_ERROR", "productName is required");

      const merchant = await prisma.merchant.findUnique({
        where: { id: req.merchantId },
        select: { name: true },
      });

      const draft = await draftProductInfo({
        merchantName: merchant?.name || null,
        productName, categoryName, description,
        allergens: Array.isArray(allergens) ? allergens : [],
        dietaryFlags: Array.isArray(dietaryFlags) ? dietaryFlags : [],
      });

      return res.json({ draft });
    } catch (err) {
      if (err.code === "AI_UNAVAILABLE") return sendError(res, 503, "AI_UNAVAILABLE", err.message);
      console.error("[product generate-info]", err?.message || err);
      return sendError(res, 500, "AI_ERROR", "Failed to generate product info draft");
    }
  }
);

// POST /merchant/products/generate-description
// Generates an enticing consumer-facing description (2-3 sentences).
router.post(
  "/merchant/products/generate-description",
  requireJwt,
  requireMerchantRole("owner", "merchant_admin"),
  async (req, res) => {
    try {
      const { productName, categoryName } = req.body || {};
      if (!productName) return sendError(res, 400, "VALIDATION_ERROR", "productName is required");

      const merchant = await prisma.merchant.findUnique({
        where: { id: req.merchantId },
        select: { name: true },
      });

      const draft = await draftProductDescription({
        merchantName: merchant?.name || null,
        productName,
        categoryName,
      });

      return res.json({ draft });
    } catch (err) {
      if (err.code === "AI_UNAVAILABLE") return sendError(res, 503, "AI_UNAVAILABLE", err.message);
      console.error("[product generate-description]", err?.message || err);
      return sendError(res, 500, "AI_ERROR", "Failed to generate product description");
    }
  }
);

// GET /admin/merchants/:merchantId/products — pv_admin oversight
router.get(
  "/admin/merchants/:merchantId/products",
  requireJwt,
  async (req, res) => {
    if (req.systemRole !== "pv_admin") {
      return sendError(res, 403, "FORBIDDEN", "Admin access required");
    }

    const merchantId = parseIntParam(req.params.merchantId);
    if (!merchantId) return sendError(res, 400, "VALIDATION_ERROR", "Invalid merchantId");

    try {
      const { status } = req.query;
      const where = { merchantId };
      if (status === "draft" || status === "active" || status === "inactive") where.status = status;

      const products = await prisma.product.findMany({
        where,
        orderBy: { id: "asc" },
        include: { category: true },
      });

      return res.json({ items: products });
    } catch (err) {
      return handlePrismaError(err, res);
    }
  }
);

// ─── Admin CRUD endpoints ────────────────────────────────────────────────────

// POST /admin/merchants/:merchantId/products — admin create product
router.post(
  "/admin/merchants/:merchantId/products",
  requireJwt,
  requireAdmin,
  async (req, res) => {
    const merchantId = parseIntParam(req.params.merchantId);
    if (!merchantId) return sendError(res, 400, "VALIDATION_ERROR", "Invalid merchantId");

    try {
      const { name, description, complianceText, sku: skuInput, imageUrl, categoryId: categoryIdRaw, startAt, endAt } = req.body || {};
      if (!name || !String(name).trim()) {
        return sendError(res, 400, "VALIDATION_ERROR", "name is required");
      }
      const imageUrlErr = validateImageUrl(imageUrl);
      if (imageUrlErr) return sendError(res, 400, "VALIDATION_ERROR", imageUrlErr);

      const skuProvided = skuInput && String(skuInput).trim();
      const sku = skuProvided || (await generateSku(merchantId));

      const existing = await prisma.product.findFirst({ where: { merchantId, sku } });
      if (existing) {
        return sendError(res, 409, "UNIQUE_VIOLATION", `SKU "${sku}" already exists for this merchant`);
      }

      let categoryId = null;
      if (categoryIdRaw != null) {
        categoryId = parseInt(categoryIdRaw, 10);
        if (!categoryId) return sendError(res, 400, "VALIDATION_ERROR", "Invalid categoryId");
        const cat = await prisma.productCategory.findFirst({ where: { id: categoryId, merchantId } });
        if (!cat) return sendError(res, 422, "INVALID_CATEGORY", "Category not found");
      }

      const product = await prisma.product.create({
        data: {
          merchantId,
          name: String(name).trim(),
          description: description ? String(description).trim() : null,
          complianceText: complianceText ? String(complianceText).trim() : null,
          imageUrl: imageUrl ? String(imageUrl).trim() : null,
          sku,
          status: "draft",
          categoryId,
          startAt: startAt ? new Date(startAt) : null,
          endAt: endAt ? new Date(endAt) : null,
        },
        include: { category: true },
      });

      emitPvHook("catalog.product.created", {
        tc: "TC-CAT-PROD-CREATE-ADMIN-01",
        sev: "info",
        stable: "catalog:product:created",
        merchantId,
        productId: product.id,
        productName: product.name,
        sku: product.sku,
        skuAutoGenerated: !skuProvided,
        actorUserId: req.userId,
        actorRole: "pv_admin",
      });

      return res.status(201).json({ product });
    } catch (err) {
      return handlePrismaError(err, res);
    }
  }
);

// PATCH /admin/merchants/:merchantId/products/:productId — admin update
router.patch(
  "/admin/merchants/:merchantId/products/:productId",
  requireJwt,
  requireAdmin,
  async (req, res) => {
    const merchantId = parseIntParam(req.params.merchantId);
    if (!merchantId) return sendError(res, 400, "VALIDATION_ERROR", "Invalid merchantId");

    const productId = parseIntParam(req.params.productId);
    if (!productId) return sendError(res, 400, "VALIDATION_ERROR", "Invalid productId");

    try {
      const existing = await prisma.product.findFirst({ where: { id: productId, merchantId } });
      if (!existing) return sendError(res, 404, "NOT_FOUND", "Product not found");

      const { name, description, complianceText, imageUrl, categoryId: categoryIdRaw, startAt, endAt, timeframeDays } = req.body || {};
      const data = {};
      if (name !== undefined) {
        if (!String(name).trim()) return sendError(res, 400, "VALIDATION_ERROR", "name cannot be empty");
        data.name = String(name).trim();
      }
      if (description !== undefined) data.description = description ? String(description).trim() : null;
      if (complianceText !== undefined) data.complianceText = complianceText ? String(complianceText).trim() : null;
      if (imageUrl !== undefined) {
        const imageUrlErr = validateImageUrl(imageUrl);
        if (imageUrlErr) return sendError(res, 400, "VALIDATION_ERROR", imageUrlErr);
        data.imageUrl = imageUrl ? String(imageUrl).trim() : null;
      }
      if (categoryIdRaw !== undefined) {
        if (categoryIdRaw === null) {
          data.categoryId = null;
        } else {
          const catId = parseInt(categoryIdRaw, 10);
          if (!catId) return sendError(res, 400, "VALIDATION_ERROR", "Invalid categoryId");
          const cat = await prisma.productCategory.findFirst({ where: { id: catId, merchantId } });
          if (!cat) return sendError(res, 422, "INVALID_CATEGORY", "Category not found");
          data.categoryId = catId;
        }
      }
      if (startAt !== undefined) data.startAt = startAt ? new Date(startAt) : null;
      if (endAt !== undefined) data.endAt = endAt ? new Date(endAt) : null;
      if (timeframeDays !== undefined) data.timeframeDays = timeframeDays ? parseInt(timeframeDays, 10) : null;
      if (!Object.keys(data).length) {
        return sendError(res, 400, "VALIDATION_ERROR", "No updatable fields provided");
      }

      const product = await prisma.product.update({ where: { id: productId }, data, include: { category: true } });

      emitPvHook("catalog.product.updated", {
        tc: "TC-CAT-PROD-UPDATE-ADMIN-01",
        sev: "info",
        stable: "catalog:product:updated",
        merchantId,
        productId: product.id,
        productName: product.name,
        sku: product.sku,
        changedFields: Object.keys(data),
        actorUserId: req.userId,
        actorRole: "pv_admin",
      });

      return res.json({ product });
    } catch (err) {
      return handlePrismaError(err, res);
    }
  }
);

// DELETE /admin/merchants/:merchantId/products/:productId — admin soft delete
router.delete(
  "/admin/merchants/:merchantId/products/:productId",
  requireJwt,
  requireAdmin,
  async (req, res) => {
    const merchantId = parseIntParam(req.params.merchantId);
    if (!merchantId) return sendError(res, 400, "VALIDATION_ERROR", "Invalid merchantId");

    const productId = parseIntParam(req.params.productId);
    if (!productId) return sendError(res, 400, "VALIDATION_ERROR", "Invalid productId");

    try {
      const existing = await prisma.product.findFirst({ where: { id: productId, merchantId } });
      if (!existing) return sendError(res, 404, "NOT_FOUND", "Product not found");
      const adminDeactivateAllowed = VALID_PRODUCT_TRANSITIONS[existing.status] || [];
      if (!adminDeactivateAllowed.includes("inactive"))
        return sendError(res, 409, "INVALID_STATE", `Cannot deactivate a product with status "${existing.status}"`);

      const product = await prisma.product.update({
        where: { id: productId },
        data: { status: "inactive" },
      });

      emitPvHook("catalog.product.deactivated", {
        tc: "TC-CAT-PROD-DEACTIVATE-ADMIN-01",
        sev: "info",
        stable: "catalog:product:deactivated",
        merchantId,
        productId: product.id,
        productName: product.name,
        sku: product.sku,
        actorUserId: req.userId,
        actorRole: "pv_admin",
      });

      return res.json({ product });
    } catch (err) {
      return handlePrismaError(err, res);
    }
  }
);

// POST /admin/merchants/:merchantId/products/:productId/reactivate — admin reactivate
router.post(
  "/admin/merchants/:merchantId/products/:productId/reactivate",
  requireJwt,
  requireAdmin,
  async (req, res) => {
    const merchantId = parseIntParam(req.params.merchantId);
    if (!merchantId) return sendError(res, 400, "VALIDATION_ERROR", "Invalid merchantId");

    const productId = parseIntParam(req.params.productId);
    if (!productId) return sendError(res, 400, "VALIDATION_ERROR", "Invalid productId");

    try {
      const existing = await prisma.product.findFirst({ where: { id: productId, merchantId } });
      if (!existing) return sendError(res, 404, "NOT_FOUND", "Product not found");
      const adminReactivateAllowed = VALID_PRODUCT_TRANSITIONS[existing.status] || [];
      if (!adminReactivateAllowed.includes("active"))
        return sendError(res, 409, "INVALID_STATE", `Cannot reactivate a product with status "${existing.status}"`);

      const product = await prisma.product.update({
        where: { id: productId },
        data: { status: "active", firstActivatedAt: existing.firstActivatedAt ?? new Date() },
      });

      emitPvHook("catalog.product.reactivated", {
        tc: "TC-CAT-PROD-REACTIVATE-ADMIN-01",
        sev: "info",
        stable: "catalog:product:reactivated",
        merchantId,
        productId: product.id,
        productName: product.name,
        sku: product.sku,
        actorUserId: req.userId,
        actorRole: "pv_admin",
      });

      return res.json({ product });
    } catch (err) {
      return handlePrismaError(err, res);
    }
  }
);

// POST /admin/merchants/:merchantId/products/:productId/activate — admin draft → active
router.post(
  "/admin/merchants/:merchantId/products/:productId/activate",
  requireJwt,
  requireAdmin,
  async (req, res) => {
    const merchantId = parseIntParam(req.params.merchantId);
    const productId  = parseIntParam(req.params.productId);
    if (!merchantId || !productId) return sendError(res, 400, "VALIDATION_ERROR", "Invalid params");
    try {
      const existing = await prisma.product.findFirst({ where: { id: productId, merchantId } });
      if (!existing) return sendError(res, 404, "NOT_FOUND", "Product not found");
      if (existing.status !== "draft")
        return sendError(res, 409, "INVALID_STATE", `Only draft products can be activated (current: ${existing.status})`);

      const product = await prisma.product.update({
        where: { id: productId },
        data: { status: "active", firstActivatedAt: existing.firstActivatedAt ?? new Date() },
        include: { category: true },
      });

      emitPvHook("catalog.product.activated", {
        tc: "TC-CAT-PROD-ACTIVATE-ADMIN-01", sev: "info", stable: "catalog:product:activated",
        merchantId, productId: product.id, productName: product.name, sku: product.sku,
        actorUserId: req.userId, actorRole: "pv_admin",
      });

      return res.json({ product });
    } catch (err) {
      return handlePrismaError(err, res);
    }
  }
);

// POST /admin/merchants/:merchantId/products/generate-info
router.post(
  "/admin/merchants/:merchantId/products/generate-info",
  requireJwt,
  requireAdmin,
  async (req, res) => {
    try {
      const merchantId = parseIntParam(req.params.merchantId);
      if (!merchantId) return sendError(res, 400, "VALIDATION_ERROR", "Invalid merchantId");
      const { productName, categoryName, description, allergens, dietaryFlags } = req.body || {};
      if (!productName) return sendError(res, 400, "VALIDATION_ERROR", "productName is required");

      const merchant = await prisma.merchant.findUnique({
        where: { id: merchantId },
        select: { name: true },
      });

      const draft = await draftProductInfo({
        merchantName: merchant?.name || null,
        productName, categoryName, description,
        allergens: Array.isArray(allergens) ? allergens : [],
        dietaryFlags: Array.isArray(dietaryFlags) ? dietaryFlags : [],
      });

      return res.json({ draft });
    } catch (err) {
      if (err.code === "AI_UNAVAILABLE") return sendError(res, 503, "AI_UNAVAILABLE", err.message);
      console.error("[admin product generate-info]", err?.message || err);
      return sendError(res, 500, "AI_ERROR", "Failed to generate product info draft");
    }
  }
);

// POST /admin/merchants/:merchantId/products/generate-description
router.post(
  "/admin/merchants/:merchantId/products/generate-description",
  requireJwt,
  requireAdmin,
  async (req, res) => {
    try {
      const merchantId = parseIntParam(req.params.merchantId);
      if (!merchantId) return sendError(res, 400, "VALIDATION_ERROR", "Invalid merchantId");
      const { productName, categoryName } = req.body || {};
      if (!productName) return sendError(res, 400, "VALIDATION_ERROR", "productName is required");

      const merchant = await prisma.merchant.findUnique({
        where: { id: merchantId },
        select: { name: true },
      });

      const draft = await draftProductDescription({
        merchantName: merchant?.name || null,
        productName,
        categoryName,
      });

      return res.json({ draft });
    } catch (err) {
      if (err.code === "AI_UNAVAILABLE") return sendError(res, 503, "AI_UNAVAILABLE", err.message);
      console.error("[admin product generate-description]", err?.message || err);
      return sendError(res, 500, "AI_ERROR", "Failed to generate product description");
    }
  }
);

module.exports = router;
