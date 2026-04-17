// index.js
require("dotenv").config({ override: true });

const { buildShortPayRouter } = require("./src/payments/shortpay.routes");
const buildAuthRouter = require("./src/auth/auth.routes");
const {
  isPosOnlyMerchantUser,
  canAccessInvoicesForMerchant,
  normalizeRole,
  normalizeMemberStatus,
  buildRequireMerchantUserManager,
} = require("./src/merchant/merchant.authz");

const { sendMail } = require("./src/utils/mail");

console.log("PerkValet backend loaded: pv-merchant-users-fix-v5");

const { createBillingPolicyStore } = require("./src/billing/billing.service");
const { buildBillingHelpers } = require("./src/billing/billing.helpers");

const { registerPaymentsRoutes } = require("./src/payments/payments.routes");
const { registerPosRoutes } = require("./src/pos/pos.routes");
const { registerConsumersRoutes } = require("./src/consumers/consumers.routes");

const { registerPosProvisioningRoutes } = require("./src/pos/pos.provisioning.routes");
const { registerSquareOAuthRoutes } = require("./src/pos/square.oauth.routes");
const { registerSquareWebhookRoute } = require("./src/pos/square.webhook.routes");
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
const catalogRouter = require("./src/catalog/catalog.routes");
const categoryRouter = require("./src/catalog/category.routes");
const storeProductRouter = require("./src/catalog/storeproduct.routes");
const bundleRouter = require("./src/bundles/bundle.routes");

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
const PUBLIC_BASE_URL = String(process.env.PUBLIC_BASE_URL || "http://localhost:5175").replace(/\/$/, "");

const NODE_ENV = process.env.NODE_ENV || "development";
const ADMIN_API_KEY = process.env.ADMIN_API_KEY || "";

const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-me";
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "15m";

// Optional: behind reverse proxy?
if (process.env.TRUST_PROXY === "1") {
  app.set("trust proxy", 1);
}

// Capture raw body for webhook HMAC verification — must run before any body parser
app.use("/webhooks/square", (req, res, next) => {
  const chunks = [];
  req.on("data", chunk => chunks.push(chunk));
  req.on("end", () => { req.rawBody = Buffer.concat(chunks); next(); });
  req.on("error", next);
});
app.use("/webhooks/clover", (req, res, next) => {
  const chunks = [];
  req.on("data", chunk => chunks.push(chunk));
  req.on("end", () => { req.rawBody = Buffer.concat(chunks); next(); });
  req.on("error", next);
});
app.use("/webhooks/toast", (req, res, next) => {
  const chunks = [];
  req.on("data", chunk => chunks.push(chunk));
  req.on("end", () => { req.rawBody = Buffer.concat(chunks); next(); });
  req.on("error", next);
});

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

function emitPvHook(event, extras = {}) {
  try {
    if (typeof globalThis.pvHook === "function") return globalThis.pvHook(event, extras);
  } catch { }
  console.log(JSON.stringify({ pvHook: event, ts: new Date().toISOString(), ...extras }));
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
  if (base) return `${base.replace(/\/$/, "")}/#/reset-password?token=${encodeURIComponent(token)}`;

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

// Allows pv_admin and pv_ar_clerk (billing staff) via JWT
function requireBillingStaff(req, res, next) {
  if (req.userId && ["pv_admin", "pv_ar_clerk"].includes(req.systemRole)) {
    return next();
  }
  return sendError(res, 403, "FORBIDDEN", "Billing staff access required");
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

const billingHelpers = buildBillingHelpers({
  prisma,
  getGlobalBillingPolicy: () => BILLING_POLICY,
});

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
  publicBaseUrl: PUBLIC_BASE_URL,
});

app.post(
  "/webhooks/stripe",
  express.raw({ type: "application/json" }),
  paymentsReg.stripeWebhookHandler()
);

app.use(paymentsReg.router);

