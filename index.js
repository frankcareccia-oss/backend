require("dotenv").config();

const { registerPaymentsRoutes } = require("./src/payments/payments.routes");
const fs = require("fs");
const path = require("path");

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

async function loadActiveQrWithStore(token) {
  return prisma.storeQr.findFirst({
    where: { token, status: "active" },
    include: { store: { include: { merchant: true } } },
  });
}

function enforceStoreAndMerchantActive(storeWithMerchant) {
  const storeErr = assertActiveStore(storeWithMerchant);
  if (storeErr) return storeErr;

  const merchantErr = assertActiveMerchant(storeWithMerchant.merchant);
  if (merchantErr) return merchantErr;

  return null;
}

/* -----------------------------
   Thread P — ShortPay (canonical /p/:code)

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

function handlePrismaError(err, res) {
  const code = err?.code;

  if (code === "P2002") {
    const target = err?.meta?.target;
    return sendError(
      res,
      409,
      "UNIQUE_VIOLATION",
      "Unique constraint violation",
      target ? { target } : undefined
    );
  }

  if (code === "P2003") {
    const field = err?.meta?.field_name;
    return sendError(
      res,
      409,
      "FK_VIOLATION",
      "Foreign key constraint violation",
      field ? { field } : undefined
    );
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
  if (NODE_ENV === "production" && !ADMIN_API_KEY) {
    return sendError(res, 500, "SERVER_MISCONFIG", "ADMIN_API_KEY is not configured in production");
  }

  // Dev convenience: if ADMIN_API_KEY is empty, skip
  if (!ADMIN_API_KEY) return next();

  const headerKey = req.headers["x-api-key"];
  const devQueryKey = req.query?.key;

  const okHeader = typeof headerKey === "string" && headerKey === ADMIN_API_KEY;
  const okDevQuery =
    NODE_ENV !== "production" && typeof devQueryKey === "string" && devQueryKey === ADMIN_API_KEY;

  if (okHeader || okDevQuery) return next();

  return sendError(res, 401, "UNAUTHORIZED", "Missing or invalid admin API key");
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
      select: { id: true, status: true, tokenVersion: true },
    });

    if (!user) return sendError(res, 401, "UNAUTHORIZED", "Invalid or expired token");
    if (user.status && user.status !== "active") return sendError(res, 403, "FORBIDDEN", "User is not active");

    const currentTv = Number.isInteger(user.tokenVersion) ? user.tokenVersion : 0;
    const tokenTv = Number.isInteger(payload.tokenVersion) ? payload.tokenVersion : 0;

    if (tokenTv !== currentTv) {
      return sendError(res, 401, "UNAUTHORIZED", "Session revoked. Please sign in again.");
    }

    req.userId = user.id;
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
    allowedHeaders: ["Content-Type", "x-api-key", "Authorization"],
    credentials: false,
  };
}

/* -----------------------------
   Rate limiting (in-memory) ✅ (fixes your crash)
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

const BILLING_POLICY_FILE = path.join(__dirname, ".billing-policy.json");

function loadBillingPolicyFromDisk() {
  try {
    if (!fs.existsSync(BILLING_POLICY_FILE)) return null;
    const raw = fs.readFileSync(BILLING_POLICY_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (e) {
    console.warn("⚠️ Failed to load billing policy from disk:", e?.message || e);
    return null;
  }
}

function saveBillingPolicyToDisk(policyObj) {
  try {
    fs.writeFileSync(BILLING_POLICY_FILE, JSON.stringify(policyObj, null, 2), "utf-8");
    return true;
  } catch (e) {
    console.warn("⚠️ Failed to save billing policy to disk:", e?.message || e);
    return false;
  }
}

const DEFAULT_BILLING_POLICY = {
  graceDays: 5,
  lateFeeCents: 1500,
  lateFeeNetDays: 7,
  guestPayTokenDays: 7,
  allowedNetTermsDays: [15, 30, 45],
  defaultNetTermsDays: 30,
  updatedAt: new Date().toISOString(),
};

let BILLING_POLICY = normalizeLoadedBillingPolicy(loadBillingPolicyFromDisk());

function sanitizeInt(n) {
  return Number.isInteger(n) ? n : null;
}

function validateBillingPolicy(body) {
  const graceDays = sanitizeInt(body.graceDays);
  const lateFeeCents = sanitizeInt(body.lateFeeCents);
  const lateFeeNetDays = sanitizeInt(body.lateFeeNetDays);
  const guestPayTokenDays = sanitizeInt(body.guestPayTokenDays);
  const allowedNetTermsDays = Array.isArray(body.allowedNetTermsDays)
    ? body.allowedNetTermsDays.map((x) => sanitizeInt(x)).filter((x) => x != null)
    : null;
  const defaultNetTermsDays = sanitizeInt(body.defaultNetTermsDays);

  if (graceDays == null || graceDays < 0) return { ok: false, msg: "graceDays must be an integer >= 0" };
  if (lateFeeCents == null || lateFeeCents < 0) return { ok: false, msg: "lateFeeCents must be an integer >= 0" };
  if (lateFeeNetDays == null || lateFeeNetDays < 1) return { ok: false, msg: "lateFeeNetDays must be an integer >= 1" };
  if (guestPayTokenDays == null || guestPayTokenDays < 1) return { ok: false, msg: "guestPayTokenDays must be an integer >= 1" };

  if (!allowedNetTermsDays || !allowedNetTermsDays.length) {
    return { ok: false, msg: "allowedNetTermsDays must be a non-empty array of integers" };
  }

  const uniq = Array.from(new Set(allowedNetTermsDays)).sort((a, b) => a - b);
  if (uniq.some((x) => x < 1)) return { ok: false, msg: "allowedNetTermsDays values must be >= 1" };

  if (defaultNetTermsDays == null) return { ok: false, msg: "defaultNetTermsDays must be an integer" };
  if (!uniq.includes(defaultNetTermsDays)) return { ok: false, msg: "defaultNetTermsDays must be a member of allowedNetTermsDays" };

  return {
    ok: true,
    policy: {
      graceDays,
      lateFeeCents,
      lateFeeNetDays,
      guestPayTokenDays,
      allowedNetTermsDays: uniq,
      defaultNetTermsDays,
      updatedAt: new Date().toISOString(),
    },
  };
}



function isIsoString(s) {
  return typeof s === "string" && !Number.isNaN(new Date(s).getTime());
}

function normalizeLoadedBillingPolicy(raw) {
  // Tolerate older/partial files; merge onto defaults, then validate.
  if (!raw || typeof raw !== "object") return DEFAULT_BILLING_POLICY;

  const merged = {
    graceDays: raw.graceDays ?? DEFAULT_BILLING_POLICY.graceDays,
    lateFeeCents: raw.lateFeeCents ?? DEFAULT_BILLING_POLICY.lateFeeCents,
    lateFeeNetDays: raw.lateFeeNetDays ?? DEFAULT_BILLING_POLICY.lateFeeNetDays,
    guestPayTokenDays: raw.guestPayTokenDays ?? DEFAULT_BILLING_POLICY.guestPayTokenDays,
    allowedNetTermsDays: raw.allowedNetTermsDays ?? DEFAULT_BILLING_POLICY.allowedNetTermsDays,
    defaultNetTermsDays: raw.defaultNetTermsDays ?? DEFAULT_BILLING_POLICY.defaultNetTermsDays,
    updatedAt: isIsoString(raw.updatedAt) ? raw.updatedAt : DEFAULT_BILLING_POLICY.updatedAt,
  };

  const v = validateBillingPolicy(merged);
  if (!v.ok) {
    console.warn("⚠️ Invalid billing policy on disk; using defaults:", v.msg);
    return DEFAULT_BILLING_POLICY;
  }

  // validateBillingPolicy stamps updatedAt=now; for disk-loaded policy we prefer the file timestamp
  return { ...v.policy, updatedAt: merged.updatedAt };
}

/* -----------------------------
   Merchant overrides: effective policy
   NOTE: requires BillingAccount.policyOverridesJson Json?
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
  if (!(original.status === "issued" || original.status === "past_due")) return { eligible: false, reason: "NOT_ISSUED_OR_PAST_DUE" };
  if (!original.dueAt) return { eligible: false, reason: "MISSING_DUE_AT" };
  if (original.status === "paid" || original.status === "void") return { eligible: false, reason: "INVOICE_NOT_ELIGIBLE_STATUS" };
  if ((original.amountPaidCents || 0) >= (original.totalCents || 0)) return { eligible: false, reason: "ALREADY_PAID" };

  const graceMs = (effectivePolicy.graceDays || 0) * 24 * 60 * 60 * 1000;
  if (now.getTime() <= new Date(original.dueAt).getTime() + graceMs) return { eligible: false, reason: "NOT_PAST_GRACE_PERIOD" };

  return { eligible: true };
}

function isLateFeeInvoice(inv) {
  return Boolean(inv?.relatedToInvoiceId) && Array.isArray(inv?.lineItems) && inv.lineItems.some((li) => li.sourceType === "late_fee");
}

/* -----------------------------
   Middleware
-------------------------------- */

