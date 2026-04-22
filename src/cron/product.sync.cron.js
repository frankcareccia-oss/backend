/**
 * product.sync.cron.js — Nightly product sync from POS
 *
 * Pulls products from Clover/Square and syncs to PV.
 * - New POS products → create in PV with pvOrigin=false, status=active
 * - Existing POS products → update POS fields only, NEVER touch pv* fields
 * - POS products removed → suspend in PV
 *
 * Schedule: 3:00 AM UTC daily
 */

"use strict";

const { prisma } = require("../db/prisma");
const { decrypt } = require("../utils/encrypt");

const CLOVER_API_BASE = process.env.CLOVER_API_BASE || "https://apisandbox.dev.clover.com";
const IS_SANDBOX = (process.env.SQUARE_APP_ID || "").startsWith("sandbox-");
const SQUARE_API_BASE = IS_SANDBOX
  ? "https://connect.squareupsandbox.com/v2"
  : "https://connect.squareup.com/v2";

async function fetchCloverProducts(conn) {
  const token = decrypt(conn.accessTokenEnc);
  const url = `${CLOVER_API_BASE}/v3/merchants/${conn.externalMerchantId}/items?limit=500`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
  if (!res.ok) throw new Error(`Clover items fetch failed: ${res.status}`);
  const data = await res.json();
  return (data.elements || []).map((item) => ({
    id: item.id,
    name: item.name,
    price: item.price || 0,
    sku: item.sku || null,
    category: item.categories?.elements?.[0]?.name || null,
    hidden: item.hidden || false,
  }));
}

async function fetchSquareProducts(conn) {
  const token = decrypt(conn.accessTokenEnc);
  const products = [];
  let cursor;

  for (let page = 0; page < 20; page++) {
    const params = new URLSearchParams({ types: "ITEM" });
    if (cursor) params.set("cursor", cursor);

    const url = `${SQUARE_API_BASE}/catalog/list?${params}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, "Square-Version": "2024-01-18" },
    });
    if (!res.ok) throw new Error(`Square catalog list failed: ${res.status}`);
    const data = await res.json();

    for (const obj of data.objects || []) {
      if (obj.type !== "ITEM" || obj.is_deleted) continue;
      const item = obj.item_data || {};
      const variation = item.variations?.[0]?.item_variation_data;
      products.push({
        id: obj.id,
        name: item.name || "",
        price: variation?.price_money?.amount || 0,
        sku: variation?.sku || null,
        category: null,
        hidden: item.is_archived || false,
      });
    }

    cursor = data.cursor;
    if (!cursor) break;
  }
  return products;
}

async function runProductSyncCron() {
  const connections = await prisma.posConnection.findMany({
    where: { status: "active", posType: { in: ["clover", "square"] } },
    include: { merchant: { select: { id: true, isSeedMerchant: true } } },
  });

  const stats = { merchants: 0, created: 0, updated: 0, suspended: 0, errors: [] };

  for (const conn of connections) {
    if (conn.merchant.isSeedMerchant) continue;
    const merchantId = conn.merchantId;

    try {
      const posProducts = conn.posType === "clover"
        ? await fetchCloverProducts(conn)
        : await fetchSquareProducts(conn);

      // Sync each POS product
      for (const posProduct of posProducts) {
        if (posProduct.hidden) continue; // skip hidden items

        const existing = await prisma.product.findFirst({
          where: { merchantId, externalCatalogId: posProduct.id },
        });

        if (!existing) {
          // New POS product — create in PV
          const skuNum = await prisma.product.count({ where: { merchantId } }) + 1;
          await prisma.product.create({
            data: {
              merchantId,
              pvOrigin: false,
              catalogSource: "pos",
              externalCatalogId: posProduct.id,
              posConnectionId: conn.id,
              name: posProduct.name,
              priceCents: posProduct.price,
              sku: `PRD-${String(skuNum).padStart(4, "0")}`,
              status: "active",
              firstActivatedAt: new Date(),
              posLastSyncedAt: new Date(),
            },
          });
          stats.created++;
        } else if (!existing.pvOrigin) {
          // Existing POS-originated — update POS fields only, NEVER touch pv* fields
          await prisma.product.update({
            where: { id: existing.id },
            data: {
              name: posProduct.name,
              priceCents: posProduct.price,
              posLastSyncedAt: new Date(),
            },
          });
          stats.updated++;
        }
        // pvOrigin=true products: skip entirely — PV owns these
      }

      // Products in PV from POS but no longer in POS → suspend
      const pvPosProducts = await prisma.product.findMany({
        where: { merchantId, pvOrigin: false, status: "active", posConnectionId: conn.id },
      });
      const posIds = new Set(posProducts.map((p) => p.id));

      for (const pvProduct of pvPosProducts) {
        if (pvProduct.externalCatalogId && !posIds.has(pvProduct.externalCatalogId)) {
          await prisma.product.update({
            where: { id: pvProduct.id },
            data: { status: "suspended" },
          });
          stats.suspended++;

          console.log(JSON.stringify({
            pvHook: "product.sync.removed_from_pos",
            tc: "TC-PRODUCT-SYNC",
            merchantId,
            productId: pvProduct.id,
            ts: new Date().toISOString(),
          }));
        }
      }

      stats.merchants++;
    } catch (err) {
      console.error(`[product-sync] Failed for merchant ${merchantId}:`, err?.message);
      stats.errors.push({ merchantId, error: err?.message });
    }
  }

  console.log(JSON.stringify({
    pvHook: "cron.product_sync.complete",
    tc: "TC-PRODUCT-SYNC",
    ...stats,
    ts: new Date().toISOString(),
  }));

  return stats;
}

module.exports = { runProductSyncCron };
