// src/promo/promo.routes.js
//
// Promotions & Loyalty domain — Thread E
//
// Merchant-facing CRUD for the 3-layer model:
//   PromoItem  →  Promotion  →  OfferSet
//
// Auth gates:
//   Merchant routes  — requireJwt + requireMerchantRole("owner","merchant_admin")
//   Admin oversight  — requireJwt + requireAdmin (pv_admin read-only for now)

const express = require("express");
const crypto = require("crypto");
const { prisma } = require("../db/prisma");
const { sendError, handlePrismaError } = require("../utils/errors");
const { parseIntParam } = require("../utils/helpers");
const { requireJwt, requireAdmin, requireMerchantRole } = require("../middleware/auth");
const { emitPvHook } = require("../utils/hooks");
const { draftPromoTerms, draftPromoDescription } = require("../utils/aiDraft");
const { capturePromotionBaseline } = require("../growth/promotionOutcome.baseline");

const router = express.Router();

// ── Helpers ────────────────────────────────────────────────────

const VALID_ITEM_TYPES    = ["visit", "any_purchase", "single_product", "product_bundle"];
const VALID_MECHANICS     = ["stamps", "points"];
const VALID_REWARD_TYPES  = ["free_item", "discount_pct", "discount_fixed", "custom"];
const VALID_PROMO_STATUSES = ["active", "paused", "archived"]; // PromoItem statuses
const VALID_PROMOTION_STATUSES = ["draft", "staged", "active", "paused", "archived"];
const VALID_PROMO_TRANSITIONS = {
  draft:    ["staged", "archived"],
  staged:   ["draft",  "active"],
  active:   ["paused", "archived"],
  paused:   ["active", "archived"],
  archived: [],
};
const VALID_OS_SCOPES     = ["merchant", "store"];
const VALID_OS_STATUSES   = ["draft", "active", "expired", "archived"];

async function logPromoAudit(promotionId, actorUserId, action, changes) {
  try {
    await prisma.promoAuditLog.create({
      data: { promotionId, actorUserId: actorUserId || null, action, changes: changes || null },
    });
  } catch (e) {
    console.error("[promo.audit] Failed to write audit log:", e?.message);
  }
}

function generateOfferSetToken() {
  // "os_" + 12 URL-safe random chars
  return "os_" + crypto.randomBytes(9).toString("base64url");
}

function generateRedemptionToken() {
  // "rd_" + 16 URL-safe random chars
  return "rd_" + crypto.randomBytes(12).toString("base64url");
}

/**
 * Validate the SKU list for a PromoItem.
 * - single_product: exactly 1 sku required
 * - product_bundle: 2+ skus required
 * - visit / any_purchase: skus must be empty
 * Returns an error string or null.
 */
function validateItemSkus(type, skus) {
  const list = Array.isArray(skus) ? skus : [];
  if (type === "visit" || type === "any_purchase") {
    if (list.length > 0) return `skus must be empty for type "${type}"`;
    return null;
  }
  if (type === "single_product") {
    if (list.length !== 1) return "single_product requires exactly 1 sku entry";
  }
  if (type === "product_bundle") {
    if (list.length < 2) return "product_bundle requires at least 2 sku entries";
  }
  for (const entry of list) {
    if (!entry.sku || !String(entry.sku).trim()) return "each sku entry must have a non-empty sku";
    const qty = entry.quantity ?? 1;
    if (!Number.isInteger(qty) || qty < 1) return "sku quantity must be a positive integer";
  }
  return null;
}

/**
 * Validate Promotion reward fields for the given rewardType.
 * Returns an error string or null.
 */
function validateReward(rewardType, rewardValue, rewardSku, rewardNote) {
  if (rewardType === "discount_pct") {
    if (!Number.isInteger(rewardValue) || rewardValue < 1 || rewardValue > 100)
      return "discount_pct requires rewardValue between 1 and 100";
  }
  if (rewardType === "discount_fixed") {
    if (!Number.isInteger(rewardValue) || rewardValue < 1)
      return "discount_fixed requires rewardValue >= 1 (cents)";
  }
  if (rewardType === "free_item") {
    if (!rewardSku || !String(rewardSku).trim())
      return "free_item requires rewardSku (a Product sku within this merchant)";
  }
  if (rewardType === "custom") {
    if (!rewardNote || !String(rewardNote).trim())
      return "custom reward requires rewardNote describing the reward";
  }
  return null;
}

/**
 * Verify that a rewardSku exists and is active for this merchant.
 * Returns the product or null.
 */
async function resolveRewardSku(merchantId, sku) {
  if (!sku) return null;
  return prisma.product.findFirst({
    where: { merchantId, sku: String(sku).trim(), status: "active" },
  });
}

// ══════════════════════════════════════════════════════════════
//  PROMO ITEMS
// ══════════════════════════════════════════════════════════════

// GET /merchant/promo-items
router.get(
  "/merchant/promo-items",
  requireJwt,
  requireMerchantRole("owner", "merchant_admin"),
  async (req, res) => {
    try {
      const { status } = req.query;
      const where = { merchantId: req.merchantId };
      if (VALID_PROMO_STATUSES.includes(status)) where.status = status;

      const items = await prisma.promoItem.findMany({
        where,
        include: { skus: true },
        orderBy: { id: "asc" },
      });

      emitPvHook("promo.item.list", {
        tc: "TC-PROMO-ITEM-LIST-01", sev: "info", stable: "promo:item:list",
        merchantId: req.merchantId, actorUserId: req.userId, actorRole: req.merchantRole,
        count: items.length, statusFilter: status || "all",
      });

      return res.json({ items });
    } catch (err) {
      return handlePrismaError(err, res);
    }
  }
);

// GET /merchant/promo-items/:itemId
router.get(
  "/merchant/promo-items/:itemId",
  requireJwt,
  requireMerchantRole("owner", "merchant_admin"),
  async (req, res) => {
    try {
      const itemId = parseIntParam(req.params.itemId);
      if (!itemId) return sendError(res, 400, "VALIDATION_ERROR", "Invalid itemId");

      const item = await prisma.promoItem.findFirst({
        where: { id: itemId, merchantId: req.merchantId },
        include: { skus: true },
      });
      if (!item) return sendError(res, 404, "NOT_FOUND", "PromoItem not found");

      return res.json({ item });
    } catch (err) {
      return handlePrismaError(err, res);
    }
  }
);

// POST /merchant/promo-items
router.post(
  "/merchant/promo-items",
  requireJwt,
  requireMerchantRole("owner", "merchant_admin"),
  async (req, res) => {
    try {
      const { name, description, type, skus } = req.body || {};

      if (!name || !String(name).trim())
        return sendError(res, 400, "VALIDATION_ERROR", "name is required");
      if (!VALID_ITEM_TYPES.includes(type))
        return sendError(res, 400, "VALIDATION_ERROR", `type must be one of: ${VALID_ITEM_TYPES.join(", ")}`);

      const skuErr = validateItemSkus(type, skus);
      if (skuErr) return sendError(res, 400, "VALIDATION_ERROR", skuErr);

      // For product types, verify each SKU exists for this merchant
      if (type === "single_product" || type === "product_bundle") {
        for (const entry of skus) {
          const product = await prisma.product.findFirst({
            where: { merchantId: req.merchantId, sku: String(entry.sku).trim() },
          });
          if (!product)
            return sendError(res, 422, "INVALID_SKU", `SKU "${entry.sku}" not found for this merchant`);
        }
      }

      const item = await prisma.promoItem.create({
        data: {
          merchantId: req.merchantId,
          name: String(name).trim(),
          description: description ? String(description).trim() : null,
          type,
          status: "active",
          skus: {
            create: (skus || []).map((e) => ({
              sku: String(e.sku).trim(),
              quantity: e.quantity ?? 1,
            })),
          },
        },
        include: { skus: true },
      });

      emitPvHook("promo.item.created", {
        tc: "TC-PROMO-ITEM-CREATE-01", sev: "info", stable: "promo:item:created",
        merchantId: req.merchantId, promoItemId: item.id, promoItemName: item.name,
        type: item.type, skuCount: item.skus.length,
        actorUserId: req.userId, actorRole: req.merchantRole,
      });

      return res.status(201).json({ item });
    } catch (err) {
      return handlePrismaError(err, res);
    }
  }
);