app.use(cors(buildCorsOptions()));

/*
 * ===============================
 * Thread J — Payments & Guest Pay
 * ===============================
 * Stripe webhook MUST be mounted with express.raw BEFORE express.json,
 * otherwise signature verification will fail.
 */

// Mount Stripe webhook first (raw body)

const paymentsReg = registerPaymentsRoutes(app, {
  prisma,
  sendError,
  requireAuth: requireJwt,
  requireAdmin, // <-- add this
  publicBaseUrl: "http://localhost:3001", // optional
});



// Stripe webhook MUST be mounted with express.raw BEFORE any JSON parsing
app.post(
  "/webhooks/stripe",
  express.raw({ type: "application/json" }),
  paymentsReg.stripeWebhookHandler()
);

// Mount payments router AFTER webhook (router uses express.json internally)
app.use(paymentsReg.router);

app.use(express.json());

// Global JSON parser for everything else
app.post("/debug/json", (req, res) => {
  res.json({ body: req.body });
});

/* -----------------------------
   Thread P — Canonical ShortPay public endpoints

   GET  /p/:code         -> summary (invoice + token state)
   POST /p/:code/intent  -> create Stripe intent (idempotent via existing payments module)
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

    const summary = buildShortPaySummary(token);

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
    
    // If already paid, short-circuit cleanly
    if (isInvoicePaid(token.invoice)) {
      emitPvHook("shortpay.intent_exists", { invoiceId: token.invoice.id, reason: "already_paid" });
      return sendError(res, 409, "ALREADY_PAID", "Invoice is already paid.");
    }

    const { amountCents: amountCentsRaw, payerEmail } = req.body || {};

// Canonical behavior: server decides amount.
// Allow client to omit amountCents; if present, it must match invoice balance due.
const invoiceTotal = summary.invoice.totalCents ?? summary.invoice.amountCents ?? null;
const invoicePaid = summary.invoice.amountPaidCents ?? 0;
const balanceDue = Number.isInteger(invoiceTotal) ? Math.max(0, invoiceTotal - (Number.isInteger(invoicePaid) ? invoicePaid : 0)) : null;

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
      // This keeps Thread P single-file but makes failures obvious if the payments module API changes.
      console.error("ShortPay: no intent creator found on paymentsReg");
      return sendError(
        res,
        500,
        "SERVER_MISCONFIG",
        "Payments module does not expose a guest-pay intent creator. Add an exported helper in src/payments/payments.routes."
      );
    }

    // Delegate to your existing (Thread O) idempotent intent creation.
    // Expected behavior: if intent already exists -> throw/return 409 intent_exists.
    // IMPORTANT (Thread P): pass the already-loaded GuestPayToken record.
    // This avoids any re-lookup mismatch (short code vs long token hash).
    const result = await createIntent({
      token,
      amountCents,
      payerEmail,
      req,
    });

    emitPvHook("shortpay.intent_created", { invoiceId: token.invoice.id, paymentId: result?.paymentId || null });
    return res.json(result);
  } catch (e) {
    // Preserve canonical idempotency behavior
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

app.get("/", (_req, res) => res.json({ status: "PerkValet backend running ✅" }));

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

    const accessToken = jwt.sign(
      { userId: user.id, tokenVersion: user.tokenVersion ?? 0 },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN }
    );

    const landing = user.systemRole === "pv_admin" ? "/merchants" : "/merchant";
    return res.json({ accessToken, systemRole: user.systemRole, landing });
  } catch (err) {
    return handlePrismaError(err, res);
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

    // Email delivery: stub is OK for C1
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
    if (new Date(prt.expiresAt).getTime() < Date.now()) return sendError(res, 400, "INVALID_TOKEN", "Invalid or expired token");
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

    if (!cur || !nextPw) return sendError(res, 400, "VALIDATION_ERROR", "currentPassword and newPassword are required");
    if (nextPw.length < 10) return sendError(res, 400, "VALIDATION_ERROR", "Password must be at least 10 characters");

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
        merchantUsers: { select: { merchantId: true, role: true, status: true } },
      },
    });

    if (!user) return sendError(res, 404, "NOT_FOUND", "User not found");

    const landing = user.systemRole === "pv_admin" ? "/merchants" : "/merchant";
    return res.json({ user, memberships: user.merchantUsers, landing });
  } catch (err) {
    return handlePrismaError(err, res);
  }
});

/* -----------------------------
   Public QR PNG
-------------------------------- */

