/* eslint-disable no-console */
require("dotenv").config();

const crypto = require("crypto");

// IMPORTANT: reuse app Prisma singleton (adapter-configured)
const { prisma } = require("../src/db/prisma");

function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function truthy(v) {
  return v === "1" || v === "true" || v === "yes";
}

function pickAmountCents(invoice) {
  return (
    invoice.amountCents ??
    invoice.totalCents ??
    invoice.totalAmountCents ??
    invoice.balanceCents ??
    100
  );
}

function loadReceiptSender() {
  // Prefer the job’s public function export.
  // If you renamed the export, adjust exportName here.
  const candidates = [
    { path: "../src/jobs/paymentReceiptMail.job", exportName: "sendPaymentReceiptEmail" },
    { path: "../src/jobs/paymentReceiptMail.job.js", exportName: "sendPaymentReceiptEmail" },
  ];

  for (const c of candidates) {
    try {
      // eslint-disable-next-line global-require, import/no-dynamic-require
      const mod = require(c.path);
      const fn = mod?.[c.exportName] || mod?.default?.[c.exportName] || mod?.default;
      if (typeof fn === "function") return { fn, from: c.path };
    } catch {
      // keep trying
    }
  }

  throw new Error(
    "Could not load sendPaymentReceiptEmail() — check export in src/jobs/paymentReceiptMail.job.js"
  );
}

async function main() {
  // Guardrails
  mustEnv("DATABASE_URL"); // used by src/db/prisma.js
  mustEnv("PUBLIC_BASE_URL");

  if (!truthy(process.env.PAYMENT_RECEIPT_ENABLED)) {
    throw new Error("PAYMENT_RECEIPT_ENABLED must be truthy (set to 1)");
  }

  const { fn: sendPaymentReceiptEmail, from: senderFrom } = loadReceiptSender();

  console.log("mail_flow_5_smoke_start", {
    ts: new Date().toISOString(),
    dryRun: truthy(process.env.PAYMENT_RECEIPT_DRY_RUN),
    senderLoadedFrom: senderFrom,
    publicBaseUrl: process.env.PUBLIC_BASE_URL,
  });

  // 1) Find an existing invoice
  const invoice = await prisma.invoice.findFirst({ orderBy: { id: "desc" } });

  if (!invoice) {
    console.error("NO INVOICE FOUND. Create one via `npx prisma studio` and rerun.");
    process.exit(2);
  }

  console.log("invoice_found", { invoiceId: invoice.id });

  // 2) Create Payment succeeded
  const payerEmail = process.env.TEST_PAYER_EMAIL || "billing+merchant@example.com";
  const providerChargeId = "ch_smoke_" + crypto.randomBytes(8).toString("hex") + "_" + Date.now();

  let payment;
  try {
    payment = await prisma.payment.create({
      data: {
        invoiceId: invoice.id,
        payerEmail,
        amountCents: pickAmountCents(invoice),
        providerChargeId,
        status: "succeeded",
        statusUpdatedAt: new Date(),
      },
    });
  } catch (err) {
    console.error("PAYMENT CREATE FAILED:", err?.message || err);
    console.error(
      [
        "",
        "This means your Payment model has additional REQUIRED fields.",
        "Paste the Prisma error message and I’ll tell you the minimal fields to add.",
      ].join("\n")
    );
    process.exit(3);
  }

  console.log("payment_created", { paymentId: payment.id, providerChargeId });

  // 3) Call receipt sender twice (idempotency)
  const args = {
    prisma,
    paymentId: payment.id,
    publicBaseUrl: process.env.PUBLIC_BASE_URL,
    dryRun: truthy(process.env.PAYMENT_RECEIPT_DRY_RUN),
  };

  console.log("receipt_attempt_1");
  await sendPaymentReceiptEmail(args);
  console.log("receipt_attempt_1_done");

  console.log("receipt_attempt_2");
  await sendPaymentReceiptEmail(args);
  console.log("receipt_attempt_2_done");

  console.log("mail_flow_5_smoke_done", { paymentId: payment.id });

  // Safe cleanup for a one-off script
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error("mail_flow_5_smoke_fatal", err?.stack || err);
  process.exit(1);
});
