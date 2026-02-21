/** Module: backend/index.js | PerkValet Backend Entry | PV Org Surface V1 */
require("dotenv").config();
const { registerPaymentsRoutes } = require("./src/payments/payments.routes");
const { registerPosRoutes } = require("./src/pos/pos.routes");
const { registerPosProvisionRoutes } = require("./src/pos/pos.provision.routes");
const { registerPosAuthRoutes } = require("./src/pos/pos.auth.routes");
const fs = require("fs");
const path = require("path");

const QRCode = require("qrcode");
const crypto = require("crypto");
const { sendMail } = require("./src/mail");
const express = require("express");
const cors = require("cors");

const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const { prisma } = require("./src/db/prisma");
const { startInvoiceMailRunScheduler } = require("./src/jobs/invoiceMailRun.scheduler");
const { startInvoiceReminderMailRunScheduler } = require("./src/jobs/invoiceReminderMailRun.scheduler");
const { normalizePhone } = require("./utils/phone");
const teamRoutes = require("./src/admin/team.routes");

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
   Invite token helpers (Staff onboarding)
-------------------------------- */

async function pvIssueInviteToken(prisma, req, userId, emailNorm) {
  // Reuse PasswordResetToken + /reset-password UI for both "invite set-password" and "forgot password".
  const token = crypto.randomBytes(32).toString("hex");
  const pepper = process.env.RESET_TOKEN_PEPPER || JWT_SECRET;
  const tokenHash = sha256Hex(`${pepper}:${token}`);

  const minutes = Number(process.env.INVITE_TOKEN_MINUTES || process.env.RESET_TOKEN_MINUTES || 24 * 60);
  const expiresAt = new Date(Date.now() + minutes * 60 * 1000);

  await prisma.passwordResetToken.create({
    data: { userId, tokenHash, expiresAt },
  });

  const resetUrl = buildResetUrl(req, token);

  // Email stub for dev (later replace with real mail delivery)
  console.log("[AUTH][EMAIL_STUB] invite/set-password", {
    to: emailNorm,
    resetUrl,
    expiresAt: expiresAt.toISOString(),
  });

  return { resetUrl, expiresAt };
}


/* -----------------------------
   Prisma error mapping
-------------------------------- */

function handlePrismaError(err, res) {
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

  // PV Org Surface V1: allow pv_support read-only access to Team.
  if (req.userId && req.systemRole === "pv_support") {
    const p = String(req.baseUrl || "") + String(req.path || "");
    if (req.method === "GET" && (p === "/admin/team" || p.startsWith("/admin/team/"))) {
      return next();
    }
    return sendError(res, 403, "FORBIDDEN", "Insufficient role for this resource");
  }

  // Billing V1: allow pv_ar_clerk access only to billing endpoints.
  if (req.userId && req.systemRole === "pv_ar_clerk") {
    const p = String(req.baseUrl || "") + String(req.path || "");
    if (p === "/billing" || p.startsWith("/billing/")) {
      return next();
    }
    return sendError(res, 403, "FORBIDDEN", "Billing-only role");
  }

  // PV QA: blocked in production (fail closed here as a second line of defense).
  if (req.userId && req.systemRole === "pv_qa" && NODE_ENV === "production") {
    return sendError(res, 403, "FORBIDDEN", "pv_qa is disabled in production");
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
   Security-V1: Trusted Device + Email Verification
-------------------------------- */
const DEVICE_VERIFY_TTL_MIN = Number(process.env.DEVICE_VERIFY_TTL_MIN || 15);
const TRUSTED_DEVICE_TTL_DAYS = Number(process.env.TRUSTED_DEVICE_TTL_DAYS || 90);

function pvSecHook(event, fields = {}) {
  try {
    emitPvHook(event, { ...fields, stable: fields?.stable || "security:v1:trusted-device" });
  } catch {
    // never break runtime for logging
  }
}

async function pvDbNow(prisma) {
  try {
    const rows = await prisma.$queryRaw`SELECT now() as now`;
    const v = rows && rows[0] && rows[0].now ? rows[0].now : null;
    return v ? new Date(v) : new Date();
  } catch {
    return new Date();
  }
}


function hashWithPepper(raw) {
  const pepper = process.env.DEVICE_ID_PEPPER || JWT_SECRET || "dev-secret-change-me";
  return crypto.createHash("sha256").update(String(pepper) + ":" + String(raw)).digest("hex");
}

function getRawDeviceId(req) {
  const v = req?.headers?.["x-pv-device-id"];
  if (!v) return "";
  return String(v).trim();
}

function getDeviceIdHash(req) {
  const raw = getRawDeviceId(req);
  if (!raw) return "";
  return hashWithPepper(raw);
}

async function isMerchantAdminUserId(userId) {
  const mu = await prisma.merchantUser.findFirst({
    where: { userId, role: "merchant_admin", status: "active" },
    select: { id: true },
  });
  return !!mu;
}

async function isPrivilegedRequest(req) {
  if (req?.systemRole === "pv_admin") return true;
  if (!req?.userId) return false;
  return isMerchantAdminUserId(req.userId);
}

async function findActiveTrustedDevice(userId, deviceIdHash) {
  if (!userId || !deviceIdHash) return null;
  // Defensive: if Prisma client is missing the trustedDevice delegate, treat as untrusted
  // (prevents 500s and keeps the device gate deterministic).
  if (!prisma?.trustedDevice?.findFirst) {
    pvSecHook("security.device.prisma_delegate_missing", {
      tc: "TC-SEC-DEV-STATUS-01",
      hasPrisma: !!prisma,
      hasTrustedDevice: !!prisma?.trustedDevice,
    });
    return null;
  }
  const now = new Date();
  return prisma.trustedDevice.findFirst({
    where: {
      userId,
      deviceIdHash,
      revokedAt: null,
      expiresAt: { gt: now },
    },
  });
}

async function touchTrustedDevice(id) {
  try {
    await prisma.trustedDevice.update({
      where: { id },
      data: { lastSeenAt: new Date() },
    });
  } catch {
    // ignore
  }
}

async function requireTrustedDeviceIfPrivileged(req, res, next) {
  try {
    const privileged = await isPrivilegedRequest(req);
    if (!privileged) return next();

    const deviceIdHash = getDeviceIdHash(req);
    if (!deviceIdHash) {
      pvSecHook("security.device.required", { tc: "TC-SEC-DEV-01", reason: "missing_device_id" });
      return sendError(res, 401, "DEVICE_ID_REQUIRED", "Missing device identifier header");
    }

    pvSecHook("security.device.check", { tc: "TC-SEC-DEV-01" });

    const td = await findActiveTrustedDevice(req.userId, deviceIdHash);
    if (!td) {
      pvSecHook("security.device.required", { tc: "TC-SEC-DEV-01", reason: "not_trusted" });
      return sendError(res, 403, "DEVICE_VERIFICATION_REQUIRED", "Device verification required");
    }

    await touchTrustedDevice(td.id);
    pvSecHook("security.device.trusted", { tc: "TC-SEC-DEV-01" });
    return next();
  } catch (err) {
    pvSecHook("security.device.verify.failed", { tc: "TC-SEC-DEV-01", error: err?.message });
    return sendError(res, 403, "DEVICE_NOT_TRUSTED", "This browser is not enabled for admin actions. Please verify this device.");
  }
}

function buildVerifyUrl({ token, returnTo }) {
  const base = process.env.API_PUBLIC_URL || "http://localhost:3001";
  const url = new URL("/auth/device/verify", base);
  url.searchParams.set("token", token);
  if (returnTo) url.searchParams.set("returnTo", returnTo);
  return url.toString();
}

function buildVerifyDoneUrl({ returnTo }) {
  const base = process.env.APP_PUBLIC_URL || "http://localhost:5173";
  const url = new URL("/verify-device/done", base);
  if (returnTo) url.searchParams.set("returnTo", returnTo);
  return url.toString();
}

async function sendDeviceVerifyEmail({ userId, toEmail, deviceIdHash, returnTo }) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, firstName: true, lastName: true },
  });
  if (!user) throw new Error("User not found");

  const rawToken = crypto.randomBytes(32).toString("hex");
  const tokenHash = hashWithPepper(rawToken);

  const now = await pvDbNow(prisma);
  const expiresAt = new Date(now.getTime() + DEVICE_VERIFY_TTL_MIN * 60 * 1000);

  await prisma.deviceVerifyToken.create({
    data: {
      userId: user.id,
      deviceIdHash,
      tokenHash,
      expiresAt,
    },
  });

  const verifyUrl = buildVerifyUrl({ token: rawToken, returnTo });
  const effectiveTo = toEmail || user.email;

  // Use the shared mail adapter (SMTP/dev/idempotency + MailEvent) instead of a hard-coded Zepto API call.
  // This keeps behavior consistent across environments and makes delivery deterministic when MAIL_MODE=smtp.
  const idempotencyKey = `security:device-verify:${user.id}:${deviceIdHash}:${expiresAt.toISOString()}`;

  try {
    const res = await sendMail({
      idempotencyKey,
      category: "system",
      to: [effectiveTo],
      subject: "PerkValet device verification",
      template: "security.device_verify",
      data: {
        toEmail: effectiveTo,
        email: user.email,
        link: verifyUrl,
        returnTo: returnTo || "/merchants",
        userId: user.id,
        deviceIdHash,
        expiresAt: expiresAt.toISOString(),
      },
      meta: {
        purpose: "device_verify",
        actorRole: "system",
        actorUserId: user.id,
      },
    });

    pvSecHook("security.device.email.sent", {
      tc: "TC-SEC-DEV-EMAIL-01",
      ok: !!res?.ok,
      transport: res?.transport,
      messageId: res?.messageId || null,
      idempotencyKey,
      toEmail: effectiveTo,
    });

    return { ok: !!res?.ok, transport: res?.transport, messageId: res?.messageId || null };
  } catch (err) {
    pvSecHook("security.device.email.sent", {
      tc: "TC-SEC-DEV-EMAIL-01",
      ok: false,
      error: err?.message,
      idempotencyKey,
      toEmail: effectiveTo,
    });
    return { ok: false, error: err?.message || "send failed" };
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
      "x-pv-device-id",
      "x-idempotency-key",
      "x-pv-hook",
      "x-pv-testcase",
      "x-pos-timestamp",
      "x-pos-idempotency-key",
      "x-pos-nonce",
      "x-pos-signature",
    ],
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

  return { ...v.policy, updatedAt: merged.updatedAt };
}

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
 * Thread J — Payments & Guest Pay
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

