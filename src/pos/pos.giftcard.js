/**
 * pos.giftcard.js — Square Gift Card reward automation
 *
 * When a consumer earns a milestone reward, this module:
 *   1. Resolves the reward's dollar value (free item price, fixed discount, etc.)
 *   2. Creates or retrieves the consumer's Square gift card
 *   3. Loads the reward amount onto the gift card
 *   4. Links the gift card to the Square customer
 *
 * The gift card balance persists until the consumer uses it at checkout.
 * No expiry — merchant bears no upfront cash cost.
 *
 * Requires: SQUARE_APP_ID, active PosConnection with Square.
 */

"use strict";

const { prisma } = require("../db/prisma");
const { decrypt } = require("../utils/encrypt");

const IS_SANDBOX = (process.env.SQUARE_APP_ID || "").startsWith("sandbox-");
const SQUARE_API_BASE = IS_SANDBOX
  ? "https://connect.squareupsandbox.com/v2"
  : "https://connect.squareup.com/v2";

/**
 * Resolve the dollar amount (in cents) for a reward.
 *
 * @param {object} promo — { rewardType, rewardValue, rewardSku }
 * @param {number} merchantId
 * @returns {Promise<number|null>} — amount in cents, or null if not calculable
 */
async function resolveRewardAmountCents(promo, merchantId) {
  if (promo.rewardType === "discount_fixed" && promo.rewardValue) {
    return promo.rewardValue; // already in cents
  }

  if (promo.rewardType === "free_item" && promo.rewardSku) {
    // Look up product price by SKU
    const product = await prisma.product.findFirst({
      where: { merchantId, sku: promo.rewardSku, status: "active" },
      select: { priceCents: true },
    });
    if (product?.priceCents) return product.priceCents;

    // Fallback: check if rewardValue is set as a manual override
    if (promo.rewardValue) return promo.rewardValue;
    return null;
  }

  if (promo.rewardType === "discount_pct" && promo.rewardValue) {
    // Percentage discounts can't be pre-loaded without knowing the purchase amount.
    // Skip gift card for now — these use the manual code redemption flow.
    return null;
  }

  // custom / unknown — skip
  return null;
}

/**
 * Make an authenticated request to Square API.
 */