// PATCH /merchant/promo-items/:itemId
router.patch(
  "/merchant/promo-items/:itemId",
  requireJwt,
  requireMerchantRole("owner", "merchant_admin"),
  async (req, res) => {
    try {
      const itemId = parseIntParam(req.params.itemId);
      if (!itemId) return sendError(res, 400, "VALIDATION_ERROR", "Invalid itemId");

      const existing = await prisma.promoItem.findFirst({
        where: { id: itemId, merchantId: req.merchantId },
        include: { skus: true },
      });
      if (!existing) return sendError(res, 404, "NOT_FOUND", "PromoItem not found");
      if (existing.status === "archived")
        return sendError(res, 409, "ARCHIVED", "Cannot update an archived PromoItem");

      const { name, description, status, skus } = req.body || {};
      const data = {};

      if (name !== undefined) {
        if (!String(name).trim()) return sendError(res, 400, "VALIDATION_ERROR", "name cannot be empty");
        data.name = String(name).trim();
      }
      if (description !== undefined) data.description = description ? String(description).trim() : null;
      if (status !== undefined) {
        if (!VALID_PROMO_STATUSES.includes(status))
          return sendError(res, 400, "VALIDATION_ERROR", `status must be one of: ${VALID_PROMO_STATUSES.join(", ")}`);
        data.status = status;
      }

      // SKU replacement: delete all + re-create (type cannot change)
      let skuOps;
      if (skus !== undefined) {
        const skuErr = validateItemSkus(existing.type, skus);
        if (skuErr) return sendError(res, 400, "VALIDATION_ERROR", skuErr);

        if (existing.type === "single_product" || existing.type === "product_bundle") {
          for (const entry of skus) {
            const product = await prisma.product.findFirst({
              where: { merchantId: req.merchantId, sku: String(entry.sku).trim() },
            });
            if (!product)
              return sendError(res, 422, "INVALID_SKU", `SKU "${entry.sku}" not found for this merchant`);
          }
        }

        skuOps = {
          deleteMany: { promoItemId: itemId },
          create: skus.map((e) => ({ sku: String(e.sku).trim(), quantity: e.quantity ?? 1 })),
        };
      }

      if (!Object.keys(data).length && !skuOps)
        return sendError(res, 400, "VALIDATION_ERROR", "No updatable fields provided");

      const item = await prisma.promoItem.update({
        where: { id: itemId },
        data: { ...data, ...(skuOps ? { skus: skuOps } : {}) },
        include: { skus: true },
      });

      emitPvHook("promo.item.updated", {
        tc: "TC-PROMO-ITEM-UPDATE-01", sev: "info", stable: "promo:item:updated",
        merchantId: req.merchantId, promoItemId: item.id, promoItemName: item.name,
        changedFields: [...Object.keys(data), ...(skuOps ? ["skus"] : [])],
        actorUserId: req.userId, actorRole: req.merchantRole,
      });

      return res.json({ item });
    } catch (err) {
      return handlePrismaError(err, res);
    }
  }
);

// DELETE /merchant/promo-items/:itemId  (archive)
router.delete(
  "/merchant/promo-items/:itemId",
  requireJwt,
  requireMerchantRole("owner", "merchant_admin"),
  async (req, res) => {
    try {
      const itemId = parseIntParam(req.params.itemId);
      if (!itemId) return sendError(res, 400, "VALIDATION_ERROR", "Invalid itemId");

      const existing = await prisma.promoItem.findFirst({
        where: { id: itemId, merchantId: req.merchantId },
      });
      if (!existing) return sendError(res, 404, "NOT_FOUND", "PromoItem not found");
      if (existing.status === "archived")
        return sendError(res, 409, "ALREADY_ARCHIVED", "PromoItem is already archived");

      const item = await prisma.promoItem.update({
        where: { id: itemId },
        data: { status: "archived" },
        include: { skus: true },
      });

      emitPvHook("promo.item.archived", {
        tc: "TC-PROMO-ITEM-ARCHIVE-01", sev: "info", stable: "promo:item:archived",
        merchantId: req.merchantId, promoItemId: item.id, promoItemName: item.name,
        actorUserId: req.userId, actorRole: req.merchantRole,
      });

      return res.json({ item });
    } catch (err) {
      return handlePrismaError(err, res);
    }
  }
);

// ══════════════════════════════════════════════════════════════
//  PROMOTIONS
// ══════════════════════════════════════════════════════════════

// GET /merchant/promotions
router.get(
  "/merchant/promotions",
  requireJwt,
  requireMerchantRole("owner", "merchant_admin"),
  async (req, res) => {
    try {
      const { status } = req.query;
      const where = { merchantId: req.merchantId };
      if (VALID_PROMOTION_STATUSES.includes(status)) where.status = status;

      const promotions = await prisma.promotion.findMany({
        where,
        include: {
          items: { include: { promoItem: { include: { skus: true } } } },
          category: true,
        },
        orderBy: { id: "asc" },
      });

      emitPvHook("promo.promotion.list", {
        tc: "TC-PROMO-PROMO-LIST-01", sev: "info", stable: "promo:promotion:list",
        merchantId: req.merchantId, actorUserId: req.userId, actorRole: req.merchantRole,
        count: promotions.length, statusFilter: status || "all",
      });

      return res.json({ promotions });
    } catch (err) {
      return handlePrismaError(err, res);
    }
  }
);

// GET /merchant/promotions/:promotionId
router.get(
  "/merchant/promotions/:promotionId",
  requireJwt,
  requireMerchantRole("owner", "merchant_admin"),
  async (req, res) => {
    try {
      const promotionId = parseIntParam(req.params.promotionId);
      if (!promotionId) return sendError(res, 400, "VALIDATION_ERROR", "Invalid promotionId");

      const promotion = await prisma.promotion.findFirst({
        where: { id: promotionId, merchantId: req.merchantId },
        include: {
          items: { include: { promoItem: { include: { skus: true } } } },
          category: true,
        },
      });
      if (!promotion) return sendError(res, 404, "NOT_FOUND", "Promotion not found");

      return res.json({ promotion });
    } catch (err) {
      return handlePrismaError(err, res);
    }
  }
);

// POST /merchant/promotions
router.post(
  "/merchant/promotions",
  requireJwt,
  requireMerchantRole("owner", "merchant_admin"),
  async (req, res) => {
    try {
      const {
        name, description, legalText,
        mechanic, earnPerUnit, threshold, maxGrantsPerVisit,
        rewardType, rewardValue, rewardSku, rewardNote,
        categoryId, storeId,
        promoItemIds,
        startAt, endAt,
        objective, rewardExpiryDays,
      } = req.body || {};

      if (!name || !String(name).trim())
        return sendError(res, 400, "VALIDATION_ERROR", "name is required");
      if (!VALID_MECHANICS.includes(mechanic))
        return sendError(res, 400, "VALIDATION_ERROR", `mechanic must be one of: ${VALID_MECHANICS.join(", ")}`);
      if (!Number.isInteger(threshold) || threshold < 1)
        return sendError(res, 400, "VALIDATION_ERROR", "threshold must be a positive integer");
      if (!VALID_REWARD_TYPES.includes(rewardType))
        return sendError(res, 400, "VALIDATION_ERROR", `rewardType must be one of: ${VALID_REWARD_TYPES.join(", ")}`);

      const rewardErr = validateReward(rewardType, rewardValue, rewardSku, rewardNote);
      if (rewardErr) return sendError(res, 400, "VALIDATION_ERROR", rewardErr);

      if (rewardType === "free_item") {
        const product = await resolveRewardSku(req.merchantId, rewardSku);
        if (!product)
          return sendError(res, 422, "INVALID_SKU", `rewardSku "${rewardSku}" not found or inactive for this merchant`);
      }

      // earnPerUnit: stamps always 1, points must be >= 1
      const earn = mechanic === "stamps" ? 1 : (Number.isInteger(earnPerUnit) && earnPerUnit >= 1 ? earnPerUnit : null);
      if (earn === null)
        return sendError(res, 400, "VALIDATION_ERROR", "earnPerUnit must be a positive integer for points mechanic");

      if (maxGrantsPerVisit !== undefined && maxGrantsPerVisit !== null) {
        if (!Number.isInteger(maxGrantsPerVisit) || maxGrantsPerVisit < 1)
          return sendError(res, 400, "VALIDATION_ERROR", "maxGrantsPerVisit must be a positive integer or null");
      }

      // Validate promoItemIds belong to this merchant
      const itemIds = Array.isArray(promoItemIds) ? promoItemIds : [];
      if (itemIds.length > 0) {
        const foundItems = await prisma.promoItem.findMany({
          where: { id: { in: itemIds }, merchantId: req.merchantId },
          select: { id: true },
        });
        if (foundItems.length !== itemIds.length)
          return sendError(res, 422, "INVALID_ITEM", "One or more promoItemIds not found for this merchant");
      }

      const promotion = await prisma.promotion.create({
        data: {
          merchantId: req.merchantId,
          name: String(name).trim(),
          description: description ? String(description).trim() : null,
          legalText: legalText ? String(legalText).trim() : null,
          mechanic,
          earnPerUnit: earn,
          threshold,
          maxGrantsPerVisit: maxGrantsPerVisit ?? null,
          rewardType,
          rewardValue: rewardValue ?? null,
          rewardSku: rewardSku ? String(rewardSku).trim() : null,
          rewardNote: rewardNote ? String(rewardNote).trim() : null,
          categoryId: categoryId ? parseInt(categoryId, 10) : null,
          storeId: storeId ? parseInt(storeId, 10) : null,
          status: "draft",
          startAt: startAt ? new Date(startAt) : null,
          endAt: endAt ? new Date(endAt) : null,
          objective: objective || null,
          rewardExpiryDays: rewardExpiryDays ? parseInt(rewardExpiryDays, 10) : 90,
          items: {
            create: itemIds.map((id) => ({ promoItemId: id })),
          },
        },
        include: {
          items: { include: { promoItem: { include: { skus: true } } } },
          category: true,
        },
      });

      emitPvHook("promo.promotion.created", {
        tc: "TC-PROMO-PROMO-CREATE-01", sev: "info", stable: "promo:promotion:created",
        merchantId: req.merchantId, promotionId: promotion.id, promotionName: promotion.name,
        mechanic, rewardType, threshold,
        actorUserId: req.userId, actorRole: req.merchantRole,
      });
      await logPromoAudit(promotion.id, req.userId, "created", null);

      return res.status(201).json({ promotion });
    } catch (err) {
      return handlePrismaError(err, res);
    }
  }
);

