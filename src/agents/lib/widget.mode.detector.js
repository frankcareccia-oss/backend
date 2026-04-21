/**
 * widget.mode.detector.js — Determines support widget behavior
 *
 * No error + exploring = ORIENT (explain the page)
 * Error detected = DIAGNOSE (fix the problem)
 * Ambiguous = ASK FIRST (let user choose)
 */

"use strict";

const PAGE_ID_MAP = {
  "/admin": "admin_home",
  "/admin/system": "admin_system",
  "/admin/support": "admin_support",
  "/admin/oversight": "admin_oversight",
  "/admin/platform/config": "admin_settings",
  "/admin/merchants": "admin_merchants",
  "/merchant/dashboard": "merchant_dashboard",
  "/merchant/weekly": "merchant_weekly",
  "/merchant/promotions": "merchant_promotions",
  "/merchant/products": "merchant_products",
  "/merchant/stores": "merchant_stores",
  "/merchant/bundles": "merchant_bundles",
  "/merchant/analytics": "merchant_analytics",
  "/merchant/growth-studio": "merchant_growth_studio",
  "/merchant/settings": "merchant_settings",
  "/merchant/invoices": "merchant_invoices",
  "/merchant/onboarding": "pos_connection",
  "/account/change-password": "change_password",
};

function resolvePageId(route) {
  if (!route) return "unknown";
  // Normalize: strip hash, normalize merchant IDs
  const clean = route
    .replace(/^#/, "")
    .replace(/\/merchants\/\d+/, "/merchant")
    .replace(/\/stores\/\d+/, "/stores/:id");

  // Exact match first
  if (PAGE_ID_MAP[clean]) return PAGE_ID_MAP[clean];

  // Prefix match
  for (const [pattern, id] of Object.entries(PAGE_ID_MAP)) {
    if (clean.startsWith(pattern)) return id;
  }

  return "unknown";
}

function detectWidgetMode(context) {
  const {
    userRole,
    currentPage,
    hasActiveError,
    userInitiated,
  } = context;

  const isAdminPage = (currentPage || "").includes("/admin");
  const pageId = resolvePageId(currentPage);

  // DIAGNOSIS — error detected
  if (hasActiveError) {
    return { mode: "diagnosis", autoOpen: true, reason: "active_error", pageId };
  }

  // ORIENTATION — user tapped ?, no error, known page
  if (userInitiated && !hasActiveError && pageId !== "unknown") {
    return { mode: "orientation", pageId, audience: isAdminPage ? "admin" : "merchant" };
  }

  // ASK FIRST — ambiguous
  return { mode: "ask_first", pageId, audience: isAdminPage ? "admin" : "merchant" };
}

module.exports = { detectWidgetMode, resolvePageId, PAGE_ID_MAP };
