// index.js 

console.log("PerkValet backend loaded: pv-merchant-users-fix-v5");
require("dotenv").config();

const { createBillingPolicyStore } = require("./src/billing/billing.service");

const { registerPaymentsRoutes } = require("./src/payments/payments.routes");
const { registerPosRoutes } = require("./src/pos/pos.routes");

const { registerPosProvisioningRoutes } = require("./src/pos/pos.provisioning.routes");
const { buildDeviceRouter } = require("./src/auth/device.routes");

const { buildMerchantStoreProfileRouter } = require("./src/merchant/merchant.storeProfile.routes");
const fs = require("fs");
const { buildMerchantStoreTeamRouter } = require("./src/merchant/merchant.storeTeam.routes");
const { buildMerchantStoreQrRouter } = require("./src/merchant/merchant.storeQr.routes");
const path = require("path");
const { loadActiveQrWithStore } = require("./src/visits/visits.service");
const buildMerchantRouter = require("./src/merchant/merchant.routes");
const { buildVisitsRateLimiters } = require("./src/visits/visits.rateLimit");

const buildStoreRouter = require("./src/store/store.routes");
const buildVisitsRouter = require("./src/visits/visits.routes");

const QRCode = require("qrcode");
const crypto = require("crypto");
const express = require("express");
const cors = require("cors");

const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const { prisma } = require("./src/db/prisma");
const { normalizePhone } = require("./utils/phone");

const app = express();
const PORT = process.env.PORT ? Number(process.env.PORT) : 3001;

const NODE_ENV = process.env.NODE_ENV || "development";
const ADMIN_API_KEY = process.env.ADMIN_API_KEY || "";

const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-me";
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "15m";

// Optional: behind reverse proxy?
if (process.env.TRUST_PROXY === "1") {
  app.set("trust proxy", 1);
}

/* -----------------------------
   Helpers
-------------------------------- */

async function ensureBillingAccountForMerchant(merchantId) {
  // Try to derive a sensible billing email:
  // 1) owner/merchant_admin user email if present
  // 2) fallback to a safe dev placeholder
  const merchant = await prisma.merchant.findUnique({
    where: { id: merchantId },
    include: {
      merchantUsers: {
        include: { user: true },
      },
    },
  });

  const derivedEmail =
    merchant?.merchantUsers?.find((mu) => mu.role === "owner" && mu.user?.email)?.user?.email ||
    merchant?.merchantUsers?.find((mu) => mu.role === "merchant_admin" && mu.user?.email)?.user?.email ||
    merchant?.merchantUsers?.find((mu) => mu.user?.email)?.user?.email ||
    `billing+merchant${merchantId}@example.com`; // dev-safe fallback

  // merchantId is UNIQUE on BillingAccount, so upsert is perfect and race-safe
  return prisma.billingAccount.upsert({
    where: { merchantId },
    update: {}, // don't overwrite existing data
    create: {
      merchantId,
      billingEmail: derivedEmail,
      // provider/status use schema defaults
    },
  });
}

function sendError(res, httpStatus, code, message, extras) {
  const payload = { error: { code, message } };
  if (extras && typeof extras === "object") payload.error = { ...payload.error, ...extras };
  return res.status(httpStatus).json(payload);
}

function parseIntParam(value) {
  const n = Number(value);
  return Number.isInteger(n) ? n : null;
}

function getClientIp(req) {
  return req.ip || req.connection?.remoteAddress || "unknown";
}

function assertActiveMerchant(merchant) {
  if (!merchant) return { code: "MERCHANT_NOT_FOUND", message: "Merchant not found", http: 404 };
  if (merchant.status !== "active") {
    return { code: "MERCHANT_NOT_ACTIVE", message: `Merchant is ${merchant.status}`, http: 409 };
  }
  return null;
}

function assertActiveStore(store) {
  if (!store) return { code: "STORE_NOT_FOUND", message: "Store not found", http: 404 };
  if (store.status !== "active") {
    return { code: "STORE_NOT_ACTIVE", message: `Store is ${store.status}`, http: 409 };
  }
  return null;
}

function enforceStoreAndMerchantActive(storeWithMerchant) {
  const storeErr = assertActiveStore(storeWithMerchant);
  if (storeErr) return storeErr;

  const merchantErr = assertActiveMerchant(storeWithMerchant.merchant);
  if (merchantErr) return merchantErr;

  return null;
}

/* -----------------------------
   Thread P ? ShortPay (canonical /p/:code)

   Goals:
   - One human-friendly public entry point: /p/:code
   - Never expose long/hash tokens to end users
   - No schema changes

   Code format:
     <idBase62><sig>
     - idBase62: GuestPayToken.id base62
     - sig: 6 base62 chars derived from HMAC(idBase62)

   Env:
     SHORTPAY_SECRET (optional) falls back to JWT_SECRET
-------------------------------- */

const BASE62 = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

function base62Encode(num) {
  if (!Number.isSafeInteger(num) || num < 0) throw new Error("base62Encode: bad num");
  if (num === 0) return "0";
  let n = num;
  let out = "";
  while (n > 0) {
    out = BASE62[n % 62] + out;
    n = Math.floor(n / 62);
  }
  return out;
}

