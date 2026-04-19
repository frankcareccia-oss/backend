// src/utils/aiDraft.js
//
// Shared AI draft generation — one Anthropic client, one place for all prompts.
// Routes call these functions; no route should import @anthropic-ai/sdk directly.
//
// All functions:
//   - Throw an Error if ANTHROPIC_API_KEY is not set
//   - Return the draft string directly (caller wraps in { draft })
//   - Use claude-haiku for speed + cost efficiency

"use strict";

const Anthropic = require("@anthropic-ai/sdk");

let _client = null;

function getClient() {
  if (!_client) _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _client;
}

function requireKey() {
  if (!process.env.ANTHROPIC_API_KEY)
    throw Object.assign(new Error("AI draft generation is not configured"), { code: "AI_UNAVAILABLE" });
}

const MODEL = "claude-haiku-4-5-20251001";

function fmtDate(val) {
  if (!val) return null;
  try {
    return new Date(val).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
  } catch { return String(val); }
}

// ── Promotions ──────────────────────────────────────────────────────────────

/**
 * Draft T&C text for a loyalty promotion.
 */
async function draftPromoTerms({
  merchantName, name, categoryName,
  threshold, rewardType, rewardValue, rewardSku, rewardNote,
  timeframeDays, startAt, endAt, maxGrantsPerVisit,
}) {
  requireKey();

  let rewardDesc;
  if (rewardType === "free_item")      rewardDesc = `a free item (SKU: ${rewardSku || "TBD"})`;
  else if (rewardType === "discount_pct")   rewardDesc = `${rewardValue}% off your purchase`;
  else if (rewardType === "discount_fixed") rewardDesc = `$${((rewardValue || 0) / 100).toFixed(2)} off your purchase`;
  else                                 rewardDesc = rewardNote || "a custom reward";

  const earnDesc = categoryName
    ? `each qualifying purchase of ${categoryName} products`
    : "each qualifying purchase";

  const windowLine = timeframeDays
    ? `Stamps earned more than ${timeframeDays} days ago will not count toward your next reward.`
    : "Earned stamps do not expire.";

  const startFmt = fmtDate(startAt);
  const endFmt   = fmtDate(endAt);
  const periodLine = (startFmt || endFmt)
    ? `Program valid ${startFmt || "immediately"} through ${endFmt || "further notice"}.`
    : "Program runs until further notice.";

  const limitLine = maxGrantsPerVisit
    ? `A maximum of ${maxGrantsPerVisit} reward(s) may be redeemed per visit.`
    : "";

  const prompt = `Write a 2-3 sentence loyalty program summary for a mobile app. Plain English, second person, no headings. Cover: how to earn, the reward, and expiry/period. End with one short sentence that the merchant may modify or cancel the program at any time.

Program: ${name}
Earn: 1 stamp per ${earnDesc}. Need ${threshold} stamps to earn ${rewardDesc}.
${windowLine}
${periodLine}
${limitLine}

Write the summary now:`;

  const msg = await getClient().messages.create({
    model: MODEL,
    max_tokens: 150,
    messages: [{ role: "user", content: prompt }],
  });

  return msg.content?.[0]?.text?.trim() || "";
}

// ── Bundles ─────────────────────────────────────────────────────────────────

/**
 * Draft T&C text for a prepaid bundle.
 * componentsDesc: human-readable summary, e.g. "10× Coffee + 5× Pastry"
 */
async function draftBundleTerms({
  merchantName, name, price, componentsDesc, startAt, endAt,
}) {
  requireKey();

  const priceDesc = price != null ? `$${Number(price).toFixed(2)}` : "the stated sale price";

  const startFmt = fmtDate(startAt);
  const endFmt   = fmtDate(endAt);
  const periodLine = (startFmt || endFmt)
    ? `Valid from ${startFmt || "date of purchase"} through ${endFmt || "further notice"}.`
    : "No fixed expiry — valid until fully redeemed or the program is closed.";

  const prompt = `Write a 2-3 sentence prepaid bundle summary for a mobile app. Plain English, second person, no headings. Cover: what's included, the price, and validity. End with one short sentence that credits are non-refundable and the merchant may cancel at any time.

Bundle: ${name} — ${componentsDesc || "as described"} for ${priceDesc}. ${periodLine}

Write the summary now:`;

  const msg = await getClient().messages.create({
    model: MODEL,
    max_tokens: 150,
    messages: [{ role: "user", content: prompt }],
  });

  return msg.content?.[0]?.text?.trim() || "";
}