// POST /merchant/promotions/generate-terms
// Calls Claude to draft T&C text based on promotion parameters.
// Merchant can review and edit before saving with the promotion.
router.post(
  "/merchant/promotions/generate-terms",
  requireJwt,
  requireMerchantRole("owner", "merchant_admin"),
  async (req, res) => {
    try {
      const {
        name, categoryName,
        threshold, rewardType, rewardValue, rewardSku, rewardNote,
        timeframeDays, startAt, endAt, maxGrantsPerVisit,
      } = req.body || {};

      if (!name || !threshold || !rewardType)
        return sendError(res, 400, "VALIDATION_ERROR", "name, threshold, and rewardType are required");

      const merchant = await prisma.merchant.findUnique({
        where: { id: req.merchantId },
        select: { name: true },
      });

      const draft = await draftPromoTerms({
        merchantName: merchant?.name || null,
        name, categoryName,
        threshold, rewardType, rewardValue, rewardSku, rewardNote,
        timeframeDays, startAt, endAt, maxGrantsPerVisit,
      });

      return res.json({ draft });
    } catch (err) {
      if (err.code === "AI_UNAVAILABLE") return sendError(res, 503, "AI_UNAVAILABLE", err.message);
      console.error("[promo generate-terms]", err?.message || err);
      return sendError(res, 500, "AI_ERROR", "Failed to generate terms draft");
    }
  }
);

// POST /merchant/promotions/generate-description
// Generates an enticing consumer-facing pitch (2 sentences).
router.post(
  "/merchant/promotions/generate-description",
  requireJwt,
  requireMerchantRole("owner", "merchant_admin"),
  async (req, res) => {
    try {
      const {
        name, categoryName, promotionType,
        threshold, rewardType, rewardValue, rewardSku, rewardNote,
        timeframeDays,
      } = req.body || {};

      if (!name) return sendError(res, 400, "VALIDATION_ERROR", "name is required");

      const merchant = await prisma.merchant.findUnique({
        where: { id: req.merchantId },
        select: { name: true },
      });

      const draft = await draftPromoDescription({
        merchantName: merchant?.name || null,
        promoName: name,
        categoryName,
        rewardType, rewardValue, rewardSku, rewardNote,
        threshold, timeframeDays,
        promotionType: promotionType || "stamp",
      });

      return res.json({ draft });
    } catch (err) {
      if (err.code === "AI_UNAVAILABLE") return sendError(res, 503, "AI_UNAVAILABLE", err.message);
      console.error("[promo generate-description]", err?.message || err);
      return sendError(res, 500, "AI_ERROR", "Failed to generate promotion description");
    }
  }
);

// PATCH /merchant/promotions/:promotionId
router.patch(
  "/merchant/promotions/:promotionId",
  requireJwt,
  requireMerchantRole("owner", "merchant_admin"),
  async (req, res) => {
    try {
      const promotionId = parseIntParam(req.params.promotionId);
      if (!promotionId) return sendError(res, 400, "VALIDATION_ERROR", "Invalid promotionId");

      const existing = await prisma.promotion.findFirst({
        where: { id: promotionId, merchantId: req.merchantId },
      });
      // legalText destructured below with the rest of req.body
      if (!existing) return sendError(res, 404, "NOT_FOUND", "Promotion not found");
      if (existing.status === "archived")
        return sendError(res, 409, "ARCHIVED", "Cannot update an archived Promotion");

      const {
        name, description, legalText, status,
        threshold, maxGrantsPerVisit, timeframeDays,
        rewardType, rewardValue, rewardSku, rewardNote,
        categoryId,
        promoItemIds,
        startAt, endAt,
      } = req.body || {};

      const data = {};
      if (name !== undefined) {
        if (!String(name).trim()) return sendError(res, 400, "VALIDATION_ERROR", "name cannot be empty");
        data.name = String(name).trim();
      }
      if (description !== undefined) data.description = description ? String(description).trim() : null;
      if (legalText !== undefined) data.legalText = legalText ? String(legalText).trim() : null;
      if (status !== undefined) {
        if (!VALID_PROMOTION_STATUSES.includes(status))
          return sendError(res, 400, "VALIDATION_ERROR", `status must be one of: ${VALID_PROMOTION_STATUSES.join(", ")}`);
        if (status !== existing.status) {
          const allowed = VALID_PROMO_TRANSITIONS[existing.status] || [];
          if (!allowed.includes(status))
            return sendError(res, 409, "INVALID_STATE", `Cannot transition from ${existing.status} to ${status}`);
          if (status === "active" && !existing.firstActivatedAt)
            data.firstActivatedAt = new Date();
        }
        data.status = status;
      }
      if (threshold !== undefined) {
        if (!Number.isInteger(threshold) || threshold < 1)
          return sendError(res, 400, "VALIDATION_ERROR", "threshold must be a positive integer");
        data.threshold = threshold;
      }
      if (maxGrantsPerVisit !== undefined) {
        if (maxGrantsPerVisit !== null && (!Number.isInteger(maxGrantsPerVisit) || maxGrantsPerVisit < 1))
          return sendError(res, 400, "VALIDATION_ERROR", "maxGrantsPerVisit must be a positive integer or null");
        data.maxGrantsPerVisit = maxGrantsPerVisit;
      }
      if (rewardType !== undefined || rewardValue !== undefined || rewardSku !== undefined || rewardNote !== undefined) {
        const rt = rewardType ?? existing.rewardType;
        const rv = rewardValue !== undefined ? rewardValue : existing.rewardValue;
        const rs = rewardSku !== undefined ? rewardSku : existing.rewardSku;
        const rn = rewardNote !== undefined ? rewardNote : existing.rewardNote;
        if (rewardType !== undefined) {
          if (!VALID_REWARD_TYPES.includes(rt))
            return sendError(res, 400, "VALIDATION_ERROR", `rewardType must be one of: ${VALID_REWARD_TYPES.join(", ")}`);
          data.rewardType = rt;
        }
        const rewardErr = validateReward(rt, rv, rs, rn);
        if (rewardErr) return sendError(res, 400, "VALIDATION_ERROR", rewardErr);
        if (rewardValue !== undefined) data.rewardValue = rv ?? null;
        if (rewardSku !== undefined) {
          if (rt === "free_item") {
            const product = await resolveRewardSku(req.merchantId, rs);
            if (!product)
              return sendError(res, 422, "INVALID_SKU", `rewardSku "${rs}" not found or inactive for this merchant`);
          }
          data.rewardSku = rs ? String(rs).trim() : null;
        }
        if (rewardNote !== undefined) data.rewardNote = rn ? String(rn).trim() : null;
      }
      if (startAt !== undefined) data.startAt = startAt ? new Date(startAt) : null;
      if (endAt !== undefined) data.endAt = endAt ? new Date(endAt) : null;
      if (timeframeDays !== undefined) data.timeframeDays = timeframeDays ? parseInt(timeframeDays, 10) : null;
      if (categoryId !== undefined) data.categoryId = categoryId ? parseInt(categoryId, 10) : null;

      let itemOps;
      if (promoItemIds !== undefined) {
        const itemIds = Array.isArray(promoItemIds) ? promoItemIds : [];
        if (itemIds.length > 0) {
          const found = await prisma.promoItem.findMany({
            where: { id: { in: itemIds }, merchantId: req.merchantId },
            select: { id: true },
          });
          if (found.length !== itemIds.length)
            return sendError(res, 422, "INVALID_ITEM", "One or more promoItemIds not found for this merchant");
        }
        itemOps = {
          deleteMany: { promotionId },
          create: itemIds.map((id) => ({ promoItemId: id })),
        };
      }

      if (!Object.keys(data).length && !itemOps)
        return sendError(res, 400, "VALIDATION_ERROR", "No updatable fields provided");

      const promotion = await prisma.promotion.update({
        where: { id: promotionId },
        data: { ...data, ...(itemOps ? { items: itemOps } : {}) },
        include: {
          items: { include: { promoItem: { include: { skus: true } } } },
          category: true,
        },
      });

      emitPvHook("promo.promotion.updated", {
        tc: "TC-PROMO-PROMO-UPDATE-01", sev: "info", stable: "promo:promotion:updated",
        merchantId: req.merchantId, promotionId: promotion.id, promotionName: promotion.name,
        changedFields: [...Object.keys(data), ...(itemOps ? ["items"] : [])],
        actorUserId: req.userId, actorRole: req.merchantRole,
      });
      await logPromoAudit(promotionId, req.userId, data.status && data.status !== existing.status ? `status_changed:${existing.status}→${data.status}` : "updated", Object.keys(data).length ? Object.keys(data) : null);

      // Growth Advisor — capture baseline when promotion activates
      if (data.status === "active" && existing.status !== "active") {
        capturePromotionBaseline(prisma, {
          promotionId,
          merchantId: req.merchantId,
        });
      }

      return res.json({ promotion });
    } catch (err) {
      return handlePrismaError(err, res);
    }
  }
);

