// backend/src/mail/mail.smtp.transport.js
// SMTP transport (best-effort). Does not throw unless misconfigured.

const nodemailer = require("nodemailer");

function must(name) {
  const v = process.env[name];
  if (!v || String(v).trim() === "") throw new Error(`${name} is required`);
  return String(v).trim();
}

function safeString(v) {
  if (v === undefined || v === null) return "";
  return String(v);
}

function normalizeText(msg) {
  // Prefer adapter-normalized fields first (newer)
  const topText = msg?.text ? String(msg.text) : "";
  if (topText.trim()) return topText;

  const body = msg?.body ? String(msg.body) : "";
  if (body.trim()) return body;

  // Back-compat: rendered.text or rendered.body/bodyText
  const rendered =
    msg && msg.rendered && typeof msg.rendered === "object" ? msg.rendered : null;

  const renderedText =
    rendered && (rendered.text || rendered.body || rendered.bodyText)
      ? String(rendered.text || rendered.body || rendered.bodyText)
      : "";
  if (renderedText.trim()) return renderedText;

  // Legacy: meta.text
  const fallback = msg?.meta?.text ? String(msg.meta.text) : "";
  if (fallback.trim()) return fallback;

  // Last resort
  return `Category: ${safeString(msg?.category)}\nTemplate: ${safeString(msg?.template)}`;
}

function normalizeHtml(msg) {
  // Prefer adapter-normalized fields first (newer)
  const topHtml = msg?.html ? String(msg.html) : "";
  if (topHtml.trim()) return topHtml;

  // Back-compat: rendered.html or rendered.bodyHtml
  const rendered =
    msg && msg.rendered && typeof msg.rendered === "object" ? msg.rendered : null;

  const renderedHtml =
    rendered && (rendered.html || rendered.bodyHtml)
      ? String(rendered.html || rendered.bodyHtml)
      : "";
  if (renderedHtml.trim()) return renderedHtml;

  // Legacy: meta.html
  const fallback = msg?.meta?.html ? String(msg.meta.html) : "";
  if (fallback.trim()) return fallback;

  return "";
}

async function sendViaSmtpTransport(msg) {
  const from = must("SMTP_FROM");

  const host = must("SMTP_HOST");
  const port = Number(must("SMTP_PORT"));
  const user = must("SMTP_USER");
  const pass = must("SMTP_PASS");

  const secure = String(process.env.SMTP_SECURE || "").trim().toLowerCase() === "true";

  const transporter = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user, pass },
  });

  const text = normalizeText(msg);
  const html = normalizeHtml(msg);

  const mailOptions = {
    from,
    to: Array.isArray(msg.to) ? msg.to.join(",") : String(msg.to || ""),
    subject: safeString(msg.subject) || "PerkValet message",
    text,

    // Only include html if we have it; otherwise nodemailer uses text.
    ...(html.trim() ? { html } : {}),

    headers: {
      "X-PerkValet-Category": safeString(msg.category),
      "X-PerkValet-Template": safeString(msg.template),
    },
  };

  const info = await transporter.sendMail(mailOptions);

  return {
    ok: true,
    transport: "smtp",
    messageId: info && info.messageId ? info.messageId : null,
  };
}

module.exports = { sendViaSmtpTransport };
