// src/pos/pos.catalog.push.js
//
// Push PV catalog changes to connected POS systems.
// POS-agnostic: resolves the adapter from PosConnection and delegates.
//
// Usage (fire-and-forget after product create/update):
//   pushProductToPos(prisma, { merchantId, product })
//   pushCategoryToPos(prisma, { merchantId, category })

"use strict";

const { SquareAdapter } = require("./adapters/square.adapter");

/**
 * Resolve the POS adapter for a merchant, if they have an active connection.
 * Returns null if no connection exists.
 */
async function resolveAdapter(prisma, merchantId) {
  const conn = await prisma.posConnection.findFirst({
    where: { merchantId, status: "active" },
  });
  if (!conn) return null;

  if (conn.posType === "square") {
    return { adapter: new SquareAdapter(conn), connection: conn };
  }
  // Future: add clover, toast, etc.
  return null;
}

/**
 * Push a PV product to the merchant's connected POS.
 * Creates or updates the item in the POS catalog.
 * Updates the PV product with the returned externalCatalogId.
 *
 * Fire-and-forget — logs errors but never throws.
 */
async function pushProductToPos(prisma, { merchantId, product }) {
  try {
    const resolved = await resolveAdapter(prisma, merchantId);
    if (!resolved) return; // no POS connection, nothing to push

    const { adapter, connection } = resolved;

    // Resolve category's externalCatalogId if product has a category
    let categoryExternalId = null;
    if (product.categoryId) {
      const cat = await prisma.productCategory.findUnique({
        where: { id: product.categoryId },
        select: { externalCatalogId: true },
      });
      categoryExternalId = cat?.externalCatalogId || null;
    }

    const result = await adapter.pushProduct({
      name: product.name,
      description: product.description,
      sku: product.sku,
      upc: product.upc,
      priceCents: product.priceCents,
      currency: "USD",
      categoryExternalId,
      externalCatalogId: product.externalCatalogId,
    });

    if (result.externalId && result.externalId !== product.externalCatalogId) {
      await prisma.product.update({
        where: { id: product.id },
        data: {
          externalCatalogId: result.externalId,
          posConnectionId: connection.id,
          catalogSource: product.catalogSource || "native",
        },
      });
    }

    console.log(`[catalog.push] product "${product.name}" pushed to ${connection.posType}: ${result.externalId}`);
  } catch (e) {
    console.error(`[catalog.push] product push failed: ${product.name}`, e?.message || String(e));
  }
}

/**
 * Push a PV category to the merchant's connected POS.
 * Creates or updates the category in the POS catalog.
 * Updates the PV category with the returned externalCatalogId.
 */
async function pushCategoryToPos(prisma, { merchantId, category }) {
  try {
    const resolved = await resolveAdapter(prisma, merchantId);
    if (!resolved) return;

    const { adapter } = resolved;

    const result = await adapter.pushCategory({
      name: category.name,
      externalCatalogId: category.externalCatalogId,
    });

    if (result.externalId && result.externalId !== category.externalCatalogId) {
      await prisma.productCategory.update({
        where: { id: category.id },
        data: {
          externalCatalogId: result.externalId,
          catalogSource: category.catalogSource || "native",
        },
      });
    }

    console.log(`[catalog.push] category "${category.name}" pushed: ${result.externalId}`);
  } catch (e) {
    console.error(`[catalog.push] category push failed: ${category.name}`, e?.message || String(e));
  }
}

module.exports = { pushProductToPos, pushCategoryToPos };
