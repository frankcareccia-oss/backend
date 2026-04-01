// src/middleware/auth.js
const jwt = require("jsonwebtoken");
const { prisma } = require("../db/prisma");
const { sendError } = require("../utils/errors");
const { parseIntParam } = require("../utils/helpers");

const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-me";
const ADMIN_API_KEY = process.env.ADMIN_API_KEY || "";
const NODE_ENV = process.env.NODE_ENV || "development";

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

function requireAdmin(req, res, next) {
  if (req.userId && req.systemRole === "pv_admin") return next();

  if (NODE_ENV === "production" && !ADMIN_API_KEY) {
    return sendError(res, 500, "SERVER_MISCONFIG", "ADMIN_API_KEY is not configured in production");
  }

  if (!ADMIN_API_KEY) return next();

  const headerKey = req.headers["x-api-key"];
  const devQueryKey = req.query?.key;

  const okHeader = typeof headerKey === "string" && headerKey === ADMIN_API_KEY;
  const okDevQuery = NODE_ENV !== "production" && typeof devQueryKey === "string" && devQueryKey === ADMIN_API_KEY;

  if (okHeader || okDevQuery) return next();

  return sendError(res, 401, "UNAUTHORIZED", "Admin authorization required");
}

function requireBillingStaff(req, res, next) {
  if (req.userId && ["pv_admin", "pv_ar_clerk"].includes(req.systemRole)) return next();
  return sendError(res, 403, "FORBIDDEN", "Billing staff access required");
}

// Requires caller to be an active member of the merchant with one of the allowed merchant roles.
// Attaches req.merchantRole, req.merchantId, and req.callerMerchantUser.
//
// merchantId resolution order:
//   1. req.params.merchantId  (admin-style routes: /admin/merchants/:merchantId/...)
//   2. any previously set req.merchantId
//   3. look up by userId alone (merchant-facing routes: /merchant/products, etc.)
function requireMerchantRole(...allowedRoles) {
  return async (req, res, next) => {
    const paramMerchantId = parseIntParam(req.params.merchantId);
    const knownMerchantId = paramMerchantId || req.merchantId || null;

    const where = knownMerchantId
      ? { userId: req.userId, merchantId: knownMerchantId, status: "active" }
      : { userId: req.userId, status: "active" };

    const mu = await prisma.merchantUser.findFirst({
      where,
      select: { id: true, role: true, merchantId: true },
    });

    if (!mu) return sendError(res, 403, "FORBIDDEN", "Not a member of this merchant");
    if (allowedRoles.length && !allowedRoles.includes(mu.role)) {
      return sendError(res, 403, "FORBIDDEN", "Insufficient merchant role");
    }

    req.merchantRole = mu.role;
    req.merchantId = mu.merchantId;
    req.callerMerchantUser = mu;
    return next();
  };
}

// Consumer JWT — issued by consumer.auth.routes.js
// Claims: { consumerId, phone, role: "consumer" }
async function requireConsumerJwt(req, res, next) {
  const header = req.headers.authorization || "";
  const [type, token] = header.split(" ");

  if (type !== "Bearer" || !token) {
    return sendError(res, 401, "UNAUTHORIZED", "Missing Bearer token");
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET);

    if (payload.role !== "consumer" || !payload.consumerId) {
      return sendError(res, 401, "UNAUTHORIZED", "Invalid consumer token");
    }

    const consumer = await prisma.consumer.findUnique({
      where: { id: payload.consumerId },
      select: { id: true, status: true, phoneE164: true },
    });

    if (!consumer || consumer.status !== "active") {
      return sendError(res, 401, "UNAUTHORIZED", "Consumer not found or inactive");
    }

    req.consumerId = consumer.id;
    req.consumerPhone = consumer.phoneE164;
    return next();
  } catch {
    return sendError(res, 401, "UNAUTHORIZED", "Invalid or expired token");
  }
}

module.exports = { requireJwt, requireAdmin, requireBillingStaff, requireMerchantRole, requireConsumerJwt };
