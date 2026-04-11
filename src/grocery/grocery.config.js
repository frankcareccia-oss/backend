/**
 * src/grocery/grocery.config.js
 *
 * Static promotion config for grocery MVP demo.
 * Maps UPC codes to subsidy amounts.
 *
 * In production this would come from a database or promotion engine.
 * For MVP Demo Mode B, this is intentionally static per spec.
 */

"use strict";

const GROCERY_PROMOS = {
  // Dairy
  "012345678901": { productName: "Organic Whole Milk (1 gal)", subsidyAmountCents: 250, promotionId: "DAIRY-001" },
  "012345678902": { productName: "Organic 2% Milk (1 gal)", subsidyAmountCents: 200, promotionId: "DAIRY-001" },
  "012345678903": { productName: "Greek Yogurt (32oz)", subsidyAmountCents: 150, promotionId: "DAIRY-002" },

  // Produce
  "023456789001": { productName: "Organic Bananas (1 lb)", subsidyAmountCents: 50, promotionId: "PRODUCE-001" },
  "023456789002": { productName: "Organic Spinach (5oz)", subsidyAmountCents: 100, promotionId: "PRODUCE-001" },
  "023456789003": { productName: "Organic Avocados (each)", subsidyAmountCents: 75, promotionId: "PRODUCE-002" },

  // Pantry
  "034567890001": { productName: "Whole Wheat Bread", subsidyAmountCents: 100, promotionId: "PANTRY-001" },
  "034567890002": { productName: "Brown Rice (2 lb)", subsidyAmountCents: 125, promotionId: "PANTRY-001" },
  "034567890003": { productName: "Organic Pasta", subsidyAmountCents: 75, promotionId: "PANTRY-002" },

  // Protein
  "045678901001": { productName: "Free-Range Eggs (1 doz)", subsidyAmountCents: 200, promotionId: "PROTEIN-001" },
  "045678901002": { productName: "Chicken Breast (1 lb)", subsidyAmountCents: 300, promotionId: "PROTEIN-001" },
};

/**
 * Look up a UPC in the static promo config.
 * @returns {{ productName, subsidyAmountCents, promotionId } | null}
 */
function lookupUpc(upc) {
  const normalized = String(upc || "").trim();
  return GROCERY_PROMOS[normalized] || null;
}

/**
 * Get all configured UPCs (for admin/debug).
 */
function getAllPromos() {
  return Object.entries(GROCERY_PROMOS).map(([upc, config]) => ({
    upc,
    ...config,
  }));
}

module.exports = { lookupUpc, getAllPromos, GROCERY_PROMOS };