app.get("/stores/:storeId/qr.png", async (req, res) => {
  const storeId = parseIntParam(req.params.storeId);
  if (!storeId) return sendError(res, 400, "VALIDATION_ERROR", "Invalid storeId");

  try {
    const activeQr = await prisma.storeQr.findFirst({
      where: { storeId, status: "active" },
      orderBy: { createdAt: "desc" },
      include: { store: true },
    });
    if (!activeQr) return sendError(res, 404, "QR_NOT_FOUND", "No active QR for this store");

    const payload = `pv:store:${activeQr.token}`;
    const pngBuffer = await QRCode.toBuffer(payload, { type: "png", errorCorrectionLevel: "M", margin: 2, scale: 8 });

    res.setHeader("Content-Type", "image/png");
    res.setHeader("Content-Disposition", `inline; filename="store-${storeId}-qr.png"`);
    res.setHeader("Cache-Control", "no-store");
    return res.send(pngBuffer);
  } catch (err) {
    return sendError(res, 500, "INTERNAL_ERROR", err?.message || "Failed to generate QR PNG");
  }
});

/* -----------------------------
   Merchant portal (JWT only)
-------------------------------- */

app.get("/merchant/stores", requireJwt, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      select: { id: true, systemRole: true, merchantUsers: { where: { status: "active" }, select: { merchantId: true } } },
    });

    if (!user) return sendError(res, 404, "NOT_FOUND", "User not found");
    if (user.systemRole === "pv_admin") return sendError(res, 403, "FORBIDDEN", "pv_admin does not use merchant portal");

    const merchantIds = user.merchantUsers.map((m) => m.merchantId);
    if (!merchantIds.length) return res.json({ items: [] });

    const stores = await prisma.store.findMany({
      where: { merchantId: { in: merchantIds }, status: "active" },
      orderBy: { createdAt: "desc" },
    });

    return res.json({ items: stores });
  } catch (err) {
    return handlePrismaError(err, res);
  }
});

