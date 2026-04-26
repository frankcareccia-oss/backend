/**
 * merchant.brand.routes.js — Brand settings for merchant-branded consumer experience
 *
 * Merchant-facing:
 *   GET    /merchant/brand         — get current brand settings
 *   PATCH  /merchant/brand         — update brand settings
 *   GET    /merchant/brand/check-slug/:slug — check slug availability
 *   POST   /merchant/brand/scrape  — auto-extract brand from website
 *
 * Public (consumer-facing):
 *   GET    /brand/:slug            — get brand data for branded consumer page
 */

"use strict";

const express = require("express");
const { prisma } = require("../db/prisma");
const { sendError } = require("../utils/errors");
const { requireJwt } = require("../middleware/auth");
const { emitPvHook } = require("../utils/hooks");
const { scrapeBrand } = require("./brand.scraper");

const router = express.Router();

// Resolve merchantId from JWT user (same pattern as other merchant routes)
async function getMerchantId(req) {
  if (req.merchantId) return req.merchantId;
  if (!req.userId) return null;
  const mu = await prisma.merchantUser.findFirst({
    where: { userId: req.userId, status: "active" },
    select: { merchantId: true },
  });
  return mu?.merchantId || null;
}

// Reserved slugs that cannot be used by merchants
const RESERVED_SLUGS = new Set([
  "app", "admin", "api", "pos", "login", "help", "support",
  "about", "pricing", "developers", "privacy", "terms", "m",
  "webhook", "webhooks", "status", "health", "docs",
]);

/**
 * Slugify a merchant name into a URL-safe slug.
 * "BLVD Coffee" → "blvd-coffee"
 */
function slugify(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .substring(0, 100);
}

// ──────────────────────────────────────────────
// GET /merchant/brand
// Get brand settings for the current merchant
// ──────────────────────────────────────────────
router.get("/merchant/brand", requireJwt, async (req, res) => {
  try {
    const merchantId = await getMerchantId(req);
    if (!merchantId) return sendError(res, 400, "VALIDATION_ERROR", "Merchant context required");

    const merchant = await prisma.merchant.findUnique({
      where: { id: merchantId },
      select: {
        id: true, name: true,
        websiteUrl: true, merchantSlug: true,
        brandLogo: true, brandColor: true, brandAccent: true,
        brandFont: true, brandTagline: true,
        brandScrapedAt: true, brandOverrides: true,
        planTier: true,
      },
    });

    if (!merchant) return sendError(res, 404, "NOT_FOUND", "Merchant not found");

    // Auto-generate slug suggestion if not set
    const suggestedSlug = merchant.merchantSlug || slugify(merchant.name);

    return res.json({
      ...merchant,
      suggestedSlug,
      brandedUrl: merchant.merchantSlug
        ? `${process.env.CONSUMER_APP_URL || "https://perksvalet.com"}/#/m/${merchant.merchantSlug}`
        : null,
    });
  } catch (err) {
    return sendError(res, 500, "SERVER_ERROR", err.message);
  }
});

