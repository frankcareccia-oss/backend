// src/bundles/bundle.events.js
//
// All bundle-related event emission lives here.
// Routes and service call these functions — they never call emitPvHook directly.
//
// Phase A: lifecycle admin events (created, updated, deleted, duplicated).
// Phase B/C: purchase + redemption events with dedup marker support.

const { emitPvHook } = require("../utils/hooks");

// ── Event type registry ────────────────────────────────────────

const BUNDLE_EVENTS = {
  // Phase A — lifecycle
  CREATED:            "bundle_created",
  UPDATED:            "bundle_updated",
  DELETED:            "bundle_deleted",
  DUPLICATED:         "bundle_duplicated",
  // Phase B/C — purchase + redemption
  PURCHASED:          "bundle_purchased",
  REDEMPTION_APPLIED: "bundle_redemption_applied",
  COMPLETED:          "bundle_completed",
  NEAR_COMPLETION:    "bundle_near_completion",
  EXPIRING_SOON:      "bundle_expiring_soon",
  EXPIRED:            "bundle_expired",
  STALLED:            "bundle_stalled",
};

// ── Internal emitter ───────────────────────────────────────────

function emit(stableKey, tc, payload) {
  emitPvHook(`catalog.${stableKey}`, {
    tc,
    sev: "info",
    stable: `catalog:${stableKey}`,
    ...payload,
  });
}

// ── Phase A: lifecycle events ──────────────────────────────────

function onBundleCreated({ merchantId, bundleId, actorUserId, actorRole }) {
  emit("bundle.created", "TC-BUNDLE-CREATE-01", { merchantId, bundleId, actorUserId, actorRole });
}

function onBundleUpdated({ merchantId, bundleId, actorUserId, actorRole, changedFields }) {
  emit("bundle.updated", "TC-BUNDLE-UPDATE-01", { merchantId, bundleId, actorUserId, actorRole, changedFields });
}

function onBundleDeleted({ merchantId, bundleId, actorUserId, actorRole }) {
  emit("bundle.deleted", "TC-BUNDLE-DELETE-01", { merchantId, bundleId, actorUserId, actorRole });
}

function onBundleDuplicated({ merchantId, sourceBundleId, newBundleId, actorUserId, actorRole }) {
  emit("bundle.duplicated", "TC-BUNDLE-DUP-01", { merchantId, sourceBundleId, newBundleId, actorUserId, actorRole });
}

// ── Phase B/C: purchase + redemption events ────────────────────
//
// These will include dedup logic via BundleInstanceEventMarker (see spec §5.3).
// Emitting the same eventKey twice within a window is a no-op — prevents double-fire
// from POS retries or network replays.

function onBundlePurchased(payload) {
  // Phase B/C: create BundleInstanceEventMarker, then emit
  emit("bundle.purchased", "TC-BUNDLE-PURCH-01", payload);
}

function onRedemptionApplied(payload) {
  emit("bundle.redemption_applied", "TC-BUNDLE-REDEEM-01", payload);
}

function onBundleCompleted(payload) {
  emit("bundle.completed", "TC-BUNDLE-COMPLETE-01", payload);
}

function onBundleNearCompletion(payload) {
  emit("bundle.near_completion", "TC-BUNDLE-NEAR-01", payload);
}

function onBundleExpiringSoon(payload) {
  emit("bundle.expiring_soon", "TC-BUNDLE-EXPIRING-01", payload);
}

function onBundleExpired(payload) {
  emit("bundle.expired", "TC-BUNDLE-EXPIRED-01", payload);
}

function onBundleStalled(payload) {
  emit("bundle.stalled", "TC-BUNDLE-STALLED-01", payload);
}

module.exports = {
  BUNDLE_EVENTS,
  // Phase A
  onBundleCreated,
  onBundleUpdated,
  onBundleDeleted,
  onBundleDuplicated,
  // Phase B/C
  onBundlePurchased,
  onRedemptionApplied,
  onBundleCompleted,
  onBundleNearCompletion,
  onBundleExpiringSoon,
  onBundleExpired,
  onBundleStalled,
};