app.post("/debug/json", (req, res) => {
  res.json({ body: req.body });
});

/* -----------------------------
   Thread P — Canonical ShortPay public endpoints
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

    if (NODE_ENV === "production" && user.systemRole === "pv_qa") {
      return sendError(res, 403, "FORBIDDEN", "pv_qa is disabled in production");
    }

    const ok = await bcrypt.compare(passwordRaw, user.passwordHash);
    if (!ok) return sendError(res, 401, "UNAUTHORIZED", "Invalid credentials");

    // Security-V1: device trust check (privileged roles only)
    const deviceIdHash = getDeviceIdHash(req);
    let requiresDeviceVerification = false;

    try {
      const merchantAdmin = await isMerchantAdminUserId(user.id);
      const privileged = user.systemRole === "pv_admin" || merchantAdmin;

      if (privileged) {
        const td = await findActiveTrustedDevice(user.id, deviceIdHash);
        requiresDeviceVerification = !td;

        if (requiresDeviceVerification) {
          pvSecHook("security.device.required", { tc: "TC-SEC-DEV-LOGIN-01", reason: "login_untrusted" });
          // Best-effort: send verification email during login to reduce friction.
          if (deviceIdHash) {
            await sendDeviceVerifyEmail({ userId: user.id, toEmail: user.email, deviceIdHash, returnTo: req.body?.returnTo });
          }
        } else {
          pvSecHook("security.device.trusted", { tc: "TC-SEC-DEV-LOGIN-01" });
        }
      }
    } catch (err) {
      pvSecHook("security.device.verify.failed", { tc: "TC-SEC-DEV-LOGIN-01", error: err?.message });
      // Fail open for login; enforcement happens on privileged routes via middleware.
    }



    const accessToken = jwt.sign({ userId: user.id, tokenVersion: user.tokenVersion ?? 0 }, JWT_SECRET, {
      expiresIn: JWT_EXPIRES_IN,
    });

    const landing =
      user.systemRole === "pv_admin"
        ? "/merchants"
        : user.systemRole === "pv_ar_clerk"
        ? "/admin/invoices"
        : user.systemRole === "pv_support"
        ? "/admin/team"
        : "/merchant";
    return res.json({ accessToken, systemRole: user.systemRole, landing, requiresDeviceVerification });
  } catch (err) {
    return handlePrismaError(err, res);
  }
});

/* -----------------------------
   POS-8C — POS Provisioning + Quick Login (shift code → JWT)

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

const POS_ASSOC_FILE = path.join(__dirname, ".pos-associates.json"); // legacy POS-8A
const POS_TERMINALS_FILE = path.join(__dirname, ".pos-terminals.json");
const POS_SHIFT_CODES_FILE = path.join(__dirname, ".pos-shift-codes.json");

function safeReadJsonFile(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch (e) {
    console.warn("⚠️ safeReadJsonFile failed:", filePath, e?.message || e);
    return fallback;
  }
}

function safeWriteJsonFile(filePath, obj) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(obj, null, 2), "utf-8");
    return true;
  } catch (e) {
    console.warn("⚠️ safeWriteJsonFile failed:", filePath, e?.message || e);
    return false;
  }
}

function posPepper() {
  return process.env.POS_PIN_PEPPER || JWT_SECRET || "dev-secret-change-me";
}

function posPinHash(pin) {
  // sha256 hex of peppered PIN (dev-safe; do not reuse password hashing)
  return sha256Hex(`${posPepper()}:${String(pin || "").trim()}`);
}

function randomId(prefix) {
  // url-safe, short-ish
  return `${prefix}${crypto.randomBytes(6).toString("base64url")}`;
}

function normalizeEmail(email) {
  const e = String(email || "").trim().toLowerCase();
  return e && e.includes("@") ? e : "";
}

function normalizePin(pin) {
  const p = String(pin || "").trim();
  if (!/^\d{4,8}$/.test(p)) return "";
  return p;
}

function parseShiftCode(code) {
  const s = String(code || "").trim();
  // storeId#pin
  const m = /^(\d{1,10})#(\d{4,8})$/.exec(s);
  if (!m) return null;
  return { storeId: Number(m[1]), pin: m[2], raw: s };
}

function loadPosAssociatesLegacy() {
  try {
    if (!fs.existsSync(POS_ASSOC_FILE)) return [];
    const raw = fs.readFileSync(POS_ASSOC_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed?.associates) ? parsed.associates : [];
    return list
      .map((x) => ({
        code: String(x?.code || "").trim(),
        userEmail: String(x?.userEmail || "").trim().toLowerCase(),
        storeId: Number.isInteger(x?.storeId) ? x.storeId : Number.parseInt(String(x?.storeId || ""), 10),
      }))
      .filter((x) => x.code && x.userEmail && Number.isInteger(x.storeId) && x.storeId > 0);
  } catch (e) {
    console.warn("⚠️ POS legacy loadPosAssociates failed:", e?.message || e);
    return [];
  }
}

function loadShiftCodes() {
  const parsed = safeReadJsonFile(POS_SHIFT_CODES_FILE, { codes: [] });
  const rows = Array.isArray(parsed?.codes) ? parsed.codes : [];
  // Normalize shape
  return rows
    .map((x) => ({
      code: String(x?.code || "").trim(),
      storeId: Number.isInteger(x?.storeId) ? x.storeId : Number.parseInt(String(x?.storeId || ""), 10),
      merchantId: Number.isInteger(x?.merchantId) ? x.merchantId : Number.parseInt(String(x?.merchantId || ""), 10),
      userEmail: String(x?.userEmail || "").trim().toLowerCase(),
      pinHash: String(x?.pinHash || "").trim(),
      terminalId: x?.terminalId ? String(x.terminalId).trim() : null,
      status: x?.status ? String(x.status).trim() : "active",
      createdAt: x?.createdAt ? String(x.createdAt).trim() : null,
    }))
    .filter(
      (x) =>
        x.code &&
        Number.isInteger(x.storeId) &&
        x.storeId > 0 &&
        Number.isInteger(x.merchantId) &&
        x.merchantId > 0 &&
        x.userEmail &&
        x.pinHash
    );
}

function saveShiftCodes(codes) {
  return safeWriteJsonFile(POS_SHIFT_CODES_FILE, { codes });
}

function loadTerminals() {
  const parsed = safeReadJsonFile(POS_TERMINALS_FILE, { terminals: [] });
  const rows = Array.isArray(parsed?.terminals) ? parsed.terminals : [];
  return rows
    .map((x) => ({
      terminalId: String(x?.terminalId || "").trim(),
      terminalLabel: String(x?.terminalLabel || "").trim(),
      storeId: Number.isInteger(x?.storeId) ? x.storeId : Number.parseInt(String(x?.storeId || ""), 10),
      merchantId: Number.isInteger(x?.merchantId) ? x.merchantId : Number.parseInt(String(x?.merchantId || ""), 10),
      status: x?.status ? String(x.status).trim() : "active",
      createdAt: x?.createdAt ? String(x.createdAt).trim() : null,
      updatedAt: x?.updatedAt ? String(x.updatedAt).trim() : null,
    }))
    .filter((x) => x.terminalId && x.terminalLabel && Number.isInteger(x.storeId) && x.storeId > 0);
}

function saveTerminals(terminals) {
  return safeWriteJsonFile(POS_TERMINALS_FILE, { terminals });
}

/**
 * POST /pos/provision
 * - Provision a terminal for a store (no schema changes)
 * - Body: { storeId, terminalLabel }
 * - Auth: requireAdmin (x-api-key OR pv_admin JWT)
 */