function base62Decode(str) {
  if (!str || typeof str !== "string") throw new Error("base62Decode: bad str");
  let n = 0;
  for (const ch of str) {
    const i = BASE62.indexOf(ch);
    if (i === -1) throw new Error("base62Decode: invalid char");
    n = n * 62 + i;
  }
  return n;
}

function shortpaySecret() {
  return process.env.SHORTPAY_SECRET || JWT_SECRET || "dev-secret-change-me";
}

function shortpaySign(idBase62) {
  const h = crypto.createHmac("sha256", shortpaySecret()).update(idBase62).digest();
  // 32 bits -> base62 -> fixed 6 chars
  const n = h.readUInt32BE(0);
  return base62Encode(n).slice(-6).padStart(6, "0");
}

function shortpayDecode(codeRaw) {
  const code = String(codeRaw || "").trim();
  if (code.length < 7 || code.length > 24) throw new Error("bad_code_length");

  const sig = code.slice(-6);
  const idPart = code.slice(0, -6);
  if (!idPart) throw new Error("bad_code_format");

  const expected = shortpaySign(idPart);
  if (sig !== expected) throw new Error("bad_code_sig");

  const tokenId = base62Decode(idPart);
  if (!Number.isSafeInteger(tokenId) || tokenId <= 0) throw new Error("bad_code_id");
  return tokenId;
}

function emitPvHook(event, extras = {}) {
  try {
    if (typeof globalThis.pvHook === "function") return globalThis.pvHook(event, extras);
  } catch {}
  if (process.env.PV_HOOKS_LOG === "1") {
    console.log(`[pvHook] ${event}`, extras);
  }
}

async function loadGuestPayTokenByIdOrRespond(res, tokenId) {
  const token = await prisma.guestPayToken.findUnique({
    where: { id: tokenId },
    include: {
      invoice: {
        include: {
          merchant: true,
          payments: true,
          lineItems: true,
        },
      },
    },
  });

  if (!token) {
    sendError(res, 404, "NOT_FOUND", "Pay link not found.");
    return null;
  }

  if (token.expiresAt && new Date(token.expiresAt).getTime() < Date.now()) {
    sendError(res, 410, "EXPIRED", "This pay link has expired.", { expiresAt: token.expiresAt });
    return null;
  }

  return token;
}

function isInvoicePaid(inv) {
  const s = String(inv?.status || "").toLowerCase();
  if (s === "paid") return true;
  // fallback: consider any succeeded payment as paid
  if (Array.isArray(inv?.payments)) {
    return inv.payments.some((p) => String(p?.status || "").toLowerCase() === "succeeded");
  }
  return false;
}

function buildShortPaySummary(token) {
  const inv = token.invoice;

  const amountCents =
    Number.isInteger(inv?.totalCents) ? inv.totalCents : Number.isInteger(inv?.amountCents) ? inv.amountCents : null;
  const amountPaidCents = Number.isInteger(inv?.amountPaidCents) ? inv.amountPaidCents : 0;

  return {
    token: {
      id: token.id,
      expiresAt: token.expiresAt || null,
      consumedAt: token.consumedAt || null,
    },
    invoice: {
      id: inv.id,
      status: inv.status || null,
      currency: inv.currency || "usd",
      totalCents: amountCents,
      amountPaidCents,
      merchantName: inv?.merchant?.name || null,
      paid: isInvoicePaid(inv),
      // Light summary for UX
      issuedAt: inv.issuedAt || null,
      dueAt: inv.dueAt || null,
      lineItems: Array.isArray(inv?.lineItems)
        ? inv.lineItems.map((li) => ({
            id: li.id,
            description: li.description || li.name || null,
            amountCents: li.amountCents ?? null,
            quantity: li.quantity ?? null,
          }))
        : [],
    },
  };
}

function pickIntentCreator(paymentsReg) {
  // Try a few common shapes; this avoids drift and keeps us reusing Thread O logic.
  const candidates = [
    paymentsReg?.createGuestPayIntent,
    paymentsReg?.guestPayCreateIntent,
    paymentsReg?.createPayIntent,
    paymentsReg?.publicCreateIntent,
    paymentsReg?.handlers?.createGuestPayIntent,
    paymentsReg?.handlers?.guestPayCreateIntent,
  ];
  return candidates.find((fn) => typeof fn === "function") || null;
}

/* -----------------------------
   Thread C1 helpers (password reset)
-------------------------------- */

