/**
 * voice.generator.js — AI-powered email template generation
 *
 * Uses Claude Haiku to generate owner-voiced email templates
 * based on merchant's style choice and personal notes.
 */

"use strict";

const { emitPvHook } = require("../utils/hooks");

const STYLE_INSTRUCTIONS = {
  warm_neighborly: "Write like a friendly neighbor who genuinely cares about their community. Conversational, inclusive, community-focused. Use \"we\" naturally.",
  cool_minimal: "Write short and confident. No adjectives, no warmth performance. Just clear and direct. Fewer words = better.",
  funny_casual: "Light humor is welcome. Relaxed and casual. Like texting a regular customer you know well. Don't force the humor — let it land naturally.",
  heartfelt_genuine: "Story-driven and emotional. Reference the journey, the purpose, the people. Allow some sentimentality. This owner wears their heart on their sleeve.",
};

const EVENT_DESCRIPTIONS = {
  welcome: "Welcome email — sent when a customer first enrolls in the rewards program",
  first_reward: "First reward earned — sent when a customer hits their first milestone",
  milestone: "Milestone visit — sent when a customer reaches 10, 25, 50, or 100 visits",
  winback: "Win-back — sent when a customer hasn't visited in 30+ days",
  expiry_warning: "Reward expiry warning — sent 7 days before a reward expires",
};

/**
 * Generate an owner-voiced email template.
 * @param {object} params
 * @param {object} params.merchant - { name, businessType, ownerName }
 * @param {string} params.eventType - welcome | first_reward | milestone | winback | expiry_warning
 * @param {string} params.styleChoice - warm_neighborly | cool_minimal | funny_casual | heartfelt_genuine
 * @param {string} [params.personalNote] - merchant's personal detail
 * @param {string} params.defaultTemplate - the default template for reference
 * @param {string} [params.language] - "en" or "es"
 * @returns {Promise<string>} Generated email body
 */
async function generateVoiceEmail({ merchant, eventType, styleChoice, personalNote, defaultTemplate, language = "en" }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not configured");

  const Anthropic = require("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey });

  const systemPrompt = `You are helping a small business owner write a personal email to their loyal customers. The email should sound like it came from a real person — the owner — not from software.

Business context:
- Business name: ${merchant.name}
- Business type: ${merchant.businessType || "small business"}
- Owner name: ${merchant.ownerName}
- Style: ${STYLE_INSTRUCTIONS[styleChoice] || STYLE_INSTRUCTIONS.warm_neighborly}
- Personal detail: ${personalNote || "none provided"}
- Language: ${language === "es" ? "Spanish (California Spanish — warm, not formal)" : "English"}

Email trigger: ${EVENT_DESCRIPTIONS[eventType] || eventType}

Default template for reference:
${defaultTemplate}

RULES — follow every one of these:
1. Maximum 6 sentences. Short is better.
2. Sign with owner first name only — not full name, not business name
3. No bullet points. No headers. Plain prose only.
4. Never use the word "loyalty" or "program" — ever
5. Never use exclamation points unless style is funny_casual
6. Never say "click here" — say what the link does
7. Include {personalizationText} variable on its own line after the opening — this gets replaced with a personal observation about this specific customer
8. Keep {firstName}, {ownerName}, {merchantName}, {rewardsLink} and other variables exactly as written — never translate variable names
9. If personalNote is provided, work it in naturally — don't just append it
10. The email should make someone stop and feel seen — not marketed to

Return ONLY the email body. No subject line. No explanation. No preamble. Just the email.`;

  const resp = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 400,
    system: systemPrompt,
    messages: [{ role: "user", content: `Write the ${eventType} email for ${merchant.name}.` }],
  });

  const text = resp.content?.[0]?.text || "";

  emitPvHook("voice.template.generated", {
    tc: "TC-VOICE-03", sev: "info",
    stable: `voice:generate:${merchant.id || "unknown"}:${eventType}`,
    merchantId: merchant.id, eventType, styleChoice, language,
  });

  return text.trim();
}

/**
 * Generate Spanish version from English template.
 */
async function generateSpanishVersion({ englishTemplate, merchant, styleChoice }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not configured");

  const Anthropic = require("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey });

  const systemPrompt = `Translate this email template from English to Spanish. Maintain the same voice, tone, and emotional register.

Style: ${STYLE_INSTRUCTIONS[styleChoice] || STYLE_INSTRUCTIONS.warm_neighborly}
Owner name: ${merchant.ownerName} (keep in English)
Business name: ${merchant.name} (keep in English)

RULES:
1. Keep all {variables} exactly as written — never translate them
2. Use warm California Spanish — not formal Spain Spanish
3. "Cartera" not "billetera" for wallet
4. "Sellos" for stamps
5. "Premio" not "recompensa" for reward
6. "Aplicar" not "canjear" for redeem
7. Match the length of the English version
8. If the English is casual, the Spanish should be casual too
9. "Bienvenido/a" for gender-neutral welcome

Return ONLY the Spanish email body.`;

  const resp = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 400,
    system: systemPrompt,
    messages: [{ role: "user", content: `Translate this to Spanish:\n\n${englishTemplate}` }],
  });

  return (resp.content?.[0]?.text || "").trim();
}

module.exports = { generateVoiceEmail, generateSpanishVersion, STYLE_INSTRUCTIONS, EVENT_DESCRIPTIONS };