app.post("/pos/provision", requireAdmin, async (req, res) => {
  try {
    const { storeId: sidRaw, terminalLabel } = req.body || {};
    const storeId = parseIntParam(sidRaw);
    const label = String(terminalLabel || "").trim();

    if (!storeId) return sendError(res, 400, "VALIDATION_ERROR", "storeId is required");
    if (!label) return sendError(res, 400, "VALIDATION_ERROR", "terminalLabel is required");

    const store = await prisma.store.findUnique({
      where: { id: storeId },
      select: { id: true, merchantId: true, status: true },
    });
    if (!store) return sendError(res, 404, "NOT_FOUND", "Store not found");
    if (store.status && store.status !== "active") return sendError(res, 403, "FORBIDDEN", "Store is not active");

    const nowIso = new Date().toISOString();
    const terminals = loadTerminals();

    // Upsert: same store + label -> keep terminalId stable
    let t = terminals.find((x) => x.storeId === storeId && x.terminalLabel === label && x.status === "active");
    if (!t) {
      t = {
        terminalId: randomId("term_"),
        terminalLabel: label,
        storeId,
        merchantId: store.merchantId,
        status: "active",
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      terminals.unshift(t);
    } else {
      t.updatedAt = nowIso;
    }

    saveTerminals(terminals);

    emitPvHook("pos.terminal.provisioned", {
      tc: "TC-POS-PROVISION-01",
      sev: "info",
      storeId,
      merchantId: store.merchantId,
      terminalId: t.terminalId,
    });

    return res.json({
      ok: true,
      storeId,
      merchantId: store.merchantId,
      terminalId: t.terminalId,
      terminalLabel: t.terminalLabel,
    });
  } catch (err) {
    return handlePrismaError(err, res);
  }
});

/**
 * POST /pos/auth/provision
 * - Provision an associate shift code for POS quick login
 * - Body: { storeId, userEmail, pin, terminalId? }
 * - Auth: requireAdmin (x-api-key OR pv_admin JWT)
 *
 * Returns: { ok, storeId, merchantId, userEmail, code, pin, createdUser, tempPassword }
 */
app.post("/pos/auth/provision", requireAdmin, async (req, res) => {
  try {
    const { storeId: sidRaw, userEmail, pin, terminalId } = req.body || {};
    const storeId = parseIntParam(sidRaw);
    const emailNorm = normalizeEmail(userEmail);
    const pinNorm = normalizePin(pin);

    if (!storeId) return sendError(res, 400, "VALIDATION_ERROR", "storeId is required");
    if (!emailNorm) return sendError(res, 400, "VALIDATION_ERROR", "userEmail is required");
    if (!pinNorm) return sendError(res, 400, "VALIDATION_ERROR", "pin must be 4-8 digits");

    const store = await prisma.store.findUnique({
      where: { id: storeId },
      select: { id: true, merchantId: true, status: true },
    });
    if (!store) return sendError(res, 404, "NOT_FOUND", "Store not found");
    if (store.status && store.status !== "active") return sendError(res, 403, "FORBIDDEN", "Store is not active");

    // Find or create user by email
    const users = await prisma.user.findMany({ where: { email: emailNorm }, take: 1 });
    let user = Array.isArray(users) && users.length ? users[0] : null;

    let tempPassword = null;
    let createdUser = false;

    if (!user) {
      tempPassword = crypto.randomBytes(6).toString("base64url");
      const passwordHash = await bcrypt.hash(tempPassword, 12);

      user = await prisma.user.create({
        data: {
          email: emailNorm,
          passwordHash,
          systemRole: "user",
          status: "active",
          tokenVersion: 0,
        },
      });
      createdUser = true;
    }

    // Prevent pv_admin being provisioned as POS
    const full = await prisma.user.findUnique({
      where: { id: user.id },
      select: { id: true, systemRole: true },
    });
    if (full?.systemRole === "pv_admin") return sendError(res, 403, "FORBIDDEN", "pv_admin cannot be a POS associate");

    // Ensure merchant membership exists and is store_subadmin
    const existingMu = await prisma.merchantUser.findFirst({
      where: { merchantId: store.merchantId, userId: user.id },
      select: { id: true, role: true, status: true },
    });

    if (existingMu) {
      await prisma.merchantUser.update({
        where: { id: existingMu.id },
        data: { role: "store_subadmin", status: "active" },
      });
    } else {
      await prisma.merchantUser.create({
        data: { merchantId: store.merchantId, userId: user.id, role: "store_subadmin", status: "active" },
      });
    }

    const code = `${storeId}#${pinNorm}`;
    const nowIso = new Date().toISOString();

    const codes = loadShiftCodes().filter((c) => c.code !== code); // replace existing
    codes.unshift({
      code,
      storeId,
      merchantId: store.merchantId,
      userEmail: emailNorm,
      pinHash: posPinHash(pinNorm),
      terminalId: terminalId ? String(terminalId).trim() : null,
      status: "active",
      createdAt: nowIso,
    });
    saveShiftCodes(codes);

    emitPvHook("pos.auth.provisioned", {
      tc: "TC-POS-AUTH-PROVISION-01",
      sev: "info",
      storeId,
      merchantId: store.merchantId,
      userEmail: emailNorm,
      code,
      createdUser,
    });

    return res.json({
      ok: true,
      storeId,
      merchantId: store.merchantId,
      userEmail: emailNorm,
      code,
      pin: pinNorm, // echo for operator convenience
      createdUser,
      tempPassword,
    });
  } catch (err) {
    return handlePrismaError(err, res);
  }
});

/**
 * POST /pos/auth/login
 * - Accepts either:
 *   A) Provisioned code: "<storeId>#<pin>" (POS-8C)
 *   B) Legacy code: arbitrary string mapped in .pos-associates.json (POS-8A)
 *
 * Body: { code }
 */
app.post("/pos/auth/login", async (req, res) => {
  try {
    const { code } = req.body || {};
    const codeNorm = String(code || "").trim();
    if (!codeNorm) return sendError(res, 400, "VALIDATION_ERROR", "code is required");

    // Prefer POS-8C provisioned shift codes (storeId#pin)
    let assoc = null;

    const parsed = parseShiftCode(codeNorm);
    if (parsed) {
      const codes = loadShiftCodes();
      const rec = codes.find((c) => c.code === codeNorm && c.status === "active");
      if (!rec) return sendError(res, 401, "UNAUTHORIZED", "Invalid code");
      if (posPinHash(parsed.pin) !== rec.pinHash) return sendError(res, 401, "UNAUTHORIZED", "Invalid code");

      assoc = { code: rec.code, userEmail: rec.userEmail, storeId: rec.storeId, merchantIdHint: rec.merchantId };
    } else {
      // Fallback to POS-8A legacy file mapping
      assoc = loadPosAssociatesLegacy().find((a) => a.code === codeNorm) || null;
      if (!assoc) return sendError(res, 401, "UNAUTHORIZED", "Invalid code");
    }

    // Resolve user by email (findMany works even if email isn't marked unique in Prisma client)
    const users = await prisma.user.findMany({
      where: { email: assoc.userEmail },
      take: 1,
    });
    const user = Array.isArray(users) && users.length ? users[0] : null;

    if (!user) return sendError(res, 401, "UNAUTHORIZED", "Invalid code");
    if (user.status && user.status !== "active") return sendError(res, 403, "FORBIDDEN", "User is not active");

    // POS must NOT be pv_admin and must be POS-only (store_subadmin-only)
    const full = await prisma.user.findUnique({
      where: { id: user.id },
      select: {
        id: true,
        email: true,
        status: true,
        systemRole: true,
        tokenVersion: true,
        merchantUsers: {
          where: { status: "active" },
          select: { merchantId: true, role: true, status: true },
        },
      },
    });

    if (!full) return sendError(res, 401, "UNAUTHORIZED", "Invalid code");
    if (full.systemRole === "pv_admin") return sendError(res, 403, "FORBIDDEN", "Admin cannot use POS");
    if (!isPosOnlyMerchantUser(full)) return sendError(res, 403, "FORBIDDEN", "Not a POS associate");

    // Store must belong to one of the user's merchants
    const allowedMerchantIds = Array.isArray(full.merchantUsers)
      ? full.merchantUsers.map((m) => m.merchantId).filter(Boolean)
      : [];

    const store = await prisma.store.findUnique({
      where: { id: assoc.storeId },
      select: { id: true, merchantId: true, status: true },
    });

    if (!store) return sendError(res, 404, "NOT_FOUND", "Store not found");
    if (store.status && store.status !== "active") return sendError(res, 403, "FORBIDDEN", "Store is not active");
    if (!allowedMerchantIds.includes(store.merchantId))
      return sendError(res, 403, "FORBIDDEN", "Store not allowed for this associate");

    const accessToken = jwt.sign(
      {
        userId: full.id,
        tokenVersion: full.tokenVersion ?? 0,
        pos: 1,
        storeId: store.id,
        merchantId: store.merchantId,
      },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN }
    );

    emitPvHook("pos.auth.login", {
      tc: "TC-POS-AUTH-LOGIN-01",
      sev: "info",
      userId: full.id,
      storeId: store.id,
      merchantId: store.merchantId,
    });

    return res.json({
      accessToken,
      systemRole: full.systemRole,
      landing: "/merchant/pos",
      posSession: true,
      storeId: store.id,
      merchantId: store.merchantId,
    });
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

/**
 * POST /admin/users/invite
 * Resend an invite / set-password link to an existing staff user (dev email stub).
 * Body: { email }
 * Auth: requireAdmin (pv_admin JWT or x-api-key)
 */
app.post("/admin/users/invite", requireAdmin, async (req, res) => {
  try {
    const { email } = req.body || {};
    const emailNorm = String(email || "").trim().toLowerCase();
    if (!emailNorm) return sendError(res, 400, "VALIDATION_ERROR", "email is required");

    const user = await prisma.user.findUnique({
      where: { email: emailNorm },
      select: { id: true, email: true, status: true },
    });
    if (!user) return sendError(res, 404, "USER_NOT_FOUND", "User not found");
    if (user.status && user.status !== "active") return sendError(res, 400, "INVALID_STATE", "User is not active");

    await pvIssueInviteToken(prisma, req, user.id, user.email);
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

/* -----------------------------
   Security-V1: Device verification
-------------------------------- */
app.post("/auth/device/start", requireJwt, async (req, res) => {
  try {
    const deviceIdHash = getDeviceIdHash(req);
    if (!deviceIdHash) {
      return sendError(res, 400, "DEVICE_ID_REQUIRED", "Missing device identifier header");
    }

    const privileged = await isPrivilegedRequest(req);
    if (!privileged) {
      return sendError(res, 403, "FORBIDDEN", "Device verification not required for this account");
    }

    const returnTo = req.body?.returnTo || req.query?.returnTo || "";
    const result = await sendDeviceVerifyEmail({
      userId: req.userId,
      toEmail: undefined,
      deviceIdHash,
      returnTo,
    });

    return res.json({ ok: !!result?.ok });
  } catch (err) {
    pvSecHook("security.device.verify.failed", { tc: "TC-SEC-DEV-START-01", error: err?.message });
    return sendError(res, 500, "SERVER_ERROR", "Failed to start device verification");
  }
});

app.get("/auth/device/status", requireJwt, async (req, res) => {
  try {
    const deviceIdHash = getDeviceIdHash(req);
    if (!deviceIdHash) {
      return res.json({ trusted: false });
    }

    const td = await findActiveTrustedDevice(req.userId, deviceIdHash);
    if (!td) {
      return res.json({ trusted: false });
    }

    return res.json({ trusted: true, expiresAt: td.expiresAt });
  } catch (err) {
    try { console.error("[security.device.status.failed]", err); } catch {}
    pvSecHook("security.device.status.failed", { tc: "TC-SEC-DEV-STATUS-01", error: err?.message, stack: err?.stack });
    return sendError(res, 500, "SERVER_ERROR", "Failed to check device status");
  }
});

app.get("/auth/device/verify", async (req, res) => {
  try {
    const rawToken = String(req.query?.token || "").trim();
    const returnTo = String(req.query?.returnTo || "").trim();

    if (!rawToken) return sendError(res, 400, "BAD_REQUEST", "Missing token");

    const tokenHash = hashWithPepper(rawToken);
    const now = await pvDbNow(prisma);

    const rec = await prisma.deviceVerifyToken.findUnique({
      where: { tokenHash },
    });

    if (!rec) {
      pvSecHook("security.device.verify.failed", { tc: "TC-SEC-DEV-VERIFY-01", reason: "not_found" });
      return sendError(res, 400, "INVALID_TOKEN", "Invalid or expired token");
    }

    if (rec.usedAt) {
      pvSecHook("security.device.verify.failed", { tc: "TC-SEC-DEV-VERIFY-01", reason: "used" });
      return sendError(res, 400, "INVALID_TOKEN", "Token already used");
    }

    if (rec.expiresAt && rec.expiresAt <= now) {
      pvSecHook("security.device.verify.failed", { tc: "TC-SEC-DEV-VERIFY-01", reason: "expired" });
      return sendError(res, 400, "INVALID_TOKEN", "Token expired");
    }

    const expiresAt = new Date(Date.now() + TRUSTED_DEVICE_TTL_DAYS * 24 * 60 * 60 * 1000);

    await prisma.$transaction([
      prisma.deviceVerifyToken.update({
        where: { id: rec.id },
        data: { usedAt: new Date() },
      }),
      prisma.trustedDevice.upsert({
        where: { userId_deviceIdHash: { userId: rec.userId, deviceIdHash: rec.deviceIdHash } },
        update: { revokedAt: null, expiresAt, lastSeenAt: new Date() },
        create: {
          userId: rec.userId,
          deviceIdHash: rec.deviceIdHash,
          expiresAt,
        },
      }),
    ]);

    pvSecHook("security.device.verified", { tc: "TC-SEC-DEV-VERIFY-01", userId: rec.userId });

    // Redirect back to UI (honor ?returnTo=)
    const doneUrl = buildVerifyDoneUrl({ returnTo });
    return res.redirect(doneUrl);
  } catch (err) {
    pvSecHook("security.device.verify.failed", { tc: "TC-SEC-DEV-VERIFY-01", error: err?.message });
    return sendError(res, 500, "SERVER_ERROR", "Device verification failed");
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

    // Security-V1: device verification flag
    let requiresDeviceVerification = false;
    try {
      const privileged = await isPrivilegedRequest(req);
      if (privileged) {
        const deviceIdHash = getDeviceIdHash(req);
        const td = await findActiveTrustedDevice(req.userId, deviceIdHash);
        requiresDeviceVerification = !td;
      }
    } catch (err) {
      pvSecHook("security.device.verify.failed", { tc: "TC-SEC-DEV-ME-01", error: err?.message });
      requiresDeviceVerification = false;
    }


    if (!user) return sendError(res, 404, "NOT_FOUND", "User not found");

    const landing = user.systemRole === "pv_admin" ? "/merchants" : "/merchant";
    return res.json({ user, memberships: user.merchantUsers, landing, requiresDeviceVerification });
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
    const pngBuffer = await QRCode.toBuffer(payload, {
      type: "png",
      errorCorrectionLevel: "M",
      margin: 2,
      scale: 8,
    });

    res.setHeader("Content-Type", "image/png");
    res.setHeader("Content-Disposition", `inline; filename="store-${storeId}-qr.png"`);
    res.setHeader("Cache-Control", "no-store");
    return res.send(pngBuffer);
  } catch (err) {
    return sendError(res, 500, "INTERNAL_ERROR", err?.message || "Failed to generate QR PNG");
  }
});

/* -----------------------------
   Merchant portal (JWT only) — extracted to src/merchant/merchant.portal.routes.js
-------------------------------- */
const { buildMerchantPortalRouter } = require("./src/merchant/merchant.portal.routes");

app.use(
  "/merchant",
  requireTrustedDeviceIfPrivileged,
  buildMerchantPortalRouter({
    prisma,
    requireJwt,
    sendError,
    handlePrismaError,
    emitPvHook,
    parseIntParam,
    assertActiveMerchant,
    crypto,
    bcrypt,
  })
);

/* -----------------------------
   Admin gate (JWT + admin key)
-------------------------------- */

function requireJwtOrAdminKey(req, res, next) {
  // If admin key is valid, skip JWT entirely (automation / scripts).
  const headerKey = req.headers["x-api-key"];
  const devQueryKey = req.query?.key;

  const okHeader = typeof headerKey === "string" && headerKey === ADMIN_API_KEY;
  const okDevQuery =
    NODE_ENV !== "production" &&
    typeof devQueryKey === "string" &&
    devQueryKey === ADMIN_API_KEY;

  // Dev convenience: if ADMIN_API_KEY is empty, allow through in non-prod.
  if (NODE_ENV !== "production" && !ADMIN_API_KEY) return next();

  if (okHeader || okDevQuery) return next();

  // Otherwise require JWT, then requireAdmin (pv_admin JWT path).
  return requireJwt(req, res, () => requireAdmin(req, res, next));
}

app.use(["/merchants", "/stores", "/users", "/admin", "/billing"], requireJwtOrAdminKey, requireTrustedDeviceIfPrivileged);

app.use("/admin/team", teamRoutes);


/* -----------------------------
   Admin: Merchants (JWT + admin key)
-------------------------------- */
/* =============================
   Admin-HR-1: Merchant Users
   - Merchant-scoped roles + contact fields + status lifecycle
   - NO Prisma/schema edits. NO migrations.
   ============================= */

/* -----------------------------
   Admin-HR-1: helpers
-------------------------------- */

function pvAssertMerchantRole(role) {
  if (!["owner", "merchant_admin", "store_admin", "store_subadmin"].includes(role)) {
    return { http: 400, code: "VALIDATION_ERROR", message: "Invalid MerchantRole" };
  }
  return null;
}

// MerchantUser contact fields are DB-only (schema.prisma is frozen in this thread).
// We detect columns at runtime and attach them to API responses when present.
let __pvMuContactColsCache = null;

async function pvResolveMerchantUserContactColumns(prisma) {
  if (__pvMuContactColsCache) return __pvMuContactColsCache;

  try {
    const rows = await prisma.$queryRawUnsafe(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND lower(table_name) = 'merchantuser'
    `);

    const cols = Array.isArray(rows) ? rows.map((r) => String(r.column_name)) : [];
    const phoneCandidates = ["phoneContact", "contactPhone", "phone_contact", "phone", "phoneRaw", "phoneE164"];
    const emailCandidates = ["emailContact", "contactEmail", "email_contact", "email"];

    const phoneCol = phoneCandidates.find((c) => cols.includes(c)) || null;
    const emailCol = emailCandidates.find((c) => cols.includes(c)) || null;

    __pvMuContactColsCache = { phoneCol, emailCol };
    return __pvMuContactColsCache;
  } catch {
    __pvMuContactColsCache = { phoneCol: null, emailCol: null };
    return __pvMuContactColsCache;
  }
}

function pvQuoteIdent(name) {
  // Defensive: only allow simple identifiers discovered from information_schema.
  // No quotes, no spaces, no punctuation.
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(String(name || ""))) return null;
  return `"${name}"`;
}

async function pvAttachMerchantUserContacts(prisma, merchantId, items) {
  if (!Array.isArray(items) || items.length === 0) return items;

  const cols = await pvResolveMerchantUserContactColumns(prisma);
  if (!cols.phoneCol && !cols.emailCol) return items;

  const phoneIdent = cols.phoneCol ? pvQuoteIdent(cols.phoneCol) : null;
  const emailIdent = cols.emailCol ? pvQuoteIdent(cols.emailCol) : null;
  if ((cols.phoneCol && !phoneIdent) || (cols.emailCol && !emailIdent)) return items;

  const selectParts = ['"id"'];
  if (phoneIdent) selectParts.push(`${phoneIdent} as "contactPhone"`);
  if (emailIdent) selectParts.push(`${emailIdent} as "contactEmail"`);

  const rows = await prisma.$queryRawUnsafe(
    `SELECT ${selectParts.join(", ")} FROM "MerchantUser" WHERE "merchantId" = $1`,
    merchantId
  );

  const map = new Map();
  (rows || []).forEach((r) => {
    map.set(Number(r.id), {
      contactPhone: r?.contactPhone ?? null,
      contactEmail: r?.contactEmail ?? null,
    });
  });

  return items.map((x) => {
    const extra = map.get(Number(x.id)) || { contactPhone: null, contactEmail: null };
    return { ...x, ...extra };
  });
}

async function pvReadMerchantUserContacts(prisma, merchantUserId) {
  const cols = await pvResolveMerchantUserContactColumns(prisma);
  if (!cols.phoneCol && !cols.emailCol) return { contactPhone: null, contactEmail: null };

  const phoneIdent = cols.phoneCol ? pvQuoteIdent(cols.phoneCol) : null;
  const emailIdent = cols.emailCol ? pvQuoteIdent(cols.emailCol) : null;
  if ((cols.phoneCol && !phoneIdent) || (cols.emailCol && !emailIdent)) return { contactPhone: null, contactEmail: null };

  const selectParts = ['"id"'];
  if (phoneIdent) selectParts.push(`${phoneIdent} as "contactPhone"`);
  if (emailIdent) selectParts.push(`${emailIdent} as "contactEmail"`);

  const rows = await prisma.$queryRawUnsafe(
    `SELECT ${selectParts.join(", ")} FROM "MerchantUser" WHERE "id" = $1`,
    merchantUserId
  );
  const r = Array.isArray(rows) && rows.length ? rows[0] : null;
  return { contactPhone: r?.contactPhone ?? null, contactEmail: r?.contactEmail ?? null };
}

/* -----------------------------
   Admin-HR-1: endpoints
-------------------------------- */

/**
 * GET /admin/merchants/:merchantId/users
 * Returns MerchantUsers for a merchant with embedded User identity, plus optional contact fields.
 */
app.get("/admin/merchants/:merchantId/users", async (req, res) => {
  const merchantId = parseIntParam(req.params.merchantId);
  if (!merchantId) return sendError(res, 400, "VALIDATION_ERROR", "Invalid merchantId");

  try {
    const list = await prisma.merchantUser.findMany({
      where: { merchantId },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            systemRole: true,
            status: true,
            createdAt: true,
            updatedAt: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    const withContacts = await pvAttachMerchantUserContacts(prisma, merchantId, list);

    emitPvHook("admin.hr.merchantUsers.list", {
      tc: "TC-ADMIN-HR-01",
      sev: "info",
      merchantId,
      count: withContacts.length,
    });

    return res.json(withContacts);
  } catch (e) {
    return handlePrismaError(e, res);
  }
});

/**
 * GET /admin/merchant-users/:merchantUserId
 * Detail view: MerchantUser + embedded User identity (+ optional contact fields).
 */
app.get("/admin/merchant-users/:merchantUserId", async (req, res) => {
  const id = parseIntParam(req.params.merchantUserId);
  if (!id) return sendError(res, 400, "VALIDATION_ERROR", "Invalid merchantUserId");

  try {
    const mu = await prisma.merchantUser.findUnique({
      where: { id },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            systemRole: true,
            status: true,
            createdAt: true,
            updatedAt: true,
          },
        },
      },
    });
    if (!mu) return sendError(res, 404, "MERCHANT_USER_NOT_FOUND", "MerchantUser not found");

    const contacts = await pvReadMerchantUserContacts(prisma, mu.id);
    const out = { ...mu, ...contacts };

    emitPvHook("admin.hr.merchantUser.get", {
      tc: "TC-ADMIN-HR-01B",
      sev: "info",
      merchantId: mu.merchantId,
      merchantUserId: mu.id,
    });

    return res.json(out);
  } catch (e) {
    return handlePrismaError(e, res);
  }
});

/**
 * PATCH /admin/merchant-users/:merchantUserId
 * Body may include: role, statusReason, contactPhone, contactEmail
 * Note: status transitions are handled by suspend/reactivate/archive endpoints.
 */
app.patch("/admin/merchant-users/:merchantUserId", async (req, res) => {
  const id = parseIntParam(req.params.merchantUserId);
  if (!id) return sendError(res, 400, "VALIDATION_ERROR", "Invalid merchantUserId");

  const { role, statusReason, contactPhone, contactEmail } = req.body || {};

  if (role) {
    const err = pvAssertMerchantRole(role);
    if (err) return sendError(res, err.http, err.code, err.message);
  }
  if (statusReason !== undefined && statusReason !== null && typeof statusReason !== "string") {
    return sendError(res, 400, "VALIDATION_ERROR", "statusReason must be a string or null");
  }

  try {
    // Update Prisma-managed fields first.
    const updated = await prisma.merchantUser.update({
      where: { id },
      data: {
        ...(role ? { role } : {}),
        ...(statusReason !== undefined ? { statusReason } : {}),
        ...(statusReason !== undefined ? { statusUpdatedAt: new Date() } : {}),
      },
      select: { id: true, merchantId: true },
    });

    // Update optional DB-only contact fields (if columns exist).
    await (async () => {
      const cols = await pvResolveMerchantUserContactColumns(prisma);
      if (!cols.phoneCol && !cols.emailCol) return;

      const sets = [];
      const params = [];
      let idx = 1;

      if (cols.phoneCol && contactPhone !== undefined) {
        const ident = pvQuoteIdent(cols.phoneCol);
        if (ident) {
          sets.push(`${ident} = $${idx++}`);
          params.push(contactPhone ?? null);
        }
      }
      if (cols.emailCol && contactEmail !== undefined) {
        const ident = pvQuoteIdent(cols.emailCol);
        if (ident) {
          sets.push(`${ident} = $${idx++}`);
          params.push(contactEmail ?? null);
        }
      }

      if (sets.length === 0) return;

      const sql = `UPDATE "MerchantUser" SET ${sets.join(", ")}, "updatedAt" = NOW() WHERE "id" = $${idx}`;
      params.push(id);
      await prisma.$executeRawUnsafe(sql, ...params);
    })();

    emitPvHook("admin.hr.merchantUser.update", {
      tc: "TC-ADMIN-HR-02",
      sev: "info",
      merchantId: updated.merchantId,
      merchantUserId: updated.id,
    });

    // Return the fresh detail payload.
    const mu = await prisma.merchantUser.findUnique({
      where: { id },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            systemRole: true,
            status: true,
            createdAt: true,
            updatedAt: true,
          },
        },
      },
    });
    const contacts = await pvReadMerchantUserContacts(prisma, id);

    return res.json({ ...mu, ...contacts });
  } catch (e) {
    return handlePrismaError(e, res);
  }
});

/**
 * POST /admin/merchant-users/:merchantUserId/suspend
 */
app.post("/admin/merchant-users/:merchantUserId/suspend", async (req, res) => {
  const id = parseIntParam(req.params.merchantUserId);
  if (!id) return sendError(res, 400, "VALIDATION_ERROR", "Invalid merchantUserId");

  try {
    const mu = await prisma.merchantUser.update({
      where: { id },
      data: {
        status: "suspended",
        suspendedAt: new Date(),
        statusUpdatedAt: new Date(),
      },
    });

    emitPvHook("admin.hr.merchantUser.suspend", {
      tc: "TC-ADMIN-HR-03",
      sev: "info",
      merchantId: mu.merchantId,
      merchantUserId: mu.id,
    });

    return res.json(mu);
  } catch (e) {
    return handlePrismaError(e, res);
  }
});

/**
 * POST /admin/merchant-users/:merchantUserId/reactivate
 */
app.post("/admin/merchant-users/:merchantUserId/reactivate", async (req, res) => {
  const id = parseIntParam(req.params.merchantUserId);
  if (!id) return sendError(res, 400, "VALIDATION_ERROR", "Invalid merchantUserId");

  try {
    const mu = await prisma.merchantUser.update({
      where: { id },
      data: {
        status: "active",
        suspendedAt: null,
        statusUpdatedAt: new Date(),
      },
    });

    emitPvHook("admin.hr.merchantUser.reactivate", {
      tc: "TC-ADMIN-HR-04",
      sev: "info",
      merchantId: mu.merchantId,
      merchantUserId: mu.id,
    });

    return res.json(mu);
  } catch (e) {
    return handlePrismaError(e, res);
  }
});

/**
 * POST /admin/merchant-users/:merchantUserId/archive
 */
app.post("/admin/merchant-users/:merchantUserId/archive", async (req, res) => {
  const id = parseIntParam(req.params.merchantUserId);
  if (!id) return sendError(res, 400, "VALIDATION_ERROR", "Invalid merchantUserId");

  try {
    const mu = await prisma.merchantUser.update({
      where: { id },
      data: {
        status: "archived",
        archivedAt: new Date(),
        statusUpdatedAt: new Date(),
      },
    });

    emitPvHook("admin.hr.merchantUser.archive", {
      tc: "TC-ADMIN-HR-05",
      sev: "info",
      merchantId: mu.merchantId,
      merchantUserId: mu.id,
    });

    return res.json(mu);
  } catch (e) {
    return handlePrismaError(e, res);
  }
});

/**
 * GET /admin/users
 * Query param: email (optional, substring match, case-insensitive)
 * Returns identity-only fields (NEVER passwordHash).
 */
app.get("/admin/users", async (req, res) => {
  try {
    const q = String(req.query?.email || "").trim().toLowerCase();
    const where = q ? { email: { contains: q, mode: "insensitive" } } : {};

    const users = await prisma.user.findMany({
      where,
      take: 25,
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        email: true,
        systemRole: true,
        status: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    emitPvHook("admin.hr.users.search", { tc: "TC-ADMIN-HR-06", sev: "info", q, count: users.length });
    return res.json(users);
  } catch (e) {
    return handlePrismaError(e, res);
  }
});

/**
 * POST /admin/merchants/:merchantId/users
 * Attach an existing user OR create a new user, then upsert MerchantUser membership.
 *
 * Body (either):
 *  - { userId, role, contactPhone?, contactEmail? }
 *  - { email, tempPassword, role, contactPhone?, contactEmail? }
 */
app.post("/admin/merchants/:merchantId/users", requireAdmin, async (req, res) => {
  const merchantId = parseIntParam(req.params.merchantId);
  if (!merchantId) return sendError(res, 400, "VALIDATION_ERROR", "Invalid merchantId");

  const { userId, email, role, contactPhone, contactEmail, sendInvite } = req.body || {};

  const roleErr = pvAssertMerchantRole(role);
  if (roleErr) return sendError(res, roleErr.http, roleErr.code, roleErr.message);

  try {
    const merchant = await prisma.merchant.findUnique({ where: { id: merchantId }, select: { id: true } });
    if (!merchant) return sendError(res, 404, "MERCHANT_NOT_FOUND", "Merchant not found");

    let user = null;
    let shouldInvite = Boolean(sendInvite);

    if (userId) {
      const uid = parseIntParam(userId);
      if (!uid) return sendError(res, 400, "VALIDATION_ERROR", "Invalid userId");

      user = await prisma.user.findUnique({
        where: { id: uid },
        select: { id: true, email: true, systemRole: true, status: true, passwordUpdatedAt: true, createdAt: true, updatedAt: true },
      });
      if (!user) return sendError(res, 404, "USER_NOT_FOUND", "User not found");
      // If the user has never set a password, default to inviting (unless explicitly disabled)
      if (sendInvite === undefined && !user.passwordUpdatedAt) shouldInvite = true;
    } else {
      const e = String(email || "").trim().toLowerCase();
      if (!e) return sendError(res, 400, "VALIDATION_ERROR", "email is required when userId is not provided");

      const existing = await prisma.user.findUnique({
        where: { email: e },
        select: { id: true, email: true, systemRole: true, status: true, passwordUpdatedAt: true, createdAt: true, updatedAt: true },
      });

      if (existing) {
        user = existing;
        if (sendInvite === undefined && !user.passwordUpdatedAt) shouldInvite = true;
      } else {
        // Create the user WITHOUT requiring the creator to choose a password.
        // passwordHash must be non-null; we store a strong random hash placeholder until the user sets a real password.
        const placeholder = crypto.randomBytes(32).toString("hex");
        const hash = await bcrypt.hash(placeholder, 12);

        user = await prisma.user.create({
          data: { email: e, passwordHash: hash, systemRole: "user", status: "active" },
          select: { id: true, email: true, systemRole: true, status: true, passwordUpdatedAt: true, createdAt: true, updatedAt: true },
        });

        // New user: invite by default unless explicitly disabled
        if (sendInvite === undefined) shouldInvite = true;
      }
    }

    const mu = await prisma.merchantUser.upsert({
      where: { merchantId_userId: { merchantId, userId: user.id } },
      update: {
        role,
        status: "active",
        suspendedAt: null,
        statusUpdatedAt: new Date(),
      },
      create: {
        merchantId,
        userId: user.id,
        role,
        status: "active",
        statusUpdatedAt: new Date(),
      },
    });

    // Optional DB-only contacts
    await (async () => {
      const cols = await pvResolveMerchantUserContactColumns(prisma);
      if (!cols.phoneCol && !cols.emailCol) return;

      const sets = [];
      const params = [];
      let idx = 1;

      if (cols.phoneCol && contactPhone !== undefined) {
        const ident = pvQuoteIdent(cols.phoneCol);
        if (ident) {
          sets.push(`${ident} = $${idx++}`);
          params.push(contactPhone ?? null);
        }
      }
      if (cols.emailCol && contactEmail !== undefined) {
        const ident = pvQuoteIdent(cols.emailCol);
        if (ident) {
          sets.push(`${ident} = $${idx++}`);
          params.push(contactEmail ?? null);
        }
      }

      if (sets.length === 0) return;

      const sql = `UPDATE "MerchantUser" SET ${sets.join(", ")}, "updatedAt" = NOW() WHERE "id" = $${idx}`;
      params.push(mu.id);
      await prisma.$executeRawUnsafe(sql, ...params);
    })();

    // Issue an invite token (reuse PasswordResetToken + /reset-password UI).
    let invite = null;
    if (shouldInvite && user.status === "active") {
      invite = await pvIssueInviteToken(prisma, req, user.id, user.email);
    }

    emitPvHook("admin.hr.merchantUser.createOrAttach", {
      tc: "TC-ADMIN-HR-07",
      sev: "info",
      merchantId,
      userId: user.id,
      merchantUserId: mu.id,
      role,
      invited: Boolean(invite),
    });

    const contacts = await pvReadMerchantUserContacts(prisma, mu.id);
    return res.json({ ...mu, user: { ...user, passwordUpdatedAt: user.passwordUpdatedAt ?? null }, ...contacts, inviteSent: Boolean(invite) });
  } catch (e) {
    return handlePrismaError(e, res);
  }
});

app.post("/merchants", async (req, res) => {
  const { name, billingEmail } = req.body || {};

  try {
    const merchantName = String(name || "").trim();
    if (!merchantName) {
      return sendError(res, 400, "VALIDATION_ERROR", "name is required");
    }

    const providedEmail = billingEmail ? String(billingEmail).trim().toLowerCase() : "";

    const merchant = await prisma.$transaction(async (tx) => {
      // 1) Create Merchant
      const m = await tx.merchant.create({
        data: { name: merchantName },
      });

      // 2) Create BillingAccount immediately (required invariant)
      // billingEmail is REQUIRED by schema.
      const emailToUse = providedEmail || `billing+merchant${m.id}@example.com`;

      await tx.billingAccount.create({
        data: {
          merchantId: m.id,
          billingEmail: emailToUse,
          provider: "manual", // keep Stripe out for now
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

/* -----------------------------
   Admin: Create Store under Merchant (Thread V2)
   POST /admin/merchants/:merchantId/stores
   - Requires JWT + admin gate (see app.use above)
   - Validates merchantId + name
   - Persists Store with merchantId
   - No schema changes / no migrations
-------------------------------- */

app.post("/admin/merchants/:merchantId/stores", requireAdmin, async (req, res) => {
  const merchantId = parseIntParam(req.params.merchantId);
  const { name } = req.body || {};

  if (!merchantId) return sendError(res, 400, "VALIDATION_ERROR", "Invalid merchantId");

  const storeName = String(name || "").trim();
  if (!storeName) return sendError(res, 400, "VALIDATION_ERROR", "name is required");

  try {
    const result = await prisma.$transaction(async (tx) => {
      const merchant = await tx.merchant.findUnique({ where: { id: merchantId } });
      const gateErr = assertActiveMerchant(merchant);
      if (gateErr) return { error: gateErr };

      const store = await tx.store.create({
        data: {
          merchantId,
          name: storeName,
          status: "active",
        },
      });

      return { store };
    });

    if (result?.error) return sendError(res, result.error.http, result.error.code, result.error.message);
    return res.status(201).json(result.store);
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

let acct = await prisma.billingAccount.findUnique({
  where: { merchantId },
  select: { id: true },
});

if (!acct) {
  const billingAccount = await ensureBillingAccountForMerchant(merchantId);
  acct = billingAccount ? { id: billingAccount.id } : null;
}

if (!acct) {
  return sendError(res, 409, "BILLING_NOT_READY", "Billing setup is not complete for this merchant yet.");
}
    const invoice = await prisma.invoice.create({
      data: {
        billingAccountId: acct.id,
        merchantId,
        status: "draft",
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

app.post("/admin/invoices/generate", handleAdminGenerateInvoice);
app.post("/admin/billing/generate-invoice", handleAdminGenerateInvoice);

app.get("/admin/invoices/:invoiceId", requireAdmin, async (req, res) => {
  const invoiceId = Number(req.params.invoiceId);
  if (!Number.isInteger(invoiceId)) return sendError(res, 400, "VALIDATION_ERROR", "Invalid invoiceId");

  try {
    const invoice = await prisma.invoice.findUnique({
      where: { id: invoiceId },
      include: {
        lineItems: true,
        payments: true,
      },
    });

    if (!invoice) return sendError(res, 404, "NOT_FOUND", "Invoice not found");

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

app.post("/admin/invoices/:invoiceId/issue", requireAdmin, async (req, res) => {
  const invoiceId = Number(req.params.invoiceId);
  const { netTermsDays } = req.body || {};

  if (!Number.isInteger(invoiceId)) return sendError(res, 400, "VALIDATION_ERROR", "Invalid invoiceId");

  try {
    const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } });
    if (!invoice) return sendError(res, 404, "NOT_FOUND", "Invoice not found");

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

app.get("/admin/invoices/:invoiceId/late-fee-preview", requireAdmin, async (req, res) => {
  try {
    const invoiceId = Number(req.params.invoiceId);
    if (!Number.isInteger(invoiceId)) {
      return sendError(res, 400, "VALIDATION_ERROR", "Invalid invoiceId");
    }

    const original = await prisma.invoice.findUnique({
      where: { id: invoiceId },
      include: { lineItems: true },
    });

    if (!original) return sendError(res, 404, "NOT_FOUND", "Invoice not found");

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
  if (!Number.isInteger(invoiceId)) return sendError(res, 400, "VALIDATION_ERROR", "Invalid invoiceId");

  try {
    const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } });
    if (!invoice) return sendError(res, 404, "NOT_FOUND", "Invoice not found");

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


// Mail-Flow-3: Invoice Mail Run Scheduler (env-guarded)
startInvoiceMailRunScheduler({
  prisma,
  publicBaseUrl: process.env.PUBLIC_BASE_URL,
});

// Mail-Flow-4: Invoice Reminder Scheduler (env-guarded)
startInvoiceReminderMailRunScheduler({
  prisma,
  publicBaseUrl: process.env.PUBLIC_BASE_URL,
});

app.listen(PORT, () => {
  console.log(`PerkValet backend listening on http://localhost:${PORT}`);
  console.log(`NODE_ENV=${NODE_ENV}`);
  console.log(`ADMIN_API_KEY ${ADMIN_API_KEY ? "ENABLED" : "DISABLED (set ADMIN_API_KEY to protect admin routes)"}`);
  console.log(`CORS_ORIGIN=${process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN : "(open/dev)"}`);
  console.log(`BILLING_POLICY_FILE=${BILLING_POLICY_FILE}`);
});