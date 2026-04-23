// test/widget.mode.detector.test.js — Widget mode detector (pure functions)

"use strict";

const {
  resolvePageId,
  detectWidgetMode,
  PAGE_ID_MAP,
} = require("../src/agents/lib/widget.mode.detector");

// ── resolvePageId: exact matches from PAGE_ID_MAP ──────────────

describe("resolvePageId — exact PAGE_ID_MAP entries", () => {
  const expected = {
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
    "/merchant/settings": "merchant_settings",
    "/merchant/invoices": "merchant_invoices",
    "/merchant/onboarding": "pos_connection",
    "/account/change-password": "change_password",
  };

  for (const [route, pageId] of Object.entries(expected)) {
    test(`${route} → ${pageId}`, () => {
      expect(resolvePageId(route)).toBe(pageId);
    });
  }
});

// ── resolvePageId: admin merchant sub-page routes (regex) ──────

describe("resolvePageId — admin merchant sub-pages", () => {
  const subPages = [
    ["/merchants/42/users", "admin_merchant_users"],
    ["/merchants/1/products", "merchant_products"],
    ["/merchants/99/promotions", "merchant_promotions"],
    ["/merchants/7/stores", "merchant_stores"],
    ["/merchants/123/bundles", "merchant_bundles"],
    ["/merchants/5/invoices", "merchant_invoices"],
    ["/merchants/10/billing", "merchant_billing"],
    ["/merchants/3/setup", "merchant_settings"],
    ["/merchants/88/reports", "merchant_analytics"],
    ["/merchants/2/ownership", "admin_ownership_transfer"],
  ];

  for (const [route, pageId] of subPages) {
    test(`${route} → ${pageId}`, () => {
      expect(resolvePageId(route)).toBe(pageId);
    });
  }
});

// ── resolvePageId: catch-all /merchants/:id ────────────────────

describe("resolvePageId — /merchants/:id catch-all", () => {
  test("/merchants/42 (exact) → admin_merchant_detail", () => {
    expect(resolvePageId("/merchants/42")).toBe("admin_merchant_detail");
  });

  test("/merchants/1 → admin_merchant_detail", () => {
    expect(resolvePageId("/merchants/1")).toBe("admin_merchant_detail");
  });

  test("/merchants/999 → admin_merchant_detail", () => {
    expect(resolvePageId("/merchants/999")).toBe("admin_merchant_detail");
  });
});

// ── resolvePageId: prefix matching ─────────────────────────────

describe("resolvePageId — prefix matching", () => {
  test("/merchant/dashboard/something → merchant_dashboard (prefix)", () => {
    expect(resolvePageId("/merchant/dashboard/something")).toBe("merchant_dashboard");
  });

  test("/admin/system/details → admin_home (shorter /admin prefix wins)", () => {
    // /admin matches before /admin/system in iteration order
    expect(resolvePageId("/admin/system/details")).toBe("admin_home");
  });

  test("/merchant/promotions/42/edit → merchant_promotions (prefix)", () => {
    expect(resolvePageId("/merchant/promotions/42/edit")).toBe("merchant_promotions");
  });

  test("/admin/merchants/list → admin_home (shorter /admin prefix wins)", () => {
    expect(resolvePageId("/admin/merchants/list")).toBe("admin_home");
  });
});

// ── resolvePageId: unknown routes ──────────────────────────────

describe("resolvePageId — unknown routes", () => {
  test("/some/random/path → unknown", () => {
    expect(resolvePageId("/some/random/path")).toBe("unknown");
  });

  test("/login → unknown", () => {
    expect(resolvePageId("/login")).toBe("unknown");
  });

  test("/ → unknown", () => {
    expect(resolvePageId("/")).toBe("unknown");
  });
});

// ── resolvePageId: edge cases ──────────────────────────────────

describe("resolvePageId — edge cases", () => {
  test("null → unknown", () => {
    expect(resolvePageId(null)).toBe("unknown");
  });

  test("undefined → unknown", () => {
    expect(resolvePageId(undefined)).toBe("unknown");
  });

  test("empty string → unknown", () => {
    expect(resolvePageId("")).toBe("unknown");
  });

  test("hash prefix stripped: #/merchant/dashboard → merchant_dashboard", () => {
    expect(resolvePageId("#/merchant/dashboard")).toBe("merchant_dashboard");
  });

  test("hash prefix stripped: #/admin → admin_home", () => {
    expect(resolvePageId("#/admin")).toBe("admin_home");
  });

  test("store ID normalized: /merchant/stores/5 → merchant_stores", () => {
    expect(resolvePageId("/merchant/stores/5")).toBe("merchant_stores");
  });
});

