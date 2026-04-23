// src/utils/mail.templates.js — Branded PerkValet email templates
"use strict";

const BRAND = {
  navy: "#1A3A5C",
  teal: "#1D9E75",
  orange: "#E8671A",
  bg: "#F4F4F0",
  white: "#FFFFFF",
  muted: "#6B7A80",
  border: "#D9D3CA",
};

function wrap(title, bodyHtml) {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:${BRAND.bg};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
<div style="max-width:560px;margin:0 auto;padding:32px 16px">
  <!-- Header -->
  <div style="background:${BRAND.navy};border-radius:12px 12px 0 0;padding:24px 28px;text-align:center">
    <div style="font-size:24px;font-weight:800;color:${BRAND.teal};letter-spacing:-0.5px">PerkValet</div>
    <div style="font-size:12px;color:rgba(255,255,255,0.5);margin-top:4px">Loyalty that works</div>
  </div>
  <!-- Body -->
  <div style="background:${BRAND.white};padding:28px;border-left:1px solid ${BRAND.border};border-right:1px solid ${BRAND.border}">
    <div style="font-size:18px;font-weight:700;color:${BRAND.navy};margin-bottom:16px">${title}</div>
    ${bodyHtml}
  </div>
  <!-- Footer -->
  <div style="background:${BRAND.white};border-top:1px solid ${BRAND.border};border-radius:0 0 12px 12px;padding:20px 28px;text-align:center;border-left:1px solid ${BRAND.border};border-right:1px solid ${BRAND.border}">
    <div style="font-size:11px;color:${BRAND.muted}">PerkValet Inc. &middot; <a href="https://perksvalet.com" style="color:${BRAND.teal};text-decoration:none">perksvalet.com</a></div>
    <div style="font-size:11px;color:${BRAND.muted};margin-top:4px">Questions? Reply to this email or contact <a href="mailto:hello@perksvalet.com" style="color:${BRAND.teal};text-decoration:none">hello@perksvalet.com</a></div>
  </div>
</div>
</body>
</html>`;
}

// ── Demo request auto-response ──
function demoRequestConfirmation(email) {
  const body = `
    <p style="font-size:14px;color:${BRAND.navy};line-height:1.7;margin:0 0 16px">
      Thanks for your interest in PerkValet! We received your demo request and a member of our team will reach out within <strong>one business day</strong>.
    </p>
    <p style="font-size:14px;color:${BRAND.navy};line-height:1.7;margin:0 0 16px">
      In the meantime, here's what PerkValet can do for your business:
    </p>
    <ul style="font-size:14px;color:${BRAND.navy};line-height:1.8;margin:0 0 16px;padding-left:20px">
      <li>Turn every POS transaction into a loyalty touchpoint</li>
      <li>Launch stamp cards, points programs, and bundles in minutes</li>
      <li>Works with Clover, Square, and Toast — no hardware needed</li>
      <li>Your customers earn rewards automatically at checkout</li>
    </ul>
    <div style="text-align:center;margin:24px 0">
      <a href="https://perksvalet.com/how-it-works.html" style="display:inline-block;padding:12px 28px;background:${BRAND.orange};color:${BRAND.white};border-radius:8px;text-decoration:none;font-weight:600;font-size:14px">See How It Works</a>
    </div>
    <p style="font-size:13px;color:${BRAND.muted};margin:0">
      This email was sent to ${email} because a demo was requested on perksvalet.com.
    </p>`;
  return {
    subject: "Thanks for your interest in PerkValet!",
    text: `Thanks for your interest in PerkValet! We received your demo request and will reach out within one business day.\n\nLearn more: https://perksvalet.com/how-it-works.html`,
    html: wrap("We'll be in touch soon", body),
  };
}