// DELETE /merchant/promotions/:promotionId  (archive)
router.delete(
  "/merchant/promotions/:promotionId",
  requireJwt,
  requireMerchantRole("owner", "merchant_admin"),
  async (req, res) => {
    try {
      const promotionId = parseIntParam(req.params.promotionId);
      if (!promotionId) return sendError(res, 400, "VALIDATION_ERROR", "Invalid promotionId");

      const existing = await prisma.promotion.findFirst({
        where: { id: promotionId, merchantId: req.merchantId },
      });
      if (!existing) return sendError(res, 404, "NOT_FOUND", "Promotion not found");
      if (existing.status === "archived")
        return sendError(res, 409, "ALREADY_ARCHIVED", "Promotion is already archived");

      const promotion = await prisma.promotion.update({
        where: { id: promotionId },
        data: { status: "archived" },
      });

      emitPvHook("promo.promotion.archived", {
        tc: "TC-PROMO-PROMO-ARCHIVE-01", sev: "info", stable: "promo:promotion:archived",
        merchantId: req.merchantId, promotionId: promotion.id, promotionName: promotion.name,
        actorUserId: req.userId, actorRole: req.merchantRole,
      });

      return res.json({ promotion });
    } catch (err) {
      return handlePrismaError(err, res);
    }
  }
);

// GET /merchant/promotions/:promotionId/audit
router.get(
  "/merchant/promotions/:promotionId/audit",
  requireJwt,
  requireMerchantRole("owner", "merchant_admin"),
  async (req, res) => {
    try {
      const promotionId = parseIntParam(req.params.promotionId);
      if (!promotionId) return sendError(res, 400, "VALIDATION_ERROR", "Invalid promotionId");
      const promo = await prisma.promotion.findFirst({ where: { id: promotionId, merchantId: req.merchantId } });
      if (!promo) return sendError(res, 404, "NOT_FOUND", "Promotion not found");
      const logs = await prisma.promoAuditLog.findMany({
        where: { promotionId },
        orderBy: { createdAt: "desc" },
        take: 50,
      });
      return res.json({ logs });
    } catch (err) { return handlePrismaError(err, res); }
  }
);

// POST /merchant/promotions/:promotionId/duplicate
// Clones an archived promotion into a new draft. Dates cleared.
router.post(
  "/merchant/promotions/:promotionId/duplicate",
  requireJwt,
  requireMerchantRole("owner", "merchant_admin"),
  async (req, res) => {
    try {
      const promotionId = parseIntParam(req.params.promotionId);
      if (!promotionId) return sendError(res, 400, "VALIDATION_ERROR", "Invalid promotionId");

      const existing = await prisma.promotion.findFirst({
        where: { id: promotionId, merchantId: req.merchantId },
        include: { items: { select: { promoItemId: true } } },
      });
      if (!existing) return sendError(res, 404, "NOT_FOUND", "Promotion not found");
      if (existing.status !== "archived")
        return sendError(res, 409, "INVALID_STATE", "Only archived promotions can be duplicated");

      const clone = await prisma.promotion.create({
        data: {
          merchantId: req.merchantId,
          name: existing.name,
          description: existing.description,
          legalText: existing.legalText,
          mechanic: existing.mechanic,
          earnPerUnit: existing.earnPerUnit,
          threshold: existing.threshold,
          maxGrantsPerVisit: existing.maxGrantsPerVisit,
          rewardType: existing.rewardType,
          rewardValue: existing.rewardValue,
          rewardSku: existing.rewardSku,
          rewardNote: existing.rewardNote,
          categoryId: existing.categoryId,
          status: "draft",
          startAt: null,
          endAt: null,
          items: { create: existing.items.map(i => ({ promoItemId: i.promoItemId })) },
        },
        include: { items: { include: { promoItem: { include: { skus: true } } } }, category: true },
      });

      emitPvHook("promo.promotion.duplicated", {
        tc: "TC-PROMO-PROMO-DUP-01", sev: "info", stable: "promo:promotion:duplicated",
        merchantId: req.merchantId, sourcePromotionId: promotionId, newPromotionId: clone.id,
        promotionName: clone.name, actorUserId: req.userId, actorRole: req.merchantRole,
      });

      return res.status(201).json({ promotion: clone });
    } catch (err) {
      return handlePrismaError(err, res);
    }
  }
);

// ══════════════════════════════════════════════════════════════
//  OFFER SETS
// ══════════════════════════════════════════════════════════════

// GET /merchant/offer-sets
router.get(
  "/merchant/offer-sets",
  requireJwt,
  requireMerchantRole("owner", "merchant_admin"),
  async (req, res) => {
    try {
      const { status } = req.query;
      const where = { merchantId: req.merchantId };
      if (VALID_OS_STATUSES.includes(status)) where.status = status;

      const offerSets = await prisma.offerSet.findMany({
        where,
        include: {
          promotions: {
            include: { promotion: true },
            orderBy: { sortOrder: "asc" },
          },
          stores: { include: { store: { select: { id: true, name: true } } } },
        },
        orderBy: { id: "asc" },
      });

      emitPvHook("promo.offer_set.list", {
        tc: "TC-PROMO-OS-LIST-01", sev: "info", stable: "promo:offer_set:list",
        merchantId: req.merchantId, actorUserId: req.userId, actorRole: req.merchantRole,
        count: offerSets.length, statusFilter: status || "all",
      });

      return res.json({ offerSets });
    } catch (err) {
      return handlePrismaError(err, res);
    }
  }
);

// GET /merchant/offer-sets/:offerSetId
router.get(
  "/merchant/offer-sets/:offerSetId",
  requireJwt,
  requireMerchantRole("owner", "merchant_admin"),
  async (req, res) => {
    try {
      const offerSetId = parseIntParam(req.params.offerSetId);
      if (!offerSetId) return sendError(res, 400, "VALIDATION_ERROR", "Invalid offerSetId");

      const offerSet = await prisma.offerSet.findFirst({
        where: { id: offerSetId, merchantId: req.merchantId },
        include: {
          promotions: {
            include: { promotion: { include: { items: { include: { promoItem: { include: { skus: true } } } } } } },
            orderBy: { sortOrder: "asc" },
          },
          stores: { include: { store: { select: { id: true, name: true, city: true, state: true } } } },
        },
      });
      if (!offerSet) return sendError(res, 404, "NOT_FOUND", "OfferSet not found");

      return res.json({ offerSet });
    } catch (err) {
      return handlePrismaError(err, res);
    }
  }
);

// POST /merchant/offer-sets
router.post(
  "/merchant/offer-sets",
  requireJwt,
  requireMerchantRole("owner", "merchant_admin"),
  async (req, res) => {
    try {
      const { name, description, scope, promotionIds, storeIds, startAt, endAt } = req.body || {};

      if (!name || !String(name).trim())
        return sendError(res, 400, "VALIDATION_ERROR", "name is required");

      const resolvedScope = VALID_OS_SCOPES.includes(scope) ? scope : "merchant";

      if (resolvedScope === "store") {
        if (!Array.isArray(storeIds) || storeIds.length === 0)
          return sendError(res, 400, "VALIDATION_ERROR", "storeIds required when scope is store");
        const found = await prisma.store.findMany({
          where: { id: { in: storeIds }, merchantId: req.merchantId },
          select: { id: true },
        });
        if (found.length !== storeIds.length)
          return sendError(res, 422, "INVALID_STORE", "One or more storeIds not found for this merchant");
      }

      const promIds = Array.isArray(promotionIds) ? promotionIds : [];
      if (promIds.length > 0) {
        const found = await prisma.promotion.findMany({
          where: { id: { in: promIds }, merchantId: req.merchantId },
          select: { id: true },
        });
        if (found.length !== promIds.length)
          return sendError(res, 422, "INVALID_PROMOTION", "One or more promotionIds not found for this merchant");
      }

      const token = generateOfferSetToken();

      const offerSet = await prisma.offerSet.create({
        data: {
          merchantId: req.merchantId,
          name: String(name).trim(),
          description: description ? String(description).trim() : null,
          token,
          scope: resolvedScope,
          status: "draft",
          startAt: startAt ? new Date(startAt) : null,
          endAt: endAt ? new Date(endAt) : null,
          promotions: {
            create: promIds.map((id, idx) => ({ promotionId: id, sortOrder: idx })),
          },
          stores: resolvedScope === "store"
            ? { create: storeIds.map((id) => ({ storeId: id })) }
            : undefined,
        },
        include: {
          promotions: { include: { promotion: true }, orderBy: { sortOrder: "asc" } },
          stores: { include: { store: { select: { id: true, name: true } } } },
        },
      });

      emitPvHook("promo.offer_set.created", {
        tc: "TC-PROMO-OS-CREATE-01", sev: "info", stable: "promo:offer_set:created",
        merchantId: req.merchantId, offerSetId: offerSet.id, offerSetName: offerSet.name,
        token: offerSet.token, scope: offerSet.scope, promotionCount: promIds.length,
        actorUserId: req.userId, actorRole: req.merchantRole,
      });

      return res.status(201).json({ offerSet });
    } catch (err) {
      return handlePrismaError(err, res);
    }
  }
);

