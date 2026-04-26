/**
 * reward.expiry.cron.js — Reward expiry notifications + cleanup
 *
 * Daily job that:
 * 1. Sends 14-day, 7-day, and 48-hour expiry notifications (email + SMS)
 * 2. Expires rewards past their expiresAt date
 * 3. Clover: deletes expired discount templates from register
 * 4. Square: zeros out gift card balance + deactivates card
 *
 * Called via setInterval in index.js.
 */

"use strict";

const { prisma } = require("../db/prisma");
const { decrypt } = require("../utils/encrypt");
const { t, formatDate, formatCurrency } = require("../i18n/t");

const CLOVER_API_BASE = process.env.CLOVER_API_BASE || "https://apisandbox.dev.clover.com";
const SQUARE_API_BASE = (process.env.SQUARE_APP_ID || "").startsWith("sandbox-")
  ? "https://connect.squareupsandbox.com/v2"
  : "https://connect.squareup.com/v2";

/**
 * Run the reward expiry job.
 */
async function runRewardExpiryCron() {
  const now = new Date();
  console.log(`[cron.expiry] running reward expiry check at ${now.toISOString()}`);

  try {
    await sendExpiryNotifications(now);
    await expireCloverRewards(now);
    await expireSquareGiftCards(now);
  } catch (e) {
    console.error("[cron.expiry] job failed:", e?.message || String(e));
  }
}

/**
 * Send expiry warning notifications for rewards approaching expiry.
 */
async function sendExpiryNotifications(now) {
  const triggers = [
    { type: "14_day", daysOut: 14 },
    { type: "7_day", daysOut: 7 },
    { type: "48_hour", daysOut: 2 },
  ];

  for (const trigger of triggers) {
    const cutoff = new Date(now.getTime() + trigger.daysOut * 24 * 60 * 60 * 1000);

    // Clover rewards
    const cloverRewards = await prisma.posRewardDiscount.findMany({
      where: {
        status: { in: ["earned", "activated"] },
        expiresAt: { not: null, lte: cutoff, gt: now },
      },
      include: {
        consumer: { select: { id: true, firstName: true, email: true, phoneE164: true, preferredLocale: true } },
        merchant: { select: { name: true, brandLogo: true, brandColor: true } },
      },
    });

    for (const reward of cloverRewards) {
      await sendNotificationIfNeeded({
        consumerId: reward.consumerId,
        rewardId: reward.id,
        rewardType: "discount",
        notificationType: trigger.type,
        consumer: reward.consumer,
        merchantName: reward.merchant.name,
        merchantBrand: { name: reward.merchant.name, logo: reward.merchant.brandLogo, color: reward.merchant.brandColor },
        rewardDescription: reward.discountName,
        rewardValue: reward.amountCents,
        expiresAt: reward.expiresAt,
      });
    }

    // Square gift cards
    const squareCards = await prisma.consumerGiftCard.findMany({
      where: {
        active: true,
        expiresAt: { not: null, lte: cutoff, gt: now },
      },
      include: {
        consumer: { select: { id: true, firstName: true, email: true, phoneE164: true, preferredLocale: true } },
        posConnection: { select: { merchant: { select: { name: true, brandLogo: true, brandColor: true } } } },
      },
    });

    for (const card of squareCards) {
      await sendNotificationIfNeeded({
        consumerId: card.consumerId,
        rewardId: card.id,
        rewardType: "giftcard",
        notificationType: trigger.type,
        consumer: card.consumer,
        merchantName: card.posConnection.merchant.name,
        merchantBrand: { name: card.posConnection.merchant.name, logo: card.posConnection.merchant.brandLogo, color: card.posConnection.merchant.brandColor },
        rewardDescription: "Gift card credit",
        rewardValue: null,
        expiresAt: card.expiresAt,
      });
    }
  }
}

/**
 * Send a notification if not already sent (dedup via RewardNotification).
 */