// Square webhook — must be mounted with express.raw BEFORE express.json
registerSquareWebhookRoute(app);

// Clover webhook — must be mounted with express.raw BEFORE express.json
const { registerCloverWebhookRoute } = require("./src/pos/clover.webhook.routes");
registerCloverWebhookRoute(app);

// Toast webhook — must be mounted with express.raw BEFORE express.json
const { registerToastWebhookRoute } = require("./src/pos/toast.webhook.routes");
registerToastWebhookRoute(app);

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

// Square OAuth + location-mapping routes (JWT-protected)
registerSquareOAuthRoutes(app, {
  prisma,
  sendError,
  requireAuth: requireJwt,
  requireAdmin,
});

// Clover OAuth + connection management (JWT-protected)
const { buildCloverOAuthRouter } = require("./src/pos/clover.oauth.routes");
app.use(buildCloverOAuthRouter({ requireJwt, sendError, emitPvHook }));

// Toast connection management (JWT-protected, client-credentials)
const { buildToastOAuthRouter } = require("./src/pos/toast.oauth.routes");
app.use(buildToastOAuthRouter({ requireJwt, sendError, emitPvHook }));

// Generic POS connection status — returns posType + connection state for the merchant
app.get("/pos/connect/status", requireJwt, async (req, res) => {
  try {
    let merchantId;
    if (req.systemRole === "pv_admin" && req.query.merchantId) {
      merchantId = parseInt(req.query.merchantId, 10);
    } else {
      const mu = await prisma.merchantUser.findFirst({
        where: { userId: req.userId, role: { in: ["owner", "merchant_admin"] } },
        select: { merchantId: true },
      });
      if (!mu) return sendError(res, 403, "FORBIDDEN", "Merchant owner or admin role required");
      merchantId = mu.merchantId;
    }

    const conn = await prisma.posConnection.findFirst({
      where: { merchantId },
      select: { id: true, posType: true, status: true, externalMerchantId: true, createdAt: true, updatedAt: true, lastCatalogSyncAt: true },
    });

    if (!conn) return res.json({ posType: null, connected: false });

    const locationCount = await prisma.posLocationMap.count({ where: { posConnectionId: conn.id, active: true } });
    const totalStores = await prisma.store.count({ where: { merchantId, status: "active" } });

    // Get per-store mapping details
    const stores = await prisma.store.findMany({
      where: { merchantId, status: "active" },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    });
    const maps = await prisma.posLocationMap.findMany({
      where: { posConnectionId: conn.id, active: true },
      select: { pvStoreId: true, externalLocationId: true, externalLocationName: true },
    });
    const mapByStore = {};
    maps.forEach(m => { mapByStore[m.pvStoreId] = m; });

    const storeStatuses = stores.map(s => ({
      storeId: s.id,
      storeName: s.name,
      mapped: !!mapByStore[s.id],
      externalLocationName: mapByStore[s.id]?.externalLocationName || null,
    }));

    res.json({
      posType: conn.posType,
      connected: conn.status === "active",
      connectionId: conn.id,
      locationCount,
      totalStores,
      storeStatuses,
      lastCatalogSyncAt: conn.lastCatalogSyncAt,
    });
  } catch (e) {
    sendError(res, 500, "SERVER_ERROR", e?.message);
  }
});

app.use(
  buildAuthRouter({
    prisma,
    sendError,
    handlePrismaError,
    emitPvHook,
    requireJwt,
    jwt,
    JWT_SECRET,
    JWT_EXPIRES_IN,
    bcrypt,
    crypto,
    sha256Hex,
    buildResetUrl,
  })
);

app.use(
  buildShortPayRouter({
    express,
    prisma,
    sendError,
    emitPvHook,
    paymentsReg,
    jwtSecret: JWT_SECRET,
  })
);

/* -----------------------------
   Public routes
-------------------------------- */

app.get("/", (_req, res) => res.json({ status: "PerkValet backend running ?" }));