// ── Products ─────────────────────────────────────────────────────────────────

/**
 * Draft a short compliance blurb for a product.
 * allergens: string[] e.g. ["gluten", "dairy", "tree nuts"]
 * dietaryFlags: string[] e.g. ["vegan", "gluten-free"]
 */
async function draftProductInfo({
  merchantName, productName, categoryName, description,
  allergens, dietaryFlags,
}) {
  requireKey();

  const allergenStatement = allergens?.length
    ? `Contains: ${allergens.join(", ")}.`
    : "No major allergens declared.";

  const dietaryStatement = dietaryFlags?.length
    ? `Dietary: ${dietaryFlags.join(", ")}.`
    : "";

  const prompt = `You are a product compliance copywriter for a food and beverage point-of-sale system. Write a short product information blurb for the product below. Output exactly TWO lines with no headings, labels, bullets, or blank lines between them:

Line 1: A 1–2 sentence industry-standard product description (what it is, key characteristics, style).
Line 2: A compliance statement beginning with "Allergen info:" followed by the allergen and dietary details.

Product Name: ${productName}
Merchant / Business: ${merchantName || "the merchant"}
Category: ${categoryName || "food & beverage"}
${description ? `Existing notes: ${description}` : ""}
Allergen info: ${allergenStatement}
${dietaryStatement}

Write the two lines now:`;

  const msg = await getClient().messages.create({
    model: MODEL,
    max_tokens: 200,
    messages: [{ role: "user", content: prompt }],
  });

  return msg.content?.[0]?.text?.trim() || "";
}

/**
 * Generate a Growth Advisor AI summary from metrics and recommendations.
 * Falls back to null if API key is missing (caller uses deterministic summary).
 */
async function draftGrowthSummary({ metrics, insights, recommendations }) {
  if (!process.env.ANTHROPIC_API_KEY) return null;

  const recText = recommendations
    .map((r) => `- ${r.headline}: ${r.recommendation}`)
    .join("\n");

  const prompt = `You are a concise business advisor for a small retail merchant. Based on these 30-day metrics, write a 2-3 sentence plain-language summary. Be direct, specific, and actionable. No filler.

Metrics:
- Orders: ${metrics.totalOrders}
- Average ticket: $${((metrics.aov || 0) / 100).toFixed(2)}
- Repeat rate: ${metrics.repeatRate != null ? Math.round(metrics.repeatRate * 100) + "%" : "unknown"}
- Return rate (first→second visit): ${metrics.firstToSecondVisitRate != null ? Math.round(metrics.firstToSecondVisitRate * 100) + "%" : "unknown"}
- Unique customers: ${metrics.uniqueConsumers}

Insights:
${insights.length ? insights.map((i) => `- ${i}`).join("\n") : "- None detected"}

Recommendations:
${recText || "- None"}

Write the summary now. No greeting, no sign-off.`;

  try {
    const msg = await getClient().messages.create({
      model: MODEL,
      max_tokens: 150,
      messages: [{ role: "user", content: prompt }],
    });
    return msg.content?.[0]?.text?.trim() || null;
  } catch (e) {
    console.error("[aiDraft] growth summary failed:", e?.message);
    return null;
  }
}

// ── Product Description (consumer-facing, enticing) ─────────────────────────

/**
 * Draft a short, enticing product description for consumer-facing display.
 * 2-3 sentences that make you want to try it.
 */