function sha256Hex(input) {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function buildResetUrl(req, token) {
  // Point users to your Vite app route if provided
  const base = (process.env.ADMIN_WEB_BASE_URL || "").trim();
  if (base) return `${base.replace(/\/$/, "")}/reset-password?token=${encodeURIComponent(token)}`;

  // fallback: backend URL (still ok for stubbed email)
  const proto = req.headers["x-forwarded-proto"] || req.protocol;
  const host = req.headers["x-forwarded-host"] || req.get("host");
  return `${proto}://${host}/reset-password?token=${encodeURIComponent(token)}`;
}

/* -----------------------------
   Prisma error mapping
-------------------------------- */

function handlePrismaError(a, b, c) {
  let err;
  let res;

  if (a && typeof a.status === "function") {
    // old style: handlePrismaError(res, req, err)
    res = a;
    err = c;
  } else {
    // new style: handlePrismaError(err, res)
    err = a;
    res = b;
  }
  const code = err?.code;

  if (code === "P2002") {
    const target = err?.meta?.target;
    return sendError(res, 409, "UNIQUE_VIOLATION", "Unique constraint violation", target ? { target } : undefined);
  }

  if (code === "P2003") {
    const field = err?.meta?.field_name;
    return sendError(res, 409, "FK_VIOLATION", "Foreign key constraint violation", field ? { field } : undefined);
  }

  if (code === "P2025") {
    return sendError(res, 404, "NOT_FOUND", "Record not found");
  }

  return sendError(res, 400, "BAD_REQUEST", err?.message || "Request failed");
}

/* -----------------------------
   Admin auth (x-api-key)
-------------------------------- */

function requireAdmin(req, res, next) {
  /**
   * Blended admin auth (Option A):
   * - pv_admin authenticated via JWT may access admin routes without an admin API key.
   * - x-api-key remains valid for automation/scripts and non-interactive access.
   */
  if (req.userId && req.systemRole === "pv_admin") {
    return next();
  }

  if (NODE_ENV === "production" && !ADMIN_API_KEY) {
    return sendError(res, 500, "SERVER_MISCONFIG", "ADMIN_API_KEY is not configured in production");
  }

  // Dev convenience: if ADMIN_API_KEY is empty, skip (non-production only)
  if (!ADMIN_API_KEY) return next();

  const headerKey = req.headers["x-api-key"];
  const devQueryKey = req.query?.key;

  const okHeader = typeof headerKey === "string" && headerKey === ADMIN_API_KEY;
  const okDevQuery = NODE_ENV !== "production" && typeof devQueryKey === "string" && devQueryKey === ADMIN_API_KEY;

  if (okHeader || okDevQuery) return next();

  return sendError(res, 401, "UNAUTHORIZED", "Admin authorization required");
}

/* -----------------------------
   JWT auth (Thread C1: tokenVersion revocation)
-------------------------------- */

async function requireJwt(req, res, next) {
  const header = req.headers.authorization || "";
  const [type, token] = header.split(" ");

  if (type !== "Bearer" || !token) {
    return sendError(res, 401, "UNAUTHORIZED", "Missing Bearer token");
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET);

    const user = await prisma.user.findUnique({
      where: { id: payload.userId },
      select: { id: true, status: true, tokenVersion: true, systemRole: true },
    });

    if (!user) return sendError(res, 401, "UNAUTHORIZED", "Invalid or expired token");
    if (user.status && user.status !== "active") return sendError(res, 403, "FORBIDDEN", "User is not active");

    const currentTv = Number.isInteger(user.tokenVersion) ? user.tokenVersion : 0;
    const tokenTv = Number.isInteger(payload.tokenVersion) ? payload.tokenVersion : 0;

    if (tokenTv !== currentTv) {
      return sendError(res, 401, "UNAUTHORIZED", "Session revoked. Please sign in again.");
    }

    req.userId = user.id;
    req.systemRole = user.systemRole;
    return next();
  } catch {
    return sendError(res, 401, "UNAUTHORIZED", "Invalid or expired token");
  }
}

/* -----------------------------
   CORS
-------------------------------- */

function buildCorsOptions() {
  const raw = process.env.CORS_ORIGIN || "";
  const allowedOrigins = raw.split(",").map((s) => s.trim()).filter(Boolean);

  console.log("CORS allowedOrigins:", allowedOrigins.length ? allowedOrigins : "(open/dev)");

  if (!allowedOrigins.length) return { origin: true };

  return {
    origin(origin, callback) {
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      return callback(new Error(`CORS blocked for origin: ${origin}`));
    },
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "x-api-key",
      "x-idempotency-key",
      "x-pv-hook",
      "x-pv-testcase",
      "x-pos-timestamp",
      "x-pos-idempotency-key",
      "x-pos-nonce",
      "x-pos-signature",
      "x-pv-device-id",
    ],
    credentials: false,
  };
}

/* -----------------------------
   Rate limiting (in-memory) ? (fixes your crash)
-------------------------------- */

function createRateLimiter({ keyPrefix, windowMs, max }) {
  const buckets = new Map();

  return function rateLimit(req, res, next) {
    const ip = getClientIp(req);
    const key = `${keyPrefix}:${ip}`;
    const now = Date.now();

    let bucket = buckets.get(key);

    if (!bucket || now >= bucket.resetAt) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }

    bucket.count += 1;

    const remaining = Math.max(0, max - bucket.count);
    const resetInMs = bucket.resetAt - now;

    res.setHeader("X-RateLimit-Limit", String(max));
    res.setHeader("X-RateLimit-Remaining", String(remaining));
    res.setHeader("X-RateLimit-Reset", String(bucket.resetAt));

    if (bucket.count > max) {
      const retryAfterSec = Math.ceil(resetInMs / 1000);
      res.setHeader("Retry-After", String(retryAfterSec));
      return sendError(res, 429, "RATE_LIMITED", `Too many requests. Retry after ${retryAfterSec}s`);
    }

    next();
  };
}