// Grocery MVP — JWT-protected
const { buildGroceryRouter } = require("./src/grocery/grocery.routes");
app.use(buildGroceryRouter({ sendError, emitPvHook, requireJwt }));

const requireMerchantUserManager = buildRequireMerchantUserManager({
  prisma,
  sendError,
});

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
    ensureBillingAccountForMerchant: billingHelpers.ensureBillingAccountForMerchant,
  })
);

app.use(
  buildMerchantStoreTeamRouter({
    prisma,
    requireJwt,
    sendError,
    handlePrismaError,
    requireMerchantUserManager,
    parseIntParam,
    emitPvHook,
  })
);

app.use(
  buildMerchantStoreProfileRouter({
    prisma,
    requireJwt,
    sendError,
    handlePrismaError,
    emitPvHook,
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
    publicBaseUrl: PUBLIC_BASE_URL,
  })
);

// POS loyalty redemption (Phase B) — before global requireJwt
const posLoyaltyRouter = require("./src/pos/pos.loyalty.routes");
app.use(posLoyaltyRouter);

// Consumer auth + wallet + promotions (Phase B) — must be before global requireJwt
const consumerAuthRouter = require("./src/consumer/consumer.auth.routes");
app.use(consumerAuthRouter);
const consumerWalletRouter = require("./src/consumer/consumer.wallet.routes");
app.use(consumerWalletRouter);
const consumerPromosRouter = require("./src/consumer/consumer.promotions.routes");
app.use(consumerPromosRouter);
const consumerCheckinRouter = require("./src/consumer/consumer.checkin.routes");
app.use(consumerCheckinRouter);
const consumerDiscoverRouter = require("./src/consumer/consumer.discover.routes");
app.use(consumerDiscoverRouter);

const growthRouter = require("./src/growth/growth.routes");
app.use(growthRouter);
const merchantReportingRouter = require("./src/merchant/merchant.reporting.routes");
app.use(merchantReportingRouter);
const promotionOutcomeRouter = require("./src/growth/promotionOutcome.routes");
app.use(promotionOutcomeRouter);

const buildAdminRouter = require("./src/admin/admin.routes");

app.use(
  requireJwt,
  buildAdminRouter({
    prisma,
    requireAdmin,
    requireJwt,
    sendError,
    handlePrismaError,
    parseIntParam,
    validateBillingPolicy,
    saveBillingPolicyToDisk,
    BILLING_POLICY,
    ensureBillingAccountForMerchant: billingHelpers.ensureBillingAccountForMerchant,
    lateFeeEligibility: billingHelpers.lateFeeEligibility,
    findExistingLateFeeInvoice: billingHelpers.findExistingLateFeeInvoice,
    getMerchantPolicyBundle: billingHelpers.getMerchantPolicyBundle,
    requireBillingStaff,
    validateOverrides: billingHelpers.validateOverrides,
  })
);

const { buildPaymentEventRouter } = require("./src/payments/paymentEvent.routes");
app.use(buildPaymentEventRouter({ requireJwt, requireAdmin, sendError, emitPvHook }));

const { buildEventOpsRouter } = require("./src/events/event.ops.routes");
app.use(buildEventOpsRouter({ prisma, requireJwt, requireAdmin, sendError, emitPvHook }));

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
    requireJwt,
    requireAdmin,
    publicBaseUrl: PUBLIC_BASE_URL,
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

// Catalog (E.2) — new domain, imports utilities directly
app.use(catalogRouter);
app.use(categoryRouter);
app.use(storeProductRouter);
app.use(bundleRouter);

// Promotions & Loyalty (Thread E) — PromoItem / Promotion / OfferSet
const promoRouter = require("./src/promo/promo.routes");
app.use(promoRouter);

// Reporting (Thread R)
const reportingRouter = require("./src/reporting/reporting.routes");
app.use(reportingRouter);

// Consumer routes registered above (before global requireJwt wall)