// PATCH /merchant/offer-sets/:offerSetId
router.patch(
  "/merchant/offer-sets/:offerSetId",
  requireJwt,
  requireMerchantRole("owner", "merchant_admin"),
  async (req, res) => {
    try {
      const offerSetId = parseIntParam(req.params.offerSetId);
      if (!offerSetId) return sendError(res, 400, "VALIDATION_ERROR", "Invalid offerSetId");

      const existing = await prisma.offerSet.findFirst({
        where: { id: offerSetId, merchantId: req.merchantId },
      });
      if (!existing) return sendError(res, 404, "NOT_FOUND", "OfferSet not found");
      if (existing.status === "archived")
        return sendError(res, 409, "ARCHIVED", "Cannot update an archived OfferSet");

      const { name, description, status, storeIds, promotionIds, startAt, endAt } = req.body || {};
      const data = {};

      if (name !== undefined) {
        if (!String(name).trim()) return sendError(res, 400, "VALIDATION_ERROR", "name cannot be empty");
        data.name = String(name).trim();
      }
      if (description !== undefined) data.description = description ? String(description).trim() : null;
      if (status !== undefined) {
        if (!VALID_OS_STATUSES.includes(status))
          return sendError(res, 400, "VALIDATION_ERROR", `status must be one of: ${VALID_OS_STATUSES.join(", ")}`);
        data.status = status;
      }
      if (startAt !== undefined) data.startAt = startAt ? new Date(startAt) : null;
      if (endAt !== undefined) data.endAt = endAt ? new Date(endAt) : null;

      let storeOps, promoOps;

      if (storeIds !== undefined) {
        if (existing.scope !== "store")
          return sendError(res, 400, "VALIDATION_ERROR", "storeIds can only be set when scope is store");
        const found = await prisma.store.findMany({
          where: { id: { in: storeIds }, merchantId: req.merchantId },
          select: { id: true },
        });
        if (found.length !== storeIds.length)
          return sendError(res, 422, "INVALID_STORE", "One or more storeIds not found for this merchant");
        storeOps = { deleteMany: { offerSetId }, create: storeIds.map((id) => ({ storeId: id })) };
      }

      if (promotionIds !== undefined) {
        const promIds = Array.isArray(promotionIds) ? promotionIds : [];
        if (promIds.length > 0) {
          const found = await prisma.promotion.findMany({
            where: { id: { in: promIds }, merchantId: req.merchantId },
            select: { id: true },
          });
          if (found.length !== promIds.length)
            return sendError(res, 422, "INVALID_PROMOTION", "One or more promotionIds not found for this merchant");
        }
        promoOps = {
          deleteMany: { offerSetId },
          create: promIds.map((id, idx) => ({ promotionId: id, sortOrder: idx })),
        };
      }

      if (!Object.keys(data).length && !storeOps && !promoOps)
        return sendError(res, 400, "VALIDATION_ERROR", "No updatable fields provided");

      const offerSet = await prisma.offerSet.update({
        where: { id: offerSetId },
        data: {
          ...data,
          ...(storeOps ? { stores: storeOps } : {}),
          ...(promoOps ? { promotions: promoOps } : {}),
        },
        include: {
          promotions: { include: { promotion: true }, orderBy: { sortOrder: "asc" } },
          stores: { include: { store: { select: { id: true, name: true } } } },
        },
      });

      emitPvHook("promo.offer_set.updated", {
        tc: "TC-PROMO-OS-UPDATE-01", sev: "info", stable: "promo:offer_set:updated",
        merchantId: req.merchantId, offerSetId: offerSet.id, offerSetName: offerSet.name,
        changedFields: [...Object.keys(data), ...(storeOps ? ["stores"] : []), ...(promoOps ? ["promotions"] : [])],
        actorUserId: req.userId, actorRole: req.merchantRole,
      });

      return res.json({ offerSet });
    } catch (err) {
      return handlePrismaError(err, res);
    }
  }
);

// POST /merchant/offer-sets/:offerSetId/publish  (draft → active)
router.post(
  "/merchant/offer-sets/:offerSetId/publish",
  requireJwt,
  requireMerchantRole("owner", "merchant_admin"),
  async (req, res) => {
    try {
      const offerSetId = parseIntParam(req.params.offerSetId);
      if (!offerSetId) return sendError(res, 400, "VALIDATION_ERROR", "Invalid offerSetId");

      const existing = await prisma.offerSet.findFirst({
        where: { id: offerSetId, merchantId: req.merchantId },
        include: { promotions: true },
      });
      if (!existing) return sendError(res, 404, "NOT_FOUND", "OfferSet not found");
      if (existing.status !== "draft")
        return sendError(res, 409, "INVALID_STATUS", `Only draft OfferSets can be published (current: ${existing.status})`);
      if (existing.promotions.length === 0)
        return sendError(res, 422, "NO_PROMOTIONS", "Cannot publish an OfferSet with no promotions");

      const offerSet = await prisma.offerSet.update({
        where: { id: offerSetId },
        data: { status: "active" },
        include: {
          promotions: { include: { promotion: true }, orderBy: { sortOrder: "asc" } },
          stores: { include: { store: { select: { id: true, name: true } } } },
        },
      });

      emitPvHook("promo.offer_set.published", {
        tc: "TC-PROMO-OS-PUBLISH-01", sev: "info", stable: "promo:offer_set:published",
        merchantId: req.merchantId, offerSetId: offerSet.id, offerSetName: offerSet.name,
        token: offerSet.token, promotionCount: offerSet.promotions.length,
        actorUserId: req.userId, actorRole: req.merchantRole,
      });

      return res.json({ offerSet });
    } catch (err) {
      return handlePrismaError(err, res);
    }
  }
);

// POST /merchant/offer-sets/:offerSetId/expire  (active → expired)
router.post(
  "/merchant/offer-sets/:offerSetId/expire",
  requireJwt,
  requireMerchantRole("owner", "merchant_admin"),
  async (req, res) => {
    try {
      const offerSetId = parseIntParam(req.params.offerSetId);
      if (!offerSetId) return sendError(res, 400, "VALIDATION_ERROR", "Invalid offerSetId");

      const existing = await prisma.offerSet.findFirst({
        where: { id: offerSetId, merchantId: req.merchantId },
      });
      if (!existing) return sendError(res, 404, "NOT_FOUND", "OfferSet not found");
      if (existing.status !== "active")
        return sendError(res, 409, "INVALID_STATUS", `Only active OfferSets can be expired (current: ${existing.status})`);

      const offerSet = await prisma.offerSet.update({
        where: { id: offerSetId },
        data: { status: "expired" },
      });

      emitPvHook("promo.offer_set.expired", {
        tc: "TC-PROMO-OS-EXPIRE-01", sev: "info", stable: "promo:offer_set:expired",
        merchantId: req.merchantId, offerSetId: offerSet.id, offerSetName: offerSet.name,
        actorUserId: req.userId, actorRole: req.merchantRole,
      });

      return res.json({ offerSet });
    } catch (err) {
      return handlePrismaError(err, res);
    }
  }
);

// DELETE /merchant/offer-sets/:offerSetId  (archive)
router.delete(
  "/merchant/offer-sets/:offerSetId",
  requireJwt,
  requireMerchantRole("owner", "merchant_admin"),
  async (req, res) => {
    try {
      const offerSetId = parseIntParam(req.params.offerSetId);
      if (!offerSetId) return sendError(res, 400, "VALIDATION_ERROR", "Invalid offerSetId");

      const existing = await prisma.offerSet.findFirst({
        where: { id: offerSetId, merchantId: req.merchantId },
      });
      if (!existing) return sendError(res, 404, "NOT_FOUND", "OfferSet not found");
      if (existing.status === "archived")
        return sendError(res, 409, "ALREADY_ARCHIVED", "OfferSet is already archived");

      const offerSet = await prisma.offerSet.update({
        where: { id: offerSetId },
        data: { status: "archived" },
      });

      emitPvHook("promo.offer_set.archived", {
        tc: "TC-PROMO-OS-ARCHIVE-01", sev: "info", stable: "promo:offer_set:archived",
        merchantId: req.merchantId, offerSetId: offerSet.id, offerSetName: offerSet.name,
        actorUserId: req.userId, actorRole: req.merchantRole,
      });

      return res.json({ offerSet });
    } catch (err) {
      return handlePrismaError(err, res);
    }
  }
);

// ══════════════════════════════════════════════════════════════
//  ADMIN ROUTES  (pv_admin — full CRUD)
// ══════════════════════════════════════════════════════════════

// ── Admin PromoItems ───────────────────────────────────────────

router.get("/admin/merchants/:merchantId/promo-items", requireJwt, requireAdmin, async (req, res) => {
  const merchantId = parseIntParam(req.params.merchantId);
  if (!merchantId) return sendError(res, 400, "VALIDATION_ERROR", "Invalid merchantId");
  try {
    const { status } = req.query;
    const where = { merchantId };
    if (VALID_PROMO_STATUSES.includes(status)) where.status = status;
    const items = await prisma.promoItem.findMany({ where, include: { skus: true }, orderBy: { id: "asc" } });
    return res.json({ items });
  } catch (err) { return handlePrismaError(err, res); }
});

router.post("/admin/merchants/:merchantId/promo-items", requireJwt, requireAdmin, async (req, res) => {
  const merchantId = parseIntParam(req.params.merchantId);
  if (!merchantId) return sendError(res, 400, "VALIDATION_ERROR", "Invalid merchantId");
  try {
    const { name, description, type, skus } = req.body || {};
    if (!name || !String(name).trim()) return sendError(res, 400, "VALIDATION_ERROR", "name is required");
    if (!VALID_ITEM_TYPES.includes(type))
      return sendError(res, 400, "VALIDATION_ERROR", `type must be one of: ${VALID_ITEM_TYPES.join(", ")}`);
    const skuErr = validateItemSkus(type, skus);
    if (skuErr) return sendError(res, 400, "VALIDATION_ERROR", skuErr);
    if (type === "single_product" || type === "product_bundle") {
      for (const entry of skus) {
        const product = await prisma.product.findFirst({ where: { merchantId, sku: String(entry.sku).trim() } });
        if (!product) return sendError(res, 422, "INVALID_SKU", `SKU "${entry.sku}" not found for this merchant`);
      }
    }
    const item = await prisma.promoItem.create({
      data: {
        merchantId, name: String(name).trim(),
        description: description ? String(description).trim() : null,
        type, status: "active",
        skus: { create: (skus || []).map((e) => ({ sku: String(e.sku).trim(), quantity: e.quantity ?? 1 })) },
      },
      include: { skus: true },
    });
    emitPvHook("promo.item.created", {
      tc: "TC-PROMO-ITEM-CREATE-ADMIN-01", sev: "info", stable: "promo:item:created",
      merchantId, promoItemId: item.id, promoItemName: item.name, type: item.type,
      actorUserId: req.userId, actorRole: "pv_admin",
    });
    return res.status(201).json({ item });
  } catch (err) { return handlePrismaError(err, res); }
});

