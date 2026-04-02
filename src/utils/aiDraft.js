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

  const prompt = `You are a legal copywriter for a consumer loyalty rewards program. Write clear, plain-English Terms & Conditions for the program described below. Requirements: 5–7 sentences, under 220 words, second person ("you earn…"), no title or heading, body text only. You must include an explicit clause that ${merchantName || "the merchant"} reserves the right to modify, suspend, or cancel this program at any time without prior notice.

Program Name: ${name}
Merchant: ${merchantName || "the merchant"}
How to earn: Collect 1 stamp for ${earnDesc}
Stamps required: ${threshold} stamps to earn ${rewardDesc}
${windowLine}
${periodLine}
${limitLine ? limitLine + "\n" : ""}
Write the Terms & Conditions now:`;

  const msg = await getClient().messages.create({
    model: MODEL,
    max_tokens: 450,
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

  const prompt = `You are a legal copywriter for a prepaid bundle credit program. Write clear, plain-English Terms & Conditions for the bundle described below. Requirements: 6–8 sentences, under 260 words, second person, no title or heading, body text only.

The terms MUST explicitly address all of the following points in order:
1. Exactly what the bundle includes (use the contents exactly as described).
2. The purchase price.
3. Validity period.
4. The bundle is non-transferable and has no cash or monetary value.
5. No refunds or exchanges after purchase.
6. Redemption is subject to product availability at the time of the visit.
7. ${merchantName || "The merchant"} reserves the right to suspend or cancel this program at any time; in such cases, any remaining unused balance will be handled in accordance with applicable consumer protection law.

Bundle Name: ${name}
Merchant: ${merchantName || "the merchant"}
Purchase Price: ${priceDesc}
Contents: ${componentsDesc || "as described"}
${periodLine}

Write the Terms & Conditions now:`;

  const msg = await getClient().messages.create({
    model: MODEL,
    max_tokens: 550,
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

module.exports = { draftPromoTerms, draftBundleTerms, draftProductInfo };
