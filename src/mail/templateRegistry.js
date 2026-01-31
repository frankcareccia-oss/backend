// backend/src/mail/templateRegistry.js
// Mail-Web-1: template registry + renderer (DEV-first).
// Purpose: avoid relying on src/mail/templates/index.js, which is not a template registry in this repo.
// ASCII-only. Minimal surface area.
//
// Contract:
//   renderTemplate(name, data) -> { subject, text }
// Throws if template not found or template errors.

function safeString(v) {
  if (v === undefined || v === null) return "";
  return String(v);
}

function moneyFromCents(cents) {
  const n = Number(cents);
  if (!Number.isFinite(n)) return "";
  const dollars = (n / 100).toFixed(2);
  return `$${dollars}`;
}

function loadTemplateModule(name) {
  switch (name) {
    // Back-compat alias used by earlier smoke tests
    case "invoice.stub":
      return require("./templates/invoice.guest_pay.stub");

    case "invoice.guest_pay.stub":
      return require("./templates/invoice.guest_pay.stub");
    case "invoice.payment_succeeded.stub":
      return require("./templates/invoice.payment_succeeded.stub");
    case "invoice.payment_failed.stub":
      return require("./templates/invoice.payment_failed.stub");
    default: {
      const err = new Error(`Unknown template: ${safeString(name)}`);
      err.code = "TEMPLATE_NOT_FOUND";
      throw err;
    }
  }
}

function renderTemplate(name, data) {
  const mod = loadTemplateModule(name);
  if (!mod || typeof mod.render !== "function") {
    const err = new Error(`Invalid template module for: ${safeString(name)}`);
    err.code = "TEMPLATE_INVALID";
    throw err;
  }
  const helpers = { safeString, moneyFromCents };
  const out = mod.render(data || {}, helpers) || {};
  const subject = safeString(out.subject);
  const text = safeString(out.text);

  if (!subject) {
    const err = new Error(`Template produced empty subject: ${safeString(name)}`);
    err.code = "TEMPLATE_EMPTY_SUBJECT";
    throw err;
  }
  if (!text) {
    const err = new Error(`Template produced empty text: ${safeString(name)}`);
    err.code = "TEMPLATE_EMPTY_TEXT";
    throw err;
  }

  return { subject, text };
}

module.exports = { renderTemplate };
