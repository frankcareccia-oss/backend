// backend/src/jobs/paymentReceiptMail.job.js
//
// Mail-Flow-5: Payment Receipt Email (triggered)
// - Called when a payment transitions to status='succeeded'
// - Sends receipt email exactly once using MailEvent idempotency:
//   triggerType=auto
//   idempotencyKey=payment.receipt:payment:<paymentId>
//
// Notes:
// - No scheduler here (triggered).
// - No template edits required; we send explicit subject/text/html.
// - Uses BillingAccount.billingEmail as recipient (fallback to payment.payerEmail if needed).
//
// Export:
// - sendPaymentReceiptEmail({ prisma, paymentId, publicBaseUrl, dryRun })

"use strict";

const path = require("path");

/**
 * pvJobHook: structured job events for QA/docs/support/chatbot.
 * Must never throw.
 */
function pvJobHook(event, fields = {}) {
  try {
    console.log(
      JSON.stringify({
        pvJobHook: event,
        ts: new Date().toISOString(),
        ...fields,
      })
    );
  } catch {
    // never break job for logging
  }
}

function safeInt(n, fallback = 0) {
  const x = Number(n);
  return Number.isFinite(x) ? Math.trunc(x) : fallback;
}

function dollars(cents) {
  const c = safeInt(cents, 0);
  return (c / 100).toFixed(2);
}

/**
 * Resolve a function export from a module without guessing silently.
 * Returns { fn, name, keys } where keys are module export keys.
 */
function resolveFn(mod, candidates, label) {
  const keys = mod && typeof mod === "object" ? Object.keys(mod) : [];
  for (const name of candidates) {
    const fn = mod && typeof mod[name] === "function" ? mod[name] : null;
    if (fn) return { fn, name, keys };
  }
  return {
    fn: null,
    name: null,
    keys,
    err: new Error(
      `${label}: could not find a callable export. Tried: ${candidates.join(
        ", "
      )}. Available exports: ${keys.join(", ") || "(none)"}`
    ),
  };
}

function renderPaymentReceiptEmail({
  invoiceId,
  paymentId,
  amountPaidCents,
  amountDueCents,
  billingEmail,
  payerEmail,
  publicBaseUrl,
}) {
  const subject = `Payment received for PerkValet invoice #${invoiceId}`;

  const lines = [];
  lines.push(`Hello,`);
  lines.push(``);
  lines.push(`We received your payment for PerkValet invoice #${invoiceId}.`);
  lines.push(`Payment ID: ${paymentId}`);
  lines.push(`Amount paid: $${dollars(amountPaidCents)}`);
  lines.push(`Remaining balance: $${dollars(amountDueCents)}`);
  lines.push(``);
  if (publicBaseUrl) {
    lines.push(`If you need help, visit: ${publicBaseUrl}`);
    lines.push(``);
  }
  lines.push(`Billing contact: ${billingEmail}`);
  if (payerEmail && payerEmail !== billingEmail) {
    lines.push(`Payer email: ${payerEmail}`);
  }
  lines.push(``);
  lines.push(`Thank you,`);
  lines.push(`PerkValet Billing`);

  const text = lines.join("\n");

  const html = `
    <div style="font-family: Arial, sans-serif; line-height: 1.4;">
      <p>Hello,</p>
      <p>We received your payment for PerkValet invoice <strong>#${invoiceId}</strong>.</p>
      <p><strong>Payment ID:</strong> ${paymentId}<br/>
         <strong>Amount paid:</strong> $${dollars(amountPaidCents)}<br/>
         <strong>Remaining balance:</strong> $${dollars(amountDueCents)}</p>
      ${
        publicBaseUrl
          ? `<p style="color:#555;">Need help? ${publicBaseUrl}</p>`
          : ``
      }
      <p style="color:#555;"><strong>Billing contact:</strong> ${billingEmail}</p>
      ${
        payerEmail && payerEmail !== billingEmail
          ? `<p style="color:#777;"><strong>Payer email:</strong> ${payerEmail}</p>`
          : ``
      }
      <p>Thank you,<br/>PerkValet Billing</p>
    </div>
  `.trim();

  return { subject, text, html };
}

/**
 * Send a payment receipt email once (idempotent).
 *
 * @param {object} args
 * @param {object} args.prisma - Prisma client (required)
 * @param {number} args.paymentId - Payment ID (required)
 * @param {string} [args.publicBaseUrl] - defaults to process.env.PUBLIC_BASE_URL
 * @param {boolean} [args.dryRun] - if true, do not send
 */
