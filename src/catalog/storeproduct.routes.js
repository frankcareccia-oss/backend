// src/catalog/storeproduct.routes.js
//
// Store Product Overrides — v1 spec
// Controls which products are enabled at each store.
// No row = product available at all stores (opt-in disable).
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

// ── Helper: verify store belongs to merchant ───────────────────
async function verifyStoreMerchant(storeId, merchantId) {
  return prisma.store.findFirst({ where: { id: storeId, merchantId } });
}

// ── Helper: get all products for a merchant with their enabled
//    state for a specific store. No StoreProduct row = enabled. ─
async function getStoreProductList(merchantId, storeId) {
  const [products, overrides] = await Promise.all([
    prisma.product.findMany({
      where: { merchantId, status: "active" },
      include: { category: true },
      orderBy: { name: "asc" },
    }),
    prisma.storeProduct.findMany({
      where: { storeId },
      select: { productId: true, enabled: true },
    }),
  ]);

  const overrideMap = {};
  for (const o of overrides) overrideMap[o.productId] = o.enabled;

  return products.map(p => ({
    ...p,
    enabledAtStore: overrideMap[p.id] !== undefined ? overrideMap[p.id] : true,
  }));
}

// ══════════════════════════════════════════════════════════════
//  MERCHANT ROUTES
// ══════════════════════════════════════════════════════════════

// GET /merchant/stores/:storeId/products
// Returns all org products with enabled/disabled state for this store
router.get(
  "/merchant/stores/:storeId/products",
  requireJwt,
  requireMerchantRole("owner", "merchant_admin"),
  async (req, res) => {
    try {
      const storeId = parseIntParam(req.params.storeId);
      if (!storeId) return sendError(res, 400, "VALIDATION_ERROR", "Invalid storeId");

      const store = await verifyStoreMerchant(storeId, req.merchantId);
      if (!store) return sendError(res, 404, "NOT_FOUND", "Store not found");

      const products = await getStoreProductList(req.merchantId, storeId);

      emitPvHook("catalog.storeproduct.list", {
        tc: "TC-SPROD-LIST-01", sev: "info", stable: "catalog:storeproduct:list",
        merchantId: req.merchantId, storeId, count: products.length,
        actorUserId: req.userId, actorRole: req.merchantRole,
      });

      return res.json({ products });
    } catch (err) {
      return handlePrismaError(err, res);
    }
  }
);

// PATCH /merchant/stores/:storeId/products/:productId
// Set enabled=true|false for one product at this store
router.patch(
  "/merchant/stores/:storeId/products/:productId",
  requireJwt,
  requireMerchantRole("owner", "merchant_admin"),
  async (req, res) => {
    try {
      const storeId   = parseIntParam(req.params.storeId);
      const productId = parseIntParam(req.params.productId);
      if (!storeId || !productId)
        return sendError(res, 400, "VALIDATION_ERROR", "Invalid storeId or productId");

      const { enabled } = req.body || {};
      if (typeof enabled !== "boolean")
        return sendError(res, 400, "VALIDATION_ERROR", "enabled must be true or false");

      const store = await verifyStoreMerchant(storeId, req.merchantId);
      if (!store) return sendError(res, 404, "NOT_FOUND", "Store not found");

      const product = await prisma.product.findFirst({
        where: { id: productId, merchantId: req.merchantId },
      });
      if (!product) return sendError(res, 404, "NOT_FOUND", "Product not found");

      const override = await prisma.storeProduct.upsert({
        where: { storeId_productId: { storeId, productId } },
        create: { storeId, productId, enabled },
        update: { enabled },
      });

      emitPvHook("catalog.storeproduct.updated", {
        tc: "TC-SPROD-UPDATE-01", sev: "info", stable: "catalog:storeproduct:updated",
        merchantId: req.merchantId, storeId, productId, enabled,
        actorUserId: req.userId, actorRole: req.merchantRole,
      });

      return res.json({ storeProduct: { ...override, enabledAtStore: override.enabled } });
    } catch (err) {
      return handlePrismaError(err, res);
    }
  }
);

// ══════════════════════════════════════════════════════════════
//  ADMIN ROUTES
// ══════════════════════════════════════════════════════════════

// GET /admin/merchants/:merchantId/stores/:storeId/products
router.get(
  "/admin/merchants/:merchantId/stores/:storeId/products",
  requireJwt,
  requireAdmin,
  async (req, res) => {
    try {
      const merchantId = parseIntParam(req.params.merchantId);
      const storeId    = parseIntParam(req.params.storeId);
      if (!merchantId || !storeId)
        return sendError(res, 400, "VALIDATION_ERROR", "Invalid merchantId or storeId");

      const store = await verifyStoreMerchant(storeId, merchantId);
      if (!store) return sendError(res, 404, "NOT_FOUND", "Store not found");

      const products = await getStoreProductList(merchantId, storeId);

      emitPvHook("catalog.storeproduct.admin.list", {
        tc: "TC-SPROD-ADMIN-LIST-01", sev: "info", stable: "catalog:storeproduct:admin:list",
        merchantId, storeId, count: products.length, actorUserId: req.userId,
      });

      return res.json({ products });
    } catch (err) {
      return handlePrismaError(err, res);
    }
  }
);

// PATCH /admin/merchants/:merchantId/stores/:storeId/products/:productId
router.patch(
  "/admin/merchants/:merchantId/stores/:storeId/products/:productId",
  requireJwt,
  requireAdmin,
  async (req, res) => {
    try {
      const merchantId = parseIntParam(req.params.merchantId);
      const storeId    = parseIntParam(req.params.storeId);
      const productId  = parseIntParam(req.params.productId);
      if (!merchantId || !storeId || !productId)
        return sendError(res, 400, "VALIDATION_ERROR", "Invalid params");

      const { enabled } = req.body || {};
      if (typeof enabled !== "boolean")
        return sendError(res, 400, "VALIDATION_ERROR", "enabled must be true or false");

      const store = await verifyStoreMerchant(storeId, merchantId);
      if (!store) return sendError(res, 404, "NOT_FOUND", "Store not found");

      const product = await prisma.product.findFirst({ where: { id: productId, merchantId } });
      if (!product) return sendError(res, 404, "NOT_FOUND", "Product not found");

      const override = await prisma.storeProduct.upsert({
        where: { storeId_productId: { storeId, productId } },
        create: { storeId, productId, enabled },
        update: { enabled },
      });

      emitPvHook("catalog.storeproduct.admin.updated", {
        tc: "TC-SPROD-ADMIN-UPDATE-01", sev: "info", stable: "catalog:storeproduct:admin:updated",
        merchantId, storeId, productId, enabled, actorUserId: req.userId,
      });

      return res.json({ storeProduct: { ...override, enabledAtStore: override.enabled } });
    } catch (err) {
      return handlePrismaError(err, res);
    }
  }
);

module.exports = router;
