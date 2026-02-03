// backend/src/mail/templates/invoice.payment_succeeded.stub.js
"use strict";

/**
 * Stub template: invoice.payment_succeeded
 *
 * Must export a FUNCTION (render) — templateRegistry expects a function.
 * This template is intentionally minimal + resilient across callers.
 *
 * Expected return shape (adapter-friendly):
 * { subject, text, html }
 */

function safe(v) {
  if (v === null || v === undefined) return "";
  return String(v);
}

function moneyFromCents(cents) {
  const n = Number(cents);
  if (!Number.isFinite(n)) return "";
  return `$${(n / 100).toFixed(2)}`;
}

function guessAmountCents({ payment, invoice }) {
  return (
    payment?.amountCents ??
    payment?.amount ??
    invoice?.amountCents ??
    invoice?.totalCents ??
    invoice?.totalAmountCents ??
    invoice?.balanceCents ??
    null
  );
}

function guessInvoiceNumber(invoice) {
  return invoice?.number ?? invoice?.invoiceNumber ?? invoice?.id ?? "";
}

/**
 * render(ctx)
 * ctx commonly includes: { invoice, payment, publicBaseUrl, guestPayUrl, billingEmail, toEmail }
 */
function render(ctx = {}) {
  const invoice = ctx.invoice || {};
  const payment = ctx.payment || {};
  const toEmail = ctx.toEmail || ctx.billingEmail || ctx.payerEmail || "";

  const invNo = guessInvoiceNumber(invoice);
  const amountCents = guessAmountCents({ payment, invoice });
  const amount = moneyFromCents(amountCents);

  // Optional URLs
  const publicBaseUrl = ctx.publicBaseUrl || "";
  const receiptUrl =
    ctx.receiptUrl ||
    (publicBaseUrl && invNo ? `${publicBaseUrl}/merchant/invoices/${safe(invoice.id || invNo)}` : "");

  const subject =
    invNo !== ""
      ? `PerkValet payment received for invoice ${safe(invNo)}`
      : "PerkValet payment received";

  const textLines = [
    "Payment received.",
    invNo !== "" ? `Invoice: ${safe(invNo)}` : "",
    amount ? `Amount: ${amount}` : "",
    toEmail ? `Sent to: ${safe(toEmail)}` : "",
    receiptUrl ? `Receipt/details: ${receiptUrl}` : "",
    "",
    "(Stub template: invoice.payment_succeeded)",
  ].filter(Boolean);

  const text = textLines.join("\n");

  const html = `
    <div style="font-family: Arial, sans-serif; line-height: 1.4;">
      <h2 style="margin: 0 0 12px;">Payment received</h2>
      ${invNo !== "" ? `<div><strong>Invoice:</strong> ${safe(invNo)}</div>` : ""}
      ${amount ? `<div><strong>Amount:</strong> ${safe(amount)}</div>` : ""}
      ${toEmail ? `<div><strong>Sent to:</strong> ${safe(toEmail)}</div>` : ""}
      ${receiptUrl ? `<div style="margin-top:12px;"><a href="${safe(receiptUrl)}">View receipt/details</a></div>` : ""}
      <hr style="margin: 16px 0;" />
      <div style="color:#666; font-size:12px;">Stub template: invoice.payment_succeeded</div>
    </div>
  `.trim();

  return { subject, text, html };
}

// Primary export: function
module.exports = render;

// Extra-compatible named exports (safe, doesn’t hurt)
module.exports.render = render;
module.exports.default = render;
