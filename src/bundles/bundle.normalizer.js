// src/bundles/bundle.normalizer.js
//
// Normalizes raw inputs into clean internal objects consumed by the engine and service.
//
// Rule tree shape (max 3 levels deep):
//   Single product:  { type:"PRODUCT", productId:1, productName:"Coffee", quantity:10 }
//   Flat group:      { type:"AND"|"OR", children:[ ...PRODUCT nodes ] }
//   Nested group:    { type:"AND", children:[ PRODUCT, { type:"OR", children:[PRODUCT, PRODUCT] } ] }
//
// Phase B/C: normalizeTransactionInput() unifies POS and manual PV payloads
//            into a canonical BundleTransactionInput before the engine evaluates them.

// ── Date helpers ───────────────────────────────────────────────

function parseDate(raw, label) {
  if (!raw) return { value: null, error: null };
  const d = new Date(raw);
  if (isNaN(d.getTime()) || d.getFullYear() < 2000 || d.getFullYear() > 2099)
    return { value: null, error: `${label} must be a valid date between 2000 and 2099 (e.g. 2026-06-01)` };
  return { value: d, error: null };
}

// ── Rule tree validation ───────────────────────────────────────

/**
 * Validates a rule tree node. Returns an array of error strings (empty = valid).
 * Enforces max 3 levels: root may be PRODUCT | AND | OR;
 * children of AND/OR may be PRODUCT or AND/OR (depth 1 only);
 * grandchildren must be PRODUCT.
 */
function validateRuleTree(tree, depth) {
  depth = depth || 0;
  if (!tree || typeof tree !== "object") return ["ruleTree is required"];

  if (!["PRODUCT", "AND", "OR"].includes(tree.type))
    return [`ruleTree.type must be PRODUCT, AND, or OR (got: ${tree.type})`];

  const errors = [];

  if (tree.type === "PRODUCT") {
    if (!Number.isInteger(Number(tree.productId)) || Number(tree.productId) < 1)
      errors.push("PRODUCT node must have a valid productId");
    if (!tree.productName || !String(tree.productName).trim())
      errors.push("PRODUCT node must have a productName");
    const qty = parseInt(tree.quantity, 10);
    if (!Number.isInteger(qty) || qty < 1)
      errors.push("PRODUCT node quantity must be a positive integer");
    return errors;
  }

  // AND / OR
  if (!Array.isArray(tree.children) || tree.children.length < 1)
    return [`${tree.type} node must have at least one child`];
  if (tree.children.length > 10)
    errors.push(`${tree.type} node cannot have more than 10 children`);

  for (let i = 0; i < tree.children.length; i++) {
    const child = tree.children[i];
    if (!child || typeof child !== "object") {
      errors.push(`${tree.type}.children[${i}] is not a valid node`);
      continue;
    }
    if (!["PRODUCT", "AND", "OR"].includes(child.type)) {
      errors.push(`${tree.type}.children[${i}].type must be PRODUCT, AND, or OR`);
      continue;
    }
    if (child.type === "PRODUCT") {
      if (!Number.isInteger(Number(child.productId)) || Number(child.productId) < 1)
        errors.push(`${tree.type}.children[${i}] must have a valid productId`);
      if (!child.productName || !String(child.productName).trim())
        errors.push(`${tree.type}.children[${i}] must have a productName`);
      const qty = parseInt(child.quantity, 10);
      if (!Number.isInteger(qty) || qty < 1)
        errors.push(`${tree.type}.children[${i}] quantity must be a positive integer`);
    } else {
      // Nested AND / OR — only allowed at depth 0 (max 3 levels total)
      if (depth >= 1) {
        errors.push(`${tree.type}.children[${i}] nesting too deep — max 3 levels`);
      } else {
        const childErrors = validateRuleTree(child, depth + 1);
        childErrors.forEach(e => errors.push(`children[${i}]: ${e}`));
      }
    }
  }

  // Per-scope duplicate check: only PRODUCT children at this level (not cross-group).
  // Each AND/OR node enforces uniqueness among its own direct PRODUCT children.
  // The same product may appear in different nested groups (e.g. "(A or B) and (A or C)").
  if (errors.length === 0) {
    const seen = new Set();
    for (const child of tree.children) {
      if (child.type !== "PRODUCT") continue;
      const id = Number(child.productId);
      if (!Number.isInteger(id) || id < 1) continue;
      if (seen.has(id)) {
        errors.push("Product appears more than once at the same level — each product can only be added once per group");
        break;
      }
      seen.add(id);
    }
  }

  return errors;
}

/**
 * Canonicalizes a rule tree: coerces types and trims strings.
 * Call after validateRuleTree passes.
 */
function canonicalizeRuleTree(tree) {
  if (tree.type === "PRODUCT") {
    return {
      type: "PRODUCT",
      productId: parseInt(tree.productId, 10),
      productName: String(tree.productName).trim(),
      quantity: parseInt(tree.quantity, 10),
    };
  }
  return {
    type: tree.type,
    children: tree.children.map(child => canonicalizeRuleTree(child)),
  };
}

// ── Lifecycle constants ────────────────────────────────────────

const MUTABLE_RULE_STATES = ["wip", "staged"];

const VALID_TRANSITIONS = {
  wip:       ["staged"],
  staged:    ["wip", "live"],
  live:      ["suspended", "archived"],
  suspended: ["live", "archived"],
  archived:  [],
};

// ── normalizeCreateInput ───────────────────────────────────────

