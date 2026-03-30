// backend/src/payments/payments.routes.js
const express = require("express");
const { mintRawToken, sha256Hex, computeGuestTokenExpiry, now } = require("./guestToken");
const { createPaymentIntent, retrievePaymentIntent, verifyWebhook } = require("./stripe");

/**
 * Payments + Guest Pay routes (NO-MIGRATIONS MODE)
 *
 * CURRENT SCHEMA NOTES (confirmed):
 * - GuestPayToken: tokenHash, expiresAt, usedAt, createdAt
 * - Payment: invoiceId, amountCents, status, providerChargeId (stores Stripe PaymentIntent.id),
 *            payerEmail, paymentMethodId?, createdAt, statusUpdatedAt
 * - Invoice: status, totalCents, amountPaidCents
 *
 * IMPORTANT ORDERING NOTE:
 * - This module returns a router that uses express.json().
 * - Therefore: in index.js you MUST mount the Stripe webhook (express.raw) BEFORE mounting this router.
 *
 * Hooking standard:
 * - Comment anchors: // PV-HOOK <domain>.<event> tc=<TC-ID> sev=<...> stable=<...>
 * - Runtime hooks: pvHook("<domain>.<event>", {...fields})
 */

/**
 * pvHook: structured JSON log line for ops/support/chatbot + easy grepping.
 * Safe by design: MUST NOT throw.
 */
function pvHook(event, fields = {}) {
  try {
    console.log(
      JSON.stringify({
        pvHook: event,
        ts: new Date().toISOString(),
        ...fields,
      })
    );
  } catch {
    // never break runtime for logging
  }
}

