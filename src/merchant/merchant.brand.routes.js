/**
 * merchant.brand.routes.js — Brand settings for merchant-branded consumer experience
 *
 * Merchant-facing:
 *   GET    /api/merchant/brand         — get current brand settings
 *   PATCH  /api/merchant/brand         — update brand settings
 *   GET    /api/merchant/brand/check-slug/:slug — check slug availability
 *   POST   /api/merchant/brand/scrape  — auto-extract brand from website
 *
 * Public (consumer-facing):
 *   GET    /api/brand/:slug            — get brand data for branded consumer page
 */

"use strict";

const express = require("express");
const { prisma } = require("../db/prisma");
const { sendError } = require("../utils/errors");
const { requireJwt } = require("../middleware/auth");
const { emitPvHook } = require("../utils/hooks");
const { scrapeBrand } = require("./brand.scraper");

const router = express.Router();

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
// GET /api/merchant/brand
// Get brand settings for the current merchant
// ──────────────────────────────────────────────
router.get("/api/merchant/brand", requireJwt, async (req, res) => {
  try {
    const merchantId = req.merchantId;
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
        ? `${process.env.CONSUMER_APP_URL || "https://perksvalet.com"}/m/${merchant.merchantSlug}`
        : null,
    });
  } catch (err) {
    return sendError(res, 500, "SERVER_ERROR", err.message);
  }
});

// ──────────────────────────────────────────────
// PATCH /api/merchant/brand
// Update brand settings
// ──────────────────────────────────────────────
router.patch("/api/merchant/brand", requireJwt, async (req, res) => {
  try {
    const merchantId = req.merchantId;
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
        ? `${process.env.CONSUMER_APP_URL || "https://perksvalet.com"}/m/${updated.merchantSlug}`
        : null,
    });
  } catch (err) {
    return sendError(res, 500, "SERVER_ERROR", err.message);
  }
});

// ──────────────────────────────────────────────
// GET /api/merchant/brand/check-slug/:slug
// Check if a slug is available
// ──────────────────────────────────────────────
router.get("/api/merchant/brand/check-slug/:slug", requireJwt, async (req, res) => {
  try {
    const slug = (req.params.slug || "").toLowerCase().replace(/[^a-z0-9-]/g, "");

    if (slug.length < 3) return res.json({ available: false, reason: "too_short" });
    if (RESERVED_SLUGS.has(slug)) return res.json({ available: false, reason: "reserved" });

    const existing = await prisma.merchant.findUnique({ where: { merchantSlug: slug } });
    const available = !existing || existing.id === req.merchantId;

    return res.json({ available, slug });
  } catch (err) {
    return sendError(res, 500, "SERVER_ERROR", err.message);
  }
});

// ──────────────────────────────────────────────
// POST /api/merchant/brand/scrape
// Auto-extract brand assets from merchant's website
// ──────────────────────────────────────────────
router.post("/api/merchant/brand/scrape", requireJwt, async (req, res) => {
  try {
    const merchantId = req.merchantId;
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
// GET /api/brand/:slug (PUBLIC — no auth)
// Consumer-facing: get brand data for branded page rendering
// ──────────────────────────────────────────────
router.get("/api/brand/:slug", async (req, res) => {
  try {
    const slug = req.params.slug;
    if (!slug) return sendError(res, 400, "VALIDATION_ERROR", "Slug is required");

    const merchant = await prisma.merchant.findUnique({
      where: { merchantSlug: slug },
      select: {
        id: true, name: true,
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

module.exports = router;