/**
 * Validates and cleans a bundle create request body.
 * Returns { errors: string[], input: object|null }.
 */
function normalizeCreateInput(body) {
  const { name, price, startAt, endAt, ruleTree, legalText } = body || {};
  const errors = [];

  if (!name || !String(name).trim()) errors.push("name is required");
  if (price === undefined || price === null || isNaN(Number(price)) || Number(price) < 0)
    errors.push("price must be a non-negative number");

  const treeErrors = validateRuleTree(ruleTree);
  errors.push(...treeErrors);

  const start = parseDate(startAt, "Start Date");
  const end   = parseDate(endAt,   "End Date");
  if (start.error) errors.push(start.error);
  if (end.error)   errors.push(end.error);
  if (!start.error && !end.error && start.value && end.value && end.value < start.value)
    errors.push("End Date cannot be before Start Date");

  if (errors.length) return { errors, input: null };

  return {
    errors: [],
    input: {
      name:        String(name).trim(),
      price:       Number(price),
      ruleTreeJson: canonicalizeRuleTree(ruleTree),
      startAt:     start.value,
      endAt:       end.value,
      legalText:   legalText ? String(legalText).trim() : null,
    },
  };
}

// ── normalizePatchInput ────────────────────────────────────────

/**
 * Validates and diffs a bundle update request body against the existing record.
 * Returns { data: object, auditChanges: array, errors: string[] }.
 */
function normalizePatchInput(body, existing) {
  const { name, price, ruleTree, startAt, endAt, status, legalText } = body || {};
  const errors = [];
  const data = {};
  const auditChanges = [];

  if (name !== undefined) {
    if (!String(name).trim()) {
      errors.push("name cannot be empty");
    } else if (name !== existing.name) {
      data.name = String(name).trim();
      auditChanges.push({ field: "name", from: existing.name, to: data.name });
    }
  }

  if (price !== undefined) {
    if (isNaN(Number(price)) || Number(price) < 0) {
      errors.push("price must be a non-negative number");
    } else {
      const newPrice = Number(price);
      if (newPrice !== Number(existing.price)) {
        data.price = newPrice;
        auditChanges.push({ field: "price", from: Number(existing.price), to: newPrice });
      }
    }
  }

  if (ruleTree !== undefined) {
    if (!MUTABLE_RULE_STATES.includes(existing.status)) {
      errors.push(`rule tree cannot be changed once a bundle is ${existing.status}`);
    } else {
      const treeErrors = validateRuleTree(ruleTree);
      if (treeErrors.length) {
        errors.push(...treeErrors);
      } else {
        const canonical = canonicalizeRuleTree(ruleTree);
        data.ruleTreeJson = canonical;
        auditChanges.push({ field: "ruleTree", from: existing.ruleTreeJson, to: canonical });
      }
    }
  }

  if (startAt !== undefined) {
    const { value, error } = parseDate(startAt, "Start Date");
    if (error) {
      errors.push(error);
    } else {
      data.startAt = value;
      auditChanges.push({ field: "startAt", from: existing.startAt, to: value });
    }
  }

  if (endAt !== undefined) {
    const { value, error } = parseDate(endAt, "End Date");
    if (error) {
      errors.push(error);
    } else {
      data.endAt = value;
      auditChanges.push({ field: "endAt", from: existing.endAt, to: value });
    }
  }

  // Cross-field: end must not precede start
  if (!errors.length) {
    const effectiveStart = data.startAt !== undefined ? data.startAt : existing.startAt;
    const effectiveEnd   = data.endAt   !== undefined ? data.endAt   : existing.endAt;
    if (effectiveStart && effectiveEnd && effectiveEnd < effectiveStart)
      errors.push("End Date cannot be before Start Date");
  }

  if (status !== undefined && status !== existing.status) {
    const allowed = VALID_TRANSITIONS[existing.status] || [];
    if (!allowed.includes(status)) {
      errors.push(`Cannot transition from ${existing.status} to ${status}`);
    } else if (status === "staged" && !data.startAt && !existing.startAt) {
      errors.push("Start Date is required before staging a bundle");
    } else {
      data.status = status;
      auditChanges.push({ field: "status", from: existing.status, to: status });
    }
  }

  if (legalText !== undefined) {
    const cleaned = legalText ? String(legalText).trim() : null;
    if (cleaned !== (existing.legalText ?? null)) {
      data.legalText = cleaned;
      auditChanges.push({ field: "legalText", from: existing.legalText ?? null, to: cleaned });
    }
  }

  return { data, auditChanges, errors };
}

// ── normalizeTransactionInput ──────────────────────────────────

/**
 * Phase B/C: normalizes a raw POS or manual PV payload into a canonical
 * BundleTransactionInput before the engine evaluates it.
 *
 * Expected shape (Phase B/C):
 *   {
 *     sourceMode: 'integrated_pos' | 'manual_pv'
 *     merchantId, storeId, consumerId?,
 *     occurredAt, transactionRef?,
 *     triggerContext: 'sale' | 'redemption' | 'preview'
 *     items: [{ productId, quantity }]
 *   }
 */
function normalizeTransactionInput(_raw) {
  throw new Error(
    "normalizeTransactionInput: not implemented — requires Phase B/C (consumer identity + POS transaction layer)"
  );
}

module.exports = {
  normalizeCreateInput,
  normalizePatchInput,
  normalizeTransactionInput,
  validateRuleTree,
  canonicalizeRuleTree,
  VALID_TRANSITIONS,
  MUTABLE_RULE_STATES,
};