app.get("/merchant/invoices", requireJwt, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      select: { id: true, systemRole: true, merchantUsers: { where: { status: "active" }, select: { merchantId: true } } },
    });

    if (!user) return sendError(res, 404, "NOT_FOUND", "User not found");
    if (user.systemRole === "pv_admin") return sendError(res, 403, "FORBIDDEN", "pv_admin does not use merchant portal");

    const merchantIds = user.merchantUsers.map((m) => m.merchantId);
    if (!merchantIds.length) return res.json({ items: [], nextCursor: null });

    const items = await prisma.invoice.findMany({
      where: { merchantId: { in: merchantIds } },
      orderBy: [{ createdAt: "desc" }],
      take: 200,
    });

    const mapped = items.map((inv) => ({
      id: inv.id,
      merchantId: inv.merchantId,
      billingAccountId: inv.billingAccountId,
      status: inv.status,
      issuedAt: inv.issuedAt ? inv.issuedAt.toISOString() : null,
      netTermsDays: inv.netTermsDays ?? null,
      dueAt: inv.dueAt ? inv.dueAt.toISOString() : null,
      subtotalCents: inv.subtotalCents,
      taxCents: inv.taxCents,
      totalCents: inv.totalCents,
      amountPaidCents: inv.amountPaidCents,
      relatedToInvoiceId: inv.relatedToInvoiceId ?? null,
    }));

    return res.json({ items: mapped, nextCursor: null });
  } catch (err) {
    return handlePrismaError(err, res);
  }
});

app.get("/merchant/invoices/:invoiceId", requireJwt, async (req, res) => {
  const invoiceId = parseIntParam(req.params.invoiceId);
  if (!invoiceId) return sendError(res, 400, "VALIDATION_ERROR", "Invalid invoiceId");

  try {
    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      select: { id: true, systemRole: true, merchantUsers: { where: { status: "active" }, select: { merchantId: true } } },
    });

    if (!user) return sendError(res, 404, "NOT_FOUND", "User not found");
    if (user.systemRole === "pv_admin") return sendError(res, 403, "FORBIDDEN", "pv_admin does not use merchant portal");

    const merchantIds = user.merchantUsers.map((m) => m.merchantId);
    if (!merchantIds.length) return sendError(res, 403, "FORBIDDEN", "No merchant memberships");

    const inv = await prisma.invoice.findUnique({
      where: { id: invoiceId },
      include: { lineItems: true, payments: true, relatedInvoices: true },
    });

    if (!inv) return sendError(res, 404, "INVOICE_NOT_FOUND", "Invoice not found");
    if (!merchantIds.includes(inv.merchantId)) return sendError(res, 403, "FORBIDDEN", "Invoice not accessible");

    return res.json({
      invoice: {
        id: inv.id,
        merchantId: inv.merchantId,
        billingAccountId: inv.billingAccountId,
        status: inv.status,
        issuedAt: inv.issuedAt ? inv.issuedAt.toISOString() : null,
        netTermsDays: inv.netTermsDays ?? null,
        dueAt: inv.dueAt ? inv.dueAt.toISOString() : null,
        subtotalCents: inv.subtotalCents,
        taxCents: inv.taxCents,
        totalCents: inv.totalCents,
        amountPaidCents: inv.amountPaidCents,
        relatedToInvoiceId: inv.relatedToInvoiceId ?? null,
        externalInvoiceId: inv.externalInvoiceId ?? null,
        generationVersion: inv.generationVersion,
      },
      lineItems: inv.lineItems,
      payments: inv.payments,
      relatedInvoices: (inv.relatedInvoices || []).map((x) => ({
        id: x.id,
        status: x.status,
        totalCents: x.totalCents,
        relatedToInvoiceId: x.relatedToInvoiceId ?? null,
      })),
    });
  } catch (err) {
    return handlePrismaError(err, res);
  }
});