async function sendNotificationIfNeeded({ consumerId, rewardId, rewardType, notificationType, consumer, merchantName, merchantBrand, rewardDescription, rewardValue, expiresAt }) {
  const channels = [];
  if (consumer.email) channels.push("email");
  if (consumer.phoneE164) channels.push("sms");

  for (const channel of channels) {
    // Check dedup
    const existing = await prisma.rewardNotification.findUnique({
      where: { rewardId_rewardType_notificationType_channel: { rewardId, rewardType, notificationType, channel } },
    });
    if (existing) continue;

    // Build message
    const locale = consumer.preferredLocale || "en";
    const daysLeft = Math.ceil((expiresAt - new Date()) / (1000 * 60 * 60 * 24));
    const valueStr = rewardValue ? formatCurrency(rewardValue, locale) : "";
    const expiryDate = formatDate(expiresAt, locale);

    if (channel === "email") {
      const { sendNotificationEmail } = require("../utils/mail");
      if (typeof sendNotificationEmail === "function") {
        const valueClause = valueStr ? ` worth ${valueStr}` : "";
        await sendNotificationEmail({
          to: consumer.email,
          subject: t("email.rewardExpirySubject", locale, { merchantName, count: daysLeft }),
          body: t("email.rewardExpiryBody", locale, { name: consumer.firstName || "there", description: rewardDescription, valueClause, merchantName, date: expiryDate }),
          merchantBrand: merchantBrand?.logo ? merchantBrand : undefined,
        }).catch(e => console.error("[cron.expiry] email send error:", e?.message));
      }
    }

    if (channel === "sms") {
      const { sendSms } = require("../utils/sms");
      if (typeof sendSms === "function") {
        await sendSms({
          to: consumer.phoneE164,
          body: t("sms.rewardExpiry", locale, { value: valueStr, merchantName, date: expiryDate }),
        }).catch(e => console.error("[cron.expiry] sms send error:", e?.message));
      }
    }

    // Record notification sent
    await prisma.rewardNotification.create({
      data: { consumerId, rewardId, rewardType, notificationType, channel },
    });

    console.log(`[cron.expiry] ${notificationType} ${channel} sent: consumer=${consumerId} reward=${rewardId}`);
  }
}

/**
 * Expire Clover rewards past their expiresAt date.
 */
async function expireCloverRewards(now) {
  const expired = await prisma.posRewardDiscount.findMany({
    where: {
      status: { in: ["earned", "activated"] },
      expiresAt: { not: null, lte: now },
    },
    include: { posConnection: true },
  });

  for (const reward of expired) {
    try {
      // Delete Clover discount template if activated
      if (reward.status === "activated" && reward.cloverDiscountId && reward.posConnection) {
        try {
          const accessToken = decrypt(reward.posConnection.accessTokenEnc);
          const mid = reward.posConnection.externalMerchantId;
          await fetch(`${CLOVER_API_BASE}/v3/merchants/${mid}/discounts/${reward.cloverDiscountId}`, {
            method: "DELETE",
            headers: { Authorization: `Bearer ${accessToken}` },
          });
          console.log(`[cron.expiry] deleted Clover template ${reward.cloverDiscountId}`);
        } catch (delErr) {
          console.warn(`[cron.expiry] could not delete Clover template:`, delErr?.message);
        }
      }

      // Mark expired
      await prisma.posRewardDiscount.update({
        where: { id: reward.id },
        data: { status: "expired" },
      });

      // Update entitlement
      if (reward.entitlementId) {
        await prisma.entitlement.update({
          where: { id: reward.entitlementId },
          data: { status: "expired" },
        }).catch(() => {});
      }

      console.log(JSON.stringify({
        pvHook: "reward.expired",
        ts: now.toISOString(),
        tc: "TC-EXPIRY-01",
        sev: "info",
        consumerId: reward.consumerId,
        rewardId: reward.id,
        merchantId: reward.merchantId,
        promotionId: reward.promotionId,
      }));
    } catch (e) {
      console.error(`[cron.expiry] error expiring Clover reward ${reward.id}:`, e?.message);
    }
  }

  if (expired.length > 0) {
    console.log(`[cron.expiry] expired ${expired.length} Clover reward(s)`);
  }
}

