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
  "/merchants/": "admin_merchant_detail",
  "/merchant/dashboard": "merchant_dashboard",
  "/merchant/weekly": "merchant_weekly",
  "/merchant/promotions": "merchant_promotions",
  "/merchant/products": "merchant_products",
  "/merchant/stores": "merchant_stores",
  "/merchant/bundles": "merchant_bundles",
  "/merchant/analytics": "merchant_analytics",
  "/merchant/growth-studio": "merchant_growth_studio",
  "/merchant/plan": "merchant_plan",
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
    .replace(/\/stores\/\d+/, "/stores/:id");

  // Check for admin merchant sub-pages BEFORE normalizing merchant IDs
  if (/\/merchants\/\d+\/users/.test(clean)) return "admin_merchant_users";
  if (/\/merchants\/\d+\/products/.test(clean)) return "merchant_products";
  if (/\/merchants\/\d+\/promotions/.test(clean)) return "merchant_promotions";
  if (/\/merchants\/\d+\/stores/.test(clean)) return "merchant_stores";
  if (/\/merchants\/\d+\/bundles/.test(clean)) return "merchant_bundles";
  if (/\/merchants\/\d+\/invoices/.test(clean)) return "merchant_invoices";
  if (/\/merchants\/\d+\/billing/.test(clean)) return "merchant_billing";
  if (/\/merchants\/\d+\/setup/.test(clean)) return "merchant_settings";
  if (/\/merchants\/\d+\/reports/.test(clean)) return "merchant_analytics";
  if (/\/merchants\/\d+\/ownership/.test(clean)) return "admin_ownership_transfer";
  if (/\/merchants\/\d+$/.test(clean)) return "admin_merchant_detail";

  const normalized = clean.replace(/\/merchants\/\d+/, "/merchant");

  // Exact match first
  if (PAGE_ID_MAP[normalized]) return PAGE_ID_MAP[normalized];

  // Prefix match
  for (const [pattern, id] of Object.entries(PAGE_ID_MAP)) {
    if (normalized.startsWith(pattern)) return id;
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
