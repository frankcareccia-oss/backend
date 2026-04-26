/**
 * brand.scraper.js — Auto-extract brand assets from a merchant's website
 *
 * Extracts: logo, primary color, accent color, font, tagline, social links
 * Static HTML approach (cheerio) — covers ~80% of small business sites
 * (Squarespace, Wix, WordPress, static HTML)
 *
 * Usage:
 *   const { scrapeBrand } = require("./brand.scraper");
 *   const brand = await scrapeBrand("https://blvdcoffee.com");
 */

"use strict";

const cheerio = require("cheerio");

const TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 2_000_000; // 2MB max

// Google Fonts catalog subset — common fonts we can safely use
const GOOGLE_FONTS = new Set([
  "Roboto", "Open Sans", "Lato", "Montserrat", "Poppins", "Raleway",
  "Nunito", "Inter", "Oswald", "Playfair Display", "Merriweather",
  "PT Sans", "Source Sans Pro", "Ubuntu", "Rubik", "Work Sans",
  "DM Sans", "Quicksand", "Barlow", "Mulish", "Josefin Sans",
  "Nunito Sans", "Bitter", "Cabin", "Karla", "Libre Baskerville",
  "Arimo", "Fira Sans", "Manrope", "Space Grotesk", "Outfit",
  "Plus Jakarta Sans", "IBM Plex Sans", "Archivo", "Comfortaa",
  "Exo 2", "Lexend", "Red Hat Display", "Sora", "Urbanist",
]);

/**
 * Scrape brand assets from a URL.
 * @param {string} url - The merchant's website URL
 * @returns {object} { logo, primaryColor, accentColor, font, tagline, socialLinks, businessName }
 */
async function scrapeBrand(url) {
  const result = {
    logo: null,
    primaryColor: null,
    accentColor: null,
    font: null,
    tagline: null,
    socialLinks: [],
    businessName: null,
  };

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "PerkValet-BrandScraper/1.0 (https://perksvalet.com)",
        "Accept": "text/html",
      },
    });
    clearTimeout(timer);

    if (!res.ok) return result;

    const contentType = res.headers.get("content-type") || "";
    if (!contentType.includes("text/html")) return result;

    const html = await res.text();
    if (html.length > MAX_BODY_BYTES) return result;

    const $ = cheerio.load(html);

    // ── Business Name ──
    result.businessName =
      $('meta[property="og:site_name"]').attr("content")?.trim() ||
      $('meta[name="application-name"]').attr("content")?.trim() ||
      cleanTitle($("title").text()) ||
      null;

    // ── Logo ──
    result.logo = extractLogo($, url);

    // ── Colors ──
    const colors = extractColors($, html);
    result.primaryColor = colors.primary;
    result.accentColor = colors.accent;

    // ── Font ──
    result.font = extractFont($, html);

    // ── Tagline ──
    result.tagline = extractTagline($);

    // ── Social Links ──
    result.socialLinks = extractSocialLinks($);

  } catch (e) {
    // Timeout, network error, parse error — return partial results
    console.error("[brand.scraper] Error scraping", url, e?.message);
  }

  return result;
}

// ── Logo extraction ──────────────────────────────────────────────

function extractLogo($, baseUrl) {
  // Priority: og:image > apple-touch-icon > large favicon > header img

  const ogImage = $('meta[property="og:image"]').attr("content");
  if (ogImage) return resolveUrl(ogImage, baseUrl);

  const appleTouchIcon = $('link[rel="apple-touch-icon"]').attr("href") ||
                          $('link[rel="apple-touch-icon-precomposed"]').attr("href");
  if (appleTouchIcon) return resolveUrl(appleTouchIcon, baseUrl);

  // Look for large favicons (192px+)
  const icons = $('link[rel="icon"]').toArray();
  for (const icon of icons) {
    const sizes = $(icon).attr("sizes") || "";
    const size = parseInt(sizes.split("x")[0], 10);
    if (size >= 128) return resolveUrl($(icon).attr("href"), baseUrl);
  }

  // Look for img in header/nav with "logo" in src, alt, or class
  const headerImgs = $("header img, nav img, .logo img, img.logo, [class*=logo] img, img[alt*=logo]").toArray();
  for (const img of headerImgs) {
    const src = $(img).attr("src");
    if (src && !src.startsWith("data:")) return resolveUrl(src, baseUrl);
  }

  // Fallback: any favicon
  const favicon = $('link[rel="icon"]').first().attr("href") ||
                  $('link[rel="shortcut icon"]').first().attr("href");
  if (favicon) return resolveUrl(favicon, baseUrl);

  return null;
}

// ── Color extraction ─────────────────────────────────────────────