const scanLimiter = createRateLimiter({
  keyPrefix: "scan",
  windowMs: Number(process.env.RL_SCAN_WINDOW_MS || 60_000),
  max: Number(process.env.RL_SCAN_MAX || 30),
});

const visitsWriteLimiter = createRateLimiter({
  keyPrefix: "visits_post",
  windowMs: Number(process.env.RL_VISITS_POST_WINDOW_MS || 60_000),
  max: Number(process.env.RL_VISITS_POST_MAX || 60),
});

/* -----------------------------
   Billing policy persistence
-------------------------------- */

const billingPolicyStore = createBillingPolicyStore({ fs, path, baseDir: __dirname });

const BILLING_POLICY_FILE = billingPolicyStore.BILLING_POLICY_FILE;
const DEFAULT_BILLING_POLICY = billingPolicyStore.DEFAULT_BILLING_POLICY;
const validateBillingPolicy = billingPolicyStore.validateBillingPolicy;
const saveBillingPolicyToDisk = billingPolicyStore.saveBillingPolicyToDisk;
let BILLING_POLICY = billingPolicyStore.loadBillingPolicyFromDisk();

/* -----------------------------
   Merchant overrides: effective policy
-------------------------------- */

function pickOverrideInt(overrides, key) {
  if (!overrides || typeof overrides !== "object") return null;
  const v = overrides[key];
  return Number.isInteger(v) ? v : null;
}

async function getMerchantPolicyBundle(merchantId) {
  const global = BILLING_POLICY;

  const acct = await prisma.billingAccount.findUnique({
    where: { merchantId },
    select: { id: true, merchantId: true, policyOverridesJson: true },
  });

  if (!acct) return { error: { http: 404, code: "BILLING_ACCOUNT_NOT_FOUND", message: "BillingAccount not found" } };

  const overrides = acct.policyOverridesJson || null;

  const effective = {
    ...global,
    graceDays: pickOverrideInt(overrides, "graceDays") ?? global.graceDays,
    lateFeeCents: pickOverrideInt(overrides, "lateFeeCents") ?? global.lateFeeCents,
    lateFeeNetDays: pickOverrideInt(overrides, "lateFeeNetDays") ?? global.lateFeeNetDays,
    guestPayTokenDays: pickOverrideInt(overrides, "guestPayTokenDays") ?? global.guestPayTokenDays,
    defaultNetTermsDays: pickOverrideInt(overrides, "defaultNetTermsDays") ?? global.defaultNetTermsDays,
  };

  if (!global.allowedNetTermsDays.includes(effective.defaultNetTermsDays)) {
    effective.defaultNetTermsDays = global.defaultNetTermsDays;
  }

  return { accountId: acct.id, merchantId: acct.merchantId, global, overrides, effective };
}

function validateOverrides(body, global) {
  if (body == null || typeof body !== "object") return { ok: false, msg: "Body must be an object" };
  if (body.clear === true) return { ok: true, overrides: null, clear: true };

  const o = {};
  const keys = ["graceDays", "lateFeeCents", "lateFeeNetDays", "guestPayTokenDays", "defaultNetTermsDays"];

  for (const k of keys) {
    if (body[k] === undefined || body[k] === null || body[k] === "") continue;

    const v = sanitizeInt(body[k]);
    if (v == null) return { ok: false, msg: `${k} must be an integer` };
    if (k === "graceDays" && v < 0) return { ok: false, msg: "graceDays must be >= 0" };
    if (k !== "graceDays" && v < 0) return { ok: false, msg: `${k} must be >= 0` };
    if (k === "lateFeeNetDays" && v < 1) return { ok: false, msg: "lateFeeNetDays must be >= 1" };
    if (k === "guestPayTokenDays" && v < 1) return { ok: false, msg: "guestPayTokenDays must be >= 1" };
    if (k === "defaultNetTermsDays" && !global.allowedNetTermsDays.includes(v)) {
      return { ok: false, msg: "defaultNetTermsDays must be one of allowedNetTermsDays (global)" };
    }
    o[k] = v;
  }

  return { ok: true, overrides: o };
}

/* -----------------------------
   Late fee helpers
-------------------------------- */