/* -----------------------------
   Admin gate (JWT + admin key)
-------------------------------- */

app.use(["/merchants", "/stores", "/users", "/admin", "/billing"], requireJwt, requireAdmin);

/* -----------------------------
   Admin: Merchants (JWT + admin key)
-------------------------------- */

app.post("/merchants", async (req, res) => {
  const { name, billingEmail } = req.body || {};

  try {
    const merchantName = String(name || "").trim();
    if (!merchantName) {
      return sendError(res, 400, "VALIDATION_ERROR", "name is required");
    }

    const providedEmail = billingEmail
      ? String(billingEmail).trim().toLowerCase()
      : "";

    const merchant = await prisma.$transaction(async (tx) => {
      // 1) Create Merchant
      const m = await tx.merchant.create({
        data: { name: merchantName },
      });

      // 2) Create BillingAccount immediately (required invariant)
      const emailToUse =
        providedEmail || `billing+merchant${m.id}@example.com`;

      await tx.billingAccount.create({
        data: {
          merchantId: m.id,
          provider: "stripe",
          billingEmail: emailToUse,
          status: "active",
        },
      });

      return m;
    });

    // Preserve existing API contract (merchant only)
    return res.json(merchant);
  } catch (err) {
    return handlePrismaError(err, res);
  }
});

app.get("/merchants", async (req, res) => {
  try {
    const status = req.query.status;
    const where =
      !status || status === "active"
        ? { status: "active" }
        : status === "all"
        ? {}
        : { status: String(status) };

    const merchants = await prisma.merchant.findMany({
      where,
      orderBy: { createdAt: "desc" },
      include: { stores: true },
    });

    return res.json(merchants);
  } catch (err) {
    return sendError(res, 500, "INTERNAL_ERROR", err?.message || "Request failed");
  }
});

app.get("/merchants/:merchantId", async (req, res) => {
  const merchantId = parseIntParam(req.params.merchantId);
  if (!merchantId) return sendError(res, 400, "VALIDATION_ERROR", "Invalid merchantId");

  try {
    const merchant = await prisma.merchant.findUnique({
      where: { id: merchantId },
      include: { stores: true },
    });
    if (!merchant) return sendError(res, 404, "MERCHANT_NOT_FOUND", "Merchant not found");
    return res.json(merchant);
  } catch (err) {
    return handlePrismaError(err, res);
  }
});

app.patch("/merchants/:merchantId", async (req, res) => {
  const merchantId = parseIntParam(req.params.merchantId);
  const { status, statusReason } = req.body || {};

  if (!merchantId) return sendError(res, 400, "VALIDATION_ERROR", "Invalid merchantId");
  if (!status || !["active", "suspended", "archived"].includes(status)) {
    return sendError(res, 400, "VALIDATION_ERROR", "status must be active|suspended|archived");
  }

  try {
    const now = new Date();
    const merchant = await prisma.merchant.update({
      where: { id: merchantId },
      data: {
        status,
        statusReason: statusReason ?? null,
        statusUpdatedAt: now,
        suspendedAt: status === "suspended" ? now : null,
        archivedAt: status === "archived" ? now : null,
      },
    });
    return res.json(merchant);
  } catch (err) {
    return handlePrismaError(err, res);
  }
});

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

app.get("/admin/billing-policy", requireAdmin, (_req, res) => res.json(BILLING_POLICY));

app.put("/admin/billing-policy", requireAdmin, (req, res) => {
  const v = validateBillingPolicy(req.body || {});
  if (!v.ok) return sendError(res, 400, "VALIDATION_ERROR", v.msg);

  BILLING_POLICY = v.policy;
  const ok = saveBillingPolicyToDisk(BILLING_POLICY);
  if (!ok) return sendError(res, 500, "PERSIST_FAILED", "Policy saved in memory but failed to persist to disk");
  return res.json(BILLING_POLICY);
});

/* =========================================================
   ADMIN INVOICES
   ========================================================= */

// List invoices (admin)
app.get("/admin/invoices", requireAdmin, async (req, res) => {
  try {
    const { status, merchantId } = req.query;

    const where = {};
    if (status) where.status = status;
    if (merchantId) where.merchantId = Number(merchantId);

    const items = await prisma.invoice.findMany({
      where,
      orderBy: { id: "desc" },
      take: 100,
    });

    res.json({ items });
  } catch (err) {
    console.error(err);
    sendError(res, 500, "INTERNAL_ERROR", "Failed to list invoices");
  }
});

