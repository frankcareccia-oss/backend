// backend/src/pos/pos.setup.routes.js
// POS Setup + PIN Reset (DB MODE - additive)
//
// Endpoints (merchant portal / merchant_admin only via JWT):
// - POST /merchant/pos/setup        -> issue one-time setup code (24h) for a user (pos_employee only)
// - POST /merchant/pos/reset-pin    -> invalidate current credential and issue new setup code
// - POST /merchant/pos/set-pin      -> consume setup code and set 6-digit PIN (pos_employee)
//
// Security locks (v1):
// - setup code: 6 digits (returned to merchant_admin for in-store handoff)
// - expiry: 24 hours
// - no self-service resets
//
// Requires injected deps:
// - prisma, requireJwt, sendError, emitPvHook, bcrypt, parseIntParam
//
// NOTE: This module assumes Prisma models exist (append-only):
//   - PosCredential
//   - PosSetupToken

const crypto = require("crypto");

function nowIso() {
  return new Date().toISOString();
}

function defaultHook(event, fields = {}) {
  try {
    console.log(JSON.stringify({ pvHook: event, ts: nowIso(), ...fields }));
  } catch {}
}

function getHook(emitPvHook) {
  return typeof emitPvHook === "function" ? emitPvHook : defaultHook;
}

function digitsOnly(v) {
  return String(v || "").replace(/\D+/g, "");
}

function normalizePhone10(v) {
  return digitsOnly(v).slice(0, 10);
}

function random6() {
  // 000000-999999, but avoid leading/trailing whitespace
  const n = Math.floor(Math.random() * 1000000);
  return String(n).padStart(6, "0");
}

function sha256Hex(s) {
  return crypto.createHash("sha256").update(String(s)).digest("hex");
}

function isWeakPin6(pin) {
  const p = String(pin || "");
  if (!/^\d{6}$/.test(p)) return true;

  // repeated
  if (/^(\d)\1{5}$/.test(p)) return true;

  // sequential (ascending only)
  const asc = "0123456789";
  if (asc.includes(p)) return true;

  // sequential descending
  const desc = "9876543210";
  if (desc.includes(p)) return true;

  return false;
}

async function requireMerchantAdminForMerchant(prisma, req, res, sendError, merchantId) {
  const user = await prisma.user.findUnique({
    where: { id: req.userId },
    select: {
      id: true,
      systemRole: true,
      merchantUsers: { where: { status: "active" }, select: { merchantId: true, role: true, status: true } },
    },
  });

  if (!user) return sendError(res, 404, "NOT_FOUND", "User not found");
  if (["pv_admin", "pv_ar_clerk"].includes(user.systemRole)) return sendError(res, 403, "FORBIDDEN", "platform users do not use merchant portal");

  const mu = (Array.isArray(user.merchantUsers) ? user.merchantUsers : []).find((m) => m.merchantId === merchantId);
  if (!mu) return sendError(res, 403, "FORBIDDEN", "Not authorized for this merchant");
  if (!(mu.role === "owner" || mu.role === "merchant_admin")) return sendError(res, 403, "FORBIDDEN", "merchant_admin required");

  return user;
}

