/**
 * pos.product.push.js — Push PV-originated products to POS on activation
 *
 * Rules:
 *   - Only push if pvOrigin = true (PV created this product)
 *   - Only push POS-compatible subset (name, price, category, sku)
 *   - Never push PV enrichment (description, image, allergens, dietary)
 *   - Exception: Square accepts description — push pvDescription to Square
 *   - Never DELETE POS items — use hidden/is_archived for suspend/archive
 *
 * "Clover and Square own the transaction. PerkValet owns the relationship."
 */

"use strict";

const { prisma } = require("../db/prisma");
const { decrypt } = require("../utils/encrypt");

const CLOVER_API_BASE = process.env.CLOVER_API_BASE || "https://apisandbox.dev.clover.com";
const IS_SANDBOX = (process.env.SQUARE_APP_ID || "").startsWith("sandbox-");
const SQUARE_API_BASE = IS_SANDBOX
  ? "https://connect.squareupsandbox.com/v2"
  : "https://connect.squareup.com/v2";

/**
 * The single rule that governs all POS write decisions.
 */
function canPVWriteToPOS(product) {
  if (product.externalCatalogId && !product.pvOrigin) return false;
  return true;
}

/**
 * Push a PV-originated product to the POS on activation (STAGED → ACTIVE).
 * Returns the POS product ID, or null if not applicable.
 */
async function pushProductToPOSOnActivation(product, conn) {
  if (!product.pvOrigin) return null;
  if (!conn || conn.status !== "active") return null;

  const token = decrypt(conn.accessTokenEnc);

  if (conn.posType === "clover") {
    return pushToClover(product, conn, token);
  } else if (conn.posType === "square") {
    return pushToSquare(product, conn, token);
  }
  return null;
}

async function pushToClover(product, conn, token) {
  const url = `${CLOVER_API_BASE}/v3/merchants/${conn.externalMerchantId}/items`;
  const payload = {
    name: product.pvDisplayName || product.name,
    price: product.pvPriceCents || product.priceCents || 0,
    sku: product.sku,
    hidden: false,
    available: true,
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Clover create item failed ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = await res.json();
  return data.id; // Clover item ID
}

async function pushToSquare(product, conn, token) {
  const url = `${SQUARE_API_BASE}/catalog/object`;
  const idempotencyKey = `pv-product-${product.id}-${Date.now()}`;

  const payload = {
    idempotency_key: idempotencyKey,
    object: {
      type: "ITEM",
      id: `#pv-${product.id}`,
      present_at_all_locations: true,
      item_data: {
        name: product.pvDisplayName || product.name,
        description: product.description || product.pvDisplayName || "",
        variations: [{
          type: "ITEM_VARIATION",
          id: `#pv-${product.id}-var`,
          item_variation_data: {
            name: "Regular",
            pricing_type: "FIXED_PRICING",
            price_money: {
              amount: product.pvPriceCents || product.priceCents || 0,
              currency: "USD",
            },
          },
        }],
      },
    },
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Square-Version": "2024-01-18",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Square create item failed ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = await res.json();
  return data.catalog_object?.id; // Square catalog object ID
}

/**
 * Suspend a product in POS (ACTIVE → SUSPENDED).
 * Sets hidden=true (Clover) or is_archived=true (Square).
 * NEVER deletes.
 */
async function suspendProductInPOS(product, conn) {
  if (!product.externalCatalogId || !conn) return;
  const token = decrypt(conn.accessTokenEnc);

  if (conn.posType === "clover") {
    const url = `${CLOVER_API_BASE}/v3/merchants/${conn.externalMerchantId}/items/${product.externalCatalogId}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ hidden: true }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Clover hide item failed ${res.status}: ${text.slice(0, 200)}`);
    }
  } else if (conn.posType === "square") {
    const url = `${SQUARE_API_BASE}/catalog/object`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Square-Version": "2024-01-18",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        idempotency_key: `pv-suspend-${product.id}-${Date.now()}`,
        object: {
          type: "ITEM",
          id: product.externalCatalogId,
          item_data: { is_archived: true },
        },
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Square archive item failed ${res.status}: ${text.slice(0, 200)}`);
    }
  }
}

/**
 * Reactivate a product in POS (SUSPENDED → ACTIVE).
 * Sets hidden=false (Clover) or is_archived=false (Square).
 */
async function reactivateProductInPOS(product, conn) {
  if (!product.externalCatalogId || !conn) return;
  const token = decrypt(conn.accessTokenEnc);

  if (conn.posType === "clover") {
    const url = `${CLOVER_API_BASE}/v3/merchants/${conn.externalMerchantId}/items/${product.externalCatalogId}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ hidden: false }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Clover unhide item failed ${res.status}: ${text.slice(0, 200)}`);
    }
  } else if (conn.posType === "square") {
    const url = `${SQUARE_API_BASE}/catalog/object`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Square-Version": "2024-01-18",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        idempotency_key: `pv-reactivate-${product.id}-${Date.now()}`,
        object: {
          type: "ITEM",
          id: product.externalCatalogId,
          item_data: { is_archived: false },
        },
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Square unarchive item failed ${res.status}: ${text.slice(0, 200)}`);
    }
  }
}

module.exports = {
  canPVWriteToPOS,
  pushProductToPOSOnActivation,
  suspendProductInPOS,
  reactivateProductInPOS,
};
