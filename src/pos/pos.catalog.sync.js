// src/pos/pos.catalog.sync.js
//
// POS Catalog Sync — imports normalized catalog data into PV Product/ProductCategory tables.
// POS-agnostic: works with any adapter that implements listCatalog().
//
// Usage:
//   await syncCatalogFromPos(prisma, adapter, { merchantId, posConnectionId });

"use strict";

/**
 * Sync catalog from a POS adapter into PV Product and ProductCategory tables.
 *
 * - Categories: upsert by externalCatalogId (create if new, update name if changed)
 * - Products: upsert by externalCatalogId (create if new, update fields if changed)
 * - Existing PV-native products are never touched
 * - Returns summary of what was created/updated
 *
 * @param {object} prisma
 * @param {PVPosAdapter} adapter — must implement listCatalog()
 * @param {{ merchantId: number, posConnectionId: number }} ctx
 */
async function syncCatalogFromPos(prisma, adapter, { merchantId, posConnectionId }) {
  const { categories, items } = await adapter.listCatalog();

  const summary = {
    categoriesCreated: 0,
    categoriesUpdated: 0,
    productsCreated: 0,
    productsUpdated: 0,
    productsSkipped: 0,
  };

  // ── Sync categories ──────────────────────────────────────────
  const categoryIdMap = {}; // externalId → PV categoryId

  for (const cat of categories) {
    const existing = await prisma.productCategory.findFirst({
      where: { merchantId, externalCatalogId: cat.externalId },
      select: { id: true, name: true },
    });

    if (existing) {
      if (existing.name !== cat.name) {
        await prisma.productCategory.update({
          where: { id: existing.id },
          data: { name: cat.name },
        });
        summary.categoriesUpdated++;
      }
      categoryIdMap[cat.externalId] = existing.id;
    } else {
      const created = await prisma.productCategory.create({
        data: {
          merchantId,
          name: cat.name,
          catalogSource: "pos",
          externalCatalogId: cat.externalId,
        },
        select: { id: true },
      });
      categoryIdMap[cat.externalId] = created.id;
      summary.categoriesCreated++;
    }
  }

  // ── Sync products ────────────────────────────────────────────
  for (const item of items) {
    const existing = await prisma.product.findFirst({
      where: { merchantId, externalCatalogId: item.externalId },
      select: { id: true },
    });

    const categoryId = item.categoryExternalId
      ? categoryIdMap[item.categoryExternalId] || null
      : null;

    if (existing) {
      await prisma.product.update({
        where: { id: existing.id },
        data: {
          name: item.name,
          description: item.description,
          imageUrl: item.imageUrl,
          upc: item.upc,
          priceCents: item.priceCents,
          categoryId,
        },
      });
      summary.productsUpdated++;
    } else {
      // Generate a unique SKU for the imported product
      const sku = await generatePosSku(prisma, merchantId);

      await prisma.product.create({
        data: {
          merchantId,
          sku,
          name: item.name,
          description: item.description,
          imageUrl: item.imageUrl,
          status: "active",
          catalogSource: "pos",
          externalCatalogId: item.externalId,
          posConnectionId,
          upc: item.upc,
          priceCents: item.priceCents,
          categoryId,
        },
      });
      summary.productsCreated++;
    }
  }

  console.log(`[catalog.sync] merchantId=${merchantId}: ${JSON.stringify(summary)}`);
  return summary;
}

/**
 * Generate a unique SKU for a POS-imported product: POS-0001, POS-0002, ...
 */
async function generatePosSku(prisma, merchantId) {
  const last = await prisma.product.findFirst({
    where: { merchantId, sku: { startsWith: "POS-" } },
    orderBy: { sku: "desc" },
    select: { sku: true },
  });

  const nextNum = last ? parseInt(last.sku.replace("POS-", ""), 10) + 1 : 1;
  return `POS-${String(nextNum).padStart(4, "0")}`;
}

module.exports = { syncCatalogFromPos };
