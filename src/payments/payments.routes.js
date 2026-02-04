// backend/src/payments/payments.routes.js
const express = require("express");
const crypto = require("crypto");
const { mintRawToken, sha256Hex, computeGuestTokenExpiry, now } = require("./guestToken");
const { createPaymentIntent, retrievePaymentIntent, verifyWebhook } = require("./stripe");
const { ensureActiveGuestPayToken } = require("../billing/guestPayToken.service");
const { sendPaymentReceiptEmail } = require("../jobs/paymentReceiptMail.job");

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

function registerPaymentsRoutes(app, { prisma, sendError, requireAuth, requireAdmin, publicBaseUrl }) {
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

  // ---------- ShortPay helpers (NO-MIGRATIONS) ----------
  // Build a stable public pay URL without exposing raw tokens.
  // Uses SHORTPAY_SECRET to produce /p/:code from GuestPayToken.id (base62 + HMAC).
  const SHORTPAY_SECRET = String(process.env.SHORTPAY_SECRET || "").trim();
  const BASE62 = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

  function base62Encode(num) {
    const n0 = Number(num);
    if (!Number.isFinite(n0) || n0 < 0) throw new Error("bad_num");
    if (n0 === 0) return "0";
    let n = Math.floor(n0);
    let out = "";
    while (n > 0) {
      out = BASE62[n % 62] + out;
      n = Math.floor(n / 62);
    }
    return out;
  }

  function hmacSig6(idPart, secret) {
    const h = crypto.createHmac("sha256", Buffer.from(String(secret || ""), "utf8"));
    h.update(Buffer.from(String(idPart || ""), "utf8"));
    const digest = h.digest();
    const u =
      (((digest[0] << 24) | (digest[1] << 16) | (digest[2] << 8) | digest[3]) >>> 0) >>> 0;
    return base62Encode(u).slice(-6).padStart(6, "0");
  }

  function buildShortPayCodeFromTokenId(tokenId) {
    const idNum = Number(tokenId);
    if (!Number.isInteger(idNum) || idNum <= 0) return "";
    if (!SHORTPAY_SECRET) return "";
    const idPart = base62Encode(idNum);
    const sig = hmacSig6(idPart, SHORTPAY_SECRET);
    return `${idPart}${sig}`;
  }

  function buildPayUrlFromTokenId(tokenId) {
    const code = buildShortPayCodeFromTokenId(tokenId);
    if (!code) return "";
    return `${PUBLIC_BASE}/p/${encodeURIComponent(code)}`;
  }

  // IMPORTANT: backend uses this exact name in handlers
  function isActiveGuestPayToken(tok) {
    if (!tok) return false;
    if (tok.usedAt) return false;
    if (tok.expiresAt && tok.expiresAt.getTime() < Date.now()) return false;
    return true;
  }

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
    if (token && typeof token === "object") {
      t = token;
    }

    // ShortPay path: caller passes guestPayTokenId (and invoiceId for cross-check)
    if (!t && guestPayTokenId != null) {
      const id = Number(guestPayTokenId);
      if (!Number.isInteger(id) || id <= 0) {
        const err = new Error("Token not found");
        err.status = 404;
        err.code = "NOT_FOUND";
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
        const err = new Error("Token not found");
        err.status = 404;
        err.code = "NOT_FOUND";
        throw err;
      }
    }

    // Legacy path: caller passes raw token string (either tokenRaw or token as string)
    if (!t) {
      const raw =
        typeof token === "string" && token.trim()
          ? token.trim()
          : typeof tokenRaw === "string"
          ? tokenRaw.trim()
          : "";
      if (raw) {
        const tokenHash = sha256Hex(raw);
        t = await prisma.guestPayToken.findUnique({
          where: { tokenHash },
          include: {
            invoice: {
              include: {
                billingAccount: { select: { providerCustomerId: true } },
                merchant: { select: { id: true, name: true } },
              },
            },
          },
        });
      }
    }

    if (!t) {
      const err = new Error("Token not found");
      err.status = 404;
      err.code = "NOT_FOUND";
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

  // Resume: return existing clientSecret instead of blocking with 409.
  try {
    const resumed = await retrievePaymentIntent({ intentId: existing.providerChargeId });

    if (!resumed?.clientSecret) {
      const err = new Error("Unable to resume payment session (missing clientSecret)");
      err.status = 500;
      err.code = "RESUME_FAILED";
      throw err;
    }
    // PV-HOOK billing.payment_intent.resumed tc=TC-PAY-07 sev=info stable=stripe_pi:<intentId>
    pvHook("billing.payment_intent.resumed", {
      tc: "TC-PAY-07",
      sev: "info",
      stable: `stripe_pi:${resumed.intentId}`,
      intentId: resumed.intentId,
      paymentId: existing.id,
      invoiceId: invoice.id,
      amountCents: due,
      source: "guest_pay",
      status: resumed.status || null,
    });

    return {
      paymentId: existing.id,
      provider: "stripe",
      clientSecret: resumed.clientSecret,
      reused: true,
      intentId: resumed.intentId,
    };
  } catch (e) {
    // PV-HOOK billing.payment_intent.resume_failed tc=TC-PAY-08 sev=error stable=stripe_pi:<intentId>
    pvHook("billing.payment_intent.resume_failed", {
      tc: "TC-PAY-08",
      sev: "error",
      stable: `stripe_pi:${existing.providerChargeId || "unknown"}`,
      intentId: existing.providerChargeId || null,
      paymentId: existing.id,
      invoiceId: invoice.id,
      amountCents: due,
      source: "guest_pay",
      error: e?.message || String(e),
    });

    const err = new Error("Unable to resume payment session");
    err.status = 500;
    err.code = "RESUME_FAILED";
    throw err;
  }
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
     ADMIN: Guest Pay Token (Billing-Security-1)
     ========================================================= */

  // POST /admin/invoices/:invoiceId/guest-pay-token
  // IDP: returns existing active token if present; otherwise mints a new one.
  // POST /admin/invoices/:invoiceId/guest-pay-token
  // IDP: returns existing active token if present; otherwise mints a new one.
  router.post("/admin/invoices/:invoiceId/guest-pay-token", requireAdminOrFail, async (req, res) => {
    try {
      const invoiceId = Number(req.params.invoiceId);
      if (!Number.isInteger(invoiceId) || invoiceId <= 0) {
        return sendError(res, 400, "bad_request", "Invalid invoiceId");
      }

      const result = await ensureActiveGuestPayToken({
        prisma,
        invoiceId,
        publicBaseUrl: PUBLIC_BASE,
        forceRotate: false,
      });

      if (result && result.idempotent) {
        // PV-HOOK billing.guest_token.idempotent_returned tc=TC-GPT-10 sev=info stable=invoice:<invoiceId>
        pvHook("billing.guest_token.idempotent_returned", {
          tc: "TC-GPT-10",
          sev: "info",
          stable: `invoice:${invoiceId}`,
          invoiceId,
          tokenId: result.tokenId,
          expiresAt: result.expiresAt || null,
        });

        return res.json(result);
      }

      // PV-HOOK billing.guest_token.minted tc=TC-GPT-01 sev=info stable=invoice:<invoiceId>
      pvHook("billing.guest_token.minted", {
        tc: "TC-GPT-01",
        sev: "info",
        stable: `invoice:${invoiceId}`,
        invoiceId,
        tokenId: result.tokenId,
        expiresAt: result.expiresAt,
        mode: "mint",
        payUrlKind: result.payUrlKind || null,
      });

      return res.json(result);
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

  // POST /admin/invoices/:invoiceId/guest-pay-token/regenerate
  // Explicit rotation: revoke any existing unused tokens and mint a fresh one.
  // POST /admin/invoices/:invoiceId/guest-pay-token/regenerate
  // Explicit rotation: revoke any existing unused tokens and mint a fresh one.
  router.post("/admin/invoices/:invoiceId/guest-pay-token/regenerate", requireAdminOrFail, async (req, res) => {
    try {
      const invoiceId = Number(req.params.invoiceId);
      if (!Number.isInteger(invoiceId) || invoiceId <= 0) {
        return sendError(res, 400, "bad_request", "Invalid invoiceId");
      }

      const result = await ensureActiveGuestPayToken({
        prisma,
        invoiceId,
        publicBaseUrl: PUBLIC_BASE,
        forceRotate: true,
      });

      // PV-HOOK billing.guest_token.regenerated tc=TC-GPT-11 sev=warn stable=invoice:<invoiceId>
      pvHook("billing.guest_token.regenerated", {
        tc: "TC-GPT-11",
        sev: "warn",
        stable: `invoice:${invoiceId}`,
        invoiceId,
        tokenId: result.tokenId,
        revokedCount: result.revokedCount || 0,
        expiresAt: result.expiresAt,
        payUrlKind: result.payUrlKind || null,
      });

      return res.json(result);
    } catch (e) {
      pvHook("billing.guest_token.regenerate_failed", {
        tc: "TC-GPT-12",
        sev: "error",
        stable: `invoice:${req.params.invoiceId || "unknown"}`,
        error: e?.message || String(e),
      });
      return sendError(res, 500, "server_error", e?.message || "Error");
    }
  });

  // GET /admin/invoices/:invoiceId/guest-pay-token (metadata only)
  router.get("/admin/invoices/:invoiceId/guest-pay-token", requireAdminOrFail, async (req, res) => {
    try {
      const invoiceId = Number(req.params.invoiceId);
      if (!Number.isInteger(invoiceId) || invoiceId <= 0) {
        return sendError(res, 400, "bad_request", "Invalid invoiceId");
      }

      const tok = await prisma.guestPayToken.findFirst({
        where: { invoiceId, usedAt: null },
        orderBy: { createdAt: "desc" },
        select: { id: true, createdAt: true, expiresAt: true, usedAt: true },
      });

      const active = Boolean(tok && isActiveGuestPayToken(tok));

      return res.json({
        invoiceId,
        active,
        tokenId: tok?.id || null,
        createdAt: tok?.createdAt ? tok.createdAt.toISOString() : null,
        expiresAt: tok?.expiresAt ? tok.expiresAt.toISOString() : null,
        payUrl: active && tok ? buildPayUrlFromTokenId(tok.id) || null : null,
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

            // THREAD M: append-only payment allocation (idempotent)
            await tx.paymentAllocation.createMany({
              data: [
                {
                  paymentId: payment.id,
                  invoiceId: inv.id,
                  amountCents: payment.amountCents || 0,
                },
              ],
              skipDuplicates: true,
            });

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

          // Mail-Flow-5: Payment receipt email (env-guarded; non-blocking)
          if (PAYMENT_RECEIPT_ENABLED) {
            try {
              await sendPaymentReceiptEmail({
                prisma,
                paymentId: payment.id,
                publicBaseUrl: PUBLIC_BASE,
                dryRun: PAYMENT_RECEIPT_DRY_RUN,
              });
              // PV-HOOK billing.receipt_email.queued tc=TC-REC-01 sev=info stable=payment:<paymentId>
              pvHook("billing.receipt_email.queued", {
                tc: "TC-REC-01",
                sev: "info",
                stable: `payment:${payment.id}`,
                paymentId: payment.id,
                invoiceId: payment.invoiceId,
                dryRun: PAYMENT_RECEIPT_DRY_RUN ? 1 : 0,
              });
            } catch (e) {
              // PV-HOOK billing.receipt_email.failed tc=TC-REC-02 sev=error stable=payment:<paymentId>
              pvHook("billing.receipt_email.failed", {
                tc: "TC-REC-02",
                sev: "error",
                stable: `payment:${payment.id}`,
                paymentId: payment.id,
                invoiceId: payment.invoiceId,
                error: e?.message || String(e),
              });
            }
          } else {
            // PV-HOOK billing.receipt_email.disabled tc=TC-REC-00 sev=info stable=payment:<paymentId>
            pvHook("billing.receipt_email.disabled", {
              tc: "TC-REC-00",
              sev: "info",
              stable: `payment:${payment.id}`,
              paymentId: payment.id,
              invoiceId: payment.invoiceId,
            });
          }

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