router.patch("/admin/merchants/:merchantId/promo-items/:itemId", requireJwt, requireAdmin, async (req, res) => {
  const merchantId = parseIntParam(req.params.merchantId);
  const itemId = parseIntParam(req.params.itemId);
  if (!merchantId || !itemId) return sendError(res, 400, "VALIDATION_ERROR", "Invalid params");
  try {
    const existing = await prisma.promoItem.findFirst({ where: { id: itemId, merchantId }, include: { skus: true } });
    if (!existing) return sendError(res, 404, "NOT_FOUND", "PromoItem not found");
    if (existing.status === "archived") return sendError(res, 409, "ARCHIVED", "Cannot update an archived PromoItem");
    const { name, description, status, skus } = req.body || {};
    const data = {};
    if (name !== undefined) { if (!String(name).trim()) return sendError(res, 400, "VALIDATION_ERROR", "name cannot be empty"); data.name = String(name).trim(); }
    if (description !== undefined) data.description = description ? String(description).trim() : null;
    if (status !== undefined) { if (!VALID_PROMO_STATUSES.includes(status)) return sendError(res, 400, "VALIDATION_ERROR", "Invalid status"); data.status = status; }
    let skuOps;
    if (skus !== undefined) {
      const skuErr = validateItemSkus(existing.type, skus);
      if (skuErr) return sendError(res, 400, "VALIDATION_ERROR", skuErr);
      skuOps = { deleteMany: { promoItemId: itemId }, create: skus.map((e) => ({ sku: String(e.sku).trim(), quantity: e.quantity ?? 1 })) };
    }
    if (!Object.keys(data).length && !skuOps) return sendError(res, 400, "VALIDATION_ERROR", "No updatable fields provided");
    const item = await prisma.promoItem.update({ where: { id: itemId }, data: { ...data, ...(skuOps ? { skus: skuOps } : {}) }, include: { skus: true } });
    emitPvHook("promo.item.updated", { tc: "TC-PROMO-ITEM-UPDATE-ADMIN-01", sev: "info", stable: "promo:item:updated", merchantId, promoItemId: item.id, promoItemName: item.name, changedFields: [...Object.keys(data), ...(skuOps ? ["skus"] : [])], actorUserId: req.userId, actorRole: "pv_admin" });
    return res.json({ item });
  } catch (err) { return handlePrismaError(err, res); }
});

router.delete("/admin/merchants/:merchantId/promo-items/:itemId", requireJwt, requireAdmin, async (req, res) => {
  const merchantId = parseIntParam(req.params.merchantId);
  const itemId = parseIntParam(req.params.itemId);
  if (!merchantId || !itemId) return sendError(res, 400, "VALIDATION_ERROR", "Invalid params");
  try {
    const existing = await prisma.promoItem.findFirst({ where: { id: itemId, merchantId } });
    if (!existing) return sendError(res, 404, "NOT_FOUND", "PromoItem not found");
    if (existing.status === "archived") return sendError(res, 409, "ALREADY_ARCHIVED", "Already archived");
    const item = await prisma.promoItem.update({ where: { id: itemId }, data: { status: "archived" }, include: { skus: true } });
    emitPvHook("promo.item.archived", { tc: "TC-PROMO-ITEM-ARCHIVE-ADMIN-01", sev: "info", stable: "promo:item:archived", merchantId, promoItemId: item.id, promoItemName: item.name, actorUserId: req.userId, actorRole: "pv_admin" });
    return res.json({ item });
  } catch (err) { return handlePrismaError(err, res); }
});

// ── Admin Promotions ───────────────────────────────────────────

router.get("/admin/merchants/:merchantId/promotions", requireJwt, requireAdmin, async (req, res) => {
  const merchantId = parseIntParam(req.params.merchantId);
  if (!merchantId) return sendError(res, 400, "VALIDATION_ERROR", "Invalid merchantId");
  try {
    const { status } = req.query;
    const where = { merchantId };
    if (VALID_PROMOTION_STATUSES.includes(status)) where.status = status;
    const promotions = await prisma.promotion.findMany({
      where,
      include: { items: { include: { promoItem: { include: { skus: true } } } }, category: true },
      orderBy: { id: "asc" },
    });
    return res.json({ promotions });
  } catch (err) { return handlePrismaError(err, res); }
});

router.post("/admin/merchants/:merchantId/promotions", requireJwt, requireAdmin, async (req, res) => {
  const merchantId = parseIntParam(req.params.merchantId);
  if (!merchantId) return sendError(res, 400, "VALIDATION_ERROR", "Invalid merchantId");
  try {
    const { name, description, mechanic, earnPerUnit, threshold, maxGrantsPerVisit, rewardType, rewardValue, rewardSku, rewardNote, categoryId, promoItemIds, startAt, endAt } = req.body || {};
    if (!name || !String(name).trim()) return sendError(res, 400, "VALIDATION_ERROR", "name is required");
    if (!VALID_MECHANICS.includes(mechanic)) return sendError(res, 400, "VALIDATION_ERROR", `mechanic must be one of: ${VALID_MECHANICS.join(", ")}`);
    if (!Number.isInteger(threshold) || threshold < 1) return sendError(res, 400, "VALIDATION_ERROR", "threshold must be a positive integer");
    if (!VALID_REWARD_TYPES.includes(rewardType)) return sendError(res, 400, "VALIDATION_ERROR", `rewardType must be one of: ${VALID_REWARD_TYPES.join(", ")}`);
    const rewardErr = validateReward(rewardType, rewardValue, rewardSku, rewardNote);
    if (rewardErr) return sendError(res, 400, "VALIDATION_ERROR", rewardErr);
    if (rewardType === "free_item") {
      const product = await resolveRewardSku(merchantId, rewardSku);
      if (!product) return sendError(res, 422, "INVALID_SKU", `rewardSku "${rewardSku}" not found or inactive`);
    }
    const earn = mechanic === "stamps" ? 1 : (Number.isInteger(earnPerUnit) && earnPerUnit >= 1 ? earnPerUnit : null);
    if (earn === null) return sendError(res, 400, "VALIDATION_ERROR", "earnPerUnit must be a positive integer for points mechanic");
    const itemIds = Array.isArray(promoItemIds) ? promoItemIds : [];
    if (itemIds.length > 0) {
      const found = await prisma.promoItem.findMany({ where: { id: { in: itemIds }, merchantId }, select: { id: true } });
      if (found.length !== itemIds.length) return sendError(res, 422, "INVALID_ITEM", "One or more promoItemIds not found");
    }
    const promotion = await prisma.promotion.create({
      data: {
        merchantId, name: String(name).trim(),
        description: description ? String(description).trim() : null,
        mechanic, earnPerUnit: earn, threshold,
        maxGrantsPerVisit: maxGrantsPerVisit ?? null,
        rewardType, rewardValue: rewardValue ?? null,
        rewardSku: rewardSku ? String(rewardSku).trim() : null,
        rewardNote: rewardNote ? String(rewardNote).trim() : null,
        categoryId: categoryId ? parseInt(categoryId, 10) : null,
        status: "draft",
        startAt: startAt ? new Date(startAt) : null,
        endAt: endAt ? new Date(endAt) : null,
        items: { create: itemIds.map((id) => ({ promoItemId: id })) },
      },
      include: { items: { include: { promoItem: { include: { skus: true } } } }, category: true },
    });
    emitPvHook("promo.promotion.created", { tc: "TC-PROMO-PROMO-CREATE-ADMIN-01", sev: "info", stable: "promo:promotion:created", merchantId, promotionId: promotion.id, promotionName: promotion.name, mechanic, rewardType, threshold, actorUserId: req.userId, actorRole: "pv_admin" });
    await logPromoAudit(promotion.id, req.userId, "created", null);
    return res.status(201).json({ promotion });
  } catch (err) { return handlePrismaError(err, res); }
});

