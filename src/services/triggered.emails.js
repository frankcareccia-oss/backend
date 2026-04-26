/**
 * triggered.emails.js — Owner-voiced triggered email system
 *
 * 5 trigger events, personalization, bilingual, branded.
 * Default templates go live immediately — no merchant action needed.
 * Custom templates override when merchant customizes via "Your Voice."
 */

"use strict";

const { prisma } = require("../db/prisma");
const { buildPersonalization } = require("./email.personalization");
const { sendNotificationEmail } = require("../utils/mail");
const { sendSms } = require("../utils/sms");
const { t, formatDate } = require("../i18n/t");
const { emitPvHook } = require("../utils/hooks");

// ── Default Templates ────────────────────────────────────────────

const DEFAULT_TEMPLATES = {
  welcome: {
    en: {
      subject: "Welcome to {merchantName}, {firstName}",
      body: `Hi {firstName} —

I'm {ownerName}, the owner of {merchantName}.

Welcome to our rewards program. I set this up because I wanted a real way to say thank you to the people who keep coming back.

Every visit earns you stamps. When you hit {threshold}, you get {rewardDescription} — on me.

See you at the counter.

{ownerName}
{merchantName}

—
Check your stamps: {rewardsLink}`,
    },
    es: {
      subject: "Bienvenido/a a {merchantName}, {firstName}",
      body: `Hola {firstName} —

Soy {ownerName}, el dueño de {merchantName}.

Bienvenido/a a nuestro programa de premios. Lo creé porque quería una forma real de agradecer a las personas que siguen regresando.

Cada visita te da sellos. Cuando llegues a {threshold}, recibes {rewardDescription} — de mi parte.

Hasta pronto.

{ownerName}
{merchantName}

—
Ve tus sellos: {rewardsLink}`,
    },
  },

  first_reward: {
    en: {
      subject: "You earned it, {firstName}",
      body: `{firstName} —

{personalizationText}

You just earned {rewardDescription}.

Bring it in anytime — valid until {rewardExpiry}. No pressure, no rush. It's yours.

{ownerName}
{merchantName}

—
See your reward: {rewardsLink}`,
    },
    es: {
      subject: "Te lo ganaste, {firstName}",
      body: `{firstName} —

{personalizationText}

Acabas de ganar {rewardDescription}.

Úsalo cuando quieras — válido hasta {rewardExpiry}. Sin presión, sin prisa. Es tuyo.

{ownerName}
{merchantName}

—
Ve tu premio: {rewardsLink}`,
    },
  },

  milestone: {
    en: {
      subject: "{visitCount} visits, {firstName}",
      body: `{firstName} —

{personalizationText}

{visitCount} visits to {merchantName}.

That means something to us. Thank you for being part of what makes this place worth showing up to every day.

{ownerName}
{merchantName}

—
Your stamps: {rewardsLink}`,
    },
    es: {
      subject: "{visitCount} visitas, {firstName}",
      body: `{firstName} —

{personalizationText}

{visitCount} visitas a {merchantName}.

Eso significa mucho para nosotros. Gracias por ser parte de lo que hace que valga la pena abrir cada día.

{ownerName}
{merchantName}

—
Tus sellos: {rewardsLink}`,
    },
  },

  winback: {
    en: {
      subject: "It's been a while, {firstName}",
      body: `{firstName} —

It's been {daysSinceLastVisit} days since your last visit to {merchantName}.

{personalizationText}

Life gets busy. No guilt.

Your {stampCount} stamps are still here whenever you're ready. So is your usual.

{ownerName}
{merchantName}

—
Pick up where you left off: {rewardsLink}`,
    },
    es: {
      subject: "Ha pasado un tiempo, {firstName}",
      body: `{firstName} —

Han pasado {daysSinceLastVisit} días desde tu última visita a {merchantName}.

{personalizationText}

La vida se pone ocupada. Sin presión.

Tus {stampCount} sellos siguen aquí cuando estés listo/a. Y tu pedido de siempre también.

{ownerName}
{merchantName}

—
Continúa donde lo dejaste: {rewardsLink}`,
    },
  },

  expiry_warning: {
    en: {
      subject: "Your reward expires in 7 days, {firstName}",
      body: `{firstName} —

You earned {rewardDescription} at {merchantName} and it expires on {expiryDate}.

{personalizationText}

Come in before {expiryDate} and it's yours.

{ownerName}
{merchantName}

—
See your reward: {rewardsLink}`,
    },
    es: {
      subject: "Tu premio vence en 7 días, {firstName}",
      body: `{firstName} —

Ganaste {rewardDescription} en {merchantName} y vence el {expiryDate}.

{personalizationText}

Pasa antes del {expiryDate} y es tuyo.

{ownerName}
{merchantName}

—
Ve tu premio: {rewardsLink}`,
    },
  },
};

// ── Template Resolution ──────────────────────────────────────────