function extractColors($, html) {
  const colorCounts = {};

  // Extract from inline styles on nav, header, button elements
  const targets = $("nav, header, .navbar, .header, .nav, button, .btn, a.btn, [class*=primary]").toArray();
  for (const el of targets) {
    const style = $(el).attr("style") || "";
    const bgMatch = style.match(/background(?:-color)?\s*:\s*(#[0-9a-fA-F]{3,6})/);
    if (bgMatch) addColor(colorCounts, normalizeHex(bgMatch[1]));
  }

  // Extract from CSS custom properties in :root or inline style tags
  const styleBlocks = $("style").toArray().map(s => $(s).html()).join("\n");
  const allCss = styleBlocks + "\n" + html.match(/style="[^"]*"/g)?.join("\n") || "";

  // Look for CSS custom properties
  const varMatches = allCss.match(/--(?:primary|brand|main|accent|theme)[^:]*:\s*(#[0-9a-fA-F]{3,6})/gi);
  if (varMatches) {
    for (const m of varMatches) {
      const hex = m.match(/#[0-9a-fA-F]{3,6}/)?.[0];
      if (hex) addColor(colorCounts, normalizeHex(hex), 3); // boost CSS var colors
    }
  }

  // Look for background-color declarations in style tags
  const bgMatches = allCss.match(/background(?:-color)?\s*:\s*(#[0-9a-fA-F]{3,6})/gi);
  if (bgMatches) {
    for (const m of bgMatches) {
      const hex = m.match(/#[0-9a-fA-F]{3,6}/)?.[0];
      if (hex) addColor(colorCounts, normalizeHex(hex));
    }
  }

  // Sort by frequency, filter out white/black/gray
  const sorted = Object.entries(colorCounts)
    .filter(([c]) => !isNeutral(c))
    .sort((a, b) => b[1] - a[1]);

  return {
    primary: sorted[0]?.[0] || null,
    accent: sorted[1]?.[0] || null,
  };
}

function addColor(counts, hex, weight = 1) {
  if (!hex) return;
  counts[hex] = (counts[hex] || 0) + weight;
}

function normalizeHex(hex) {
  if (!hex) return null;
  hex = hex.toLowerCase();
  if (hex.length === 4) {
    // #abc → #aabbcc
    return "#" + hex[1] + hex[1] + hex[2] + hex[2] + hex[3] + hex[3];
  }
  return hex;
}

function isNeutral(hex) {
  if (!hex || hex.length !== 7) return true;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  // White-ish, black-ish, or gray-ish
  const avg = (r + g + b) / 3;
  const spread = Math.max(r, g, b) - Math.min(r, g, b);
  return avg > 230 || avg < 25 || spread < 20;
}

// ── Font extraction ──────────────────────────────────────────────

function extractFont($, html) {
  // Check Google Fonts link tags
  const gfLinks = $('link[href*="fonts.googleapis.com"]').toArray();
  for (const link of gfLinks) {
    const href = $(link).attr("href") || "";
    const familyMatch = href.match(/family=([^:&+]+)/);
    if (familyMatch) {
      const font = decodeURIComponent(familyMatch[1]).replace(/\+/g, " ");
      if (GOOGLE_FONTS.has(font)) return font;
    }
  }

  // Check font-family in body/h1 styles
  const styleBlocks = $("style").toArray().map(s => $(s).html()).join("\n");
  const fontMatch = styleBlocks.match(/font-family\s*:\s*['"]?([^'",;]+)/i);
  if (fontMatch) {
    const font = fontMatch[1].trim();
    if (GOOGLE_FONTS.has(font)) return font;
  }

  // Check inline styles on body
  const bodyFont = $("body").css("font-family") || $("body").attr("style")?.match(/font-family\s*:\s*['"]?([^'",;]+)/i)?.[1];
  if (bodyFont && GOOGLE_FONTS.has(bodyFont.trim())) return bodyFont.trim();

  return null;
}

// ── Tagline extraction ───────────────────────────────────────────

function extractTagline($) {
  // meta description, first sentence, max 200 chars
  const desc = $('meta[name="description"]').attr("content")?.trim() ||
               $('meta[property="og:description"]').attr("content")?.trim();
  if (!desc) return null;

  // Take first sentence
  const firstSentence = desc.split(/[.!?]/)[0]?.trim();
  if (firstSentence && firstSentence.length <= 200) return firstSentence;
  return desc.substring(0, 200);
}

// ── Social link extraction ───────────────────────────────────────

function extractSocialLinks($) {
  const platforms = ["instagram.com", "facebook.com", "yelp.com", "tiktok.com", "twitter.com", "x.com"];
  const links = [];
  const seen = new Set();

  $("a[href]").each((_, el) => {
    const href = $(el).attr("href") || "";
    for (const platform of platforms) {
      if (href.includes(platform) && !seen.has(platform)) {
        seen.add(platform);
        links.push({ platform: platform.split(".")[0], url: href });
      }
    }
  });

  return links;
}

// ── Helpers ──────────────────────────────────────────────────────

function cleanTitle(title) {
  if (!title) return null;
  // Remove common suffixes: "BLVD Coffee | Home", "BLVD Coffee - Craft Coffee"
  return title.split(/\s*[|–—-]\s*/)[0]?.trim() || null;
}

function resolveUrl(href, baseUrl) {
  if (!href) return null;
  if (href.startsWith("http")) return href;
  try {
    return new URL(href, baseUrl).href;
  } catch {
    return null;
  }
}

module.exports = { scrapeBrand };