/**
 * Expire Square gift cards past their expiresAt date.
 * Zeros out balance via ADJUST_DECREMENT then deactivates.
 */
async function expireSquareGiftCards(now) {
  const expired = await prisma.consumerGiftCard.findMany({
    where: {
      active: true,
      expiresAt: { not: null, lte: now },
    },
    include: { posConnection: true },
  });

  for (const card of expired) {
    try {
      const accessToken = decrypt(card.posConnection.accessTokenEnc);

      // Get current balance
      const balRes = await fetch(`${SQUARE_API_BASE}/gift-cards/${card.squareGiftCardId}`, {
        headers: { Authorization: `Bearer ${accessToken}`, "Square-Version": "2024-01-18" },
      });
      const balData = await balRes.json();
      const currentBalance = balData.gift_card?.balance_money?.amount || 0;

      if (currentBalance > 0) {
        // Zero out via ADJUST_DECREMENT
        await fetch(`${SQUARE_API_BASE}/gift-cards/activities`, {
          method: "POST",
          headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json", "Square-Version": "2024-01-18" },
          body: JSON.stringify({
            idempotency_key: `pv-expiry-adjust-${card.id}-${Date.now()}`,
            gift_card_activity: {
              type: "ADJUST_DECREMENT",
              gift_card_id: card.squareGiftCardId,
              adjust_decrement_activity_details: {
                amount_money: { amount: currentBalance, currency: "USD" },
                reason: "PROMOTIONAL_REWARD_EXPIRED",
              },
            },
          }),
        });
        console.log(`[cron.expiry] zeroed Square gift card ${card.squareGiftCardId}: $${(currentBalance / 100).toFixed(2)} → $0`);
      }

      // Deactivate
      await fetch(`${SQUARE_API_BASE}/gift-cards/activities`, {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json", "Square-Version": "2024-01-18" },
        body: JSON.stringify({
          idempotency_key: `pv-expiry-deactivate-${card.id}-${Date.now()}`,
          gift_card_activity: {
            type: "DEACTIVATE",
            gift_card_id: card.squareGiftCardId,
            deactivate_activity_details: { reason: "PROMOTIONAL_REWARD_EXPIRED" },
          },
        }),
      });

      // Mark inactive in PV
      await prisma.consumerGiftCard.update({
        where: { id: card.id },
        data: { active: false },
      });

      // Log event
      await prisma.giftCardEvent.create({
        data: {
          giftCardId: card.id,
          consumerId: card.consumerId,
          merchantId: card.posConnection.merchantId,
          eventType: "ADJUST",
          amountCents: -currentBalance,
          ganLast4: (card.squareGan || "").slice(-4),
          payloadJson: {
            reason: "promotion_expired",
            previousBalance: currentBalance,
            newBalance: 0,
            action: "expired_balance_zeroed",
          },
        },
      });

      // Update entitlements
      await prisma.entitlement.updateMany({
        where: { consumerId: card.consumerId, merchantId: card.posConnection.merchantId, type: "reward", status: "active" },
        data: { status: "expired" },
      });

      console.log(JSON.stringify({
        pvHook: "reward.expired",
        ts: now.toISOString(),
        tc: "TC-EXPIRY-02",
        sev: "info",
        consumerId: card.consumerId,
        giftCardId: card.id,
        squareGiftCardId: card.squareGiftCardId,
        previousBalance: currentBalance,
      }));
    } catch (e) {
      console.error(`[cron.expiry] error expiring Square gift card ${card.id}:`, e?.message);
    }
  }

  if (expired.length > 0) {
    console.log(`[cron.expiry] expired ${expired.length} Square gift card(s)`);
  }
}

module.exports = { runRewardExpiryCron, sendExpiryNotifications, expireCloverRewards, expireSquareGiftCards };