// Generate draft invoice (admin, dev)
/* -----------------------------
   Admin invoice generation (shared handler)
-------------------------------- */

async function handleAdminGenerateInvoice(req, res) {
  const { merchantId, totalCents, netTermsDays } = req.body || {};

  if (!Number.isInteger(merchantId) || merchantId <= 0) {
    return sendError(res, 400, "VALIDATION_ERROR", "merchantId required");
  }

  if (!Number.isInteger(totalCents) || totalCents < 0) {
    return sendError(res, 400, "VALIDATION_ERROR", "totalCents must be >= 0");
  }

  if (!Number.isInteger(netTermsDays) || netTermsDays < 1) {
    return sendError(res, 400, "VALIDATION_ERROR", "netTermsDays must be >= 1");
  }
  try {
    // BillingAccount is required by the Invoice schema
    const acct = await prisma.billingAccount.findUnique({
      where: { merchantId },
      select: { id: true },
    });

    if (!acct) {
      return sendError(
        res,
        404,
        "BILLING_ACCOUNT_NOT_FOUND",
        "BillingAccount not found for merchant"
      );
    }

    const invoice = await prisma.invoice.create({
      data: {
        billingAccountId: acct.id,
        merchantId,

        status: "draft",

        // Keep values consistent with schema defaults
        netTermsDays,
        subtotalCents: totalCents,
        taxCents: 0,
        totalCents: totalCents,
        amountPaidCents: 0,
        generationVersion: 1,

        lineItems: {
          create: [
            {
              description: "Platform fee",
              quantity: 1,
              unitPriceCents: totalCents,
              amountCents: totalCents,
              sourceType: "platform_fee",
              sourceRefId: null,
            },
          ],
        },
      },
      select: { id: true },
    });

    return res.json({ invoiceId: invoice.id });
  } catch (err) {
    console.error(err);
    return sendError(res, 500, "INTERNAL_ERROR", err?.message || "Failed to generate invoice");
  }
}

/**
 * Canonical endpoint (preferred)
 * POST /admin/invoices/generate
 */
app.post("/admin/invoices/generate", handleAdminGenerateInvoice);

/**
 * Legacy alias (current UI calls this)
 * POST /admin/billing/generate-invoice
 */
app.post("/admin/billing/generate-invoice", handleAdminGenerateInvoice);

// Get invoice detail (admin)
app.get("/admin/invoices/:invoiceId", requireAdmin, async (req, res) => {
  const invoiceId = Number(req.params.invoiceId);
  if (!Number.isInteger(invoiceId))
    return sendError(res, 400, "VALIDATION_ERROR", "Invalid invoiceId");

  try {
    const invoice = await prisma.invoice.findUnique({
      where: { id: invoiceId },
      include: {
        lineItems: true,
        payments: true,
      },
    });

    if (!invoice)
      return sendError(res, 404, "NOT_FOUND", "Invoice not found");

    res.json({
      invoice,
      lineItems: invoice.lineItems,
      payments: invoice.payments,
    });
  } catch (err) {
    console.error(err);
    sendError(res, 500, "INTERNAL_ERROR", "Failed to load invoice");
  }
});

// Issue invoice (admin)
app.post("/admin/invoices/:invoiceId/issue", requireAdmin, async (req, res) => {
  const invoiceId = Number(req.params.invoiceId);
  const { netTermsDays } = req.body || {};

  if (!Number.isInteger(invoiceId))
    return sendError(res, 400, "VALIDATION_ERROR", "Invalid invoiceId");

  try {
    const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } });
    if (!invoice)
      return sendError(res, 404, "NOT_FOUND", "Invoice not found");

    if (invoice.status !== "draft")
      return sendError(res, 400, "INVALID_STATE", "Only draft invoices can be issued");

    const terms = Number.isInteger(netTermsDays) ? netTermsDays : invoice.netTermsDays;
    const dueAt = new Date(Date.now() + terms * 24 * 60 * 60 * 1000);

    const updated = await prisma.invoice.update({
      where: { id: invoiceId },
      data: {
        status: "issued",
        issuedAt: new Date(),
        dueAt,
        netTermsDays: terms,
      },
    });

    res.json({ invoice: updated });
  } catch (err) {
    console.error(err);
    sendError(res, 500, "INTERNAL_ERROR", "Failed to issue invoice");
  }
});

// Void invoice (admin)