async function sendPaymentReceiptEmail({
  prisma,
  paymentId,
  publicBaseUrl = null,
  dryRun = false,
} = {}) {
  if (!prisma) throw new Error("sendPaymentReceiptEmail: prisma is required");
  const pid = Number(paymentId);
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error("sendPaymentReceiptEmail: invalid paymentId");
  }

  const baseUrl = (publicBaseUrl || process.env.PUBLIC_BASE_URL || "").trim();

  // mail.events + mail.adapter
  const mailEvents = require(path.join("..", "mail", "mail.events"));
  const hasSentResolved = resolveFn(mailEvents, ["hasSentByKey"], "mail.events");
  if (!hasSentResolved.fn) throw hasSentResolved.err;

  const mailAdapter = require(path.join("..", "mail", "mail.adapter"));
  const sendResolved = resolveFn(mailAdapter, ["sendMail"], "mail.adapter");
  if (!sendResolved.fn) throw sendResolved.err;

  // Load payment with invoice link
  const payment = await prisma.payment.findUnique({
    where: { id: pid },
    select: {
      id: true,
      invoiceId: true,
      status: true,
      payerEmail: true,
      providerChargeId: true,
      createdAt: true,
    },
  });

  if (!payment) {
    pvJobHook("paymentReceipt.skip_payment_not_found", { paymentId: pid });
    return { sent: 0, skipped: 1, reason: "payment_not_found" };
  }

  if (payment.status !== "succeeded") {
    pvJobHook("paymentReceipt.skip_not_succeeded", {
      paymentId: pid,
      status: payment.status,
    });
    return { sent: 0, skipped: 1, reason: "not_succeeded" };
  }

  if (!payment.invoiceId) {
    pvJobHook("paymentReceipt.skip_no_invoiceId", { paymentId: pid });
    return { sent: 0, skipped: 1, reason: "no_invoiceId" };
  }

  const invoice = await prisma.invoice.findUnique({
    where: { id: Number(payment.invoiceId) },
    include: {
      billingAccount: { select: { billingEmail: true } },
    },
  });

  if (!invoice) {
    pvJobHook("paymentReceipt.skip_invoice_not_found", {
      paymentId: pid,
      invoiceId: payment.invoiceId,
    });
    return { sent: 0, skipped: 1, reason: "invoice_not_found" };
  }

  const billingEmail =
    invoice.billingAccount && invoice.billingAccount.billingEmail
      ? String(invoice.billingAccount.billingEmail).trim()
      : "";

  const payerEmail = payment.payerEmail ? String(payment.payerEmail).trim() : "";

  const toEmail = billingEmail || payerEmail;

  if (!toEmail) {
    pvJobHook("paymentReceipt.skip_no_recipient", {
      paymentId: pid,
      invoiceId: invoice.id,
    });
    return { sent: 0, skipped: 1, reason: "no_recipient" };
  }

  // Compute amounts (best-effort; schema doesn’t store payment amount explicitly)
  const totalCents = safeInt(invoice.totalCents, 0);
  const paidCents = safeInt(invoice.amountPaidCents, 0);
  const dueCents = Math.max(0, totalCents - paidCents);

  // We cannot infer this payment’s exact amount without a field; we show “amount paid” as paid-to-date.
  const amountPaidCents = paidCents;

  const idempotencyKey = `payment.receipt:payment:${pid}`;

  // Pre-check idempotency
  try {
    const alreadySent = await hasSentResolved.fn({
      prisma,
      triggerType: "auto",
      idempotencyKey,
    });

    if (alreadySent) {
      pvJobHook("paymentReceipt.skip_idempotent", {
        paymentId: pid,
        invoiceId: invoice.id,
        toEmail,
        idempotencyKey,
      });
      return { sent: 0, skipped: 1, reason: "idempotent" };
    }
  } catch (e) {
    pvJobHook("paymentReceipt.idempotency_check_error", {
      paymentId: pid,
      idempotencyKey,
      err: String(e && e.message ? e.message : e),
    });
    // continue; adapter + unique constraint provides best-effort protection
  }

  const rendered = renderPaymentReceiptEmail({
    invoiceId: invoice.id,
    paymentId: pid,
    amountPaidCents,
    amountDueCents: dueCents,
    billingEmail: billingEmail || "(not set)",
    payerEmail: payerEmail || null,
    publicBaseUrl: baseUrl || null,
  });

  const msg = {
    category: "invoice",
    template: "invoice.payment_succeeded",
    toEmail,
    to: toEmail,

    subject: rendered.subject,
    text: rendered.text,
    html: rendered.html,

    meta: {
      triggerType: "auto",
      idempotencyKey,
      actorRole: "system",
      actorUserId: null,
      invoiceId: invoice.id,
      paymentId: pid,
      prisma,
      flow: "payment_receipt",
      providerChargeId: payment.providerChargeId || null,
    },
  };

  pvJobHook("paymentReceipt.attempt", {
    paymentId: pid,
    invoiceId: invoice.id,
    toEmail,
    idempotencyKey,
    dryRun: !!dryRun,
  });

  if (dryRun) {
    pvJobHook("paymentReceipt.dry_run_skip_send", {
      paymentId: pid,
      invoiceId: invoice.id,
    });
    return { sent: 0, skipped: 1, reason: "dry_run" };
  }

  await sendResolved.fn(msg);

  pvJobHook("paymentReceipt.sent", {
    paymentId: pid,
    invoiceId: invoice.id,
    toEmail,
    idempotencyKey,
  });

  return { sent: 1, skipped: 0 };
}

module.exports = {
  sendPaymentReceiptEmail,
};