function addDays(date, days) {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

async function findExistingLateFeeInvoice(originalInvoiceId) {
  return prisma.invoice.findFirst({
    where: {
      relatedToInvoiceId: originalInvoiceId,
      lineItems: { some: { sourceType: "late_fee", sourceRefId: String(originalInvoiceId) } },
    },
    select: { id: true, status: true },
  });
}

function lateFeeEligibility(original, now, effectivePolicy) {
  if (!original) return { eligible: false, reason: "INVOICE_NOT_FOUND" };
  if (!(original.status === "issued" || original.status === "past_due"))
    return { eligible: false, reason: "NOT_ISSUED_OR_PAST_DUE" };
  if (!original.dueAt) return { eligible: false, reason: "MISSING_DUE_AT" };
  if (original.status === "paid" || original.status === "void")
    return { eligible: false, reason: "INVOICE_NOT_ELIGIBLE_STATUS" };
  if ((original.amountPaidCents || 0) >= (original.totalCents || 0))
    return { eligible: false, reason: "ALREADY_PAID" };

  const graceMs = (effectivePolicy.graceDays || 0) * 24 * 60 * 60 * 1000;
  if (now.getTime() <= new Date(original.dueAt).getTime() + graceMs)
    return { eligible: false, reason: "NOT_PAST_GRACE_PERIOD" };

  return { eligible: true };
}

function isLateFeeInvoice(inv) {
  return (
    Boolean(inv?.relatedToInvoiceId) &&
    Array.isArray(inv?.lineItems) &&
    inv.lineItems.some((li) => li.sourceType === "late_fee")
  );
}

/* -----------------------------
   Middleware
-------------------------------- */

// Build once so we can safely reuse for preflight OPTIONS.
const corsOptions = buildCorsOptions();

app.use(cors(corsOptions));

// Safe global OPTIONS handler (regex avoids path-to-regexp '*' crash).
app.options(/.*/, cors(corsOptions));

/*
 * ===============================
 * Thread J ? Payments & Guest Pay
 * ===============================
 * Stripe webhook MUST be mounted with express.raw BEFORE express.json,
 * otherwise signature verification will fail.
 */

const paymentsReg = registerPaymentsRoutes(app, {
  prisma,
  sendError,
  requireAuth: requireJwt,
  requireAdmin, // <-- add this
  publicBaseUrl: "http://localhost:3001",
});

app.post(
  "/webhooks/stripe",
  express.raw({ type: "application/json" }),
  paymentsReg.stripeWebhookHandler()
);

app.use(paymentsReg.router);


  // POS-2: POS API (JWT-only, POS-only)
  const posReg = registerPosRoutes(app, {
    prisma,
    sendError,
    requireAuth: requireJwt,
  });
  app.use(posReg.router);

  // PV-HOOK pos.routes.mounted tc=TC-POS-BOOT-01 sev=info stable=pos:router
  emitPvHook("pos.routes.mounted", { tc: "TC-POS-BOOT-01", sev: "info", stable: "pos:router" });

app.use(express.json());

/* -----------------------------
   PV API Request Logger
-------------------------------- */
function pvApiLog(req) {
  try {
    const ctx = {
      method: req.method,
      path: req.originalUrl,
      userId: req.user?.id || null,
      role: req.user?.systemRole || null,
      merchantId: req.user?.merchantId || null,
      storeId: req.user?.storeId || null,
      ts: new Date().toISOString()
    };
    console.log("\x1b[36m[PV API]\x1b[0m", JSON.stringify(ctx));
  } catch (err) {
    // never break request processing
  }
}

function pvApiLoggerMiddleware(req, res, next) {
  pvApiLog(req);
  next();
}

app.use(pvApiLoggerMiddleware);

app.post("/debug/json", (req, res) => {
  res.json({ body: req.body });
});

const posProvisioningReg = registerPosProvisioningRoutes(app, {
  prisma,
  sendError,
  handlePrismaError,
  parseIntParam,
  requireAdmin,
  emitPvHook,
  isPosOnlyMerchantUser,
  sha256Hex,
  JWT_SECRET,
  JWT_EXPIRES_IN,
  bcrypt,
  crypto,
  jwt,
});

app.use(posProvisioningReg.router);

/* -----------------------------
   Thread P ? Canonical ShortPay public endpoints
-------------------------------- */

app.get("/p/:code", async (req, res) => {
  emitPvHook("shortpay.loaded", { code: req.params.code });

  let tokenId;
  try {
    tokenId = shortpayDecode(req.params.code);
  } catch {
    return sendError(res, 404, "NOT_FOUND", "Pay link not found.");
  }

  try {
    const token = await loadGuestPayTokenByIdOrRespond(res, tokenId);
    if (!token) return;

    return res.json(buildShortPaySummary(token));
  } catch (e) {
    console.error("GET /p/:code failed:", e);
    return sendError(res, 500, "SERVER_ERROR", "Unable to load pay link.");
  }
});

app.post("/p/:code/intent", async (req, res) => {
  let tokenId;
  try {
    tokenId = shortpayDecode(req.params.code);
  } catch {
    return sendError(res, 404, "NOT_FOUND", "Pay link not found.");
  }

  try {
    const token = await loadGuestPayTokenByIdOrRespond(res, tokenId);
    if (!token) return;

    const summary = buildShortPaySummary(token);

    if (isInvoicePaid(token.invoice)) {
      emitPvHook("shortpay.intent_exists", { invoiceId: token.invoice.id, reason: "already_paid" });
      return sendError(res, 409, "ALREADY_PAID", "Invoice is already paid.");
    }

    const { amountCents: amountCentsRaw, payerEmail } = req.body || {};

    const invoiceTotal = summary.invoice.totalCents ?? summary.invoice.amountCents ?? null;
    const invoicePaid = summary.invoice.amountPaidCents ?? 0;
    const balanceDue = Number.isInteger(invoiceTotal)
      ? Math.max(0, invoiceTotal - (Number.isInteger(invoicePaid) ? invoicePaid : 0))
      : null;

    if (!Number.isInteger(balanceDue) || balanceDue <= 0) {
      emitPvHook("shortpay.intent_exists", { invoiceId: summary.invoice.id, reason: "no_balance_due" });
      return sendError(res, 409, "already_paid", "Invoice has no balance due.");
    }

    if (amountCentsRaw != null) {
      if (!Number.isInteger(amountCentsRaw) || amountCentsRaw <= 0) {
        return sendError(res, 400, "bad_request", "amountCents must be a positive integer when provided.");
      }
      if (amountCentsRaw !== balanceDue) {
        return sendError(res, 400, "bad_request", "amountCents does not match invoice balance due.");
      }
    }

    const amountCents = balanceDue;

    const createIntent = pickIntentCreator(paymentsReg);
    if (!createIntent) {
      console.error("ShortPay: no intent creator found on paymentsReg");
      return sendError(
        res,
        500,
        "SERVER_MISCONFIG",
        "Payments module does not expose a guest-pay intent creator. Add an exported helper in src/payments/payments.routes."
      );
    }

    const result = await createIntent({
      token,
      amountCents,
      payerEmail,
      req,
    });

    emitPvHook("shortpay.intent_created", { invoiceId: token.invoice.id, paymentId: result?.paymentId || null });
    return res.json(result);
  } catch (e) {
    const status = e?.status || e?.httpStatus || e?.http;
    const code = String(e?.code || "").toLowerCase();

    if (status === 409 || code.includes("intent_exists")) {
      emitPvHook("shortpay.intent_exists", { code: req.params.code });
      return sendError(res, 409, "INTENT_EXISTS", "Payment intent already exists.");
    }

    console.error("POST /p/:code/intent failed:", e);
    return sendError(res, 500, "SERVER_ERROR", "Unable to create payment intent.");
  }
});

/* -----------------------------
   Public routes
-------------------------------- */

app.get("/", (_req, res) => res.json({ status: "PerkValet backend running ?" }));

app.post("/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    const emailNorm = String(email || "").trim().toLowerCase();
    const passwordRaw = String(password || "");

    if (!emailNorm || !passwordRaw) {
      return sendError(res, 400, "VALIDATION_ERROR", "email and password are required");
    }

    // Use findMany (works even if Prisma client thinks email is not unique)
    const users = await prisma.user.findMany({
      where: { email: emailNorm },
      take: 1,
    });
    const user = Array.isArray(users) && users.length ? users[0] : null;

    if (!user) return sendError(res, 401, "UNAUTHORIZED", "Invalid credentials");
    if (user.status && user.status !== "active") return sendError(res, 403, "FORBIDDEN", "User is not active");

    const ok = await bcrypt.compare(passwordRaw, user.passwordHash);
    if (!ok) return sendError(res, 401, "UNAUTHORIZED", "Invalid credentials");

    const accessToken = jwt.sign({ userId: user.id, tokenVersion: user.tokenVersion ?? 0 }, JWT_SECRET, {
      expiresIn: JWT_EXPIRES_IN,
    });

    const landing = user.systemRole === "pv_admin" ? "/merchants" : "/merchant";
    return res.json({ accessToken, systemRole: user.systemRole, landing });
  } catch (err) {
    return handlePrismaError(err, res);
  }
});

