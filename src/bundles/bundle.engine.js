// src/bundles/bundle.engine.js
//
// Bundle evaluation engine — single source of truth for all redemption logic.
//
// Phase A: lifecycle validation only (category + quantity model).
//          preview() and consume() are stubbed; they will be filled in Phase B/C
//          without touching routes, service, or normalizer.
//
// Phase B/C replacement plan:
//   - Replace preview() and consume() with rule tree evaluators
//   - Rule tree node types: PRODUCT { productId, quantity } | AND { children } | OR { children }
//   - BundleInstance will carry originalRuleTreeJson + remainingRuleTreeJson instead of remainingUses
//   - All other modules (normalizer, service, events, routes) remain unchanged

// ── preview ───────────────────────────────────────────────────

/**
 * Dry-run a redemption — returns what would happen without mutating state.
 *
 * @param {object} transactionInput  Canonical BundleTransactionInput (from normalizer)
 * @param {object} instance          BundleInstance record from DB
 * @returns {{ valid: boolean, message: string, remainingAfter: any }}
 */
function preview(transactionInput, instance) {
  // Phase A: not yet implemented — redemption requires consumer identity (Phase B)
  // Phase B/C: walk the rule tree against transactionInput.items, return projected remaining
  return {
    valid: false,
    message: "Redemption preview not yet available — requires consumer identity (Phase B/C)",
    remainingAfter: null,
  };
}

// ── consume ───────────────────────────────────────────────────

/**
 * Apply a redemption and return updated instance state.
 * Must only be called after preview() confirms valid: true.
 *
 * @param {object} transactionInput  Canonical BundleTransactionInput (from normalizer)
 * @param {object} instance          BundleInstance record from DB
 * @returns {{ success: boolean, updatedRemaining: any, status: string }}
 */
function consume(transactionInput, instance) {
  // Phase A: not yet implemented
  // Phase B/C: decrement rule tree, derive new status (active / redeemed), persist via service
  return {
    success: false,
    updatedRemaining: null,
    status: instance?.status ?? "active",
  };
}

// ── describeRemaining ─────────────────────────────────────────

/**
 * Returns a human-readable description of a BundleInstance's remaining value.
 * Phase A: simple integer counter.
 * Phase B/C: walk the remaining rule tree and produce a label like "2 Coffee, 1 Pastry".
 *
 * @param {object} instance  BundleInstance record from DB
 * @returns {string}
 */
function describeRemaining(instance) {
  if (instance == null) return "unknown";
  // Phase B/C: replace with rule tree walker
  const uses = instance.remainingUses ?? 0;
  return `${uses} use${uses === 1 ? "" : "s"} remaining`;
}

module.exports = { preview, consume, describeRemaining };