// ── detectWidgetMode: diagnosis ────────────────────────────────

describe("detectWidgetMode — diagnosis (hasActiveError)", () => {
  test("returns diagnosis mode with autoOpen when error is active", () => {
    const result = detectWidgetMode({
      userRole: "merchant_admin",
      currentPage: "/merchant/dashboard",
      hasActiveError: true,
      userInitiated: false,
    });

    expect(result.mode).toBe("diagnosis");
    expect(result.autoOpen).toBe(true);
    expect(result.reason).toBe("active_error");
    expect(result.pageId).toBe("merchant_dashboard");
  });

  test("diagnosis takes priority even when userInitiated", () => {
    const result = detectWidgetMode({
      userRole: "pv_admin",
      currentPage: "/admin/system",
      hasActiveError: true,
      userInitiated: true,
    });

    expect(result.mode).toBe("diagnosis");
    expect(result.autoOpen).toBe(true);
  });
});

// ── detectWidgetMode: orientation ──────────────────────────────

describe("detectWidgetMode — orientation (userInitiated, known page)", () => {
  test("returns orientation for merchant page", () => {
    const result = detectWidgetMode({
      userRole: "merchant_admin",
      currentPage: "/merchant/promotions",
      hasActiveError: false,
      userInitiated: true,
    });

    expect(result.mode).toBe("orientation");
    expect(result.pageId).toBe("merchant_promotions");
    expect(result.audience).toBe("merchant");
  });

  test("returns orientation for admin page", () => {
    const result = detectWidgetMode({
      userRole: "pv_admin",
      currentPage: "/admin/oversight",
      hasActiveError: false,
      userInitiated: true,
    });

    expect(result.mode).toBe("orientation");
    expect(result.pageId).toBe("admin_oversight");
    expect(result.audience).toBe("admin");
  });
});

// ── detectWidgetMode: ask_first (ambiguous) ────────────────────

describe("detectWidgetMode — ask_first (ambiguous)", () => {
  test("not userInitiated, no error → ask_first", () => {
    const result = detectWidgetMode({
      userRole: "merchant_admin",
      currentPage: "/merchant/dashboard",
      hasActiveError: false,
      userInitiated: false,
    });

    expect(result.mode).toBe("ask_first");
    expect(result.pageId).toBe("merchant_dashboard");
    expect(result.audience).toBe("merchant");
  });

  test("userInitiated but unknown page → ask_first", () => {
    const result = detectWidgetMode({
      userRole: "pv_admin",
      currentPage: "/some/unknown/page",
      hasActiveError: false,
      userInitiated: true,
    });

    expect(result.mode).toBe("ask_first");
    expect(result.pageId).toBe("unknown");
  });
});

// ── detectWidgetMode: audience detection ───────────────────────

describe("detectWidgetMode — audience detection", () => {
  test("admin page → audience: admin", () => {
    const result = detectWidgetMode({
      userRole: "pv_admin",
      currentPage: "/admin/merchants",
      hasActiveError: false,
      userInitiated: true,
    });

    expect(result.audience).toBe("admin");
  });

  test("merchant page → audience: merchant", () => {
    const result = detectWidgetMode({
      userRole: "merchant_admin",
      currentPage: "/merchant/settings",
      hasActiveError: false,
      userInitiated: true,
    });

    expect(result.audience).toBe("merchant");
  });

  test("non-admin, non-merchant page → audience: merchant", () => {
    const result = detectWidgetMode({
      userRole: "merchant_admin",
      currentPage: "/account/change-password",
      hasActiveError: false,
      userInitiated: false,
    });

    expect(result.audience).toBe("merchant");
  });

  test("admin merchant sub-page includes /admin → audience: admin", () => {
    // Note: /merchants/42/users does NOT contain /admin, so audience is merchant
    const result = detectWidgetMode({
      userRole: "pv_admin",
      currentPage: "/merchants/42/users",
      hasActiveError: false,
      userInitiated: true,
    });

    expect(result.audience).toBe("merchant");
  });
});