app.get("/admin/invoices/:invoiceId/late-fee-preview", requireAdmin, async (req, res) => {
  try {
    const invoiceId = Number(req.params.invoiceId);
    if (!Number.isInteger(invoiceId)) {
      return sendError(res, 400, "VALIDATION_ERROR", "Invalid invoiceId");
    }

    // Load invoice with line items so we can compute eligibility and detect existing late-fee invoices
    const original = await prisma.invoice.findUnique({
      where: { id: invoiceId },
      include: { lineItems: true },
    });

    if (!original) return sendError(res, 404, "NOT_FOUND", "Invoice not found");

    // Effective policy: global policy for now (merchant overrides can be layered later)
    const effectivePolicy = BILLING_POLICY;

    const now = new Date();
    const elig = lateFeeEligibility(original, now, effectivePolicy);

    const existing = await findExistingLateFeeInvoice(invoiceId);

    let wouldCreate = null;
    if (elig.eligible && !existing?.id) {
      const dueAt = new Date(now);
      const netDays = Number(effectivePolicy?.lateFeeNetDays || 7);
      dueAt.setDate(dueAt.getDate() + netDays);

      wouldCreate = {
        dueAt: dueAt.toISOString(),
        lineItem: {
          description: "Late fee",
          quantity: 1,
          amountCents: Number(effectivePolicy?.lateFeeCents || 0),
        },
      };
    }

    return res.json({
      eligible: Boolean(elig.eligible),
      reason: elig.reason || null,
      policy: effectivePolicy
        ? {
            graceDays: effectivePolicy.graceDays,
            lateFeeCents: effectivePolicy.lateFeeCents,
            lateFeeNetDays: effectivePolicy.lateFeeNetDays,
          }
        : null,
      existingLateFeeInvoiceId: existing?.id || null,
      wouldCreate,
    });
  } catch (e) {
    return sendError(res, 500, "SERVER_ERROR", e?.message || "Late fee preview failed");
  }
});

app.post("/admin/invoices/:invoiceId/void", requireAdmin, async (req, res) => {
  const invoiceId = Number(req.params.invoiceId);
  if (!Number.isInteger(invoiceId))
    return sendError(res, 400, "VALIDATION_ERROR", "Invalid invoiceId");

  try {
    const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } });
    if (!invoice)
      return sendError(res, 404, "NOT_FOUND", "Invoice not found");

    if (invoice.status === "paid")
      return sendError(res, 400, "INVALID_STATE", "Paid invoices cannot be voided");

    const updated = await prisma.invoice.update({
      where: { id: invoiceId },
      data: { status: "void" },
    });

    res.json(updated);
  } catch (err) {
    console.error(err);
    sendError(res, 500, "INTERNAL_ERROR", "Failed to void invoice");
  }
});

app.get("/admin/merchants/:merchantId/billing-policy", requireAdmin, async (req, res) => {
  const merchantId = parseIntParam(req.params.merchantId);
  if (!merchantId) return sendError(res, 400, "VALIDATION_ERROR", "Invalid merchantId");

  try {
    const bundle = await getMerchantPolicyBundle(merchantId);
    if (bundle.error) return sendError(res, bundle.error.http, bundle.error.code, bundle.error.message);

    return res.json({
      merchantId,
      billingAccountId: bundle.accountId,
      global: bundle.global,
      overrides: bundle.overrides,
      effective: bundle.effective,
    });
  } catch (err) {
    return handlePrismaError(err, res);
  }
});

app.put("/admin/merchants/:merchantId/billing-policy", requireAdmin, async (req, res) => {
  const merchantId = parseIntParam(req.params.merchantId);
  if (!merchantId) return sendError(res, 400, "VALIDATION_ERROR", "Invalid merchantId");

  try {
    const acct = await prisma.billingAccount.findUnique({
      where: { merchantId },
      select: { id: true, merchantId: true, policyOverridesJson: true },
    });
    if (!acct) return sendError(res, 404, "BILLING_ACCOUNT_NOT_FOUND", "BillingAccount not found");

    const v = validateOverrides(req.body || {}, BILLING_POLICY);
    if (!v.ok) return sendError(res, 400, "VALIDATION_ERROR", v.msg);

    await prisma.billingAccount.update({
      where: { id: acct.id },
      data: { policyOverridesJson: v.clear ? null : v.overrides },
    });

    const bundle = await getMerchantPolicyBundle(merchantId);
    return res.json({
      merchantId,
      billingAccountId: acct.id,
      overrides: bundle.overrides,
      effective: bundle.effective,
    });
  } catch (err) {
    return handlePrismaError(err, res);
  }
});

app.get("/stores/:storeId", async (req, res) => {
  const storeId = parseIntParam(req.params.storeId);
  if (!storeId) return sendError(res, 400, "VALIDATION_ERROR", "Invalid storeId");

  try {
    const store = await prisma.store.findUnique({
      where: { id: storeId },
      include: { merchant: true },
    });
    if (!store) return sendError(res, 404, "STORE_NOT_FOUND", "Store not found");
    return res.json(store);
  } catch (err) {
    return handlePrismaError(err, res);
  }
});

