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
    ? `Stamps stay active for ${timeframeDays} days from when they're earned.`
    : "Your stamps never expire.";

  const startFmt = fmtDate(startAt);
  const endFmt   = fmtDate(endAt);
  const periodLine = (startFmt || endFmt)
    ? `Available ${startFmt || "now"} through ${endFmt || "further notice"}.`
    : "This program is ongoing with no end date.";

  const limitLine = maxGrantsPerVisit
    ? `Up to ${maxGrantsPerVisit} reward(s) can be redeemed per visit.`
    : "";

  const prompt = `Write a 2-3 sentence loyalty program summary for a mobile app. Warm, friendly, plain English, second person. No headings. Cover: how to earn, the reward, and any time limits. End with one short reassuring sentence noting that program details may be updated from time to time.

Tone rules:
- Be welcoming, not legalistic. This is a gift, not a contract.
- Say "stay active for X days" instead of "won't count after X days"
- Say "details may be updated" instead of "we may modify or cancel"
- Never use the words "void", "forfeit", "terminate", or "cancel"
- Keep it under 3 sentences total

Program: ${name}
Earn: 1 stamp per ${earnDesc}. Collect ${threshold} stamps to receive ${rewardDesc}.
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

// ── Promotion Description (consumer-facing pitch, two versions) ─────────────

/**
 * Draft two versions of consumer-facing promotion copy.
 * Version A: Reward-led — opens with what you get.
 * Version B: Experience-led — opens with the moment or the habit.
 * Returns { versionA, versionB }.
 */
async function draftPromoDescription({
  merchantName, promoName, categoryName, merchantType,
  rewardType, rewardValue, rewardSku, rewardNote,
  threshold, timeframeDays, timeCondition,
  promotionType, bundleComponents,
}) {
  requireKey();

  // Build reward description
  let rewardDesc;
  if (rewardType === "free_item")      rewardDesc = `a free ${rewardSku || "item"}`;
  else if (rewardType === "discount_pct")   rewardDesc = `${rewardValue}% off your order`;
  else if (rewardType === "discount_fixed") rewardDesc = `$${((rewardValue || 0) / 100).toFixed(2)} off`;
  else                                 rewardDesc = rewardNote || "a special reward";

  // Tone guidance by promotion type
  const toneGuide = {
    stamp: "Motivational, habit-affirming. The customer's routine is already working for them. Make the milestone feel achievable, not distant.",
    bundle: "Value + convenience. Two great things together. Make it feel like an obvious upgrade, not an upsell.",
    tiered: "Aspirational but attainable. The journey gets more rewarding. Acknowledge loyalty without making new customers feel behind.",
    conditional: timeCondition
      ? "Make the time window feel like a moment, not a schedule. 'Tuesday mornings just got better' not 'double stamps 7-10am Tuesdays.'"
      : "Warm, welcoming. Frame as an easy upgrade or a welcome back.",
    referral: "Social proof + shared reward. Keep it personal, not transactional.",
  };

  const tone = toneGuide[promotionType] || toneGuide.stamp;

  // Category-specific sensory cues
  const sensoryCue = {
    coffee_shop: "Use sensory language — the smell, the warmth, the ritual. Tap into morning routines and neighborhood identity.",
    restaurant: "Invoke flavors, the table, the experience of a meal well shared.",
    fitness: "Energy, progress, showing up for yourself. The reward mirrors the effort.",
    salon_spa: "Self-care, feeling good, treating yourself. The reward extends the pampering.",
    retail: "Discovery, style, finding something you love. The reward is the next find.",
  };
  const sensory = sensoryCue[merchantType] || "";

  const prompt = `You are writing consumer-facing loyalty promotion copy for a small business. Your job is to make joining feel like a no-brainer — not a transaction.

Business: "${merchantName || "a local shop"}"${merchantType ? ` (${merchantType.replace("_", " ")})` : ""}
Program: "${promoName || "Loyalty Program"}"
Type: ${promotionType || "stamp"}
Threshold: ${threshold || "?"} visits/purchases
Reward: ${rewardDesc}
${timeCondition ? `Time condition: ${timeCondition}` : ""}
${timeframeDays ? `Stamps expire after ${timeframeDays} days.` : ""}

