// backend/src/payments/stripe.js
const Stripe = require("stripe");

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name}`);
  return v;
}

function getStripe() {
  const key = requireEnv("STRIPE_SECRET_KEY");
  return new Stripe(key, {
    apiVersion: process.env.STRIPE_API_VERSION || "2024-06-20",
  });
}

/**
 * Create a PaymentIntent and return { intentId, clientSecret, status }.
 *
 * V1 policy:
 * - Cards only (no redirect-based payment methods)
 * - Confirmation happens client-side via Stripe.js using clientSecret
 */
async function createPaymentIntent({
  amountCents,
  currency = "usd",
  customerId,
  metadata = {},
  idempotencyKey,
}) {
  const stripe = getStripe();

  const params = {
    amount: amountCents,
    currency,
    metadata,

    // V1: cards only (avoids return_url + redirect flows)
    payment_method_types: ["card"],
  };

  if (customerId) params.customer = customerId;

  const intent = await stripe.paymentIntents.create(
    params,
    idempotencyKey ? { idempotencyKey } : undefined
  );

  return {
    intentId: intent.id,
    clientSecret: intent.client_secret,
    status: intent.status,
  };
}

/**
 * Verify Stripe webhook signature and return event.
 * Caller must pass raw body Buffer and Stripe-Signature header.
 */
function verifyWebhook({ rawBody, signatureHeader }) {
  const stripe = getStripe();
  const secret = requireEnv("STRIPE_WEBHOOK_SECRET");

  console.log(
    "[STRIPE][WEBHOOK] sigHeader?",
    Boolean(signatureHeader),
    "whsec..." + secret.slice(-6),
    "rawBodyIsBuffer?",
    Buffer.isBuffer(rawBody)
  );

  return stripe.webhooks.constructEvent(rawBody, signatureHeader, secret);
}

async function retrievePaymentIntent(intentId) {
  const stripe = getStripe();
  const intent = await stripe.paymentIntents.retrieve(intentId);
  return {
    intentId: intent.id,
    clientSecret: intent.client_secret,
    status: intent.status,
  };
}

module.exports = {
  createPaymentIntent,
  retrievePaymentIntent,
  verifyWebhook,
};
