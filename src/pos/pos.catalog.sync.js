// src/pos/pos.catalog.sync.js
//
// POS Catalog Sync — imports normalized catalog data into PV Product/ProductCategory tables.
// POS-agnostic: works with any adapter that implements listCatalog().
// Tracks changes in CatalogSyncLog for merchant visibility.
//
// Usage:
//   await syncCatalogFromPos(prisma, adapter, { merchantId, posConnectionId, trigger });

"use strict";

/**
 * Sync catalog from a POS adapter into PV Product and ProductCategory tables.
 *
 * @param {object} prisma
 * @param {PVPosAdapter} adapter — must implement listCatalog()
 * @param {{ merchantId: number, posConnectionId: number, trigger?: string }} ctx
 */
async function syncCatalogFromPos(prisma, adapter, { merchantId, posConnectionId, trigger = "manual" }) {
  const { categories, items } = await adapter.listCatalog();

  const summary = {
    categoriesCreated: 0,
    categoriesUpdated: 0,
    productsCreated: 0,
    productsUpdated: 0,
  };

  const changes = []; // detailed change log

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
        changes.push({ action: "updated", type: "category", name: cat.name, field: "name", oldValue: existing.name });
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
      changes.push({ action: "created", type: "category", name: cat.name });
    }
  }

  // ── Sync products ────────────────────────────────────────────
  for (const item of items) {
    const existing = await prisma.product.findFirst({
      where: { merchantId, externalCatalogId: item.externalId },
      select: { id: true, name: true, description: true, priceCents: true, upc: true, imageUrl: true },
    });

    const categoryId = item.categoryExternalId
      ? categoryIdMap[item.categoryExternalId] || null
      : null;

    if (existing) {
      // Track what changed
      const changedFields = [];
      if (item.name && item.name !== existing.name) changedFields.push("name");
      if (item.description !== undefined && item.description !== existing.description) changedFields.push("description");
      if (item.priceCents !== undefined && item.priceCents !== existing.priceCents) changedFields.push("price");
      if (item.upc !== undefined && item.upc !== existing.upc) changedFields.push("upc");
      if (item.imageUrl !== undefined && item.imageUrl !== existing.imageUrl) changedFields.push("imageUrl");

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
      if (changedFields.length > 0) {
        changes.push({ action: "updated", type: "product", name: item.name, fields: changedFields });
      }
    } else {
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
      changes.push({ action: "created", type: "product", name: item.name, price: item.priceCents });
    }
  }

  // ── Update PosConnection sync timestamp ──────────────────────
  await prisma.posConnection.update({
    where: { id: posConnectionId },
    data: {
      lastCatalogSyncAt: new Date(),
      lastCatalogSyncSummary: summary,
    },
  });

  // ── Write sync log ───────────────────────────────────────────
  await prisma.catalogSyncLog.create({
    data: {
      posConnectionId,
      merchantId,
      trigger,
      summary,
      changes: changes.length > 0 ? changes : null,
    },
  });

  const totalChanges = summary.categoriesCreated + summary.categoriesUpdated + summary.productsCreated + changes.filter(c => c.fields?.length).length;
  console.log(`[catalog.sync] merchantId=${merchantId} trigger=${trigger}: ${JSON.stringify(summary)} (${totalChanges} actual changes)`);
  return { summary, changes };
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