/* -----------------------------
   POS-8C ? POS Provisioning + Quick Login (shift code ? JWT)

   Goals:
   - Support "sidecar" POS associates logging in fast with a short shift code
   - Support provisioning terminals and associates without DB migrations
   - Keep legacy POS-8A file-based associates mapping working (backward compatible)

   Endpoints:
   - POST /pos/provision            (ADMIN/x-api-key or pv_admin JWT)  -> provisions a terminal for a store (NDJSON/dashboard safe)
   - POST /pos/auth/provision       (ADMIN/x-api-key or pv_admin JWT)  -> provisions an associate shift code (storeId#pin)
   - POST /pos/auth/login           (public)                           -> exchanges code for a POS JWT

   Files (NOT committed):
   - .pos-terminals.json
   - .pos-shift-codes.json
   - .pos-associates.json (legacy POS-8A)

   Notes:
   - We store a PIN HASH on disk (never the raw PIN) and validate on login.
   - POS JWT embeds { pos:1, storeId, merchantId } for /pos/* endpoints.
-------------------------------- */

/* -----------------------------
   Device Trust (V1 minimal status)
   - Admin UI calls GET /auth/device/status after login
   - In this branch we treat local dev as always trusted.
   - Safe informational endpoint (no state changes)
-------------------------------- */
app.get("/auth/device/status", requireJwt, async (req, res) => {
  try {
    const deviceId = String(req.get("x-pv-device-id") || "").trim();
    const deviceIdShort = deviceId ? `${deviceId.slice(0, 8)}?` : null;

    emitPvHook("auth.device.status", {
      stable: "auth:device_status",
      ok: true,
      trusted: true,
      deviceIdShort,
      userId: req.user?.id ?? null,
      systemRole: req.user?.systemRole ?? null,
    });

    return res.json({
      ok: true,
      trusted: true,
      requiresDeviceVerification: false,
      deviceIdShort,
    });
  } catch (err) {
    emitPvHook("auth.device.status_error", {
      stable: "auth:device_status",
      ok: false,
      message: String(err?.message || err),
    });
    return sendError(res, 500, "INTERNAL_ERROR", "Device status failed");
  }
});