async function getTemplate(eventType, merchantId, lang) {
  // Try custom template first
  try {
    const custom = await prisma.emailTemplate.findFirst({
      where: { merchantId, eventType, language: lang, isActive: true, isCustom: true },
    });
    if (custom) return { subject: custom.subject, body: custom.body, isCustom: true };
  } catch {}

  // Fall back to default
  const def = DEFAULT_TEMPLATES[eventType]?.[lang] || DEFAULT_TEMPLATES[eventType]?.en;
  return def ? { ...def, isCustom: false } : null;
}

// ── Variable Replacement ─────────────────────────────────────────

function populateTemplate(text, vars) {
  let result = text;
  for (const [key, val] of Object.entries(vars)) {
    result = result.replace(new RegExp(`\\{${key}\\}`, "g"), val ?? "");
  }
  return result;
}

// ── Resolve Owner Name ───────────────────────────────────────────

async function getOwnerName(merchantId) {
  try {
    const ownerMu = await prisma.merchantUser.findFirst({
      where: { merchantId, role: "owner", status: "active" },
      include: { user: { select: { firstName: true, lastName: true } } },
    });
    return ownerMu?.user?.firstName || "The Team";
  } catch {
    return "The Team";
  }
}

// ── Main Send Function ───────────────────────────────────────────

/**
 * Send a triggered email to a consumer.
 *
 * @param {string} eventType - welcome | first_reward | milestone | winback | expiry_warning
 * @param {object} consumer - { id, firstName, email, phoneE164, preferredLocale }
 * @param {number} merchantId
 * @param {object} [extras] - { rewardDescription, rewardExpiry, expiryDate, threshold, visitCount }
 */
async function sendTriggeredEmail(eventType, consumer, merchantId, extras = {}) {
  const lang = consumer.preferredLocale || "en";

  // Get merchant info
  const merchant = await prisma.merchant.findUnique({
    where: { id: merchantId },
    select: {
      name: true, merchantSlug: true,
      brandLogo: true, brandColor: true,
      stores: { select: { id: true, name: true } },
    },
  });
  if (!merchant) return;

  const ownerName = await getOwnerName(merchantId);

  // Build personalization from visit history
  const personalization = await buildPersonalization(consumer.id, merchantId, lang);

  // Build rewards link
  const consumerAppUrl = process.env.CONSUMER_APP_URL || "https://consumer-app-ac05.onrender.com";
  const rewardsLink = merchant.merchantSlug
    ? `${consumerAppUrl}/#/m/${merchant.merchantSlug}`
    : consumerAppUrl;

  // Template variables
  const vars = {
    firstName: consumer.firstName || "there",
    ownerName,
    merchantName: merchant.name,
    personalizationText: personalization.personalizationText,
    rewardsLink,
    threshold: extras.threshold || "?",
    rewardDescription: extras.rewardDescription || "a reward",
    rewardExpiry: extras.rewardExpiry || "",
    expiryDate: extras.expiryDate || "",
    visitCount: String(personalization.visitCount),
    stampCount: String(personalization.stampCount),
    daysSinceLastVisit: String(personalization.daysSinceLastVisit || ""),
  };

  // Get template (custom > default)
  const template = await getTemplate(eventType, merchantId, lang);
  if (!template) {
    console.error(`[triggered.emails] No template for ${eventType}/${lang}`);
    return;
  }

  const subject = populateTemplate(template.subject, vars);
  const body = populateTemplate(template.body, vars);

  // Merchant brand for branded email
  const merchantBrand = merchant.brandLogo
    ? { name: merchant.name, logo: merchant.brandLogo, color: merchant.brandColor }
    : undefined;

  // Send email if consumer has email
  if (consumer.email) {
    try {
      await sendNotificationEmail({
        to: consumer.email,
        subject,
        body,
        merchantBrand,
      });

      emitPvHook("email.triggered.sent", {
        tc: "TC-VOICE-01", sev: "info",
        stable: `voice:${merchantId}:${eventType}:${consumer.id}`,
        eventType, consumerId: consumer.id, merchantId,
        language: lang,
        templateType: template.isCustom ? "custom" : "default",
      });
    } catch (e) {
      emitPvHook("email.triggered.failed", {
        tc: "TC-VOICE-02", sev: "error",
        stable: `voice:${merchantId}:${eventType}:${consumer.id}`,
        eventType, consumerId: consumer.id, merchantId,
        error: e?.message,
      });
    }
  }

  // SMS fallback if no email but has phone
  if (!consumer.email && consumer.phoneE164) {
    try {
      const smsBody = `${merchant.name}: ${subject}. ${rewardsLink}`;
      if (typeof sendSms === "function") {
        await sendSms({ to: consumer.phoneE164, body: smsBody });
      }
    } catch (e) {
      console.error("[triggered.emails] SMS fallback failed:", e?.message);
    }
  }
}

module.exports = { sendTriggeredEmail, getTemplate, DEFAULT_TEMPLATES, populateTemplate };
