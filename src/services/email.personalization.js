/**
 * email.personalization.js — Build personalization context from visit history
 *
 * Selects the single most meaningful observation about a consumer's
 * relationship with a merchant. Priority order:
 *   1. Active streak (≥4 consecutive weeks)
 *   2. Round number milestone (10, 25, 50, 100)
 *   3. Time-of-day pattern (>70% confidence)
 *   4. Long tenure (≥6 months)
 *   5. Favorite location (multi-location only)
 *   6. Fallback — always genuine, never empty
 */

"use strict";

const { prisma } = require("../db/prisma");

/**
 * Build personalization for a consumer-merchant pair.
 * @param {number} consumerId
 * @param {number} merchantId
 * @param {string} locale - "en" or "es"
 * @returns {object} { visitCount, streak, visitPattern, tenureMonths, favoriteLocation, daysSinceLastVisit, stampCount, personalizationText }
 */
async function buildPersonalization(consumerId, merchantId, locale = "en") {
  const visits = await prisma.visit.findMany({
    where: { consumerId, store: { merchantId } },
    orderBy: { visitedAt: "asc" },
    select: { visitedAt: true, storeId: true },
  });

  const merchant = await prisma.merchant.findUnique({
    where: { id: merchantId },
    select: { name: true, stores: { select: { id: true, name: true } } },
  });

  // Get min visits threshold from PlatformConfig
  let minVisits = 4;
  try {
    const row = await prisma.platformConfig.findUnique({ where: { key: "min_visits_for_personalization" } });
    if (row?.value) minVisits = parseInt(row.value, 10) || 4;
  } catch {}

  const visitCount = visits.length;
  const streak = calculateStreak(visits);
  const visitPattern = detectVisitPattern(visits);
  const tenureMonths = visits.length > 0 ? monthsSince(visits[0].visitedAt) : 0;
  const favoriteLocation = merchant?.stores?.length > 1 ? getMostFrequentLocation(visits, merchant.stores) : null;
  const daysSinceLastVisit = visits.length > 0 ? daysSince(visits[visits.length - 1].visitedAt) : null;

  // Current stamp count
  let stampCount = 0;
  try {
    const progress = await prisma.consumerPromoProgress.findMany({
      where: { consumerId, promotion: { merchantId } },
      select: { currentStamps: true },
    });
    stampCount = progress.reduce((sum, p) => sum + (p.currentStamps || 0), 0);
  } catch {}

  const personalizationText = visitCount >= minVisits
    ? selectPersonalizationText(visits, merchant, streak, visitPattern, tenureMonths, favoriteLocation, locale)
    : getFallback(merchant?.name || "", locale);

  return {
    visitCount,
    streak,
    visitPattern,
    tenureMonths,
    favoriteLocation: favoriteLocation?.name || null,
    daysSinceLastVisit,
    stampCount,
    personalizationText,
  };
}

function selectPersonalizationText(visits, merchant, streak, visitPattern, tenureMonths, favoriteLocation, locale) {
  const name = merchant?.name || "";
  const es = locale === "es";

  // 1. Active streak (≥4 weeks)
  if (streak >= 4) {
    return es
      ? `No has fallado una semana en ${streak} semanas.`
      : `You haven't missed a week in ${streak} weeks.`;
  }

  // 2. Round number milestone
  const count = visits.length;
  if ([10, 25, 50, 100].includes(count)) {
    return es
      ? `Esta es tu visita número ${count} a ${name}.`
      : `This is your ${ordinal(count)} visit to ${name}.`;
  }

  // 3. Time-of-day pattern (>70% confidence)
  if (visitPattern.confidence > 0.7 && visitPattern.label) {
    const label = es ? translatePattern(visitPattern.label) : visitPattern.label;
    return es
      ? `Eres uno de nuestros regulares de ${label}.`
      : `You're one of our ${visitPattern.label} regulars.`;
  }

  // 4. Long tenure (≥6 months)
  if (tenureMonths >= 6) {
    return es
      ? `Llevas ${tenureMonths} meses visitando ${name}.`
      : `You've been coming to ${name} for ${tenureMonths} months.`;
  }

  // 5. Favorite location (multi-location only)
  if (favoriteLocation) {
    return es
      ? `Eres un regular de nuestra tienda en ${favoriteLocation.name}.`
      : `You're a regular at our ${favoriteLocation.name} location.`;
  }

  // 6. Fallback
  return getFallback(name, locale);
}

function getFallback(merchantName, locale) {
  return locale === "es"
    ? `Eres una de las personas que hace que ${merchantName} sea lo que es.`
    : `You're one of the people who makes ${merchantName} what it is.`;
}

// ── Helpers ──────────────────────────────────────

function calculateStreak(visits) {
  if (visits.length < 2) return 0;
  const sorted = [...visits].sort((a, b) => new Date(b.visitedAt) - new Date(a.visitedAt));
  let streak = 1;
  for (let i = 1; i < sorted.length; i++) {
    const gap = daysBetween(sorted[i].visitedAt, sorted[i - 1].visitedAt);
    if (gap <= 10) streak++;
    else break;
  }
  return streak;
}

function detectVisitPattern(visits) {
  if (visits.length < 4) return { confidence: 0, label: null };
  const recent = visits.slice(-12);
  const counts = {};
  for (const v of recent) {
    const d = new Date(v.visitedAt);
    const day = d.toLocaleDateString("en-US", { weekday: "long" });
    const hour = d.getHours();
    const period = hour < 12 ? "morning" : hour < 17 ? "afternoon" : "evening";
    const key = `${day} ${period}`;
    counts[key] = (counts[key] || 0) + 1;
  }
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  if (!top) return { confidence: 0, label: null };
  return { confidence: top[1] / recent.length, label: top[0] };
}

function getMostFrequentLocation(visits, stores) {
  const counts = {};
  for (const v of visits) {
    counts[v.storeId] = (counts[v.storeId] || 0) + 1;
  }
  const topId = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0];
  return topId ? stores.find(s => s.id === parseInt(topId, 10)) || null : null;
}

function monthsSince(date) {
  if (!date) return 0;
  const now = new Date();
  const d = new Date(date);
  return Math.floor((now - d) / (1000 * 60 * 60 * 24 * 30.44));
}

function daysSince(date) {
  if (!date) return null;
  return Math.floor((new Date() - new Date(date)) / (1000 * 60 * 60 * 24));
}

function daysBetween(a, b) {
  return Math.abs(Math.floor((new Date(a) - new Date(b)) / (1000 * 60 * 60 * 24)));
}

function ordinal(n) {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

function translatePattern(label) {
  // "Tuesday morning" → "martes por la mañana"
  const days = { Monday: "lunes", Tuesday: "martes", Wednesday: "miércoles", Thursday: "jueves", Friday: "viernes", Saturday: "sábado", Sunday: "domingo" };
  const periods = { morning: "por la mañana", afternoon: "por la tarde", evening: "por la noche" };
  const parts = label.split(" ");
  const day = days[parts[0]] || parts[0];
  const period = periods[parts[1]] || parts[1];
  return `${day} ${period}`;
}

module.exports = { buildPersonalization };