async function draftProductDescription({
  merchantName, productName, categoryName,
}) {
  requireKey();

  const prompt = `You are a menu copywriter for an independent ${categoryName || "food & beverage"} shop called "${merchantName || "the shop"}". Write a 2-sentence product description for "${productName}" that makes a customer want to order it right now. Be warm, sensory, and specific — mention texture, flavor, or experience. No hype words like "amazing" or "best". No headings, no bullets. Just two vivid sentences.

Write the description now:`;

  const msg = await getClient().messages.create({
    model: MODEL,
    max_tokens: 100,
    messages: [{ role: "user", content: prompt }],
  });

  return msg.content?.[0]?.text?.trim() || "";
}

// ── Promotion Description (consumer-facing pitch) ───────────────────────────

/**
 * Draft a short, compelling promotion description for consumer-facing display.
 * 2 sentences that make joining feel like a no-brainer.
 */
async function draftPromoDescription({
  merchantName, promoName, categoryName,
  rewardType, rewardValue, rewardSku, rewardNote,
  threshold, timeframeDays,
  promotionType, bundleComponents,
}) {
  requireKey();

  // Build reward description
  let rewardDesc;
  if (rewardType === "free_item")      rewardDesc = `a free ${rewardSku || "item"}`;
  else if (rewardType === "discount_pct")   rewardDesc = `${rewardValue}% off your order`;
  else if (rewardType === "discount_fixed") rewardDesc = `$${((rewardValue || 0) / 100).toFixed(2)} off`;
  else                                 rewardDesc = rewardNote || "a special reward";

  // Build context based on promotion type
  let typeContext;
  if (promotionType === "bundle" && bundleComponents) {
    typeContext = `This is a combo/bundle deal: ${bundleComponents}. The consumer gets all items together.`;
  } else {
    typeContext = `This is a stamp/loyalty program. The consumer earns 1 stamp per qualifying ${categoryName || "purchase"}. After ${threshold} stamps, they earn ${rewardDesc}.`;
  }

  const urgencyLine = timeframeDays
    ? `Stamps expire after ${timeframeDays} days, so there is a gentle urgency.`
    : "";

  const prompt = `You are a loyalty program copywriter for "${merchantName || "a local shop"}". Write exactly 2 sentences that make a consumer want to join this program RIGHT NOW. Be warm and specific — mention the actual reward, the number of visits, and make it feel effortless. No hype words like "amazing" or "incredible". No headings, no bullets. Make the consumer think "why wouldn't I do this?"

Program: ${promoName || "Loyalty Program"}
${typeContext}
${urgencyLine}

Write the 2-sentence pitch now:`;

  const msg = await getClient().messages.create({
    model: MODEL,
    max_tokens: 120,
    messages: [{ role: "user", content: prompt }],
  });

  return msg.content?.[0]?.text?.trim() || "";
}

// ── Bundle Description (consumer-facing pitch) ──────────────────────────────

/**
 * Draft a short, compelling bundle description for consumer-facing display.
 * 2 sentences that sell the value + convenience.
 */
async function draftBundleDescription({
  merchantName, bundleName, componentsDesc, price,
}) {
  requireKey();

  const priceDesc = price != null ? `$${Number(price).toFixed(2)}` : "one easy price";

  const prompt = `You are a menu copywriter for "${merchantName || "a local shop"}". Write exactly 2 sentences that make a consumer want to grab this combo deal. Focus on convenience, value, and how the items go together. Be warm and specific. No hype words. No headings, no bullets.

Bundle: ${bundleName || "Combo Deal"}
What's included: ${componentsDesc || "a curated selection"}
Price: ${priceDesc}

Write the 2-sentence pitch now:`;

  const msg = await getClient().messages.create({
    model: MODEL,
    max_tokens: 100,
    messages: [{ role: "user", content: prompt }],
  });

  return msg.content?.[0]?.text?.trim() || "";
}

module.exports = {
  draftPromoTerms, draftBundleTerms,
  draftProductInfo, draftProductDescription,
  draftPromoDescription, draftBundleDescription,
  draftGrowthSummary,
};
