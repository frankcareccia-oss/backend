// backend/src/mail/mail.adapter.js
// Pluggable adapter. DEV-safe default. No vendor lock.
// Safety: real email is NOT implemented in Mail-Web-1.

const { MAIL_CATEGORIES, assertValidMailCategory } = require("./mail.categories");
const { sendViaDevTransport } = require("./mail.dev.transport");
const { pvMailHook } = require("./mail.hooks");

function normalizeTo(to) {
  if (Array.isArray(to)) return to.map(String);
  return [String(to)];
}

function assertNonEmptyString(name, value) {
  if (!value || String(value).trim().length === 0) {
    throw new Error(`${name} is required`);
  }
}

function getEnableRealEmailFlag() {
  // Must be exactly "true" to be considered enabled.
  return String(process.env.ENABLE_REAL_EMAIL || "").trim().toLowerCase() === "true";
}

/**
 * Main entrypoint
 * @param {object} input
 * @param {string} input.category - invoice|support|marketing|system
 * @param {string|string[]} input.to
 * @param {string} input.subject
 * @param {string} input.template
 * @param {object} input.data
 * @param {object} input.meta
 */
async function sendMail(input) {
  // Hooks must never throw; adapter can throw for validation.
  pvMailHook("mail.send.requested", {
    category: input && input.category,
    template: input && input.template,
  });

  if (!input) throw new Error("sendMail input is required");

  const category = String(input.category);
  assertValidMailCategory(category);

  const to = normalizeTo(input.to);
  if (!to.length) throw new Error("to is required");

  assertNonEmptyString("subject", input.subject);
  assertNonEmptyString("template", input.template);

  const msg = {
    category,
    to,
    subject: String(input.subject),
    template: String(input.template),
    data: input.data || {},
    meta: input.meta || {},
  };

  const enableReal = getEnableRealEmailFlag();

  // Critical safety: even if enabled, real transport isn't shipped in Mail-Web-1.
  if (enableReal) {
    pvMailHook("mail.real.blocked", {
      reason: "real transport not implemented",
      category,
    });
    throw new Error(
      "ENABLE_REAL_EMAIL=true but real transport is not implemented in Mail-Web-1. Refusing to send."
    );
  }

  // Default: DEV sink only.
  const result = await sendViaDevTransport(msg);

  pvMailHook("mail.send.completed", {
    category,
    transport: result.transport,
    ok: result.ok,
    mailId: result.id,
  });

  return result;
}

module.exports = {
  sendMail,
  MAIL_CATEGORIES,
};