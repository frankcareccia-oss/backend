// backend/src/mail/mail.adapter.js
// Pluggable adapter. DEV-safe default. No vendor lock.
//
// Mail-Prod-1:
// - Add SMTP transport behind MAIL_MODE=smtp
// - Preserve DEV sink behavior (MAIL_MODE=dev default)
// - Safety: mail failures never break API flows (best-effort send)
// - Keep ENABLE_REAL_EMAIL for backwards compatibility but prefer MAIL_MODE.

const { MAIL_CATEGORIES, assertValidMailCategory } = require("./mail.categories");
const { sendViaDevTransport } = require("./mail.dev.transport");
const { sendViaSmtpTransport } = require("./mail.smtp.transport");
const { pvMailHook } = require("./mail.hooks");
const { renderTemplate } = require("./templateRegistry");

function normalizeTo(to) {
  if (Array.isArray(to)) return to.map(String);
  return [String(to)];
}

function assertNonEmptyString(name, value) {
  if (!value || String(value).trim().length === 0) {
    throw new Error(`${name} is required`);
  }
}

function getMailMode() {
  // Preferred:
  //   MAIL_MODE=dev | smtp
  // Back-compat:
  //   ENABLE_REAL_EMAIL=true  => smtp
  const mode = String(process.env.MAIL_MODE || "").trim().toLowerCase();
  if (mode === "smtp") return "smtp";
  if (mode === "dev") return "dev";

  const legacyEnable = String(process.env.ENABLE_REAL_EMAIL || "").trim().toLowerCase() === "true";
  if (legacyEnable) return "smtp";

  return "dev";
}

function summarizeErr(e) {
  return e?.message || String(e);
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

  // Attempt template rendering for DEV artifacts and SMTP subject/text. Never blocks send.
  let rendered = null;
  try {
    rendered = renderTemplate(String(input.template), input.data || {});
  } catch (e) {
    pvMailHook("mail.template.render_failed", {
      sev: "warn",
      category,
      template: input && input.template,
      error: summarizeErr(e),
    });
    rendered = null;
  }

  const msg = {
    category,
    to,
    subject: String(input.subject),
    template: String(input.template),
    rendered, // { subject, text } or null
    data: input.data || {},
    meta: input.meta || {},
  };

  const mode = getMailMode();

  // PV-HOOK mail.send.attempt tc=TC-MAIL-01 sev=info stable=mailmode:<mode>
  pvMailHook("mail.send.attempt", {
    tc: "TC-MAIL-01",
    sev: "info",
    stable: `mailmode:${mode}`,
    mode,
    category,
    template: msg.template,
    toCount: msg.to.length,
  });

  // Always write DEV artifacts (so QA/support can inspect), even when SMTP is enabled.
  // Failure to write dev artifact must never block.
  try {
    await sendViaDevTransport(msg);
  } catch (e) {
    pvMailHook("mail.dev.write_failed", {
      tc: "TC-MAIL-02",
      sev: "warn",
      stable: `mailmode:${mode}`,
      error: summarizeErr(e),
    });
  }

  // Best-effort sending
  if (mode === "smtp") {
    try {
      const result = await sendViaSmtpTransport(msg);

      pvMailHook("mail.send.success", {
        tc: "TC-MAIL-03",
        sev: "info",
        stable: `mailmode:${mode}`,
        mode,
        category,
        transport: result.transport,
        ok: result.ok,
        messageId: result.messageId || null,
      });

      return result;
    } catch (e) {
      pvMailHook("mail.send.failure", {
        tc: "TC-MAIL-04",
        sev: "error",
        stable: `mailmode:${mode}`,
        mode,
        category,
        error: summarizeErr(e),
      });

      // Critical safety: DO NOT break API flows on mail failure.
      return {
        ok: false,
        transport: "smtp",
        error: summarizeErr(e),
      };
    }
  }

  // Default: DEV sink only (already written above); return a successful "dev" result
  pvMailHook("mail.send.completed", {
    tc: "TC-MAIL-05",
    sev: "info",
    stable: `mailmode:${mode}`,
    category,
    transport: "dev",
    ok: true,
  });

  return {
    ok: true,
    transport: "dev",
  };
}

module.exports = {
  sendMail,
  MAIL_CATEGORIES,
};