app.post("/auth/forgot-password", async (req, res) => {
  try {
    const { email } = req.body || {};
    const emailNorm = String(email || "").trim().toLowerCase();

    if (!emailNorm) return sendError(res, 400, "VALIDATION_ERROR", "email is required");

    const user = await prisma.user.findUnique({
      where: { email: emailNorm },
      select: { id: true, status: true },
    });

    const genericOk = { ok: true, message: "If an account exists, a reset email has been sent." };

    if (!user) return res.json(genericOk);
    if (user.status && user.status !== "active") return res.json(genericOk);

    const token = crypto.randomBytes(32).toString("hex");
    const pepper = process.env.RESET_TOKEN_PEPPER || JWT_SECRET;
    const tokenHash = sha256Hex(`${pepper}:${token}`);

    const minutes = Number(process.env.RESET_TOKEN_MINUTES || 45);
    const expiresAt = new Date(Date.now() + minutes * 60 * 1000);

    await prisma.passwordResetToken.create({
      data: { userId: user.id, tokenHash, expiresAt },
    });

    const resetUrl = buildResetUrl(req, token);

    console.log("[AUTH][EMAIL_STUB] password reset", {
      to: emailNorm,
      resetUrl,
      expiresAt: expiresAt.toISOString(),
    });

    return res.json(genericOk);
  } catch (err) {
    return handlePrismaError(err, res);
  }
});

app.post("/auth/reset-password", async (req, res) => {
  try {
    const { token, newPassword } = req.body || {};
    const tokenRaw = String(token || "").trim();
    const pw = String(newPassword || "");

    if (!tokenRaw || !pw) return sendError(res, 400, "VALIDATION_ERROR", "token and newPassword are required");
    if (pw.length < 10) return sendError(res, 400, "VALIDATION_ERROR", "Password must be at least 10 characters");

    const pepper = process.env.RESET_TOKEN_PEPPER || JWT_SECRET;
    const tokenHash = sha256Hex(`${pepper}:${tokenRaw}`);

    const prt = await prisma.passwordResetToken.findUnique({
      where: { tokenHash },
      include: { user: { select: { id: true, status: true } } },
    });

    if (!prt) return sendError(res, 400, "INVALID_TOKEN", "Invalid or expired token");
    if (prt.usedAt) return sendError(res, 400, "INVALID_TOKEN", "Invalid or expired token");
    if (new Date(prt.expiresAt).getTime() < Date.now())
      return sendError(res, 400, "INVALID_TOKEN", "Invalid or expired token");
    if (prt.user?.status && prt.user.status !== "active") return sendError(res, 403, "FORBIDDEN", "User is not active");

    const passwordHash = await bcrypt.hash(pw, 12);
    const now = new Date();

    await prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: prt.userId },
        data: {
          passwordHash,
          passwordUpdatedAt: now,
          tokenVersion: { increment: 1 },
        },
      });

      await tx.passwordResetToken.update({
        where: { id: prt.id },
        data: { usedAt: now },
      });
    });

    return res.json({ ok: true });
  } catch (err) {
    return handlePrismaError(err, res);
  }
});

app.post("/auth/change-password", requireJwt, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    const cur = String(currentPassword || "");
    const nextPw = String(newPassword || "");

    if (!cur || !nextPw)
      return sendError(res, 400, "VALIDATION_ERROR", "currentPassword and newPassword are required");
    if (nextPw.length < 10)
      return sendError(res, 400, "VALIDATION_ERROR", "Password must be at least 10 characters");

    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      select: { id: true, passwordHash: true, status: true },
    });

    if (!user) return sendError(res, 404, "NOT_FOUND", "User not found");
    if (user.status && user.status !== "active") return sendError(res, 403, "FORBIDDEN", "User is not active");

    const ok = await bcrypt.compare(cur, user.passwordHash);
    if (!ok) return sendError(res, 401, "UNAUTHORIZED", "Invalid current password");

    const passwordHash = await bcrypt.hash(nextPw, 12);
    const now = new Date();

    await prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash,
        passwordUpdatedAt: now,
        tokenVersion: { increment: 1 },
      },
    });

    return res.json({ ok: true });
  } catch (err) {
    return handlePrismaError(err, res);
  }
});

app.get("/me", requireJwt, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      select: {
        id: true,
        email: true,
        systemRole: true,
        status: true,
        merchantUsers: {
          select: {
            merchantId: true,
            role: true,
            status: true,
            merchant: {
              select: {
                id: true,
                name: true,
              },
            },
          },
        },
      },
    });

    if (!user) return sendError(res, 404, "NOT_FOUND", "User not found");

    const landing = user.systemRole === "pv_admin" ? "/merchants" : "/merchant";
    const merchantName =
      Array.isArray(user.merchantUsers) && user.merchantUsers.length
        ? user.merchantUsers[0]?.merchant?.name || null
        : null;

    return res.json({ user, memberships: user.merchantUsers, merchantName, landing });
  } catch (err) {
    return handlePrismaError(err, res);
  }
});

/* -----------------------------
   Public QR PNG
-------------------------------- */

/* -----------------------------
   Merchant portal (JWT only)
-------------------------------- */

function isPosOnlyMerchantUser(user) {
  // Treat as POS-only if the user has at least one active merchant membership
  // and ALL memberships are store_subadmin.
  const mus = Array.isArray(user?.merchantUsers) ? user.merchantUsers : [];
  if (!mus.length) return false;

  const roles = mus.map((m) => m?.role).filter(Boolean);
  if (!roles.length) return false;

  return roles.every((r) => r === "store_subadmin");
}