Tone: ${tone}
${sensory ? `Sensory guidance: ${sensory}` : ""}

Write TWO versions, each exactly 2 sentences:
Version A: Lead with the reward. Make the math feel effortless.
Version B: Lead with the experience or the habit. Make joining feel like belonging.

Rules:
- Maximum 2 sentences per version
- Never use the word "loyalty" — it's corporate
- Never use "points" unless that's the actual mechanic
- Never say "terms and conditions apply"
- No "unlimited", "always free", or "guaranteed"
- Write for someone who already loves this place

Return ONLY a JSON object, no markdown, no code fences:
{"versionA": "...", "versionB": "..."}`;

  const msg = await getClient().messages.create({
    model: MODEL,
    max_tokens: 200,
    messages: [{ role: "user", content: prompt }],
  });

  const raw = msg.content?.[0]?.text?.trim() || "";

  // Strip markdown code fences if AI wrapped the JSON
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();

  // Parse JSON response
  try {
    const parsed = JSON.parse(cleaned);
    return {
      versionA: parsed.versionA || "",
      versionB: parsed.versionB || "",
    };
  } catch {
    // If AI didn't return valid JSON, use the cleaned text as version A
    return { versionA: raw, versionB: "" };
  }
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

// ── Validation Insight (projected vs actual) ────────────────────────────────

/**
 * Generate an actionable insight comparing projected vs actual promotion performance.
 * Returns 2-3 sentences — warm, specific, actionable. Never blame the merchant.
 */
async function draftValidationInsight({
  merchantName, promotionName, objective,
  projectedValue, actualValue, divergencePct,
  attributionRate, durationDays,
  direction, // "over" or "under"
}) {
  requireKey();

  const prompt = `You are a friendly business advisor for "${merchantName || "a local shop"}". Their promotion "${promotionName}" has been running for ${durationDays} days.

Objective: ${objective || "bring customers back"}
Projected performance: ${projectedValue}
Actual performance: ${actualValue}
Difference: ${divergencePct > 0 ? "+" : ""}${divergencePct}% ${direction === "over" ? "above" : "below"} projection
Attribution rate: ${attributionRate ? Math.round(attributionRate * 100) + "%" : "unknown"}

Write 2-3 sentences of actionable, warm advice. Rules:
- If underperforming: suggest concrete actions (staff training, signage, timing adjustments) — never blame the merchant
- If overperforming: celebrate briefly, then mention budget implications
- Reference the actual numbers, not abstract percentages
- End with one specific next step
- Be encouraging, not alarming
- Never use "unfortunately" or "disappointing"

Write the insight now:`;

  const msg = await getClient().messages.create({
    model: MODEL,
    max_tokens: 150,
    messages: [{ role: "user", content: prompt }],
  });

  return msg.content?.[0]?.text?.trim() || "";
}

/**
 * Generate validation insights without AI (deterministic fallback).
 * Used when ANTHROPIC_API_KEY is not set or AI call fails.
 */
function generateDeterministicInsight({
  promotionName, divergencePct, direction, attributionRate, durationDays,
}) {
  const insights = [];

  if (direction === "under") {
    insights.push(`${promotionName} is performing ${Math.abs(divergencePct)}% below projection after ${durationDays} days.`);
    if (attributionRate && attributionRate < 0.6) {
      insights.push(`Your attribution rate is ${Math.round(attributionRate * 100)}% — try having your team ask every customer for their phone number to improve tracking.`);
    } else {
      insights.push("Consider adding counter signage or having staff mention the program at checkout to boost visibility.");
    }
  } else {
    insights.push(`Great news — ${promotionName} is ${divergencePct}% ahead of projection after ${durationDays} days.`);
    insights.push("You may want to review your budget to ensure it covers the increased activity.");
  }

  return insights.join(" ");
}

module.exports = {
  draftPromoTerms, draftBundleTerms,
  draftProductInfo, draftProductDescription,
  draftPromoDescription, draftBundleDescription,
  draftGrowthSummary,
  draftValidationInsight, generateDeterministicInsight,
};
