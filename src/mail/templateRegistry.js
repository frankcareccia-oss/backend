// backend/src/mail/templateRegistry.js
// Purpose: avoid relying on src/mail/templates/index.js, which is not a template
// registry in this repo.
//
// Contract:
// - Keep this registry stable and explicit.
// - renderTemplate(name, data) -> { subject, text, html? }
// - Unknown template should throw (adapter will catch + log).
//
// Mail-Flow-1 stubs already supported:
// - invoice.guest_pay.stub
// - invoice.payment_succeeded.stub
// - invoice.payment_failed.stub
//
// Mail-Flow-2 addition:
// - invoice.issued  -> templates/invoice.issued.stub

"use strict";

function safeString(v) {
  if (v == null) return "";
  return String(v).trim();
}

function loadTemplate(name) {
  const n = safeString(name);

  // Keep registry explicit. No dynamic requires.
  switch (n) {
    // Existing (Mail-Flow-1)
    case "invoice.guest_pay.stub":
      return require("./templates/invoice.guest_pay.stub");

    case "invoice.guest_pay":
      // Back-compat alias (if any callers used the short name)
      return require("./templates/invoice.guest_pay.stub");

    case "invoice.payment_succeeded.stub":
      return require("./templates/invoice.payment_succeeded.stub");

    case "invoice.payment_succeeded":
      // Back-compat alias
      return require("./templates/invoice.payment_succeeded.stub");

    case "invoice.payment_failed.stub":
      return require("./templates/invoice.payment_failed.stub");

    case "invoice.payment_failed":
      // Back-compat alias
      return require("./templates/invoice.payment_failed.stub");

    // New (Mail-Flow-2)
    case "invoice.issued":
      return require("./templates/invoice.issued.stub");

    case "invoice.issued.stub":
      // Allow explicit stub name too
      return require("./templates/invoice.issued.stub");

    default: {
      const err = new Error(`Unknown template: ${safeString(name)}`);
      err.code = "MAIL_TEMPLATE_UNKNOWN";
      throw err;
    }
  }
}

function renderTemplate(name, data) {
  const tmpl = loadTemplate(name);
  if (typeof tmpl !== "function") {
    const err = new Error(`Template is not a function: ${safeString(name)}`);
    err.code = "MAIL_TEMPLATE_INVALID";
    throw err;
  }
  const out = tmpl(data || {});
  if (!out || typeof out !== "object") {
    const err = new Error(`Template returned invalid payload: ${safeString(name)}`);
    err.code = "MAIL_TEMPLATE_INVALID_RESULT";
    throw err;
  }
  // Require at least subject + text; html is optional.
  if (!safeString(out.subject) || !safeString(out.text)) {
    const err = new Error(
      `Template must return { subject, text } (html optional): ${safeString(name)}`
    );
    err.code = "MAIL_TEMPLATE_MISSING_FIELDS";
    throw err;
  }
  return out;
}

module.exports = { renderTemplate };
