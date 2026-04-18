/**
 * pos.promotion.ingest.js — Pull existing promotions/discounts from POS on connect
 *
 * Square: Loyalty programs (accrual rules, reward tiers) + catalog discounts
 * Clover: Discount templates only (no loyalty API)
 *
 * Results stored in a normalized format for gap analysis display.
 */

"use strict";

const { prisma } = require("../db/prisma");
const { decrypt } = require("../utils/encrypt");

/**
 * Ingest existing promotions/discounts from a POS connection.
 * Called after OAuth completes during onboarding.
 *
 * @param {object} posConnection — PosConnection record
 * @returns {Promise<{ posPromotions: Array, posDiscounts: Array }>}
 */
async function ingestPosPromotions(posConnection) {
  const posType = posConnection.posType;

  if (posType === "square") {
    return ingestSquarePromotions(posConnection);
  } else if (posType === "clover") {
    return ingestCloverPromotions(posConnection);
  }

  return { posPromotions: [], posDiscounts: [] };
}

// ── Square ──

async function ingestSquarePromotions(conn) {
  const accessToken = decrypt(conn.accessTokenEnc);
  const isSandbox = (process.env.SQUARE_APP_ID || "").startsWith("sandbox-");
  const baseUrl = isSandbox
    ? "https://connect.squareupsandbox.com/v2"
    : "https://connect.squareup.com/v2";

  const posPromotions = [];
  const posDiscounts = [];

  // 1. Pull loyalty program
  try {
    const loyaltyRes = await fetch(`${baseUrl}/loyalty/programs`, {
      headers: { Authorization: `Bearer ${accessToken}`, "Square-Version": "2024-01-18" },
    });

    if (loyaltyRes.ok) {
      const data = await loyaltyRes.json();
      const programs = data.programs || [];

      for (const program of programs) {
        if (program.status !== "ACTIVE") continue;

        for (const tier of (program.reward_tiers || [])) {
          const mapped = {
            source: "square_loyalty",
            sourceId: `${program.id}:${tier.id}`,
            name: tier.name || program.terminology?.other || "Loyalty Reward",
            description: buildSquareLoyaltyDescription(program, tier),
            mechanic: mapSquareAccrual(program.accrual_rules),
            threshold: tier.points,
            rewardType: mapSquareRewardType(tier),
            rewardValue: getSquareRewardValue(tier),
            status: program.status.toLowerCase(),
            rawData: { program, tier },
          };
          posPromotions.push(mapped);
        }
      }
    }
  } catch (e) {
    console.warn("[ingest] Square loyalty fetch error:", e?.message);
  }

  // 2. Pull catalog discounts
  try {
    const catalogRes = await fetch(`${baseUrl}/catalog/list?types=DISCOUNT`, {
      headers: { Authorization: `Bearer ${accessToken}`, "Square-Version": "2024-01-18" },
    });

    if (catalogRes.ok) {
      const data = await catalogRes.json();
      for (const obj of (data.objects || [])) {
        const disc = obj.discount_data;
        if (!disc) continue;

        posDiscounts.push({
          source: "square_catalog",
          sourceId: obj.id,
          name: disc.name,
          type: disc.discount_type,
          percentage: disc.percentage ? parseFloat(disc.percentage) : null,
          amountCents: disc.amount_money?.amount || null,
          pinRequired: disc.pin_required || false,
          rawData: disc,
        });
      }
    }
  } catch (e) {
    console.warn("[ingest] Square catalog discount fetch error:", e?.message);
  }

  return { posPromotions, posDiscounts };
}

function buildSquareLoyaltyDescription(program, tier) {
  const accrual = program.accrual_rules?.[0];
  let earnDesc = "Earn points on each purchase";

  if (accrual?.accrual_type === "VISIT") {
    earnDesc = "Earn 1 point per visit";
  } else if (accrual?.accrual_type === "SPEND") {
    const perDollar = accrual.spend_data?.amount_money?.amount;
    earnDesc = perDollar ? `Earn 1 point per $${(perDollar / 100).toFixed(2)} spent` : "Earn points based on spend";
  }

  return `${earnDesc}. Redeem ${tier.points} points for ${tier.name}.`;
}

function mapSquareAccrual(rules) {
  if (!rules || !rules.length) return "stamps";
  const type = rules[0].accrual_type;
  if (type === "VISIT") return "stamps";
  if (type === "SPEND") return "points";
  return "stamps";
}

