/**
 * promo.bundle.js — Bundle promotion logic
 *
 * Flow:
 * 1. Consumer enrolls in a bundle promo
 * 2. Each purchase, order items are matched against bundle definition
 * 3. Matched items are checked off in BundleProgress
 * 4. When all items purchased → bundle complete → reward granted (next visit)
 *
 * Bundles can be completed across multiple visits (accumulating bundle)
 * or in a single transaction (fixed bundle).
 *
 * Key: bundle items are matched by item name (case-insensitive fuzzy match)
 * since SKU mapping between POS and PV may not be exact.
 */

"use strict";

const { prisma } = require("../db/prisma");

/**
 * Check if any order items match a bundle definition and update progress.
 * Called from the webhook pipeline after order items are available.
 *
 * @param {{ consumerId, merchantId, orderItems: Array<{ itemName, sku? }> }} ctx
 * @returns {Array<{ promotionId, completed, checkedItems, newlyChecked }>}
 */
async function processBundleItems(ctx) {
  const { consumerId, merchantId, orderItems } = ctx;
  if (!orderItems || orderItems.length === 0) return [];

  // Find active bundle promos for this merchant
  const bundlePromos = await prisma.promotion.findMany({
    where: { merchantId, status: "active", promotionType: "bundle" },
    select: { id: true, name: true, bundleDefinition: true },
  });

  if (bundlePromos.length === 0) return [];

  const results = [];
  const now = new Date();

  for (const promo of bundlePromos) {
    const def = promo.bundleDefinition;
    if (!def || !def.items) continue;

    const bundleItems = Array.isArray(def.items) ? def.items : [];
    if (bundleItems.length === 0) continue;

    // Get or create progress
    let progress = await prisma.bundleProgress.findUnique({
      where: { consumerId_promotionId: { consumerId, promotionId: promo.id } },
    });

    if (!progress) {
      progress = await prisma.bundleProgress.create({
        data: {
          consumerId,
          promotionId: promo.id,
          merchantId,
          checkedItems: [],
        },
      });
    }

    // Already complete — skip
    if (progress.complete) continue;

    // Check validity window
    if (def.validityDays) {
      const elapsed = Math.floor((now - new Date(progress.startedAt)) / (1000 * 60 * 60 * 24));
      if (elapsed > def.validityDays) {
        // Expired — reset progress
        await prisma.bundleProgress.update({
          where: { id: progress.id },
          data: { checkedItems: [], startedAt: now },
        });
        progress.checkedItems = [];
      }
    }

    const checked = Array.isArray(progress.checkedItems) ? [...progress.checkedItems] : [];
    const newlyChecked = [];

    // Match order items against bundle items
    for (const orderItem of orderItems) {
      const orderName = (orderItem.itemName || "").toLowerCase().trim();
      const orderSku = (orderItem.sku || "").toLowerCase().trim();

      for (const bundleItem of bundleItems) {
        const bundleNameLower = (bundleItem.name || "").toLowerCase().trim();
        const bundleSkuLower = (bundleItem.sku || "").toLowerCase().trim();
        // Use original case for the key stored in checkedItems
        const key = bundleItem.sku || bundleItem.name;

        // Already checked off
        if (checked.includes(key)) continue;

        // Match by SKU (exact, case-insensitive) or name (fuzzy contains)
        const skuMatch = bundleSkuLower && orderSku && orderSku === bundleSkuLower;
        const nameMatch = orderName && bundleNameLower && (
          orderName.includes(bundleNameLower) || bundleNameLower.includes(orderName)
        );

        if (skuMatch || nameMatch) {
          checked.push(key);
          newlyChecked.push(key);
          break; // One order item matches one bundle item
        }
      }
    }

    if (newlyChecked.length === 0) continue;

    // Check if bundle is now complete
    const totalNeeded = bundleItems.length;
    const complete = checked.length >= totalNeeded;

    await prisma.bundleProgress.update({
      where: { id: progress.id },
      data: {
        checkedItems: checked,
        complete,
        completedAt: complete ? now : null,
      },
    });

    // If complete, grant reward (for next visit)
    if (complete) {
      const redemption = await prisma.promoRedemption.create({
        data: {
          promotionId: promo.id,
          consumerId,
          merchantId,
          pointsDecremented: 0,
          balanceBefore: 0,
          balanceAfter: 0,
          status: "granted",
          grantedAt: now,
        },
      });

      await prisma.entitlement.create({
        data: {
          consumerId,
          merchantId,
          type: "reward",
          sourceId: redemption.id,
          status: "active",
          metadataJson: {
            displayLabel: `Bundle complete: ${promo.name}`,
            rewardProgramId: promo.id,
            bundleComplete: true,
          },
        },
      });

      console.log(`[promo.bundle] bundle complete: consumer=${consumerId} promo=${promo.id} "${promo.name}"`);
    }

    results.push({
      promotionId: promo.id,
      promotionName: promo.name,
      completed: complete,
      checkedItems: checked,
      newlyChecked,
      totalItems: totalNeeded,
    });
  }

  return results;
}

module.exports = { processBundleItems };