app.get("/stores/:storeId/qrs", async (req, res) => {
  const storeId = parseIntParam(req.params.storeId);
  if (!storeId) return sendError(res, 400, "VALIDATION_ERROR", "Invalid storeId");

  try {
    const qrs = await prisma.storeQr.findMany({
      where: { storeId },
      orderBy: { createdAt: "desc" },
    });
    return res.json(qrs);
  } catch (err) {
    return handlePrismaError(err, res);
  }
});

app.post("/stores/:storeId/qrs", async (req, res) => {
  const storeId = parseIntParam(req.params.storeId);
  if (!storeId) return sendError(res, 400, "VALIDATION_ERROR", "Invalid storeId");

  try {
    const now = new Date();

    const result = await prisma.$transaction(async (tx) => {
      const store = await tx.store.findUnique({
        where: { id: storeId },
        include: { merchant: true },
      });

      const gateErr = enforceStoreAndMerchantActive(store);
      if (gateErr) return { error: gateErr };

      await tx.storeQr.updateMany({
        where: { storeId, status: "active" },
        data: { status: "archived", updatedAt: now },
      });

      const token = crypto.randomBytes(16).toString("hex");

      const qr = await tx.storeQr.create({
        data: { storeId, merchantId: store.merchantId, token, status: "active", updatedAt: now },
      });

      return { qr };
    });

    if (result?.error) return sendError(res, result.error.http, result.error.code, result.error.message);

    const { qr } = result;
    return res.json({ ...qr, payload: `pv:store:${qr.token}`, pngUrl: `/stores/${storeId}/qr.png` });
  } catch (err) {
    return handlePrismaError(err, res);
  }
});

/* -----------------------------
   Visits + Scan (rate-limited)
-------------------------------- */

app.post("/visits", visitsWriteLimiter, async (req, res) => {
  const { token, source, metadata } = req.body;

  try {
    if (!token) return sendError(res, 400, "VALIDATION_ERROR", "token is required");

    const allowedSources = ["qr_scan", "manual", "import"];
    const src = source ?? "qr_scan";
    if (!allowedSources.includes(src)) {
      return sendError(res, 400, "VALIDATION_ERROR", `source must be one of: ${allowedSources.join(", ")}`);
    }

    const qr = await loadActiveQrWithStore(token);
    if (!qr) return sendError(res, 404, "QR_NOT_FOUND", "Invalid or inactive QR");

    const gateErr = enforceStoreAndMerchantActive(qr.store);
    if (gateErr) return sendError(res, gateErr.http, gateErr.code, gateErr.message);

    const visit = await prisma.visit.create({
      data: { storeId: qr.storeId, qrId: qr.id, merchantId: qr.store.merchantId, source: src, metadata: metadata ?? undefined },
    });

    return res.json({ visitId: visit.id, store: qr.store });
  } catch (err) {
    return handlePrismaError(err, res);
  }
});

app.post("/scan", scanLimiter, async (req, res) => {
  const { token, phone, email, firstName, lastName, metadata } = req.body;

  try {
    if (!token) return sendError(res, 400, "VALIDATION_ERROR", "token is required");

    const qr = await loadActiveQrWithStore(token);
    if (!qr) return sendError(res, 404, "QR_NOT_FOUND", "Invalid or inactive QR");

    const gateErr = enforceStoreAndMerchantActive(qr.store);
    if (gateErr) return sendError(res, gateErr.http, gateErr.code, gateErr.message);

    if (!phone) return sendError(res, 400, "VALIDATION_ERROR", "phone is required");

    const normalized = normalizePhone(phone, "US");
    if (!normalized?.e164) return sendError(res, 400, "VALIDATION_ERROR", "Invalid phone number");

    const consumer = await prisma.consumer.upsert({
      where: { phoneE164: normalized.e164 },
      update: {
        email: email ?? undefined,
        firstName: firstName ?? undefined,
        lastName: lastName ?? undefined,
        phoneRaw: normalized.raw,
        phoneCountry: normalized.country || "US",
      },
      create: {
        email: email || null,
        firstName: firstName || null,
        lastName: lastName || null,
        phoneRaw: normalized.raw,
        phoneE164: normalized.e164,
        phoneCountry: normalized.country || "US",
      },
    });

    const visit = await prisma.visit.create({
      data: { storeId: qr.storeId, qrId: qr.id, consumerId: consumer.id, merchantId: qr.store.merchantId, source: "qr_scan", metadata: metadata ?? undefined },
    });

    return res.json({ store: qr.store, consumerId: consumer.id, visitId: visit.id });
  } catch (err) {
    return handlePrismaError(err, res);
  }
});

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
