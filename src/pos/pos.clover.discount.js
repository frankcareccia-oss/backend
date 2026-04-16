/**
 * pos.clover.discount.js — Clover discount reward delivery
 *
 * When a consumer earns a milestone reward on a Clover merchant, this module
 * applies the discount directly to a Clover order via API.
 *
 * Two timing modes (driven by promotion config, defaulting to "next_visit"):
 *   - instant:    apply discount to the current order (same payment that triggered milestone)
 *   - next_visit: store as pending, apply on the consumer's next payment
 *
 * Discount guard: fixed-amount discounts are NEVER applied if the order total
 * is less than the reward value — the consumer must not get money back.
 *
 * Requires: active Clover PosConnection with Orders R/W permission.
 */

"use strict";

const { prisma } = require("../db/prisma");
const { decrypt } = require("../utils/encrypt");

const CLOVER_API_BASE = process.env.CLOVER_API_BASE || "https://apisandbox.dev.clover.com";

/**
 * Make an authenticated request to Clover API v3.
 */
async function cloverRequest(accessToken, merchantId, path, method, body) {
  const url = `${CLOVER_API_BASE}/v3/merchants/${merchantId}${path}`;
  const opts = {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  const data = await res.json();
  if (!res.ok) {
    const errMsg = data?.message || `Clover API ${res.status}`;
    throw new Error(errMsg);
  }
  return data;
}

/**
 * Get the total for a Clover order (sum of line item prices, in cents).
 */
async function getOrderTotal(accessToken, merchantId, orderId) {
  const order = await cloverRequest(accessToken, merchantId, `/orders/${orderId}?expand=lineItems`, "GET");
  let total = 0;
  if (order.lineItems?.elements) {
    for (const li of order.lineItems.elements) {
      total += li.price || 0;
    }
  }
  return { total, order };
}

/**
 * Build the discount display name from promotion data.
 * This text appears on the Clover receipt.
 */
function buildDiscountName(promo, itemName) {
  const prefix = "PerkValet Reward";
  if (promo.rewardType === "free_item" && itemName) {
    return `${prefix} — Free ${itemName}`;
  }
  if (promo.rewardType === "discount_fixed" && promo.rewardValue) {
    return `${prefix} — $${(promo.rewardValue / 100).toFixed(2)} off`;
  }
  if (promo.rewardType === "discount_pct" && promo.rewardValue) {
    return `${prefix} — ${promo.rewardValue}% off`;
  }
  if (promo.rewardNote) return `${prefix} — ${promo.rewardNote}`;
  return `${prefix} — ${promo.name}`;
}

/**
 * Resolve the reward amount in cents for a given promotion.
 * Same logic as pos.giftcard.js resolveRewardAmountCents.
 */
async function resolveRewardAmountCents(promo, merchantId) {
  if (promo.rewardType === "discount_fixed" && promo.rewardValue) {
    return promo.rewardValue; // already in cents
  }
  if (promo.rewardType === "free_item" && promo.rewardSku) {
    const product = await prisma.product.findFirst({
      where: { merchantId, sku: promo.rewardSku, status: "active" },
      select: { priceCents: true, name: true },
    });
    if (product?.priceCents) return product.priceCents;
    if (promo.rewardValue) return promo.rewardValue;
    return null;
  }
  // Percentage discounts don't need a pre-resolved amount
  if (promo.rewardType === "discount_pct" && promo.rewardValue) {
    return null; // handled via percentage field
  }
  return null;
}

/**
 * Apply a discount to a Clover order.
 * Returns the created discount record or null if skipped.
 *
 * @param {object} params
 * @param {object} params.posConnection — PosConnection row
 * @param {string} params.orderId — Clover order ID
 * @param {object} params.promo — promotion data { id, name, rewardType, rewardValue, rewardSku, rewardNote }
 * @param {number} params.consumerId
 * @param {number} params.entitlementId — optional, links to wallet entitlement
 */
async function applyCloverDiscount({ posConnection, orderId, promo, consumerId, entitlementId }) {
  const accessToken = decrypt(posConnection.accessTokenEnc);
  const merchantId = posConnection.externalMerchantId;

  // Resolve amount for fixed/free_item discounts
  const amountCents = await resolveRewardAmountCents(promo, posConnection.merchantId);
  const isPercentage = promo.rewardType === "discount_pct";

  if (!isPercentage && !amountCents) {
    console.log(`[clover.discount] skipping — no calculable amount for promo ${promo.id} (${promo.rewardType})`);
    return null;
  }

  // ── Discount guard: check order total >= reward for fixed discounts ──
  if (!isPercentage && amountCents) {
    const { total } = await getOrderTotal(accessToken, merchantId, orderId);
    if (total < amountCents) {
      const msg = `order total ($${(total / 100).toFixed(2)}) < reward value ($${(amountCents / 100).toFixed(2)}) — reward stays pending`;
      console.log(`[clover.discount] SKIPPED: ${msg}`);
      console.log(JSON.stringify({
        pvHook: "clover.discount.skipped",
        ts: new Date().toISOString(),
        tc: "TC-CLO-DISC-GUARD",
        sev: "warn",
        consumerId,
        promotionId: promo.id,
        orderId,
        orderTotal: total,
        rewardAmount: amountCents,
      }));

      // Record as skipped
      await prisma.posRewardDiscount.create({
        data: {
          consumerId,
          merchantId: posConnection.merchantId,
          posConnectionId: posConnection.id,
          entitlementId: entitlementId || null,
          promotionId: promo.id,
          cloverOrderId: orderId,
          discountName: buildDiscountName(promo),
          amountCents,
          rewardType: promo.rewardType,
          status: "skipped",
          skippedReason: msg,
        },
      });
      return { skipped: true, reason: msg };
    }
  }

  // ── Resolve item name for free_item rewards ──
  let itemName = null;
  if (promo.rewardType === "free_item" && promo.rewardSku) {
    const product = await prisma.product.findFirst({
      where: { merchantId: posConnection.merchantId, sku: promo.rewardSku, status: "active" },
      select: { name: true },
    });
    itemName = product?.name || null;
  }

  const discountName = buildDiscountName(promo, itemName);

  // ── Apply the discount via Clover API ──
  const discountBody = { name: discountName };
  if (isPercentage) {
    discountBody.percentage = promo.rewardValue;
  } else {
    discountBody.amount = -amountCents;
  }

  const discount = await cloverRequest(
    accessToken,
    merchantId,
    `/orders/${orderId}/discounts`,
    "POST",
    discountBody
  );

  // ── Record in PV ──
  const record = await prisma.posRewardDiscount.create({
    data: {
      consumerId,
      merchantId: posConnection.merchantId,
      posConnectionId: posConnection.id,
      entitlementId: entitlementId || null,
      promotionId: promo.id,
      cloverOrderId: orderId,
      cloverDiscountId: discount.id,
      discountName,
      amountCents: isPercentage ? null : amountCents,
      percentage: isPercentage ? promo.rewardValue : null,
      rewardType: promo.rewardType,
      status: "applied",
      appliedAt: new Date(),
    },
  });

  console.log(`[clover.discount] applied "${discountName}" to order ${orderId} for consumer ${consumerId}`);
  console.log(JSON.stringify({
    pvHook: "clover.discount.applied",
    ts: new Date().toISOString(),
    tc: "TC-CLO-DISC-01",
    sev: "info",
    consumerId,
    promotionId: promo.id,
    orderId,
    discountId: discount.id,
    discountName,
    amountCents: isPercentage ? null : amountCents,
    percentage: isPercentage ? promo.rewardValue : null,
  }));

  return { applied: true, discountId: discount.id, recordId: record.id, discountName };
}

/**
 * Issue a Clover discount reward for a milestone.
 * Called from pos.stamps.js when milestoneEarned === true on a Clover merchant.
 *
 * For "instant" timing: applies discount to the current order.
 * For "next_visit" timing: stores as pending for the next payment webhook.
 *
 * Fire-and-forget — never blocks the stamp pipeline.
 *
 * @param {object} params
 * @param {number} params.consumerId
 * @param {number} params.merchantId
 * @param {object} params.promo — { id, name, rewardType, rewardValue, rewardSku, rewardNote }
 * @param {string|null} params.orderId — Clover order ID (available for instant rewards)
 * @param {number|null} params.entitlementId — links to wallet entitlement
 */
async function issueCloverDiscountReward({ consumerId, merchantId, promo, orderId, entitlementId }) {
  try {
    // Find the Clover PosConnection for this merchant
    const conn = await prisma.posConnection.findFirst({
      where: { merchantId, posType: "clover", status: "active" },
    });
    if (!conn) {
      console.log(`[clover.discount] skipping — no active Clover connection for merchant ${merchantId}`);
      return null;
    }

    // Default to "next_visit" timing (promo.rewardTiming not yet in schema)
    const timing = promo.rewardTiming || "next_visit";

    if (timing === "instant" && orderId) {
      // Apply discount to the current order immediately
      return await applyCloverDiscount({ posConnection: conn, orderId, promo, consumerId, entitlementId });
    }

    // ── Next-visit: store as pending ──
    const amountCents = await resolveRewardAmountCents(promo, merchantId);
    let itemName = null;
    if (promo.rewardType === "free_item" && promo.rewardSku) {
      const product = await prisma.product.findFirst({
        where: { merchantId, sku: promo.rewardSku, status: "active" },
        select: { name: true },
      });
      itemName = product?.name || null;
    }

    const record = await prisma.posRewardDiscount.create({
      data: {
        consumerId,
        merchantId,
        posConnectionId: conn.id,
        entitlementId: entitlementId || null,
        promotionId: promo.id,
        discountName: buildDiscountName(promo, itemName),
        amountCents: promo.rewardType === "discount_pct" ? null : amountCents,
        percentage: promo.rewardType === "discount_pct" ? promo.rewardValue : null,
        rewardType: promo.rewardType,
        status: "pending",
      },
    });

    console.log(`[clover.discount] pending reward stored for consumer ${consumerId}, promo "${promo.name}" — will apply on next visit`);
    console.log(JSON.stringify({
      pvHook: "clover.reward.pending",
      ts: new Date().toISOString(),
      tc: "TC-CLO-DISC-03",
      sev: "info",
      consumerId,
      promotionId: promo.id,
      recordId: record.id,
    }));

    return { pending: true, recordId: record.id };
  } catch (e) {
    console.error(`[clover.discount] error issuing reward: consumerId=${consumerId} promo=${promo?.id}:`, e?.message || String(e));
    return null;
  }
}

/**
 * Check and apply any pending Clover discount rewards for a consumer on a new payment.
 * Called from clover.webhook.routes.js during payment processing.
 *
 * @param {object} params
 * @param {number} params.consumerId
 * @param {number} params.merchantId
 * @param {object} params.posConnection — PosConnection row
 * @param {string} params.orderId — Clover order ID from the current payment
 */
async function applyPendingCloverRewards({ consumerId, merchantId, posConnection, orderId }) {
  if (!orderId) return [];

  const pending = await prisma.posRewardDiscount.findMany({
    where: { consumerId, merchantId, posConnectionId: posConnection.id, status: "pending" },
    orderBy: { createdAt: "asc" },
  });

  if (!pending.length) return [];

  const results = [];

  for (const reward of pending) {
    try {
      // Reconstruct promo-like object from the stored reward data
      const promoLike = {
        id: reward.promotionId,
        name: reward.discountName,
        rewardType: reward.rewardType,
        rewardValue: reward.amountCents || reward.percentage,
        rewardSku: null,
      };

      const result = await applyCloverDiscount({
        posConnection,
        orderId,
        promo: promoLike,
        consumerId,
        entitlementId: reward.entitlementId,
      });

      if (result?.applied) {
        // Update the original pending record
        await prisma.posRewardDiscount.update({
          where: { id: reward.id },
          data: {
            status: "applied",
            cloverOrderId: orderId,
            cloverDiscountId: result.discountId,
            appliedAt: new Date(),
          },
        });

        console.log(JSON.stringify({
          pvHook: "clover.reward.applied_next_visit",
          ts: new Date().toISOString(),
          tc: "TC-CLO-DISC-04",
          sev: "info",
          consumerId,
          orderId,
          rewardId: reward.id,
          discountId: result.discountId,
        }));
      } else if (result?.skipped) {
        // Discount guard rejected — leave as pending for a future order
        console.log(`[clover.discount] pending reward ${reward.id} skipped on order ${orderId} — will retry next visit`);
      }

      results.push({ rewardId: reward.id, ...result });
    } catch (e) {
      console.error(`[clover.discount] error applying pending reward ${reward.id}:`, e?.message || String(e));
      results.push({ rewardId: reward.id, error: e?.message });
    }
  }

  return results;
}

module.exports = {
  applyCloverDiscount,
  issueCloverDiscountReward,
  applyPendingCloverRewards,
  buildDiscountName,
  resolveRewardAmountCents,
  // Exported for testing
  cloverRequest,
  getOrderTotal,
};
