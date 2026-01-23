const Stripe = require("stripe");
const { prisma } = require("../db/prisma");

const { emitSystemHook } = require("../hooks/systemHooks");

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: process.env.STRIPE_API_VERSION || "2024-06-20",
});

/**
 * payment_intent.succeeded
 */
async function handlePaymentIntentSucceeded(pi) {
  const providerChargeId = pi.id; // pi_...

  const payment = await prisma.payment.findFirst({
    where: { providerChargeId },
  });

  // Not a PI we created — acknowledge to stop retries
  if (!payment) return;

  // Idempotent: Stripe retries events
  if (payment.status === "succeeded") return;

  await prisma.$transaction(async (tx) => {
    // 1) Update payment
    const updatedPayment = await tx.payment.update({
      where: { id: payment.id },
      data: {
        status: "succeeded",
        statusUpdatedAt: new Date(),
      },
    });

    // ✅ HOOK: payment succeeded (emit even if invoice apply is skipped)
    emitSystemHook({
      type: "payment.succeeded",
      source: "stripe:webhook",
      entity: {
        paymentId: updatedPayment.id,
        invoiceId: updatedPayment.invoiceId || null,
        providerChargeId,
      },
      facts: {
        amountCents: updatedPayment.amountCents,
        payerEmail: updatedPayment.payerEmail || null,
      },
      timestamp: new Date(),
    });

    // 2) Apply to invoice (if linked)
    if (!updatedPayment.invoiceId) return;

    const invoice = await tx.invoice.findUnique({
      where: { id: updatedPayment.invoiceId },
    });
    if (!invoice) return;

    const newPaid =
      (invoice.amountPaidCents || 0) +
      (updatedPayment.amountCents || 0);

    const invoiceUpdate = { amountPaidCents: newPaid };

    const fullyPaid = newPaid >= (invoice.totalCents || 0);
    if (fullyPaid) {
      invoiceUpdate.status = "paid";
    }

    await tx.invoice.update({
      where: { id: invoice.id },
      data: invoiceUpdate,
    });

    // ✅ HOOK: invoice updated due to payment application
    emitSystemHook({
      type: "invoice.payment_applied",
      source: "stripe:webhook",
      entity: {
        invoiceId: invoice.id,
        paymentId: updatedPayment.id,
        providerChargeId,
      },
      facts: {
        amountAppliedCents: updatedPayment.amountCents,
        newAmountPaidCents: newPaid,
        totalCents: invoice.totalCents || 0,
        fullyPaid,
        newStatus: fullyPaid ? "paid" : invoice.status,
      },
      timestamp: new Date(),
    });
  });
}

/**
 * payment_intent.payment_failed
 */
async function handlePaymentIntentFailed(pi) {
  const providerChargeId = pi.id;

  const payment = await prisma.payment.findFirst({
    where: { providerChargeId },
  });

  if (!payment) return;
  if (payment.status === "failed") return;

  const updated = await prisma.payment.update({
    where: { id: payment.id },
    data: {
      status: "failed",
      statusUpdatedAt: new Date(),
    },
  });

  // ✅ HOOK: payment failed
  emitSystemHook({
    type: "payment.failed",
    source: "stripe:webhook",
    entity: {
      paymentId: updated.id,
      invoiceId: updated.invoiceId || null,
      providerChargeId,
    },
    facts: {
      payerEmail: updated.payerEmail || null,
    },
    timestamp: new Date(),
  });
}

/**
 * Express route handler
 */
async function stripeWebhookExpressHandler(req, res) {
  const sig = req.headers["stripe-signature"];
  if (!sig) return res.status(400).send("Missing Stripe-Signature");

  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body, // RAW buffer
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case "payment_intent.succeeded":
        await handlePaymentIntentSucceeded(event.data.object);
        break;

      case "payment_intent.payment_failed":
        await handlePaymentIntentFailed(event.data.object);
        break;

      default:
        // ignore
        break;
    }

    return res.json({ received: true });
  } catch (e) {
    console.error("[stripe-webhook] error:", e);
    return res.status(500).send("Webhook handler failed");
  }
}

module.exports = { stripeWebhookExpressHandler };