router.patch("/admin/merchants/:merchantId/promotions/:promotionId", requireJwt, requireAdmin, async (req, res) => {
  const merchantId = parseIntParam(req.params.merchantId);
  const promotionId = parseIntParam(req.params.promotionId);
  if (!merchantId || !promotionId) return sendError(res, 400, "VALIDATION_ERROR", "Invalid params");
  try {
    const existing = await prisma.promotion.findFirst({ where: { id: promotionId, merchantId } });
    if (!existing) return sendError(res, 404, "NOT_FOUND", "Promotion not found");
    if (existing.status === "archived") return sendError(res, 409, "ARCHIVED", "Cannot update an archived Promotion");
    const { name, description, legalText, status, threshold, maxGrantsPerVisit, rewardType, rewardValue, rewardSku, rewardNote, categoryId, promoItemIds, startAt, endAt } = req.body || {};
    const data = {};
    if (name !== undefined) { if (!String(name).trim()) return sendError(res, 400, "VALIDATION_ERROR", "name cannot be empty"); data.name = String(name).trim(); }
    if (description !== undefined) data.description = description ? String(description).trim() : null;
    if (legalText !== undefined) data.legalText = legalText ? String(legalText).trim() : null;
    if (status !== undefined) {
      if (!VALID_PROMOTION_STATUSES.includes(status)) return sendError(res, 400, "VALIDATION_ERROR", "Invalid status");
      if (status !== existing.status) {
        const allowed = VALID_PROMO_TRANSITIONS[existing.status] || [];
        if (!allowed.includes(status)) return sendError(res, 409, "INVALID_STATE", `Cannot transition from ${existing.status} to ${status}`);
        if (status === "active" && !existing.firstActivatedAt)
          data.firstActivatedAt = new Date();
      }
      data.status = status;
    }
    if (threshold !== undefined) { if (!Number.isInteger(threshold) || threshold < 1) return sendError(res, 400, "VALIDATION_ERROR", "threshold must be a positive integer"); data.threshold = threshold; }
    if (maxGrantsPerVisit !== undefined) { if (maxGrantsPerVisit !== null && (!Number.isInteger(maxGrantsPerVisit) || maxGrantsPerVisit < 1)) return sendError(res, 400, "VALIDATION_ERROR", "maxGrantsPerVisit must be a positive integer or null"); data.maxGrantsPerVisit = maxGrantsPerVisit; }
    if (rewardValue !== undefined) data.rewardValue = rewardValue ?? null;
    if (rewardSku !== undefined) data.rewardSku = rewardSku ? String(rewardSku).trim() : null;
    if (rewardNote !== undefined) data.rewardNote = rewardNote ? String(rewardNote).trim() : null;
    if (categoryId !== undefined) data.categoryId = categoryId ? parseInt(categoryId, 10) : null;
    if (startAt !== undefined) data.startAt = startAt ? new Date(startAt) : null;
    if (endAt !== undefined) data.endAt = endAt ? new Date(endAt) : null;
    const { timeframeDays: tfDays } = req.body || {};
    if (tfDays !== undefined) data.timeframeDays = tfDays ? parseInt(tfDays, 10) : null;
    let itemOps;
    if (promoItemIds !== undefined) {
      const itemIds = Array.isArray(promoItemIds) ? promoItemIds : [];
      if (itemIds.length > 0) {
        const found = await prisma.promoItem.findMany({ where: { id: { in: itemIds }, merchantId }, select: { id: true } });
        if (found.length !== itemIds.length) return sendError(res, 422, "INVALID_ITEM", "One or more promoItemIds not found");
      }
      itemOps = { deleteMany: { promotionId }, create: itemIds.map((id) => ({ promoItemId: id })) };
    }
    if (!Object.keys(data).length && !itemOps) return sendError(res, 400, "VALIDATION_ERROR", "No updatable fields provided");
    const promotion = await prisma.promotion.update({
      where: { id: promotionId },
      data: { ...data, ...(itemOps ? { items: itemOps } : {}) },
      include: { items: { include: { promoItem: { include: { skus: true } } } }, category: true },
    });
    emitPvHook("promo.promotion.updated", { tc: "TC-PROMO-PROMO-UPDATE-ADMIN-01", sev: "info", stable: "promo:promotion:updated", merchantId, promotionId: promotion.id, promotionName: promotion.name, changedFields: [...Object.keys(data), ...(itemOps ? ["items"] : [])], actorUserId: req.userId, actorRole: "pv_admin" });
    await logPromoAudit(promotionId, req.userId, data.status && data.status !== existing.status ? `status_changed:${existing.status}→${data.status}` : "updated", Object.keys(data).length ? Object.keys(data) : null);

    // Growth Advisor — capture baseline when promotion activates
    if (data.status === "active" && existing.status !== "active") {
      capturePromotionBaseline(prisma, { promotionId, merchantId });
    }

    return res.json({ promotion });
  } catch (err) { return handlePrismaError(err, res); }
});

router.delete("/admin/merchants/:merchantId/promotions/:promotionId", requireJwt, requireAdmin, async (req, res) => {
  const merchantId = parseIntParam(req.params.merchantId);
  const promotionId = parseIntParam(req.params.promotionId);
  if (!merchantId || !promotionId) return sendError(res, 400, "VALIDATION_ERROR", "Invalid params");
  try {
    const existing = await prisma.promotion.findFirst({ where: { id: promotionId, merchantId } });
    if (!existing) return sendError(res, 404, "NOT_FOUND", "Promotion not found");
    if (existing.status === "archived") return sendError(res, 409, "ALREADY_ARCHIVED", "Already archived");
    const promotion = await prisma.promotion.update({ where: { id: promotionId }, data: { status: "archived" } });
    emitPvHook("promo.promotion.archived", { tc: "TC-PROMO-PROMO-ARCHIVE-ADMIN-01", sev: "info", stable: "promo:promotion:archived", merchantId, promotionId: promotion.id, promotionName: promotion.name, actorUserId: req.userId, actorRole: "pv_admin" });
    return res.json({ promotion });
  } catch (err) { return handlePrismaError(err, res); }
});

