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

// ── Waitlist confirmation ──
function waitlistConfirmation(email) {
  const body = `
    <p style="font-size:14px;color:${BRAND.navy};line-height:1.7;margin:0 0 16px">
      You're on the list! We'll reach out as soon as PerkValet is ready for your business.
    </p>
    <p style="font-size:14px;color:${BRAND.navy};line-height:1.7;margin:0 0 16px">
      In the meantime, here's what you can look forward to:
    </p>
    <ul style="font-size:14px;color:${BRAND.navy};line-height:1.8;margin:0 0 16px;padding-left:20px">
      <li>Automatic digital loyalty — no punch cards, no apps to download</li>
      <li>Works with your existing POS system at checkout</li>
      <li>Customers earn rewards just by paying — nothing extra to do</li>
      <li>Real insights into who your regulars are and how often they visit</li>
    </ul>
    <div style="text-align:center;margin:24px 0">
      <a href="https://perksvalet.com/how-it-works.html" style="display:inline-block;padding:12px 28px;background:${BRAND.orange};color:${BRAND.white};border-radius:8px;text-decoration:none;font-weight:600;font-size:14px">See How It Works</a>
    </div>
    <p style="font-size:13px;color:${BRAND.muted};margin:0">
      This email was sent to ${email} because you joined the PerkValet waitlist.
    </p>`;
  return {
    subject: "You're on the PerkValet waitlist!",
    text: `You're on the PerkValet waitlist! We'll reach out as soon as we're ready for your business.\n\nLearn more: https://perksvalet.com/how-it-works.html`,
    html: wrap("You're on the list", body),
  };
}

// ── Upgrade welcome + invoice ──
function upgradeInvoice({ merchantName, firstName, locationCount, invoiceNumber, totalCents, dueAt, payUrl, lineItems }) {
  const total = `$${(totalCents / 100).toFixed(2)}`;
  const due = dueAt ? new Date(dueAt).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }) : "upon receipt";
  const hasMultipleLocations = locationCount > 1;
  const greeting = firstName || merchantName;

  const itemRows = (lineItems || []).map(li => `
    <tr>
      <td style="padding:6px 0;font-size:13px;color:${BRAND.navy};border-bottom:1px solid ${BRAND.border}">${li.description || "Service"}</td>
      <td style="padding:6px 0;font-size:13px;color:${BRAND.navy};border-bottom:1px solid ${BRAND.border};text-align:right">$${(li.amountCents / 100).toFixed(2)}</td>
    </tr>
  `).join("");

  const featureBullet = (emoji, title, desc) => `
    <tr>
      <td style="padding:8px 0;vertical-align:top;width:32px;font-size:20px">${emoji}</td>
      <td style="padding:8px 0;vertical-align:top">
        <div style="font-size:14px;font-weight:700;color:${BRAND.navy}">${title}</div>
        <div style="font-size:13px;color:${BRAND.muted};line-height:1.5;margin-top:2px">${desc}</div>
      </td>
    </tr>`;

  const body = `
    <p style="font-size:15px;font-weight:700;color:${BRAND.navy};line-height:1.6;margin:0 0 8px">
      You made a great call, ${greeting}.
    </p>
    <p style="font-size:14px;color:${BRAND.navy};line-height:1.7;margin:0 0 24px">
      ${merchantName} just upgraded to Value-Added &mdash; and everything activates the moment your payment is confirmed.
    </p>

    <div style="font-size:13px;font-weight:700;color:${BRAND.muted};text-transform:uppercase;letter-spacing:0.5px;margin-bottom:12px">Here's what just unlocked for your business</div>

    <table style="width:100%;border-collapse:collapse;margin-bottom:24px">
      ${featureBullet("\u2728", "Unlimited promotions", "Run a morning special, a happy hour, and your main loyalty program &mdash; all at the same time.")}
      ${hasMultipleLocations ? featureBullet("\uD83D\uDCCD", "Multi-location stamp sharing", `A customer who visits one location earns toward the same reward at your other ${locationCount - 1} location${locationCount > 2 ? "s" : ""}. One program, everywhere you are.`) : featureBullet("\uD83D\uDCCD", "Multi-location ready", "When you add more locations, your customers will earn toward the same reward everywhere. One program, no extra setup.")}
      ${featureBullet("\uD83D\uDCCA", "Advanced analytics + Weekly Briefing", "Every Monday morning, PerkValet sends you a summary of last week &mdash; what worked, what didn't, and what to try next.")}
      ${featureBullet("\uD83E\uDD16", "AI-generated promotion copy", "Describe your promotion, and PerkValet writes the consumer-facing description for you &mdash; including allergen and dietary statements.")}
      ${featureBullet("\uD83D\uDE80", "Growth Advisor", "Tell us your goal &mdash; fill slow periods, bring back lapsed customers, reward your best regulars &mdash; and Growth Advisor builds the right promotion for it.")}
    </table>

    <div style="border-top:1px solid ${BRAND.border};margin:24px 0"></div>

    <div style="font-size:13px;font-weight:700;color:${BRAND.muted};text-transform:uppercase;letter-spacing:0.5px;margin-bottom:12px">Your first invoice</div>

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
      ${itemRows ? `
      <div style="margin-top:12px;border-top:1px solid ${BRAND.border};padding-top:12px">
        <table style="width:100%;border-collapse:collapse">${itemRows}
          <tr>
            <td style="padding:8px 0;font-size:14px;font-weight:700;color:${BRAND.navy}">Total</td>
            <td style="padding:8px 0;font-size:14px;font-weight:700;color:${BRAND.navy};text-align:right">${total}</td>
          </tr>
        </table>
      </div>` : ""}
    </div>

    <div style="text-align:center;margin:24px 0">
      <a href="${payUrl}" style="display:inline-block;padding:14px 0;width:100%;max-width:400px;background:${BRAND.orange};color:${BRAND.white};border-radius:8px;text-decoration:none;font-weight:700;font-size:15px;text-align:center;box-sizing:border-box">Complete your upgrade &rarr;</a>
    </div>

    <p style="font-size:13px;color:${BRAND.muted};text-align:center;margin:0 0 16px;line-height:1.5">
      Everything activates the moment payment is confirmed.<br>
      No waiting, no setup &mdash; it's all ready for you.
    </p>`;

  return {
    subject: `You just unlocked everything \u2014 welcome to Value-Added, ${merchantName}`,
    text: `You made a great call, ${greeting}.\n\n${merchantName} just upgraded to Value-Added. Everything activates the moment your payment is confirmed.\n\nInvoice #${invoiceNumber}\nAmount: ${total}\nDue: ${due}\n\nComplete your upgrade: ${payUrl}\n\nQuestions? Contact hello@perksvalet.com`,
    html: wrap("Welcome to Value-Added \u2728", body),
  };
}

module.exports = { demoRequestConfirmation, invoiceIssued, invoiceOverdue, waitlistConfirmation, upgradeInvoice };
