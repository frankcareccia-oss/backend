/**
 * product.lifecycle.cron.js — Scheduled state transitions for products and promotions
 *
 * Runs every 15 minutes. Checks:
 *   1. STAGED products/promotions with pvGoLiveAt <= now → activate
 *   2. ACTIVE products with pvSuspendAt <= now → suspend
 *
 * Only runs for non-seed merchants.
 */

"use strict";

const { prisma } = require("../db/prisma");
const { pushProductToPOSOnActivation, suspendProductInPOS } = require("../pos/pos.product.push");

async function runProductLifecycleCron() {
  const now = new Date();
  const stats = { productsActivated: 0, productsSuspended: 0, promosActivated: 0, errors: [] };

  // ── STAGED → ACTIVE: products with go-live time arrived ──
  const readyProducts = await prisma.product.findMany({
    where: {
      status: "staged",
      startAt: { lte: now },
      merchant: { isSeedMerchant: false },
    },
    include: {
      merchant: true,
      posConnection: true,
    },
  });

  for (const product of readyProducts) {
    try {
      const data = {
        status: "active",
        firstActivatedAt: product.firstActivatedAt ?? now,
      };

      // Push to POS if PV-originated and has a connection
      if (product.pvOrigin && product.posConnection) {
        try {
          const posId = await pushProductToPOSOnActivation(product, product.posConnection);
          if (posId) {
            data.externalCatalogId = posId;
            data.posPushedAt = now;
          }
        } catch (pushErr) {
          console.error(`[lifecycle-cron] POS push failed for product ${product.id}:`, pushErr?.message);
          stats.errors.push({ type: "product_push", id: product.id, error: pushErr?.message });
          // Don't block activation — product goes active in PV even if POS push fails
        }
      }

      await prisma.product.update({ where: { id: product.id }, data });
      stats.productsActivated++;

      console.log(JSON.stringify({
        pvHook: "product.activated",
        tc: "TC-LIFECYCLE-CRON",
        productId: product.id,
        merchantId: product.merchantId,
        scheduledFor: product.startAt?.toISOString(),
        activatedAt: now.toISOString(),
        pvOriginated: product.pvOrigin,
        ts: now.toISOString(),
      }));
    } catch (err) {
      console.error(`[lifecycle-cron] Failed to activate product ${product.id}:`, err?.message);
      stats.errors.push({ type: "product_activate", id: product.id, error: err?.message });
    }
  }

  // ── ACTIVE → SUSPENDED: products with suspend time arrived ──
  const readyToSuspend = await prisma.product.findMany({
    where: {
      status: "active",
      pvSuspendAt: { lte: now },
      merchant: { isSeedMerchant: false },
    },
    include: { posConnection: true },
  });

  for (const product of readyToSuspend) {
    try {
      // Hide in POS
      if (product.externalCatalogId && product.posConnection) {
        try {
          await suspendProductInPOS(product, product.posConnection);
        } catch (posErr) {
          console.error(`[lifecycle-cron] POS suspend failed for product ${product.id}:`, posErr?.message);
          stats.errors.push({ type: "product_pos_suspend", id: product.id, error: posErr?.message });
        }
      }

      await prisma.product.update({
        where: { id: product.id },
        data: { status: "suspended" },
      });
      stats.productsSuspended++;

      console.log(JSON.stringify({
        pvHook: "product.suspended",
        tc: "TC-LIFECYCLE-CRON",
        productId: product.id,
        merchantId: product.merchantId,
        scheduledSuspension: true,
        ts: now.toISOString(),
      }));
    } catch (err) {
      console.error(`[lifecycle-cron] Failed to suspend product ${product.id}:`, err?.message);
      stats.errors.push({ type: "product_suspend", id: product.id, error: err?.message });
    }
  }

  // ── STAGED → ACTIVE: promotions with go-live time arrived ──
  const readyPromos = await prisma.promotion.findMany({
    where: {
      status: "staged",
      startAt: { lte: now },
      merchant: { isSeedMerchant: false },
    },
  });

  for (const promo of readyPromos) {
    try {
      await prisma.promotion.update({
        where: { id: promo.id },
        data: {
          status: "active",
          firstActivatedAt: promo.firstActivatedAt ?? now,
        },
      });
      stats.promosActivated++;

      console.log(JSON.stringify({
        pvHook: "promotion.activated",
        tc: "TC-LIFECYCLE-CRON",
        promotionId: promo.id,
        merchantId: promo.merchantId,
        scheduledFor: promo.startAt?.toISOString(),
        ts: now.toISOString(),
      }));
    } catch (err) {
      console.error(`[lifecycle-cron] Failed to activate promotion ${promo.id}:`, err?.message);
      stats.errors.push({ type: "promo_activate", id: promo.id, error: err?.message });
    }
  }

  return stats;
}

module.exports = { runProductLifecycleCron };
