// backend/src/mail/templates/invoice.issued.stub.js
// Mail-Flow-2: Invoice issued email template (stub, safe defaults).
//
// Purpose:
// - Provide a canonical template module so templateRegistry can resolve "invoice.issued"
// - Keep content minimal and Notepad-friendly
// - No external assets
//
// Expected data (best-effort; all optional):
// - invoiceId (number|string)
// - amountDueCents (number)
// - payUrl (string) OR guestPayUrl (string) OR link (string)
// - billingEmail (string)
// - merchantName (string)

"use strict";

function safeStr(v) {
  return v == null ? "" : String(v);
}

function safeInt(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function dollarsFromCents(cents) {
  const c = safeInt(cents, 0);
  return (c / 100).toFixed(2);
}

module.exports = function renderInvoiceIssuedStub(data = {}) {
  const invoiceId = safeStr(data.invoiceId || data.id || "");
  const merchantName = safeStr(data.merchantName || "");
  const billingEmail = safeStr(data.billingEmail || data.toEmail || "");

  const amountDueCents =
    data.amountDueCents != null
      ? safeInt(data.amountDueCents, 0)
      : data.dueCents != null
      ? safeInt(data.dueCents, 0)
      : null;

  const payUrl =
    safeStr(data.payUrl) ||
    safeStr(data.guestPayUrl) ||
    safeStr(data.guestPayURL) ||
    safeStr(data.link) ||
    "";

  const subjectParts = [];
  subjectParts.push("PerkValet invoice");
  if (invoiceId) subjectParts.push(`#${invoiceId}`);
  subjectParts.push("is ready");
  const subject = subjectParts.join(" ");

  const lines = [];
  lines.push("Hello,");
  lines.push("");
  if (merchantName) {
    lines.push(`A new PerkValet invoice is ready for ${merchantName}.`);
  } else {
    lines.push("A new PerkValet invoice is ready.");
  }
  if (invoiceId) lines.push(`Invoice: #${invoiceId}`);
  if (amountDueCents != null) {
    lines.push(`Amount due: $${dollarsFromCents(amountDueCents)}`);
  }
  lines.push("");
  if (payUrl) {
    lines.push(`Pay securely here: ${payUrl}`);
    lines.push("");
  } else {
    lines.push("Payment link is being prepared. If you need assistance, reply to this email.");
    lines.push("");
  }
  if (billingEmail) {
    lines.push(`Billing contact: ${billingEmail}`);
    lines.push("");
  }
  lines.push("Thank you,");
  lines.push("PerkValet Billing");

  const text = lines.join("\n");

  const html = `
    <div style="font-family: Arial, sans-serif; line-height: 1.4;">
      <p>Hello,</p>
      ${
        merchantName
          ? `<p>A new PerkValet invoice is ready for <strong>${merchantName}</strong>.</p>`
          : `<p>A new PerkValet invoice is ready.</p>`
      }
      ${invoiceId ? `<p><strong>Invoice:</strong> #${invoiceId}</p>` : ""}
      ${
        amountDueCents != null
          ? `<p><strong>Amount due:</strong> $${dollarsFromCents(amountDueCents)}</p>`
          : ""
      }
      ${
        payUrl
          ? `<p><a href="${payUrl}">Pay securely here</a></p>`
          : `<p>Payment link is being prepared. If you need assistance, reply to this email.</p>`
      }
      ${billingEmail ? `<p style="color:#555;"><strong>Billing contact:</strong> ${billingEmail}</p>` : ""}
      <p>Thank you,<br/>PerkValet Billing</p>
    </div>
  `.trim();

  return { subject, text, html };
};