// ──────────────────────────────────────────────
// PATCH /merchant/brand
// Update brand settings
// ──────────────────────────────────────────────
router.patch("/merchant/brand", requireJwt, async (req, res) => {
  try {
    const merchantId = await getMerchantId(req);
    if (!merchantId) return sendError(res, 400, "VALIDATION_ERROR", "Merchant context required");

    // Only owner or merchant_admin can update brand
    const mu = await prisma.merchantUser.findFirst({
      where: { userId: req.userId, merchantId, status: "active" },
      select: { role: true },
    });
    if (!mu || !["owner", "merchant_admin"].includes(mu.role)) {
      return sendError(res, 403, "FORBIDDEN", "Merchant owner or admin role required");
    }

    const {
      websiteUrl, merchantSlug, brandLogo, brandColor,
      brandAccent, brandFont, brandTagline,
    } = req.body || {};

    const data = {};

    if (websiteUrl !== undefined) {
      if (websiteUrl && !/^https?:\/\/.+/.test(websiteUrl)) {
        return sendError(res, 400, "VALIDATION_ERROR", "Website URL must start with http:// or https://");
      }
      data.websiteUrl = websiteUrl || null;
    }

    if (merchantSlug !== undefined) {
      if (merchantSlug) {
        const slug = merchantSlug.toLowerCase().replace(/[^a-z0-9-]/g, "").substring(0, 100);
        if (slug.length < 3) {
          return sendError(res, 400, "VALIDATION_ERROR", "Slug must be at least 3 characters");
        }
        if (RESERVED_SLUGS.has(slug)) {
          return sendError(res, 400, "VALIDATION_ERROR", "This slug is reserved");
        }
        // Check uniqueness
        const existing = await prisma.merchant.findUnique({ where: { merchantSlug: slug } });
        if (existing && existing.id !== merchantId) {
          return sendError(res, 409, "UNIQUE_VIOLATION", "This slug is already taken");
        }
        data.merchantSlug = slug;
      } else {
        data.merchantSlug = null;
      }
    }

    if (brandLogo !== undefined) {
      if (brandLogo && !/^https?:\/\/.+/.test(brandLogo)) {
        return sendError(res, 400, "VALIDATION_ERROR", "Logo must be a valid URL");
      }
      data.brandLogo = brandLogo || null;
    }

    if (brandColor !== undefined) {
      if (brandColor && !/^#[0-9a-fA-F]{6}$/.test(brandColor)) {
        return sendError(res, 400, "VALIDATION_ERROR", "Color must be a valid hex code (e.g. #2D5A3D)");
      }
      data.brandColor = brandColor || null;
    }

    if (brandAccent !== undefined) {
      if (brandAccent && !/^#[0-9a-fA-F]{6}$/.test(brandAccent)) {
        return sendError(res, 400, "VALIDATION_ERROR", "Accent color must be a valid hex code");
      }
      data.brandAccent = brandAccent || null;
    }

    if (brandFont !== undefined) data.brandFont = brandFont ? String(brandFont).substring(0, 100) : null;
    if (brandTagline !== undefined) data.brandTagline = brandTagline ? String(brandTagline).substring(0, 200) : null;

    if (Object.keys(data).length === 0) {
      return sendError(res, 400, "VALIDATION_ERROR", "Nothing to update");
    }

    const updated = await prisma.merchant.update({
      where: { id: merchantId },
      data,
      select: {
        id: true, name: true,
        websiteUrl: true, merchantSlug: true,
        brandLogo: true, brandColor: true, brandAccent: true,
        brandFont: true, brandTagline: true,
        brandScrapedAt: true,
      },
    });

    emitPvHook("merchant.brand.updated", {
      tc: "TC-BRAND-01", sev: "info",
      stable: `merchant:${merchantId}:brand`,
      merchantId,
      fields: Object.keys(data),
    });

    return res.json({
      ...updated,
      brandedUrl: updated.merchantSlug
        ? `${process.env.CONSUMER_APP_URL || "https://perksvalet.com"}/#/m/${updated.merchantSlug}`
        : null,
    });
  } catch (err) {
    return sendError(res, 500, "SERVER_ERROR", err.message);
  }
});

// ──────────────────────────────────────────────
// GET /merchant/brand/check-slug/:slug
// Check if a slug is available
// ──────────────────────────────────────────────
router.get("/merchant/brand/check-slug/:slug", requireJwt, async (req, res) => {
  try {
    const slug = (req.params.slug || "").toLowerCase().replace(/[^a-z0-9-]/g, "");

    if (slug.length < 3) return res.json({ available: false, reason: "too_short" });
    if (RESERVED_SLUGS.has(slug)) return res.json({ available: false, reason: "reserved" });

    const myMerchantId = await getMerchantId(req);
    const existing = await prisma.merchant.findUnique({ where: { merchantSlug: slug } });
    const available = !existing || existing.id === myMerchantId;

    return res.json({ available, slug });
  } catch (err) {
    return sendError(res, 500, "SERVER_ERROR", err.message);
  }
});

