// src/bundles/bundle.normalizer.js
//
// Normalizes raw inputs into clean internal objects consumed by the engine and service.
//
// Phase A: handles create and patch payloads (category + quantity model).
// Phase B/C: normalizeTransactionInput() will unify POS and manual PV payloads
//            into a canonical BundleTransactionInput before the engine evaluates them.

// ── Date helpers ───────────────────────────────────────────────

function parseDate(raw, label) {
  if (!raw) return { value: null, error: null };
  const d = new Date(raw);
  if (isNaN(d.getTime()) || d.getFullYear() < 2000 || d.getFullYear() > 2099)
    return { value: null, error: `${label} must be a valid date between 2000 and 2099 (e.g. 2026-06-01)` };
  return { value: d, error: null };
}

// ── Lifecycle constants ────────────────────────────────────────

// States where quantity is still mutable
const MUTABLE_QTY_STATES = ["wip", "staged"];

// Valid status transitions (from → allowed tos).
// WIP/Staged are deleted (not archived) to remove them.
// Archived bundles are cloned via /duplicate — no status transition from archived.
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
  const { name, categoryId, quantity, price, startAt, endAt } = body || {};
  const errors = [];

  if (!name || !String(name).trim()) errors.push("name is required");
  if (!categoryId || !Number.isInteger(Number(categoryId))) errors.push("categoryId is required");
  const qty = parseInt(quantity, 10);
  if (!quantity || !Number.isInteger(qty) || qty < 1) errors.push("quantity must be a positive integer");
  if (price === undefined || price === null || isNaN(Number(price)) || Number(price) < 0)
    errors.push("price must be a non-negative number");

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
      name:       String(name).trim(),
      categoryId: parseInt(categoryId, 10),
      quantity:   qty,
      price:      Number(price),
      startAt:    start.value,
      endAt:      end.value,
    },
  };
}

// ── normalizePatchInput ────────────────────────────────────────

/**
 * Validates and diffs a bundle update request body against the existing record.
 * Returns { data: object, auditChanges: array, errors: string[] }.
 * Only fields that actually changed are included in `data`.
 */
function normalizePatchInput(body, existing) {
  const { name, price, quantity, startAt, endAt, status } = body || {};
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

  if (quantity !== undefined) {
    if (!MUTABLE_QTY_STATES.includes(existing.status)) {
      errors.push(`quantity cannot be changed once a bundle is ${existing.status}`);
    } else {
      const qty = parseInt(quantity, 10);
      if (!Number.isInteger(qty) || qty < 1) {
        errors.push("quantity must be a positive integer");
      } else if (qty !== existing.quantity) {
        data.quantity = qty;
        auditChanges.push({ field: "quantity", from: existing.quantity, to: qty });
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

  return { data, auditChanges, errors };
}

// ── normalizeTransactionInput ──────────────────────────────────

/**
 * Phase B/C: normalizes a raw POS or manual PV payload into a canonical
 * BundleTransactionInput before the engine evaluates it.
 *
 * Both integrated POS and manual PV flows must produce identical output
 * from this function — the engine must never see the source mode.
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
  VALID_TRANSITIONS,
  MUTABLE_QTY_STATES,
};
