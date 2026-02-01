// backend/src/mail/mail.smtp.transport.js
// Mail-Prod-1: SMTP transport using nodemailer.
// Safety: transport MAY throw; adapter catches and converts to best-effort result.

const nodemailer = require("nodemailer");

function env(name, fallback = "") {
  return String(process.env[name] || fallback).trim();
}

function must(name) {
  const v = env(name);
  if (!v) throw new Error(`${name} is required for MAIL_MODE=smtp`);
  return v;
}

function num(name, fallback) {
  const raw = env(name, String(fallback ?? ""));
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number`);
  return n;
}

function bool(name, fallback = false) {
  const raw = env(name, fallback ? "true" : "false").toLowerCase();
  return raw === "true" || raw === "1" || raw === "yes";
}

function buildTransport() {
  const host = must("SMTP_HOST");
  const port = num("SMTP_PORT", 587);
  const secure = bool("SMTP_SECURE", port === 465);

  const user = env("SMTP_USER");
  const pass = env("SMTP_PASS");

  const auth =
    user && pass
      ? {
          user,
          pass,
        }
      : undefined;

  return nodemailer.createTransport({
    host,
    port,
    secure,
    auth,
  });
}

function normalizeText(msg) {
  // Prefer rendered.text (template output) if available; otherwise use meta-provided fields.
  const renderedText = msg?.rendered?.text ? String(msg.rendered.text) : "";
  if (renderedText.trim()) return renderedText;

  const fallback = msg?.meta?.text ? String(msg.meta.text) : "";
  if (fallback.trim()) return fallback;

  return `Category: ${String(msg?.category || "")}\nTemplate: ${String(msg?.template || "")}`;
}

/**
 * @param {object} msg
 * @param {string} msg.category
 * @param {string[]} msg.to
 * @param {string} msg.subject
 * @param {object|null} msg.rendered
 * @param {object} msg.meta
 */
async function sendViaSmtpTransport(msg) {
  const from = must("SMTP_FROM");

  const transport = buildTransport();

  const info = await transport.sendMail({
    from,
    to: msg.to.join(", "),
    subject: msg.subject,
    text: normalizeText(msg),
    // Optional: allow override via meta.html
    ...(msg?.meta?.html ? { html: String(msg.meta.html) } : {}),
    headers: {
      "X-PerkValet-Category": String(msg.category || ""),
      "X-PerkValet-Template": String(msg.template || ""),
    },
  });

  return {
    ok: true,
    transport: "smtp",
    messageId: info && info.messageId ? String(info.messageId) : null,
    response: info && info.response ? String(info.response) : null,
  };
}

module.exports = {
  sendViaSmtpTransport,
};