/**
 * Thread U ? Merchant user management helpers
 */
function canManageUsersForMerchant(user, merchantId) {
  const mus = Array.isArray(user?.merchantUsers) ? user.merchantUsers : [];
  const m = mus.find((x) => x.status === "active" && x.merchantId === merchantId);
  if (!m) return false;
  return m.role === "owner" || m.role === "merchant_admin";
}

function canAccessInvoicesForMerchant(user, merchantId) {
  const mus = Array.isArray(user?.merchantUsers) ? user.merchantUsers : [];
  const m = mus.find((x) => x.status === "active" && x.merchantId === merchantId);
  if (!m) return false;
  return m.role === "owner" || m.role === "merchant_admin" || m.role === "ap_clerk";
}

function normalizeRole(role) {
  const r = String(role || "").trim();
  const allowed = ["owner", "merchant_admin", "ap_clerk", "merchant_employee", "store_admin", "store_subadmin"];
  return allowed.includes(r) ? r : null;
}

function normalizeMemberStatus(status) {
  const s = String(status || "").trim();
  const allowed = ["active", "suspended"];
  return allowed.includes(s) ? s : null;
}

async function requireMerchantUserManager(req, res, merchantId) {
  const user = await prisma.user.findUnique({
    where: { id: req.userId },
    select: {
      id: true,
      systemRole: true,
      merchantUsers: {
        where: { status: "active" },
        select: { merchantId: true, role: true, status: true },
      },
    },
  });

  if (!user) {
    sendError(res, 404, "NOT_FOUND", "User not found");
    return null;
  }
  if (user.systemRole === "pv_admin") {
    sendError(res, 403, "FORBIDDEN", "pv_admin does not use merchant portal");
    return null;
  }
  if (isPosOnlyMerchantUser(user)) {
    sendError(res, 403, "FORBIDDEN", "POS associates cannot manage users");
    return null;
  }
  if (!canManageUsersForMerchant(user, merchantId)) {
    sendError(res, 403, "FORBIDDEN", "Not authorized to manage users for this merchant");
    return null;
  }

  return user;
}

app.use(
  buildMerchantRouter({
    prisma,
    requireJwt,
    requireAdmin,
    sendError,
    handlePrismaError,
    parseIntParam,
    emitPvHook,
    requireMerchantUserManager,
    normalizeRole,
    normalizeMemberStatus,
    crypto,
    bcrypt,
    isPosOnlyMerchantUser,
    canAccessInvoicesForMerchant,
  })
);

app.use(
  buildMerchantStoreTeamRouter({
    prisma,
    requireJwt,
    sendError,
    handlePrismaError,
  })
);


app.use(
  buildMerchantStoreQrRouter({
    prisma,
    requireJwt,
    sendError,
    handlePrismaError,
    parseIntParam,
    crypto,
    QRCode,
    emitPvHook,
    isPosOnlyMerchantUser,
    publicBaseUrl: "http://localhost:3001",
  })
);

const buildAdminRouter = require("./src/admin/admin.routes");

app.use(
  requireJwt,
  buildAdminRouter({
    prisma,
    requireAdmin,
    sendError,
    handlePrismaError,
    parseIntParam,
    validateBillingPolicy,
    saveBillingPolicyToDisk,
    BILLING_POLICY,
    ensureBillingAccountForMerchant,
    lateFeeEligibility,
    findExistingLateFeeInvoice,
    getMerchantPolicyBundle,
    validateOverrides,
  })
);

app.get("/whoami", requireAdmin, async (req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return res.json({
      nodeEnv: NODE_ENV,
      adminKeyEnabled: Boolean(ADMIN_API_KEY),
      serverTime: new Date().toISOString(),
      ipSeenAs: getClientIp(req),
      db: "ok",
    });
  } catch (err) {
    return sendError(res, 500, "DB_ERROR", err?.message || "DB check failed");
  }
});

app.use(
  buildStoreRouter({
    prisma,
    sendError,
    handlePrismaError,
    parseIntParam,
    crypto,
    enforceStoreAndMerchantActive,
  })
);

/* -----------------------------
   Visits + Scan (rate-limited)
-------------------------------- */

app.use(
  buildVisitsRouter({
    prisma,
    sendError,
    handlePrismaError,
   loadActiveQrWithStore: (token) => loadActiveQrWithStore(prisma, token),
    enforceStoreAndMerchantActive,
    normalizePhone,
    visitsWriteLimiter,
    scanLimiter,
  })
);

/* -----------------------------
   Server
-------------------------------- */

app.listen(PORT, () => {
  console.log(`PerkValet backend listening on http://localhost:${PORT}`);
  console.log(`NODE_ENV=${NODE_ENV}`);
  console.log(`ADMIN_API_KEY ${ADMIN_API_KEY ? "ENABLED" : "DISABLED (set ADMIN_API_KEY to protect admin routes)"}`);
  console.log(`CORS_ORIGIN=${process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN : "(open/dev)"}`);
  console.log(`BILLING_POLICY_FILE=${BILLING_POLICY_FILE}`);
});