// ──────────────────────────────────────────────
// POST /merchant/brand/scrape
// Auto-extract brand assets from merchant's website
// ──────────────────────────────────────────────
router.post("/merchant/brand/scrape", requireJwt, async (req, res) => {
  try {
    const merchantId = await getMerchantId(req);
    if (!merchantId) return sendError(res, 400, "VALIDATION_ERROR", "Merchant context required");

    const { websiteUrl } = req.body || {};
    if (!websiteUrl || !/^https?:\/\/.+/.test(websiteUrl)) {
      return sendError(res, 400, "VALIDATION_ERROR", "Valid website URL is required");
    }

    // Rate limit: 1 scrape per merchant per hour
    const merchant = await prisma.merchant.findUnique({
      where: { id: merchantId },
      select: { brandScrapedAt: true, name: true },
    });
    if (merchant?.brandScrapedAt) {
      const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
      if (merchant.brandScrapedAt > hourAgo) {
        return sendError(res, 429, "RATE_LIMITED", "Brand scraping is limited to once per hour. Try again later.");
      }
    }

    emitPvHook("merchant.brand.scrape.started", {
      tc: "TC-BRAND-02", sev: "info",
      stable: `merchant:${merchantId}:brand:scrape`,
      merchantId, websiteUrl,
    });

    const scraped = await scrapeBrand(websiteUrl);

    // Auto-generate slug from scraped business name or merchant name
    const nameForSlug = scraped.businessName || merchant?.name || "";
    const suggestedSlug = slugify(nameForSlug);

    // Save websiteUrl and scrape timestamp (don't overwrite existing brand settings automatically)
    await prisma.merchant.update({
      where: { id: merchantId },
      data: { websiteUrl, brandScrapedAt: new Date() },
    });

    emitPvHook("merchant.brand.scrape.completed", {
      tc: "TC-BRAND-03", sev: "info",
      stable: `merchant:${merchantId}:brand:scrape`,
      merchantId,
      foundLogo: !!scraped.logo,
      foundColor: !!scraped.primaryColor,
      foundFont: !!scraped.font,
    });

    return res.json({
      scraped: {
        logo: scraped.logo,
        primaryColor: scraped.primaryColor,
        accentColor: scraped.accentColor,
        font: scraped.font,
        tagline: scraped.tagline,
        businessName: scraped.businessName,
        socialLinks: scraped.socialLinks,
      },
      suggestedSlug,
    });
  } catch (err) {
    return sendError(res, 500, "SERVER_ERROR", err.message);
  }
});

// ──────────────────────────────────────────────
// GET /brand/:slug (PUBLIC — no auth)
// Consumer-facing: get brand data for branded page rendering
// ──────────────────────────────────────────────
router.get("/brand/:slug", async (req, res) => {
  try {
    const slug = req.params.slug;
    if (!slug) return sendError(res, 400, "VALIDATION_ERROR", "Slug is required");

    const merchant = await prisma.merchant.findUnique({
      where: { merchantSlug: slug },
      select: {
        id: true, name: true, planTier: true, status: true,
        brandLogo: true, brandColor: true, brandAccent: true,
        brandFont: true, brandTagline: true,
        stores: {
          where: { status: "active" },
          select: { id: true, name: true, city: true, state: true },
          orderBy: { name: "asc" },
        },
      },
    });

    if (!merchant) return sendError(res, 404, "NOT_FOUND", "Merchant not found");

    // Feature gate: branded pages require Value-Added (or trial)
    if (merchant.planTier !== "value_added" && merchant.status !== "active") {
      return sendError(res, 403, "UPGRADE_REQUIRED", "Branded pages require the Value-Added plan");
    }

    return res.json({
      merchantId: merchant.id,
      name: merchant.name,
      logo: merchant.brandLogo,
      color: merchant.brandColor,
      accent: merchant.brandAccent,
      font: merchant.brandFont,
      tagline: merchant.brandTagline,
      stores: merchant.stores,
    });
  } catch (err) {
    return sendError(res, 500, "SERVER_ERROR", err.message);
  }
});

