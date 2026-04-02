// src/bundles/bundle.engine.js
//
// Bundle evaluation engine — single source of truth for all redemption logic.
//
// Phase A: lifecycle validation only.
// Phase C: simple mode implemented — one tap consumes one "set" from the rule tree
//          (all PRODUCT quantities decremented by 1).
//
// redemptionMode "simple":
//   preview(instance)  → shows what remaining looks like after one set
//   consume(instance)  → decrements one set; returns updatedRemaining + new status
//
// Phase B/C per_product / per_set modes: not yet implemented.

// ── Internal tree helpers ─────────────────────────────────────

/**
 * Recursively collect all PRODUCT leaf nodes from a rule tree.
 */
function collectProducts(tree) {
  if (!tree || typeof tree !== "object") return [];
  if (tree.type === "PRODUCT") return [tree];
  return (Array.isArray(tree.children) ? tree.children : []).flatMap(collectProducts);
}

/**
 * Returns true if all PRODUCT quantities in the tree are <= 0.
 */
function isExhausted(tree) {
  const products = collectProducts(tree);
  return products.length > 0 && products.every((p) => Number(p.quantity) <= 0);
}

/**
 * Decrement every PRODUCT quantity by 1 (minimum 0). Pure — returns new tree.
 */
function decrementOneSet(tree) {
  if (!tree || typeof tree !== "object") return tree;
  if (tree.type === "PRODUCT") {
    return { ...tree, quantity: Math.max(0, Number(tree.quantity) - 1) };
  }
  return {
    ...tree,
    children: (Array.isArray(tree.children) ? tree.children : []).map(decrementOneSet),
  };
}

/**
 * Human-readable description of remaining products in a tree.
 * Returns e.g. "Coffee ×5, Pastry ×5" or "Fully redeemed".
 */
function describeRemainingFromTree(tree) {
  const products = collectProducts(tree).filter((p) => Number(p.quantity) > 0);
  if (!products.length) return "Fully redeemed";
  return products.map((p) => `${p.productName} ×${p.quantity}`).join(", ");
}

// ── preview ───────────────────────────────────────────────────

/**
 * Dry-run a redemption — returns what would happen without mutating state.
 *
 * @param {object} instance  BundleInstance record from DB
 * @returns {{ valid: boolean, message: string, remainingAfter: any, willComplete: boolean }}
 */
function preview(instance) {
  const tree = instance?.remainingRuleTreeJson;
  if (!tree) {
    return { valid: false, message: "No remaining rule tree on instance", remainingAfter: null, willComplete: false };
  }

  const products = collectProducts(tree);
  if (!products.length) {
    return { valid: false, message: "No products found in bundle", remainingAfter: tree, willComplete: false };
  }

  if (isExhausted(tree)) {
    return { valid: false, message: "Bundle is fully redeemed", remainingAfter: tree, willComplete: false };
  }

  const after = decrementOneSet(tree);
  const willComplete = isExhausted(after);

  return {
    valid: true,
    message: willComplete
      ? "This will fully redeem the bundle."
      : `Remaining after this redemption: ${describeRemainingFromTree(after)}.`,
    remainingAfter: after,
    willComplete,
  };
}

// ── consume ───────────────────────────────────────────────────

/**
 * Apply a redemption and return updated instance state.
 * Must only be called after preview() confirms valid: true.
 *
 * @param {object} instance  BundleInstance record from DB
 * @returns {{ success: boolean, updatedRemaining: any, status: string }}
 */
function consume(instance) {
  const tree = instance?.remainingRuleTreeJson;
  if (!tree) {
    return { success: false, updatedRemaining: null, status: instance?.status ?? "active" };
  }

  if (isExhausted(tree)) {
    return { success: false, updatedRemaining: tree, status: "redeemed" };
  }

  const updated = decrementOneSet(tree);
  const exhausted = isExhausted(updated);

  return {
    success: true,
    updatedRemaining: updated,
    status: exhausted ? "redeemed" : "active",
  };
}

// ── describeRemaining ─────────────────────────────────────────

/**
 * Returns a human-readable description of a BundleInstance's remaining value.
 *
 * @param {object} instance  BundleInstance record from DB
 * @returns {string}
 */
function describeRemaining(instance) {
  if (!instance) return "unknown";
  const tree = instance.remainingRuleTreeJson;
  if (!tree) return "unknown";
  return describeRemainingFromTree(tree);
}

module.exports = { preview, consume, describeRemaining };