function mapSquareRewardType(tier) {
  const def = tier.definition;
  if (!def) return "custom";
  if (def.discount_type === "FIXED_AMOUNT") return "discount_fixed";
  if (def.discount_type === "FIXED_PERCENTAGE") return "discount_pct";
  return "custom";
}

function getSquareRewardValue(tier) {
  const def = tier.definition;
  if (!def) return null;
  if (def.fixed_discount_money?.amount) return def.fixed_discount_money.amount;
  if (def.percentage_discount) return parseFloat(def.percentage_discount);
  return null;
}

// ── Clover ──

async function ingestCloverPromotions(conn) {
  const accessToken = decrypt(conn.accessTokenEnc);
  const cloverBase = process.env.CLOVER_API_BASE || "https://apisandbox.dev.clover.com";
  const merchantId = conn.externalMerchantId;

  const posPromotions = [];
  const posDiscounts = [];

  // Pull discount templates
  try {
    const res = await fetch(`${cloverBase}/v3/merchants/${merchantId}/discounts`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (res.ok) {
      const data = await res.json();
      for (const disc of (data.elements || [])) {
        posDiscounts.push({
          source: "clover_discount",
          sourceId: disc.id,
          name: disc.name,
          type: disc.percentage ? "percentage" : "fixed",
          percentage: disc.percentage || null,
          amountCents: disc.amount ? Math.abs(disc.amount) : null,
          rawData: disc,
        });
      }
    }
  } catch (e) {
    console.warn("[ingest] Clover discount fetch error:", e?.message);
  }

  // Clover has no loyalty API — note this for gap analysis
  // Any loyalty programs are through third-party apps

  return { posPromotions, posDiscounts };
}

/**
 * Store ingested promotions on the merchant for gap analysis display.
 *
 * @param {number} merchantId
 * @param {object} ingested — { posPromotions, posDiscounts }
 */
async function storeIngestedPromotions(merchantId, ingested) {
  // Store as metadata on the merchant for now
  // Could be a separate table later if needed
  await prisma.merchant.update({
    where: { id: merchantId },
    data: {
      // Store in a JSON field — we'll add this to the schema
    },
  });

  console.log(JSON.stringify({
    pvHook: "pos.promotions.ingested",
    ts: new Date().toISOString(),
    tc: "TC-INGEST-01",
    sev: "info",
    merchantId,
    posPromotions: ingested.posPromotions.length,
    posDiscounts: ingested.posDiscounts.length,
  }));

  return ingested;
}

/**
 * Generate gap analysis between POS promotions and PV capabilities.
 */
function generateGapAnalysis(posPromotions, posDiscounts, pvPromotions) {
  const analysis = {
    whatYouHave: [],
    whatPvAdds: [],
  };

  // What they have → PV equivalent
  for (const promo of posPromotions) {
    analysis.whatYouHave.push({
      posName: promo.name,
      posSource: promo.source,
      pvEquivalent: `PerkValet can replicate this as a ${promo.mechanic} program with ${promo.rewardType} reward`,
      changes: promo.mechanic === "stamps" ? "No changes — works the same way" : "PV uses visit-based stamps instead of spend-based points",
      supported: true,
    });
  }

  for (const disc of posDiscounts) {
    analysis.whatYouHave.push({
      posName: disc.name,
      posSource: disc.source,
      pvEquivalent: "PerkValet can use this as a reward discount",
      changes: "Discount will be applied automatically when customer earns enough stamps",
      supported: true,
    });
  }

  // What PV adds
  analysis.whatPvAdds = [
    { feature: "Cross-store stamp accumulation", description: "Customers earn stamps at any of your locations" },
    { feature: "Consumer mobile app", description: "Customers see their progress and rewards in the PerkValet app" },
    { feature: "Reward notifications", description: "Automated email/SMS when rewards are earned or about to expire" },
    { feature: "Budget controls", description: "Set monthly caps and get alerts at 50%, 75%, and 90%" },
    { feature: "Attribution tracking", description: "See exactly which transactions are linked to loyalty members" },
    { feature: "Growth Advisor", description: "AI-powered insights and recommendations based on your data" },
    { feature: "Promotion simulator", description: "Project costs and outcomes before launching" },
  ];

  // Add PV-specific features not in their POS
  if (posPromotions.length === 0) {
    analysis.whatPvAdds.unshift({
      feature: "Loyalty program",
      description: "Your POS doesn't have a loyalty program — PerkValet adds one automatically",
    });
  }

  return analysis;
}

module.exports = { ingestPosPromotions, storeIngestedPromotions, generateGapAnalysis };