async function squareRequest(accessToken, path, method, body) {
  const res = await fetch(`${SQUARE_API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "Square-Version": "2024-01-18",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) {
    const errMsg = data?.errors?.[0]?.detail || `Square API ${res.status}`;
    throw new Error(errMsg);
  }
  return data;
}

/**
 * Find or create a Square gift card for a consumer at a merchant.
 * Stores the gift card ID on the PosConnection metadata for reuse.
 *
 * @param {string} accessToken — decrypted Square access token
 * @param {string} squareCustomerId — Square customer ID
 * @param {string} locationId — Square location ID
 * @param {number} consumerId — PV consumer ID
 * @param {number} posConnectionId — PV PosConnection ID
 * @returns {Promise<string>} — Square gift card ID
 */
async function findOrCreateGiftCard(accessToken, squareCustomerId, locationId, consumerId, posConnectionId, amountCents) {
  // Check if we already have a gift card for this consumer
  const existing = await prisma.consumerGiftCard.findFirst({
    where: { consumerId, posConnectionId, active: true },
    select: { squareGiftCardId: true },
  });

  if (existing) return { giftCardId: existing.squareGiftCardId, isNew: false };

  // Create a new digital gift card
  const createRes = await squareRequest(accessToken, "/gift-cards", "POST", {
    idempotency_key: `pv-gc-${consumerId}-${posConnectionId}-${Date.now()}`,
    location_id: locationId,
    gift_card: { type: "DIGITAL" },
  });

  const giftCard = createRes.gift_card;

  // Activate with the reward amount (Square requires a positive amount)
  await squareRequest(accessToken, "/gift-cards/activities", "POST", {
    idempotency_key: `pv-gc-activate-${giftCard.id}`,
    gift_card_activity: {
      type: "ACTIVATE",
      gift_card_id: giftCard.id,
      location_id: locationId,
      activate_activity_details: {
        amount_money: { amount: amountCents, currency: "USD" },
        buyer_payment_instrument_ids: ["CASH"],
      },
    },
  });

  // Link to Square customer
  await squareRequest(accessToken, `/gift-cards/${giftCard.id}/link-customer`, "POST", {
    customer_id: squareCustomerId,
  });

  // Store reference in PV
  await prisma.consumerGiftCard.create({
    data: {
      consumerId,
      posConnectionId,
      squareGiftCardId: giftCard.id,
      squareGan: giftCard.gan,
      active: true,
    },
  });

  console.log(`[pos.giftcard] created gift card ${giftCard.id} (GAN: ${giftCard.gan}) for consumer ${consumerId}`);
  return { giftCardId: giftCard.id, isNew: true };
}

/**
 * Load reward funds onto the consumer's gift card.
 *
 * @param {string} accessToken
 * @param {string} giftCardId
 * @param {string} locationId
 * @param {number} amountCents
 * @param {string} reason — display reason for the load
 * @returns {Promise<object>} — gift card activity result
 */
async function loadGiftCardFunds(accessToken, giftCardId, locationId, amountCents, reason) {
  const res = await squareRequest(accessToken, "/gift-cards/activities", "POST", {
    idempotency_key: `pv-gc-load-${giftCardId}-${amountCents}-${Date.now()}`,
    gift_card_activity: {
      type: "LOAD",
      gift_card_id: giftCardId,
      location_id: locationId,
      load_activity_details: {
        amount_money: { amount: amountCents, currency: "USD" },
        buyer_payment_instrument_ids: ["CASH"],
      },
    },
  });

  console.log(`[pos.giftcard] loaded $${(amountCents / 100).toFixed(2)} onto ${giftCardId} — ${reason}`);
  return res.gift_card_activity;
}

/**
 * Main entry point: issue a gift card reward for a milestone.
 *
 * Called from pos.stamps.js when milestoneEarned === true.
 * Fire-and-forget — never blocks the stamp pipeline.
 *
 * @param {object} params
 * @param {number} params.consumerId
 * @param {number} params.merchantId
 * @param {object} params.promo — { id, name, rewardType, rewardValue, rewardSku }
 */
async function issueGiftCardReward({ consumerId, merchantId, promo }) {
  try {
    // 1. Resolve the reward dollar value
    const amountCents = await resolveRewardAmountCents(promo, merchantId);
    if (!amountCents || amountCents <= 0) {
      console.log(`[pos.giftcard] skipping — no calculable amount for promo ${promo.id} (${promo.rewardType})`);
      return null;
    }

    // 2. Find the Square PosConnection for this merchant
    const conn = await prisma.posConnection.findFirst({
      where: { merchantId, posType: "square", status: "active" },
      select: { id: true, accessTokenEnc: true, externalMerchantId: true },
    });
    if (!conn) {
      console.log(`[pos.giftcard] skipping — no active Square connection for merchant ${merchantId}`);
      return null;
    }

    // 3. Find a mapped location
    const locationMap = await prisma.posLocationMap.findFirst({
      where: { posConnectionId: conn.id, active: true },
      select: { externalLocationId: true },
    });
    if (!locationMap) {
      console.log(`[pos.giftcard] skipping — no mapped location for merchant ${merchantId}`);
      return null;
    }

    // 4. Resolve the Square customer ID for this consumer
    const consumer = await prisma.consumer.findUnique({
      where: { id: consumerId },
      select: { phoneE164: true },
    });
    if (!consumer?.phoneE164) {
      console.log(`[pos.giftcard] skipping — consumer ${consumerId} has no phone`);
      return null;
    }

    const accessToken = decrypt(conn.accessTokenEnc);

    // Search for Square customer by phone
    const searchRes = await squareRequest(accessToken, "/customers/search", "POST", {
      query: { filter: { phone_number: { exact: consumer.phoneE164 } } },
    });
    const squareCustomer = searchRes.customers?.[0];
    if (!squareCustomer) {
      console.log(`[pos.giftcard] skipping — no Square customer found for phone ${consumer.phoneE164}`);
      return null;
    }

    // 5. Find or create gift card
    const { giftCardId, isNew } = await findOrCreateGiftCard(
      accessToken,
      squareCustomer.id,
      locationMap.externalLocationId,
      consumerId,
      conn.id,
      amountCents
    );

    // 6. Load funds — skip if card was just created (activated with the amount already)
    if (!isNew) {
      const reason = `${promo.name} — ${buildRewardLabel(promo)}`;
      await loadGiftCardFunds(accessToken, giftCardId, locationMap.externalLocationId, amountCents, reason);
    }

    console.log(`[pos.giftcard] reward issued: $${(amountCents / 100).toFixed(2)} for consumer ${consumerId}, promo "${promo.name}" (${isNew ? "new card" : "existing card"})`);
    return { giftCardId, amountCents };
  } catch (e) {
    console.error(`[pos.giftcard] error issuing reward: consumerId=${consumerId} promo=${promo?.id}:`, e?.message || String(e));
    return null;
  }
}

function buildRewardLabel(promo) {
  if (promo.rewardType === "discount_fixed" && promo.rewardValue) {
    return `$${(promo.rewardValue / 100).toFixed(2)} off`;
  }
  if (promo.rewardType === "free_item" && promo.rewardSku) {
    return `Free item (${promo.rewardSku})`;
  }
  return promo.name;
}

module.exports = { issueGiftCardReward, resolveRewardAmountCents };