// ── Invoice issued ──
function invoiceIssued({ merchantName, invoiceNumber, totalCents, dueAt, lineItems }) {
  const total = `$${(totalCents / 100).toFixed(2)}`;
  const due = dueAt ? new Date(dueAt).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }) : "upon receipt";

  const itemRows = (lineItems || []).map(li => `
    <tr>
      <td style="padding:8px 0;font-size:13px;color:${BRAND.navy};border-bottom:1px solid ${BRAND.border}">${li.description || li.label || "Service"}</td>
      <td style="padding:8px 0;font-size:13px;color:${BRAND.navy};border-bottom:1px solid ${BRAND.border};text-align:right">$${(li.amountCents / 100).toFixed(2)}</td>
    </tr>
  `).join("");

  const body = `
    <p style="font-size:14px;color:${BRAND.navy};line-height:1.7;margin:0 0 16px">
      Hi ${merchantName},
    </p>
    <p style="font-size:14px;color:${BRAND.navy};line-height:1.7;margin:0 0 20px">
      A new invoice has been issued for your PerkValet account.
    </p>
    <div style="background:${BRAND.bg};border-radius:8px;padding:16px 20px;margin-bottom:20px">
      <table style="width:100%;border-collapse:collapse">
        <tr>
          <td style="font-size:13px;color:${BRAND.muted};padding:4px 0">Invoice</td>
          <td style="font-size:13px;font-weight:600;color:${BRAND.navy};text-align:right;padding:4px 0">#${invoiceNumber}</td>
        </tr>
        <tr>
          <td style="font-size:13px;color:${BRAND.muted};padding:4px 0">Amount due</td>
          <td style="font-size:18px;font-weight:700;color:${BRAND.navy};text-align:right;padding:4px 0">${total}</td>
        </tr>
        <tr>
          <td style="font-size:13px;color:${BRAND.muted};padding:4px 0">Due date</td>
          <td style="font-size:13px;font-weight:600;color:${BRAND.navy};text-align:right;padding:4px 0">${due}</td>
        </tr>
      </table>
    </div>
    ${itemRows ? `
    <div style="margin-bottom:20px">
      <div style="font-size:12px;font-weight:700;color:${BRAND.muted};text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px">Line Items</div>
      <table style="width:100%;border-collapse:collapse">${itemRows}
        <tr>
          <td style="padding:10px 0;font-size:14px;font-weight:700;color:${BRAND.navy}">Total</td>
          <td style="padding:10px 0;font-size:14px;font-weight:700;color:${BRAND.navy};text-align:right">${total}</td>
        </tr>
      </table>
    </div>` : ""}
    <p style="font-size:13px;color:${BRAND.muted};margin:0">
      If you have questions about this invoice, reply to this email or contact <a href="mailto:hello@perksvalet.com" style="color:${BRAND.teal}">hello@perksvalet.com</a>.
    </p>`;

  return {
    subject: `PerkValet Invoice #${invoiceNumber} — ${total} due ${due}`,
    text: `Invoice #${invoiceNumber} for ${merchantName}\nAmount: ${total}\nDue: ${due}\n\nContact hello@perksvalet.com with questions.`,
    html: wrap(`Invoice #${invoiceNumber}`, body),
  };
}

// ── Invoice overdue reminder ──
function invoiceOverdue({ merchantName, invoiceNumber, totalCents, dueAt }) {
  const total = `$${(totalCents / 100).toFixed(2)}`;
  const due = dueAt ? new Date(dueAt).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }) : "N/A";

  const body = `
    <p style="font-size:14px;color:${BRAND.navy};line-height:1.7;margin:0 0 16px">
      Hi ${merchantName},
    </p>
    <p style="font-size:14px;color:${BRAND.navy};line-height:1.7;margin:0 0 16px">
      This is a friendly reminder that invoice <strong>#${invoiceNumber}</strong> for <strong>${total}</strong> was due on <strong>${due}</strong> and is now past due.
    </p>
    <p style="font-size:14px;color:${BRAND.navy};line-height:1.7;margin:0 0 20px">
      Please arrange payment at your earliest convenience. If you've already sent payment, you can disregard this notice.
    </p>
    <p style="font-size:13px;color:${BRAND.muted};margin:0">
      Questions? Reply to this email or contact <a href="mailto:hello@perksvalet.com" style="color:${BRAND.teal}">hello@perksvalet.com</a>.
    </p>`;

  return {
    subject: `Reminder: PerkValet Invoice #${invoiceNumber} is past due`,
    text: `Reminder: Invoice #${invoiceNumber} for ${total} was due ${due} and is now past due.\n\nContact hello@perksvalet.com with questions.`,
    html: wrap("Payment Reminder", body),
  };
}

module.exports = { demoRequestConfirmation, invoiceIssued, invoiceOverdue };