// Consumer identity (Thread 2)
registerConsumersRoutes(app, {
  prisma,
  sendError,
  requireJwt,
  emitPvHook,
});

/* -----------------------------
   Server
-------------------------------- */

if (require.main === module) app.listen(PORT, () => {
  console.log(`PerkValet backend listening on http://localhost:${PORT}`);
  console.log(`NODE_ENV=${NODE_ENV}`);
  console.log(`ADMIN_API_KEY ${ADMIN_API_KEY ? "ENABLED" : "DISABLED (set ADMIN_API_KEY to protect admin routes)"}`);
  console.log(`CORS_ORIGIN=${process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN : "(open/dev)"}`);
  console.log(`BILLING_POLICY_FILE=${BILLING_POLICY_FILE}`);

  // ── Scheduled Jobs (node-cron) ──────────────────────────────────────────────
  const cron = require("node-cron");

  // Growth Advisor — recompute promotion outcomes every 6 hours
  const { computeAllPromotionOutcomes } = require("./src/growth/promotionOutcome.aggregate");
  cron.schedule("0 */6 * * *", async () => {
    console.log("[PV Cron] recomputing promotion outcomes...");
    computeAllPromotionOutcomes(prisma).catch((e) => {
      console.error("[PV Cron] outcome recompute failed:", e?.message || String(e));
    });
  }, { timezone: "UTC" });

  // Gift Card Reconciliation — compare Square balances against ledger daily at 3 AM UTC
  const { reconcileGiftCardBalances } = require("./src/pos/pos.giftcard");
  cron.schedule("0 3 * * *", async () => {
    console.log("[PV Cron] reconciling gift card balances...");
    reconcileGiftCardBalances().catch((e) => {
      console.error("[PV Cron] gift card reconciliation failed:", e?.message || String(e));
    });
  }, { timezone: "UTC" });

  // Reward Expiry — send notifications + expire overdue rewards daily at 8 AM UTC
  const { runRewardExpiryCron } = require("./src/cron/reward.expiry.cron");
  cron.schedule("0 8 * * *", async () => {
    console.log("[PV Cron] running reward expiry check...");
    runRewardExpiryCron().catch((e) => {
      console.error("[PV Cron] reward expiry cron failed:", e?.message || String(e));
    });
  }, { timezone: "UTC" });

  // Seed Data — generate staging transactions at noon + 5pm Pacific
  const { runSeedCron } = require("./src/cron/seed.data.cron");
  cron.schedule("0 12 * * *", async () => {
    console.log("[PV Cron] seed data — morning window...");
    runSeedCron({ window: "morning" }).catch((e) => {
      console.error("[PV Cron] seed morning failed:", e?.message || String(e));
    });
  }, { timezone: "America/Los_Angeles" });
  cron.schedule("0 17 * * *", async () => {
    console.log("[PV Cron] seed data — afternoon window...");
    runSeedCron({ window: "afternoon" }).catch((e) => {
      console.error("[PV Cron] seed afternoon failed:", e?.message || String(e));
    });
  }, { timezone: "America/Los_Angeles" });

  // Reporting Aggregation — nightly at 2 AM UTC
  const { runReportingAggregation } = require("./src/cron/reporting.aggregate.cron");
  cron.schedule("0 2 * * *", async () => {
    console.log("[PV Cron] nightly reporting aggregation starting...");
    try {
      const result = await runReportingAggregation();
      console.log("[PV Cron] reporting aggregation complete:", JSON.stringify(result));
    } catch (e) {
      console.error("[PV Cron] reporting aggregation failed:", e?.message || String(e));
    }
  }, { timezone: "UTC" });

  // Event Publisher — poll outbox and dispatch to consumers
  const { bootstrapEventPublisher } = require("./src/events/event.bootstrap");
  const eventPublisher = bootstrapEventPublisher(prisma, emitPvHook);
  eventPublisher.start(5000); // poll every 5 seconds
});

module.exports = app;