// ──────────────────────────────────────────────
// POST /brand/:slug/view (PUBLIC)
// Log a branded page view for analytics
// ──────────────────────────────────────────────
router.post("/brand/:slug/view", async (req, res) => {
  try {
    const merchant = await prisma.merchant.findUnique({
      where: { merchantSlug: req.params.slug },
      select: { id: true },
    });
    if (!merchant) return res.status(404).json({ ok: false });

    emitPvHook("brand.page.view", {
      tc: "TC-BRAND-04", sev: "info",
      stable: `brand:${req.params.slug}:view`,
      merchantId: merchant.id,
      slug: req.params.slug,
      referrer: req.get("referer") || null,
    });

    return res.json({ ok: true });
  } catch {
    return res.json({ ok: false });
  }
});

// ──────────────────────────────────────────────
// GET /brand/:slug/manifest.json (PUBLIC)
// Dynamic PWA manifest for "Add to Home Screen"
// ──────────────────────────────────────────────
router.get("/brand/:slug/manifest.json", async (req, res) => {
  try {
    const merchant = await prisma.merchant.findUnique({
      where: { merchantSlug: req.params.slug },
      select: { name: true, brandLogo: true, brandColor: true, brandTagline: true },
    });
    if (!merchant) return res.status(404).json({ error: "Not found" });

    const appUrl = process.env.CONSUMER_APP_URL || "https://perksvalet.com";
    const manifest = {
      name: `${merchant.name} Loyalty`,
      short_name: merchant.name,
      description: merchant.brandTagline || `Loyalty rewards at ${merchant.name}`,
      start_url: `/m/${req.params.slug}`,
      scope: `/m/${req.params.slug}`,
      display: "standalone",
      theme_color: merchant.brandColor || "#0D9488",
      background_color: merchant.brandColor || "#0D9488",
      icons: merchant.brandLogo ? [
        { src: merchant.brandLogo, sizes: "192x192", type: "image/png" },
        { src: merchant.brandLogo, sizes: "512x512", type: "image/png" },
      ] : [
        { src: `${appUrl}/perksvalet-192.png`, sizes: "192x192", type: "image/png" },
      ],
    };

    res.setHeader("Content-Type", "application/manifest+json");
    res.setHeader("Cache-Control", "public, max-age=3600");
    return res.json(manifest);
  } catch (err) {
    return res.status(500).json({ error: "Failed to generate manifest" });
  }
});

// ──────────────────────────────────────────────
// GET /brand/:slug/meta (PUBLIC)
// Social sharing meta data for og:tags
// ──────────────────────────────────────────────
router.get("/brand/:slug/meta", async (req, res) => {
  try {
    const merchant = await prisma.merchant.findUnique({
      where: { merchantSlug: req.params.slug },
      select: { name: true, brandLogo: true, brandTagline: true },
    });
    if (!merchant) return res.status(404).json({ error: "Not found" });

    const appUrl = process.env.CONSUMER_APP_URL || "https://perksvalet.com";
    return res.json({
      title: `${merchant.name} Loyalty`,
      description: merchant.brandTagline || `Join ${merchant.name}'s loyalty program — earn rewards with every visit.`,
      image: merchant.brandLogo || `${appUrl}/perksvalet-og.png`,
      url: `${appUrl}/m/${req.params.slug}`,
    });
  } catch (err) {
    return res.status(500).json({ error: "Failed to load meta" });
  }
});

module.exports = router;