router.get("/admin/merchants/:merchantId/promotions/:promotionId/audit", requireJwt, requireAdmin, async (req, res) => {
  const merchantId = parseIntParam(req.params.merchantId);
  const promotionId = parseIntParam(req.params.promotionId);
  if (!merchantId || !promotionId) return sendError(res, 400, "VALIDATION_ERROR", "Invalid params");
  try {
    const promo = await prisma.promotion.findFirst({ where: { id: promotionId, merchantId } });
    if (!promo) return sendError(res, 404, "NOT_FOUND", "Promotion not found");
    const logs = await prisma.promoAuditLog.findMany({
      where: { promotionId },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    return res.json({ logs });
  } catch (err) { return handlePrismaError(err, res); }
});

router.post("/admin/merchants/:merchantId/promotions/:promotionId/duplicate", requireJwt, requireAdmin, async (req, res) => {
  const merchantId   = parseIntParam(req.params.merchantId);
  const promotionId  = parseIntParam(req.params.promotionId);
  if (!merchantId || !promotionId) return sendError(res, 400, "VALIDATION_ERROR", "Invalid params");
  try {
    const existing = await prisma.promotion.findFirst({
      where: { id: promotionId, merchantId },
      include: { items: { select: { promoItemId: true } } },
    });
    if (!existing) return sendError(res, 404, "NOT_FOUND", "Promotion not found");
    if (existing.status !== "archived")
      return sendError(res, 409, "INVALID_STATE", "Only archived promotions can be duplicated");

    const clone = await prisma.promotion.create({
      data: {
        merchantId,
        name: existing.name, description: existing.description, legalText: existing.legalText,
        mechanic: existing.mechanic, earnPerUnit: existing.earnPerUnit, threshold: existing.threshold,
        maxGrantsPerVisit: existing.maxGrantsPerVisit,
        rewardType: existing.rewardType, rewardValue: existing.rewardValue,
        rewardSku: existing.rewardSku, rewardNote: existing.rewardNote,
        categoryId: existing.categoryId, status: "draft", startAt: null, endAt: null,
        items: { create: existing.items.map(i => ({ promoItemId: i.promoItemId })) },
      },
      include: { items: { include: { promoItem: { include: { skus: true } } } }, category: true },
    });

    emitPvHook("promo.promotion.duplicated", {
      tc: "TC-PROMO-PROMO-DUP-ADMIN-01", sev: "info", stable: "promo:promotion:duplicated",
      merchantId, sourcePromotionId: promotionId, newPromotionId: clone.id,
      promotionName: clone.name, actorUserId: req.userId, actorRole: "pv_admin",
    });

    return res.status(201).json({ promotion: clone });
  } catch (err) { return handlePrismaError(err, res); }
});

// ── Admin OfferSets ────────────────────────────────────────────

router.get("/admin/merchants/:merchantId/offer-sets", requireJwt, requireAdmin, async (req, res) => {
  const merchantId = parseIntParam(req.params.merchantId);
  if (!merchantId) return sendError(res, 400, "VALIDATION_ERROR", "Invalid merchantId");
  try {
    const { status } = req.query;
    const where = { merchantId };
    if (VALID_OS_STATUSES.includes(status)) where.status = status;
    const offerSets = await prisma.offerSet.findMany({
      where,
      include: {
        promotions: { include: { promotion: true }, orderBy: { sortOrder: "asc" } },
        stores: { include: { store: { select: { id: true, name: true } } } },
      },
      orderBy: { id: "asc" },
    });
    return res.json({ offerSets });
  } catch (err) { return handlePrismaError(err, res); }
});

router.post("/admin/merchants/:merchantId/offer-sets", requireJwt, requireAdmin, async (req, res) => {
  const merchantId = parseIntParam(req.params.merchantId);
  if (!merchantId) return sendError(res, 400, "VALIDATION_ERROR", "Invalid merchantId");
  try {
    const { name, description, scope, promotionIds, storeIds, startAt, endAt } = req.body || {};
    if (!name || !String(name).trim()) return sendError(res, 400, "VALIDATION_ERROR", "name is required");
    const resolvedScope = VALID_OS_SCOPES.includes(scope) ? scope : "merchant";
    if (resolvedScope === "store") {
      if (!Array.isArray(storeIds) || storeIds.length === 0) return sendError(res, 400, "VALIDATION_ERROR", "storeIds required when scope is store");
      const found = await prisma.store.findMany({ where: { id: { in: storeIds }, merchantId }, select: { id: true } });
      if (found.length !== storeIds.length) return sendError(res, 422, "INVALID_STORE", "One or more storeIds not found");
    }
    const promIds = Array.isArray(promotionIds) ? promotionIds : [];
    if (promIds.length > 0) {
      const found = await prisma.promotion.findMany({ where: { id: { in: promIds }, merchantId }, select: { id: true } });
      if (found.length !== promIds.length) return sendError(res, 422, "INVALID_PROMOTION", "One or more promotionIds not found");
    }
    const token = generateOfferSetToken();
    const offerSet = await prisma.offerSet.create({
      data: {
        merchantId, name: String(name).trim(),
        description: description ? String(description).trim() : null,
        token, scope: resolvedScope, status: "draft",
        startAt: startAt ? new Date(startAt) : null,
        endAt: endAt ? new Date(endAt) : null,
        promotions: { create: promIds.map((id, idx) => ({ promotionId: id, sortOrder: idx })) },
        stores: resolvedScope === "store" ? { create: storeIds.map((id) => ({ storeId: id })) } : undefined,
      },
      include: {
        promotions: { include: { promotion: true }, orderBy: { sortOrder: "asc" } },
        stores: { include: { store: { select: { id: true, name: true } } } },
      },
    });
    emitPvHook("promo.offer_set.created", { tc: "TC-PROMO-OS-CREATE-ADMIN-01", sev: "info", stable: "promo:offer_set:created", merchantId, offerSetId: offerSet.id, offerSetName: offerSet.name, token: offerSet.token, promotionCount: promIds.length, actorUserId: req.userId, actorRole: "pv_admin" });
    return res.status(201).json({ offerSet });
  } catch (err) { return handlePrismaError(err, res); }
});

router.patch("/admin/merchants/:merchantId/offer-sets/:offerSetId", requireJwt, requireAdmin, async (req, res) => {
  const merchantId = parseIntParam(req.params.merchantId);
  const offerSetId = parseIntParam(req.params.offerSetId);
  if (!merchantId || !offerSetId) return sendError(res, 400, "VALIDATION_ERROR", "Invalid params");
  try {
    const existing = await prisma.offerSet.findFirst({ where: { id: offerSetId, merchantId } });
    if (!existing) return sendError(res, 404, "NOT_FOUND", "OfferSet not found");
    if (existing.status === "archived") return sendError(res, 409, "ARCHIVED", "Cannot update an archived OfferSet");
    const { name, description, status, storeIds, promotionIds, startAt, endAt } = req.body || {};
    const data = {};
    if (name !== undefined) { if (!String(name).trim()) return sendError(res, 400, "VALIDATION_ERROR", "name cannot be empty"); data.name = String(name).trim(); }
    if (description !== undefined) data.description = description ? String(description).trim() : null;
    if (status !== undefined) { if (!VALID_OS_STATUSES.includes(status)) return sendError(res, 400, "VALIDATION_ERROR", "Invalid status"); data.status = status; }
    if (startAt !== undefined) data.startAt = startAt ? new Date(startAt) : null;
    if (endAt !== undefined) data.endAt = endAt ? new Date(endAt) : null;
    let storeOps, promoOps;
    if (storeIds !== undefined) {
      const found = await prisma.store.findMany({ where: { id: { in: storeIds }, merchantId }, select: { id: true } });
      if (found.length !== storeIds.length) return sendError(res, 422, "INVALID_STORE", "One or more storeIds not found");
      storeOps = { deleteMany: { offerSetId }, create: storeIds.map((id) => ({ storeId: id })) };
    }
    if (promotionIds !== undefined) {
      const promIds = Array.isArray(promotionIds) ? promotionIds : [];
      if (promIds.length > 0) {
        const found = await prisma.promotion.findMany({ where: { id: { in: promIds }, merchantId }, select: { id: true } });
        if (found.length !== promIds.length) return sendError(res, 422, "INVALID_PROMOTION", "One or more promotionIds not found");
      }
      promoOps = { deleteMany: { offerSetId }, create: promIds.map((id, idx) => ({ promotionId: id, sortOrder: idx })) };
    }
    if (!Object.keys(data).length && !storeOps && !promoOps) return sendError(res, 400, "VALIDATION_ERROR", "No updatable fields provided");
    const offerSet = await prisma.offerSet.update({
      where: { id: offerSetId },
      data: { ...data, ...(storeOps ? { stores: storeOps } : {}), ...(promoOps ? { promotions: promoOps } : {}) },
      include: { promotions: { include: { promotion: true }, orderBy: { sortOrder: "asc" } }, stores: { include: { store: { select: { id: true, name: true } } } } },
    });
    emitPvHook("promo.offer_set.updated", { tc: "TC-PROMO-OS-UPDATE-ADMIN-01", sev: "info", stable: "promo:offer_set:updated", merchantId, offerSetId: offerSet.id, offerSetName: offerSet.name, changedFields: [...Object.keys(data), ...(storeOps ? ["stores"] : []), ...(promoOps ? ["promotions"] : [])], actorUserId: req.userId, actorRole: "pv_admin" });
    return res.json({ offerSet });
  } catch (err) { return handlePrismaError(err, res); }
});

router.post("/admin/merchants/:merchantId/offer-sets/:offerSetId/publish", requireJwt, requireAdmin, async (req, res) => {
  const merchantId = parseIntParam(req.params.merchantId);
  const offerSetId = parseIntParam(req.params.offerSetId);
  if (!merchantId || !offerSetId) return sendError(res, 400, "VALIDATION_ERROR", "Invalid params");
  try {
    const existing = await prisma.offerSet.findFirst({ where: { id: offerSetId, merchantId }, include: { promotions: true } });
    if (!existing) return sendError(res, 404, "NOT_FOUND", "OfferSet not found");
    if (existing.status !== "draft") return sendError(res, 409, "INVALID_STATUS", `Only draft OfferSets can be published (current: ${existing.status})`);
    if (existing.promotions.length === 0) return sendError(res, 422, "NO_PROMOTIONS", "Cannot publish an OfferSet with no promotions");
    const offerSet = await prisma.offerSet.update({
      where: { id: offerSetId }, data: { status: "active" },
      include: { promotions: { include: { promotion: true }, orderBy: { sortOrder: "asc" } }, stores: { include: { store: { select: { id: true, name: true } } } } },
    });
    emitPvHook("promo.offer_set.published", { tc: "TC-PROMO-OS-PUBLISH-ADMIN-01", sev: "info", stable: "promo:offer_set:published", merchantId, offerSetId: offerSet.id, token: offerSet.token, actorUserId: req.userId, actorRole: "pv_admin" });
    return res.json({ offerSet });
  } catch (err) { return handlePrismaError(err, res); }
});

router.post("/admin/merchants/:merchantId/offer-sets/:offerSetId/expire", requireJwt, requireAdmin, async (req, res) => {
  const merchantId = parseIntParam(req.params.merchantId);
  const offerSetId = parseIntParam(req.params.offerSetId);
  if (!merchantId || !offerSetId) return sendError(res, 400, "VALIDATION_ERROR", "Invalid params");
  try {
    const existing = await prisma.offerSet.findFirst({ where: { id: offerSetId, merchantId } });
    if (!existing) return sendError(res, 404, "NOT_FOUND", "OfferSet not found");
    if (existing.status !== "active") return sendError(res, 409, "INVALID_STATUS", `Only active OfferSets can be expired (current: ${existing.status})`);
    const offerSet = await prisma.offerSet.update({ where: { id: offerSetId }, data: { status: "expired" } });
    emitPvHook("promo.offer_set.expired", { tc: "TC-PROMO-OS-EXPIRE-ADMIN-01", sev: "info", stable: "promo:offer_set:expired", merchantId, offerSetId: offerSet.id, actorUserId: req.userId, actorRole: "pv_admin" });
    return res.json({ offerSet });
  } catch (err) { return handlePrismaError(err, res); }
});

router.delete("/admin/merchants/:merchantId/offer-sets/:offerSetId", requireJwt, requireAdmin, async (req, res) => {
  const merchantId = parseIntParam(req.params.merchantId);
  const offerSetId = parseIntParam(req.params.offerSetId);
  if (!merchantId || !offerSetId) return sendError(res, 400, "VALIDATION_ERROR", "Invalid params");
  try {
    const existing = await prisma.offerSet.findFirst({ where: { id: offerSetId, merchantId } });
    if (!existing) return sendError(res, 404, "NOT_FOUND", "OfferSet not found");
    if (existing.status === "archived") return sendError(res, 409, "ALREADY_ARCHIVED", "Already archived");
    const offerSet = await prisma.offerSet.update({ where: { id: offerSetId }, data: { status: "archived" } });
    emitPvHook("promo.offer_set.archived", { tc: "TC-PROMO-OS-ARCHIVE-ADMIN-01", sev: "info", stable: "promo:offer_set:archived", merchantId, offerSetId: offerSet.id, actorUserId: req.userId, actorRole: "pv_admin" });
    return res.json({ offerSet });
  } catch (err) { return handlePrismaError(err, res); }
});

module.exports = router;