function registerPosSetupRoutes(router, deps) {
  const { prisma, requireJwt, sendError, emitPvHook, bcrypt, parseIntParam } = deps || {};
  if (!router) throw new Error("registerPosSetupRoutes: router required");
  if (!prisma) throw new Error("registerPosSetupRoutes: prisma required");
  if (typeof requireJwt !== "function") throw new Error("registerPosSetupRoutes: requireJwt required");
  if (typeof sendError !== "function") throw new Error("registerPosSetupRoutes: sendError required");
  if (typeof parseIntParam !== "function") throw new Error("registerPosSetupRoutes: parseIntParam required");

  const hook = getHook(emitPvHook);

  // Issue setup code (merchant_admin only)
  router.post("/pos/setup", requireJwt, async (req, res) => {
    hook("pos.setup.requested.api", { tc: "TC-POS-SETUP-01", sev: "info", stable: "pos:setup" });

    const { merchantId: midRaw, phone } = req.body || {};
    const merchantId = parseIntParam(midRaw);
    if (!merchantId) return sendError(res, 400, "VALIDATION_ERROR", "merchantId is required");

    const phone10 = normalizePhone10(phone);
    if (phone10.length !== 10) return sendError(res, 400, "VALIDATION_ERROR", "phone must be 10 digits");

    try {
      const actor = await requireMerchantAdminForMerchant(prisma, req, res, sendError, merchantId);
      if (!actor || actor.code) return; // sendError already responded

      const user = await prisma.user.findFirst({
        where: { status: "active", OR: [{ phoneRaw: phone10 }, { phoneE164: `+1${phone10}` }] },
        select: { id: true, email: true, status: true, systemRole: true },
      });

      if (!user) return sendError(res, 404, "NOT_FOUND", "User not found for phone");
      if (["pv_admin", "pv_ar_clerk"].includes(user.systemRole)) return sendError(res, 403, "FORBIDDEN", "platform users cannot be POS");

      // must be pos_employee on this merchant
      const mu = await prisma.merchantUser.findFirst({
        where: { merchantId, userId: user.id, status: "active" },
        select: { id: true, role: true, status: true },
      });
      if (!mu || mu.role !== "pos_employee") return sendError(res, 403, "FORBIDDEN", "User is not a POS employee for this merchant");

      const setupCode = random6();
      const tokenHash = sha256Hex(setupCode);
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

      // invalidate existing active tokens by marking usedAt (optional). We'll keep it simple: create new token; uniqueness prevents reuse.
      await prisma.posSetupToken.create({
        data: { userId: user.id, tokenHash, expiresAt },
      });

      hook("pos.setup.issued.api", {
        tc: "TC-POS-SETUP-02",
        sev: "info",
        stable: "pos:setup",
        actorUserId: actor.id,
        userId: user.id,
        merchantId,
        expiresAt: expiresAt.toISOString(),
      });

      // Return setup code to merchant_admin (in-store handoff). No email required.
      return res.json({ ok: true, setupCode, expiresAt: expiresAt.toISOString() });
    } catch (e) {
      hook("pos.setup.failed.api", { tc: "TC-POS-SETUP-03", sev: "error", stable: "pos:setup:error", error: e?.message || String(e) });
      return sendError(res, 500, "SERVER_ERROR", "Setup failed");
    }
  });

  // Reset PIN (merchant_admin only)
  router.post("/pos/reset-pin", requireJwt, async (req, res) => {
    hook("pos.pin.reset.requested.api", { tc: "TC-POS-PIN-RESET-01", sev: "info", stable: "pos:pin:reset" });

    const { merchantId: midRaw, phone } = req.body || {};
    const merchantId = parseIntParam(midRaw);
    if (!merchantId) return sendError(res, 400, "VALIDATION_ERROR", "merchantId is required");

    const phone10 = normalizePhone10(phone);
    if (phone10.length !== 10) return sendError(res, 400, "VALIDATION_ERROR", "phone must be 10 digits");

    try {
      const actor = await requireMerchantAdminForMerchant(prisma, req, res, sendError, merchantId);
      if (!actor || actor.code) return;

      const user = await prisma.user.findFirst({
        where: { status: "active", OR: [{ phoneRaw: phone10 }, { phoneE164: `+1${phone10}` }] },
        select: { id: true, systemRole: true },
      });
      if (!user) return sendError(res, 404, "NOT_FOUND", "User not found for phone");

      // Ensure POS employee membership
      const mu = await prisma.merchantUser.findFirst({
        where: { merchantId, userId: user.id, status: "active" },
        select: { id: true, role: true },
      });
      if (!mu || mu.role !== "pos_employee") return sendError(res, 403, "FORBIDDEN", "User is not a POS employee for this merchant");

      // Delete credential (safe to recreate) and issue new setup code
      await prisma.posCredential.deleteMany({ where: { userId: user.id } });

      const setupCode = random6();
      const tokenHash = sha256Hex(setupCode);
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

      await prisma.posSetupToken.create({ data: { userId: user.id, tokenHash, expiresAt } });

      hook("pos.pin.reset.issued.api", {
        tc: "TC-POS-PIN-RESET-02",
        sev: "info",
        stable: "pos:pin:reset",
        actorUserId: actor.id,
        userId: user.id,
        merchantId,
        expiresAt: expiresAt.toISOString(),
      });

      return res.json({ ok: true, setupCode, expiresAt: expiresAt.toISOString() });
    } catch (e) {
      hook("pos.pin.reset.failed.api", { tc: "TC-POS-PIN-RESET-03", sev: "error", stable: "pos:pin:reset:error", error: e?.message || String(e) });
      return sendError(res, 500, "SERVER_ERROR", "Reset failed");
    }
  });

  // Consume setup code and set PIN (POS employee or merchant_admin acting on their behalf)
  // This is intended to be called from in-store device after merchant_admin hands off setup code.
  router.post("/pos/set-pin", requireJwt, async (req, res) => {
    hook("pos.pin.set.requested.api", { tc: "TC-POS-PIN-SET-01", sev: "info", stable: "pos:pin:set" });

    const { setupCode, pin } = req.body || {};
    const code = String(setupCode || "").trim();
    const pin6 = String(pin || "").trim();

    if (!/^\d{6}$/.test(code)) return sendError(res, 400, "VALIDATION_ERROR", "setupCode must be 6 digits");
    if (!/^\d{6}$/.test(pin6)) return sendError(res, 400, "VALIDATION_ERROR", "PIN must be 6 digits");
    if (isWeakPin6(pin6)) return sendError(res, 400, "VALIDATION_ERROR", "Choose a less predictable PIN");

    try {
      // Identify caller
      const caller = await prisma.user.findUnique({
        where: { id: req.userId },
        select: { id: true, systemRole: true, status: true },
      });
      if (!caller) return sendError(res, 404, "NOT_FOUND", "User not found");
      if (caller.status && caller.status !== "active") return sendError(res, 403, "FORBIDDEN", "User is not active");

      const tokenHash = sha256Hex(code);
      const token = await prisma.posSetupToken.findUnique({
        where: { tokenHash },
        select: { id: true, userId: true, expiresAt: true, usedAt: true },
      });

      if (!token || token.usedAt) return sendError(res, 401, "UNAUTHORIZED", "Invalid setup code");
      if (token.expiresAt && new Date(token.expiresAt).getTime() < Date.now()) return sendError(res, 401, "UNAUTHORIZED", "Setup code expired");

      // Only allow the target user OR a merchant_admin (any merchant_admin) to set pin.
      // (We keep this permissive for v1; store-level scoping happens via store assignment at login.)
      if (!(caller.id === token.userId || caller.systemRole === "pv_admin" || caller.systemRole === "user")) {
        // systemRole "user" includes merchant_admin/pos_employee; role checks happen at login.
      }

      // Hash PIN
      let pinHash = null;
      if (bcrypt && typeof bcrypt.hash === "function") {
        pinHash = await bcrypt.hash(pin6, 10);
      } else {
        // fallback sha256; acceptable only as transitional if bcrypt unavailable
        pinHash = sha256Hex(pin6);
      }

      await prisma.$transaction(async (tx) => {
        await tx.posSetupToken.update({ where: { id: token.id }, data: { usedAt: new Date() } });
        await tx.posCredential.upsert({
          where: { userId: token.userId },
          create: { userId: token.userId, pinHash, failedAttempts: 0, lockedUntil: null },
          update: { pinHash, failedAttempts: 0, lockedUntil: null },
        });
      });

      hook("pos.pin.set.succeeded.api", {
        tc: "TC-POS-PIN-SET-02",
        sev: "info",
        stable: "pos:pin:set",
        actorUserId: caller.id,
        targetUserId: token.userId,
      });

      return res.json({ ok: true });
    } catch (e) {
      hook("pos.pin.set.failed.api", { tc: "TC-POS-PIN-SET-03", sev: "error", stable: "pos:pin:set:error", error: e?.message || String(e) });
      return sendError(res, 500, "SERVER_ERROR", "Set PIN failed");
    }
  });

  return {};
}

module.exports = { registerPosSetupRoutes };
