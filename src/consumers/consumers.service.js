// src/consumers/consumers.service.js
// Consumer identity service — lookup, create, merchant association.
// Phone (E164) is the canonical key. Duplicate phone resolves to existing record.

const { parsePhoneNumberFromString } = require("libphonenumber-js");

/**
 * Normalize a raw phone string to E164.
 * Returns { raw, e164, country } or null if invalid.
 */
function safeNormalizePhone(input, defaultCountry = "US") {
  if (!input || typeof input !== "string") return null;
  const raw = input.trim();
  try {
    const phone = parsePhoneNumberFromString(raw, defaultCountry);
    if (!phone || !phone.isValid()) return null;
    return { raw, e164: phone.number, country: phone.country || defaultCountry };
  } catch {
    return null;
  }
}

/**
 * Fetch the primary active promotion for a merchant and the consumer's progress on it.
 * Returns promotionProgress / rewardEarned / rewardLabel, or nulls if no active promo.
 */
async function fetchPromoProgress(prisma, consumerId, merchantId) {
  const promotions = await prisma.promotion.findMany({
    where: { merchantId, status: "active" },
    orderBy: { createdAt: "asc" },
    take: 1,
    select: {
      id: true,
      name: true,
      threshold: true,
      rewardType: true,
      rewardValue: true,
      rewardNote: true,
    },
  });

  if (!promotions.length) return { promotionProgress: null, rewardEarned: false, rewardLabel: null };

  const promo = promotions[0];

  const prog = await prisma.consumerPromoProgress.findUnique({
    where: { consumerId_promotionId: { consumerId, promotionId: promo.id } },
    select: { stampCount: true, milestonesAvailable: true },
  });

  const current = prog?.stampCount ?? 0;
  const rewardEarned = (prog?.milestonesAvailable ?? 0) > 0;

  let rewardLabel = promo.name;
  if (promo.rewardType === "discount_pct" && promo.rewardValue) {
    rewardLabel = `${promo.rewardValue}% off`;
  } else if (promo.rewardType === "discount_fixed" && promo.rewardValue) {
    rewardLabel = `$${(promo.rewardValue / 100).toFixed(2)} off`;
  } else if (promo.rewardNote) {
    rewardLabel = promo.rewardNote;
  }

  return {
    promotionProgress: {
      current,
      target: promo.threshold,
      label: `${promo.name}: ${current} / ${promo.threshold}`,
    },
    rewardEarned,
    rewardLabel,
  };
}

/**
 * Look up a consumer by phone number.
 * Returns the consumer record or null if not found.
 * Pass merchantId to also return visit stats for that merchant.
 */
async function lookupByPhone(prisma, phone, { merchantId, storeId } = {}) {
  const normalized = safeNormalizePhone(phone);
  if (!normalized) return { error: "invalid_phone" };

  const consumer = await prisma.consumer.findUnique({
    where: { phoneE164: normalized.e164 },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      phoneE164: true,
      phoneRaw: true,
      status: true,
      createdAt: true,
    },
  });

  if (!consumer) return { found: false, e164: normalized.e164 };
  if (consumer.status === "archived") return { found: false, e164: normalized.e164 };

  // Visit stats scoped to merchant (merchantId direct, or inferred from storeId)
  let visitCount = null;
  let lastVisitAt = null;
  let resolvedMerchantId = merchantId ? Number(merchantId) : null;

  if (!resolvedMerchantId && storeId) {
    const store = await prisma.store.findUnique({
      where: { id: Number(storeId) },
      select: { merchantId: true },
    });
    resolvedMerchantId = store?.merchantId ?? null;
  }

  if (resolvedMerchantId) {
    const stats = await prisma.visit.aggregate({
      where: {
        consumerId: consumer.id,
        merchantId: resolvedMerchantId,
        status: { not: "abandoned" },
      },
      _count: { id: true },
      _max: { createdAt: true },
    });
    visitCount = stats._count.id ?? 0;
    lastVisitAt = stats._max.createdAt ?? null;
  }

  let promotionProgress = null;
  let rewardEarned = false;
  let rewardLabel = null;

  if (resolvedMerchantId) {
    const promoData = await fetchPromoProgress(prisma, consumer.id, resolvedMerchantId);
    promotionProgress = promoData.promotionProgress;
    rewardEarned = promoData.rewardEarned;
    rewardLabel = promoData.rewardLabel;
  }

  return { found: true, consumer, visitCount, lastVisitAt, promotionProgress, rewardEarned, rewardLabel };
}

/**
 * Create a new consumer.
 * If the phone already exists, returns the existing record (idempotent).
 * Also ensures a MerchantConsumer link exists for the given merchantId.
 */
async function createConsumer(prisma, { phone, firstName, lastName, email, merchantId, storeId }) {
  const normalized = safeNormalizePhone(phone);
  if (!normalized) return { error: "invalid_phone" };

  const fName = String(firstName || "").trim() || null;
  const lName = String(lastName || "").trim() || null;
  const emailVal = String(email || "").trim().toLowerCase() || null;

  // Upsert — duplicate phone resolves to existing record per spec
  const consumer = await prisma.consumer.upsert({
    where: { phoneE164: normalized.e164 },
    update: {
      // Only fill in missing fields — don't overwrite existing data
      ...(fName ? { firstName: fName } : {}),
      ...(lName ? { lastName: lName } : {}),
      ...(emailVal ? { email: emailVal } : {}),
    },
    create: {
      phoneE164: normalized.e164,
      phoneRaw: normalized.raw,
      phoneCountry: normalized.country,
      firstName: fName,
      lastName: lName,
      email: emailVal,
    },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      phoneE164: true,
      phoneRaw: true,
      status: true,
      createdAt: true,
    },
  });

  const created = !consumer.createdAt || consumer.createdAt > new Date(Date.now() - 2000);

  // Ensure MerchantConsumer link
  if (merchantId) {
    const existing = await prisma.merchantConsumer.findUnique({
      where: { merchantId_consumerId: { merchantId, consumerId: consumer.id } },
      select: { id: true },
    });

    if (!existing) {
      await prisma.merchantConsumer.create({
        data: { merchantId, consumerId: consumer.id },
      });
    }
  }

  // Ensure StoreConsumer link
  if (storeId) {
    const existing = await prisma.storeConsumer.findUnique({
      where: { storeId_consumerId: { storeId, consumerId: consumer.id } },
      select: { id: true },
    });

    if (!existing) {
      await prisma.storeConsumer.create({
        data: { storeId, consumerId: consumer.id },
      });
    }
  }

  return { consumer, created };
}

module.exports = { lookupByPhone, createConsumer, safeNormalizePhone, fetchPromoProgress };