function registerPaymentsRoutes(app, { prisma, sendError, requireAuth, requireAdmin, publicBaseUrl, requireJwt }) {
  // requireJwt may be passed directly or fall back to requireAuth (same function, different name)
  if (!requireJwt) requireJwt = requireAuth;
  if (!app) throw new Error("registerPaymentsRoutes: app required");
  if (!prisma) throw new Error("registerPaymentsRoutes: prisma required");
  if (!sendError) throw new Error("registerPaymentsRoutes: sendError required");

  const router = express.Router();

  // NOTE: This JSON parser is fine ONLY if the webhook route is mounted BEFORE this router.
  router.use(express.json());

  const PUBLIC_BASE = String(publicBaseUrl || process.env.PUBLIC_BASE_URL || "http://localhost:3001").replace(
    /\/$/,
    ""
  );

  // ---------- helpers ----------
  function amountDueCents(invoice) {
    const due = (invoice.totalCents || 0) - (invoice.amountPaidCents || 0);
    return Math.max(0, due);
  }

  function isInvoicePayable(invoice) {
    if (!invoice) return false;
    if (invoice.status === "void") return false;
    if (invoice.status === "paid") return false;
    return amountDueCents(invoice) > 0;
  }

  async function loadInvoiceForPay(invoiceId) {
    return prisma.invoice.findUnique({
      where: { id: Number(invoiceId) },
      include: {
        merchant: { select: { id: true, name: true } },
        billingAccount: { select: { id: true, providerCustomerId: true } },
      },
    });
  }

  function requireAdminOrFail(req, res, next) {
    if (typeof requireAdmin !== "function") {
      return sendError(res, 500, "server_misconfig", "requireAdmin middleware not provided");
    }
    return requireAdmin(req, res, next);
  }

  /**
   * Canonical Guest Pay intent creator (exported via return object)
   *
   * Used by:
   * - POST /pay/:token/intent (raw long token)
   * - Thread P ShortPay: POST /p/:code/intent (short code resolved to GuestPayToken)
   *
   * Contract: returns { paymentId, provider, clientSecret }
   * Throws Error with { status: 409, code: "INTENT_EXISTS" } for idempotency collisions.
   */
  async function createGuestPayIntent({ token, tokenRaw, guestPayTokenId, invoiceId, amountCents, payerEmail, req }) {
    // Canonical guest-pay intent creator, reusable by:
    // - POST /pay/:token/intent (legacy raw long token)
    // - POST /p/:code/intent (ShortPay; passes guestPayTokenId + invoiceId)
    // - any internal caller that already has a loaded token record

    let t = null;

    // Preferred: caller passes a loaded GuestPayToken record
    if (token && typeof token === 'object') {
      t = token;
    }

    // ShortPay path: caller passes guestPayTokenId (and invoiceId for cross-check)
    if (!t && guestPayTokenId != null) {
      const id = Number(guestPayTokenId);
      if (!Number.isInteger(id) || id <= 0) {
        const err = new Error('Token not found');
        err.status = 404;
        err.code = 'NOT_FOUND';
        throw err;
      }
      t = await prisma.guestPayToken.findUnique({
        where: { id },
        include: {
          invoice: {
            include: {
              billingAccount: { select: { providerCustomerId: true } },
              merchant: { select: { id: true, name: true } },
            },
          },
        },
      });

      // Optional sanity check when invoiceId provided
      if (t && invoiceId != null && t.invoice && Number(invoiceId) !== Number(t.invoice.id)) {
        const err = new Error('Token not found');
        err.status = 404;
        err.code = 'NOT_FOUND';
        throw err;
      }
    }

    // Legacy path: caller passes raw token string (either tokenRaw or token as string)
    if (!t) {
      const raw = (typeof token === 'string' && token.trim()) ? token.trim() : (typeof tokenRaw === 'string' ? tokenRaw.trim() : '');
      if (raw) {
        const tokenHash = sha256Hex(raw);
        t = await prisma.guestPayToken.findUnique({
          where: { tokenHash },
          include: {
            invoice: {
              include: { billingAccount: { select: { providerCustomerId: true } }, merchant: { select: { id: true, name: true } } },
            },
          },
        });
      }
    }

    if (!t) {
      const err = new Error('Token not found');
      err.status = 404;
      err.code = 'NOT_FOUND';
      throw err;
    }

    // Standardize on variable name used below
    token = t;

    if (token.usedAt) {
      const err = new Error("This payment link was already used");
      err.status = 410;
      err.code = "GONE";
      throw err;
    }

    if (token.expiresAt && token.expiresAt.getTime() < Date.now()) {
      const err = new Error("This payment link expired");
      err.status = 410;
      err.code = "GONE";
      throw err;
    }

    // Ensure invoice is present + has billingAccount providerCustomerId (if available)
    let invoice = token.invoice || null;
    if (!invoice) {
      const err = new Error("Invoice not found");
      err.status = 404;
      err.code = "NOT_FOUND";
      throw err;
    }

    if (!invoice.billingAccount) {
      // ShortPay loader in index.js might not include billingAccount; fetch minimal fields.
      const inv = await prisma.invoice.findUnique({
        where: { id: invoice.id },
        include: { billingAccount: { select: { providerCustomerId: true } } },
      });
      if (inv) invoice = { ...invoice, billingAccount: inv.billingAccount };
    }

    if (!isInvoicePayable(invoice)) {
      const err = new Error("Invoice is not payable");
      err.status = 409;
      err.code = "NOT_PAYABLE";
      throw err;
    }

    const due = amountDueCents(invoice);
    const requested = Number(amountCents);
    if (!Number.isFinite(requested)) {
      const err = new Error("amountCents required");
      err.status = 400;
      err.code = "BAD_REQUEST";
      throw err;
    }
    if (requested !== due) {
      const err = new Error("Guest pay must pay full amount due");
      err.status = 400;
      err.code = "BAD_REQUEST";
      throw err;
    }

    const email = payerEmail ? String(payerEmail).trim() : null;

    // Thread O.1 idempotency guard: if we already created a pending PI, reject duplicates.
    const existing = await prisma.payment.findFirst({
      where: {
        invoiceId: invoice.id,
        amountCents: due,
        status: "pending",
        providerChargeId: { not: null },
      },
      orderBy: { createdAt: "desc" },
      select: { id: true, providerChargeId: true, createdAt: true },
    });

    if (existing) {
      // PV-HOOK billing.payment_intent.duplicate tc=TC-PAY-03 sev=warn stable=invoice:<invoiceId>
      pvHook("billing.payment_intent.duplicate", {
        tc: "TC-PAY-03",
        sev: "warn",
        stable: `invoice:${invoice.id}`,
        invoiceId: invoice.id,
        amountCents: due,
        source: "guest_pay",
        existingPaymentId: existing.id,
        existingIntentId: existing.providerChargeId,
        existingCreatedAt: existing.createdAt ? new Date(existing.createdAt).toISOString() : null,
      });

      // Try to return the existing clientSecret so the frontend can reuse the PaymentIntent
      try {
        const { clientSecret, status } = await retrievePaymentIntent(existing.providerChargeId);
        if (clientSecret && status !== "succeeded" && status !== "canceled") {
          return res.json({ clientSecret, reused: true });
        }
      } catch {
        // Stripe retrieve failed — fall through to 409
      }

      const err = new Error(
        "A payment session already exists for this invoice. Please refresh the page."
      );
      err.status = 409;
      err.code = "INTENT_EXISTS";
      throw err;
    }

    // Create Payment row
    const payment = await prisma.payment.create({
      data: {
        invoiceId: invoice.id,
        amountCents: due,
        status: "pending",
        payerEmail: email,
        statusUpdatedAt: now(),
      },
    });

    // Create Stripe PaymentIntent
    const { intentId, clientSecret } = await createPaymentIntent({
      amountCents: due,
      currency: "usd",
      customerId: invoice.billingAccount?.providerCustomerId || undefined,
      metadata: {
        pv_paymentId: String(payment.id),
        pv_invoiceId: String(invoice.id),
        pv_source: "guest_pay",
      },
    });

    // Store intentId in providerChargeId
    await prisma.payment.update({
      where: { id: payment.id },
      data: {
        providerChargeId: intentId,
        status: "pending",
        statusUpdatedAt: now(),
      },
    });

    // PV-HOOK billing.payment_intent.created tc=TC-PAY-01 sev=info stable=stripe_pi:<intentId>
    pvHook("billing.payment_intent.created", {
      tc: "TC-PAY-01",
      sev: "info",
      stable: `stripe_pi:${intentId}`,
      intentId,
      paymentId: payment.id,
      invoiceId: invoice.id,
      amountCents: due,
      source: "guest_pay",
    });

    return { paymentId: payment.id, provider: "stripe", clientSecret };
  }

  /* =========================================================
     ADMIN: Mint Guest Pay Token (Step 2)
     ========================================================= */

  // POST /admin/invoices/:invoiceId/guest-pay-token
  router.post("/admin/invoices/:invoiceId/guest-pay-token", requireJwt, requireAdminOrFail, async (req, res) => {
    try {
      const invoiceId = Number(req.params.invoiceId);
      if (!Number.isInteger(invoiceId) || invoiceId <= 0) {
        return sendError(res, 400, "bad_request", "Invalid invoiceId");
      }

      const inv = await prisma.invoice.findUnique({
        where: { id: invoiceId },
        select: { id: true, status: true, dueAt: true, totalCents: true, amountPaidCents: true },
      });

      if (!inv) return sendError(res, 404, "not_found", "Invoice not found");

      // Only for payable, issued invoices
      if (!(inv.status === "issued" || inv.status === "past_due")) {
        return sendError(res, 409, "not_issuable", "Token can be minted only for issued or past_due invoices");
      }
      if (!isInvoicePayable(inv)) {
        return sendError(res, 409, "not_payable", "Invoice is not payable");
      }

      const raw = mintRawToken(32);
      const tokenHash = sha256Hex(raw);
      const expiresAt = computeGuestTokenExpiry({ dueAt: inv.dueAt });

      // Invalidate existing active tokens by marking usedAt (no revokedAt yet)
      await prisma.guestPayToken.updateMany({
        where: { invoiceId: inv.id, usedAt: null },
        data: { usedAt: now() },
      });

      await prisma.guestPayToken.create({
        data: { invoiceId: inv.id, tokenHash, expiresAt },
      });

      const payUrl = `${PUBLIC_BASE}/pay/${encodeURIComponent(raw)}`;

      // PV-HOOK billing.guest_token.minted tc=TC-GPT-01 sev=info stable=invoice:<invoiceId>
      pvHook("billing.guest_token.minted", {
        tc: "TC-GPT-01",
        sev: "info",
        stable: `invoice:${inv.id}`,
        invoiceId: inv.id,
        expiresAt: expiresAt.toISOString(),
      });

      return res.json({
        invoiceId: inv.id,
        token: raw,
        payUrl,
        expiresAt: expiresAt.toISOString(),
      });
    } catch (e) {
      // PV-HOOK billing.guest_token.mint_failed tc=TC-GPT-02 sev=error stable=invoice:<invoiceId>
      pvHook("billing.guest_token.mint_failed", {
        tc: "TC-GPT-02",
        sev: "error",
        stable: `invoice:${req.params.invoiceId || "unknown"}`,
        error: e?.message || String(e),
      });
      return sendError(res, 500, "server_error", e?.message || "Error");
    }
  });

  // GET /admin/invoices/:invoiceId/guest-pay-token (metadata only)
  router.get("/admin/invoices/:invoiceId/guest-pay-token", requireJwt, requireAdminOrFail, async (req, res) => {
    try {
      const invoiceId = Number(req.params.invoiceId);
      if (!Number.isInteger(invoiceId) || invoiceId <= 0) {
        return sendError(res, 400, "bad_request", "Invalid invoiceId");
      }

      const tok = await prisma.guestPayToken.findFirst({
        where: { invoiceId, usedAt: null },
        orderBy: { createdAt: "desc" },
        select: { id: true, createdAt: true, expiresAt: true },
      });

      return res.json({
        invoiceId,
        active: Boolean(tok),
        tokenId: tok?.id || null,
        createdAt: tok?.createdAt ? tok.createdAt.toISOString() : null,
        expiresAt: tok?.expiresAt ? tok.expiresAt.toISOString() : null,
      });
    } catch (e) {
      return sendError(res, 500, "server_error", e?.message || "Error");
    }
  });

  /* =========================================================
     GUEST PAY: GET summary
     ========================================================= */

  router.get("/pay/:token", async (req, res) => {
    try {
      const rawToken = String(req.params.token || "");
      if (!rawToken) return sendError(res, 400, "bad_request", "Missing token");

      const tokenHash = sha256Hex(rawToken);

      const token = await prisma.guestPayToken.findUnique({
        where: { tokenHash },
        include: { invoice: { include: { merchant: { select: { name: true } } } } },
      });

      if (!token) return sendError(res, 404, "not_found", "Invalid or expired payment link");
      if (token.usedAt) return sendError(res, 410, "gone", "This payment link was already used");
      if (token.expiresAt && token.expiresAt.getTime() < Date.now()) {
        return sendError(res, 410, "gone", "This payment link expired");
      }

      const inv = token.invoice;
      if (!inv) return sendError(res, 404, "not_found", "Invoice not found");

      return res.json({
        merchantName: inv.merchant?.name || "Merchant",
        invoiceId: inv.id,
        externalInvoiceId: inv.externalInvoiceId || null,
        currency: "USD",
        totalCents: inv.totalCents,
        amountPaidCents: inv.amountPaidCents,
        amountDueCents: amountDueCents(inv),
        dueAt: inv.dueAt,
        status: inv.status,
      });
    } catch (e) {
      return sendError(res, 500, "server_error", e?.message || "Error");
    }
  });

  /* =========================================================
     GUEST PAY: POST create intent (PAY IN FULL ONLY)
     ========================================================= */

  router.post("/pay/:token/intent", async (req, res) => {
    try {
      const rawToken = String(req.params.token || "");
      if (!rawToken) return sendError(res, 400, "bad_request", "Missing token");

      const tokenHash = sha256Hex(rawToken);

      const token = await prisma.guestPayToken.findUnique({
        where: { tokenHash },
        include: { invoice: { include: { billingAccount: { select: { providerCustomerId: true } } } } },
      });

      if (!token) return sendError(res, 404, "not_found", "Invalid or expired payment link");
      if (token.usedAt) return sendError(res, 410, "gone", "This payment link was already used");
      if (token.expiresAt && token.expiresAt.getTime() < Date.now()) {
        return sendError(res, 410, "gone", "This payment link expired");
      }

      const invoice = token.invoice;
      if (!invoice) return sendError(res, 404, "not_found", "Invoice not found");
      if (!isInvoicePayable(invoice)) return sendError(res, 409, "not_payable", "Invoice is not payable");

      const due = amountDueCents(invoice);

      const requested = Number(req.body?.amountCents);
      if (!Number.isFinite(requested)) return sendError(res, 400, "bad_request", "amountCents required");
      if (requested !== due) return sendError(res, 400, "bad_request", "Guest pay must pay full amount due");

      const payerEmail = req.body?.payerEmail ? String(req.body.payerEmail).trim() : null;

      // Thread O.1: Idempotency guard.
      // No migrations: use existing Payment rows as the gate.
      // If we already created a pending Stripe PI for this invoice+amount, reject duplicates with 409.
      const existing = await prisma.payment.findFirst({
        where: {
          invoiceId: invoice.id,
          amountCents: due,
          status: "pending",
          providerChargeId: { not: null },
        },
        orderBy: { createdAt: "desc" },
        select: { id: true, providerChargeId: true, createdAt: true },
      });

      if (existing) {
        // PV-HOOK billing.payment_intent.duplicate tc=TC-PAY-03 sev=warn stable=invoice:<invoiceId>
        pvHook("billing.payment_intent.duplicate", {
          tc: "TC-PAY-03",
          sev: "warn",
          stable: `invoice:${invoice.id}`,
          invoiceId: invoice.id,
          amountCents: due,
          source: "guest_pay",
          existingPaymentId: existing.id,
          existingIntentId: existing.providerChargeId,
          existingCreatedAt: existing.createdAt ? new Date(existing.createdAt).toISOString() : null,
        });

        // Try to return the existing clientSecret so the frontend can reuse the PaymentIntent
        try {
          const { clientSecret, status } = await retrievePaymentIntent(existing.providerChargeId);
          if (clientSecret && status !== "succeeded" && status !== "canceled") {
            return res.json({ clientSecret, reused: true });
          }
        } catch {
          // Stripe retrieve failed — fall through to 409
        }

        return sendError(
          res,
          409,
          "intent_exists",
          "A payment session already exists for this invoice. Please refresh the page."
        );
      }

      // Create Payment row
      const payment = await prisma.payment.create({
        data: {
          invoiceId: invoice.id,
          amountCents: due,
          status: "pending",
          payerEmail,
          statusUpdatedAt: now(),
        },
      });

      // Create Stripe PaymentIntent
      const { intentId, clientSecret } = await createPaymentIntent({
        amountCents: due,
        currency: "usd",
        customerId: invoice.billingAccount?.providerCustomerId || undefined,
        metadata: {
          pv_paymentId: String(payment.id),
          pv_invoiceId: String(invoice.id),
          pv_source: "guest_pay",
        },
      });

      // Store intentId in providerChargeId
      await prisma.payment.update({
        where: { id: payment.id },
        data: {
          providerChargeId: intentId,
          status: "pending",
          statusUpdatedAt: now(),
        },
      });

      // PV-HOOK billing.payment_intent.created tc=TC-PAY-01 sev=info stable=stripe_pi:<intentId>
      pvHook("billing.payment_intent.created", {
        tc: "TC-PAY-01",
        sev: "info",
        stable: `stripe_pi:${intentId}`,
        intentId,
        paymentId: payment.id,
        invoiceId: invoice.id,
        amountCents: due,
        source: "guest_pay",
      });

      return res.json({ paymentId: payment.id, provider: "stripe", clientSecret });
    } catch (e) {
      // PV-HOOK billing.payment_intent.create_failed tc=TC-PAY-02 sev=error stable=guest_token:<tokenHash>
      pvHook("billing.payment_intent.create_failed", {
        tc: "TC-PAY-02",
        sev: "error",
        stable: `guest_token:${sha256Hex(String(req.params.token || ""))}`,
        error: e?.message || String(e),
      });
      return sendError(res, 500, "server_error", e?.message || "Error");
    }
  });

  /* =========================================================
     MERCHANT-AUTH PAY: POST create intent (PARTIAL OK)
     ========================================================= */

  router.post("/payments/intent", requireAuth, async (req, res) => {
    try {
      const invoiceId = Number(req.body?.invoiceId);
      const amountCents = Number(req.body?.amountCents);

      if (!Number.isFinite(invoiceId)) return sendError(res, 400, "bad_request", "invoiceId required");
      if (!Number.isFinite(amountCents) || amountCents <= 0) {
        return sendError(res, 400, "bad_request", "amountCents must be > 0");
      }

      const inv = await loadInvoiceForPay(invoiceId);
      if (!inv) return sendError(res, 404, "not_found", "Invoice not found");
      if (!isInvoicePayable(inv)) return sendError(res, 409, "not_payable", "Invoice is not payable");

      const due = amountDueCents(inv);
      if (amountCents > due) return sendError(res, 400, "bad_request", "amountCents exceeds amount due");

      const payerEmail = req.body?.payerEmail ? String(req.body.payerEmail).trim() : null;

      const payment = await prisma.payment.create({
        data: {
          invoiceId: inv.id,
          amountCents,
          status: "pending",
          payerEmail,
          statusUpdatedAt: now(),
        },
      });

      const { intentId, clientSecret } = await createPaymentIntent({
        amountCents,
        currency: "usd",
        customerId: inv.billingAccount?.providerCustomerId || undefined,
        metadata: {
          pv_paymentId: String(payment.id),
          pv_invoiceId: String(inv.id),
          pv_source: "merchant_auth",
        },
      });

      await prisma.payment.update({
        where: { id: payment.id },
        data: {
          providerChargeId: intentId,
          statusUpdatedAt: now(),
        },
      });

      // PV-HOOK billing.payment_intent.created tc=TC-PAY-01 sev=info stable=stripe_pi:<intentId>
      pvHook("billing.payment_intent.created", {
        tc: "TC-PAY-01",
        sev: "info",
        stable: `stripe_pi:${intentId}`,
        intentId,
        paymentId: payment.id,
        invoiceId: inv.id,
        amountCents,
        source: "merchant_auth",
      });

      return res.json({ paymentId: payment.id, provider: "stripe", clientSecret });
    } catch (e) {
      // PV-HOOK billing.payment_intent.create_failed tc=TC-PAY-02 sev=error stable=invoice:<invoiceId>
      pvHook("billing.payment_intent.create_failed", {
        tc: "TC-PAY-02",
        sev: "error",
        stable: `invoice:${String(req.body?.invoiceId || "unknown")}`,
        error: e?.message || String(e),
      });
      return sendError(res, 500, "server_error", e?.message || "Error");
    }
  });

  /* =========================================================
     STRIPE WEBHOOK HANDLER (mounted in index.js with express.raw)
     ========================================================= */

  function stripeWebhookHandler() {
    return async (req, res) => {
      const sig = req.headers["stripe-signature"];
      if (!sig) return sendError(res, 400, "bad_request", "Missing Stripe signature header");

      let event;
      try {
        event = verifyWebhook({ rawBody: req.body, signatureHeader: sig });
      } catch (e) {
        // PV-HOOK billing.webhook.signature_failed tc=TC-WH-01 sev=warn stable=stripe_sig:missing_or_invalid
        pvHook("billing.webhook.signature_failed", {
          tc: "TC-WH-01",
          sev: "warn",
          stable: "stripe_sig:missing_or_invalid",
          error: e?.message || String(e),
        });
        return sendError(res, 400, "webhook_sig_error", e?.message || "Invalid Stripe signature");
      }

      const obj = event.data?.object;
      const intentId = obj?.id;
      if (!intentId) return res.status(200).json({ received: true });

      try {
        const payment = await prisma.payment.findFirst({
          where: { providerChargeId: intentId },
          select: { id: true, status: true, invoiceId: true, amountCents: true },
        });

        if (!payment) {
          // PV-HOOK billing.webhook.unmatched_intent tc=TC-WH-02 sev=info stable=stripe_pi:<intentId>
          pvHook("billing.webhook.unmatched_intent", {
            tc: "TC-WH-02",
            sev: "info",
            stable: `stripe_pi:${intentId}`,
            intentId,
            type: event.type,
          });
          return res.status(200).json({ received: true });
        }

        if (event.type === "payment_intent.succeeded") {
          // PV-HOOK billing.webhook.payment_succeeded tc=TC-PAY-04 sev=info stable=stripe_pi:<intentId>
          pvHook("billing.webhook.payment_succeeded", {
            tc: "TC-PAY-04",
            sev: "info",
            stable: `stripe_pi:${intentId}`,
            intentId,
            paymentId: payment.id,
            invoiceId: payment.invoiceId,
          });

          // Atomic idempotency gate: only process once
          const updated = await prisma.payment.updateMany({
            where: { id: payment.id, status: { not: "succeeded" } },
            data: { status: "succeeded", statusUpdatedAt: now() },
          });

          if (updated.count === 0) return res.status(200).json({ received: true });

          await prisma.$transaction(async (tx) => {
            const inv = await tx.invoice.findUnique({
              where: { id: payment.invoiceId },
              select: { id: true, status: true, totalCents: true, amountPaidCents: true },
            });
            if (!inv) return;

            // No reconciliation into draft/void invoices
            if (inv.status === "void" || inv.status === "draft") return;

            const newPaid = (inv.amountPaidCents || 0) + (payment.amountCents || 0);
            const fullyPaid = newPaid >= (inv.totalCents || 0);

            // PV-HOOK billing.invoice.payment_applied tc=TC-INV-03 sev=info stable=invoice:<invoiceId>
            pvHook("billing.invoice.payment_applied", {
              tc: "TC-INV-03",
              sev: "info",
              stable: `invoice:${inv.id}`,
              invoiceId: inv.id,
              paymentId: payment.id,
              appliedCents: payment.amountCents,
              newPaid,
              totalCents: inv.totalCents || 0,
            });

            await tx.invoice.update({
              where: { id: inv.id },
              data: {
                amountPaidCents: newPaid,
                status: fullyPaid ? "paid" : inv.status,
              },
            });

            if (fullyPaid) {
              // PV-HOOK billing.invoice.marked_paid tc=TC-INV-04 sev=info stable=invoice:<invoiceId>
              pvHook("billing.invoice.marked_paid", {
                tc: "TC-INV-04",
                sev: "info",
                stable: `invoice:${inv.id}`,
                invoiceId: inv.id,
              });
            }

            // Cleanup stale pending attempts by marking them FAILED (not provider failure)
            // PV-HOOK billing.payment_attempts.cleaned tc=TC-PAY-06 sev=info stable=invoice:<invoiceId>
            const cleaned = await tx.payment.updateMany({
              where: {
                invoiceId: inv.id,
                status: "pending",
                id: { not: payment.id },
              },
              data: {
                status: "failed",
                statusUpdatedAt: now(),
              },
            });

            if (cleaned.count > 0) {
              pvHook("billing.payment_attempts.cleaned", {
                tc: "TC-PAY-06",
                sev: "info",
                stable: `invoice:${inv.id}`,
                invoiceId: inv.id,
                keptPaymentId: payment.id,
                cleanedCount: cleaned.count,
                cleanedStatus: "failed",
                reason: "superseded_by_successful_payment",
              });
            }

            // Mark any unused tokens for invoice as used (best-effort, no-migrations mode)
            const used = await tx.guestPayToken.updateMany({
              where: { invoiceId: inv.id, usedAt: null },
              data: { usedAt: now() },
            });

            if (used.count > 0) {
              // PV-HOOK billing.guest_token.used tc=TC-GPT-03 sev=info stable=invoice:<invoiceId>
              pvHook("billing.guest_token.used", {
                tc: "TC-GPT-03",
                sev: "info",
                stable: `invoice:${inv.id}`,
                invoiceId: inv.id,
                count: used.count,
              });
            }
          });

          return res.status(200).json({ received: true });
        }

        if (event.type === "payment_intent.payment_failed") {
          // PV-HOOK billing.webhook.payment_failed tc=TC-PAY-05 sev=warn stable=stripe_pi:<intentId>
          pvHook("billing.webhook.payment_failed", {
            tc: "TC-PAY-05",
            sev: "warn",
            stable: `stripe_pi:${intentId}`,
            intentId,
            paymentId: payment.id,
            invoiceId: payment.invoiceId,
          });

          // Don't downgrade succeeded payments
          if (payment.status !== "succeeded") {
            await prisma.payment.update({
              where: { id: payment.id },
              data: { status: "failed", statusUpdatedAt: now() },
            });
          }
          return res.status(200).json({ received: true });
        }

        return res.status(200).json({ received: true });
      } catch (e) {
        // PV-HOOK billing.webhook.handler_error tc=TC-WH-03 sev=error stable=stripe_pi:<intentId>
        pvHook("billing.webhook.handler_error", {
          tc: "TC-WH-03",
          sev: "error",
          stable: `stripe_pi:${intentId}`,
          intentId,
          type: event.type,
          error: e?.message || String(e),
        });
        return res.status(200).json({ received: true });
      }
    };
  }

  // IMPORTANT: do NOT app.use(router) here. Return it so index.js can mount it AFTER webhook.
  // Thread P: expose canonical guest-pay intent creator so /p/:code can reuse it.
  return { stripeWebhookHandler, router, createGuestPayIntent };
}

module.exports = { registerPaymentsRoutes };
