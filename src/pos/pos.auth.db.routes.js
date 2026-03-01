// backend/src/pos/pos.auth.db.routes.js
// POS Auth (DB MODE - additive, no removals)
// - POST /pos/auth/login
//
// Compatibility rules:
// - If POS_AUTH_MODE=db, this route is mounted instead of file-mode.
// - Request may be:
//    A) { code: "<storeId>#<phone10>#<pin6>" }   (recommended transitional payload; keeps existing "code" field)
//    B) { storeId, phone, pin }                 (clean payload, if/when UI supports it)
//    C) { code: "<storeId>#<pin4-8>" }          (legacy) -> will optionally fallback to file-mode verifier if provided
//
// Security locks (v1):
// - PIN: 6 digits
// - lockout: 5 failed attempts -> 10 minutes
// - setup token expiry: 24 hours (handled in setup routes)
// - in-store usage assumed (sessions short); JWT expires in 15m (existing behavior)
//
// Dependencies injected (from index.js):
// - prisma, sendError, jwt, jwtSecret, jwtExpiresIn, emitPvHook
// - OPTIONAL legacyVerifier(req,res): function that can attempt file-mode auth for legacy payloads
//
// NOTE: This module assumes Prisma models exist (append-only):
//   - PosCredential (userId unique, pinHash, failedAttempts, lockedUntil)
//   - PosSetupToken (tokenHash unique, expiresAt, usedAt)
//
// No functionality removal: legacy auth can remain available via optional fallback.

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

function normalizeInt(n) {
  const x = Number(n);
  return Number.isInteger(x) ? x : null;
}

function digitsOnly(v) {
  return String(v || "").replace(/\D+/g, "");
}

function normalizePhone10(v) {
  return digitsOnly(v).slice(0, 10);
}

function parseTransitionalCode(codeRaw) {
  // "<storeId>#<phone10>#<pin6>"
  const compact = String(codeRaw || "").trim().replace(/\s+/g, "");
  const parts = compact.split("#");
  if (parts.length !== 3) return { ok: false, reason: "bad_format" };
  const storeId = normalizeInt(parts[0]);
  const phone10 = normalizePhone10(parts[1]);
  const pin = String(parts[2] || "").trim();

  if (!storeId) return { ok: false, reason: "bad_storeId" };
  if (phone10.length !== 10) return { ok: false, reason: "bad_phone" };
  if (!/^\d{6}$/.test(pin)) return { ok: false, reason: "bad_pin" };

  return { ok: true, storeId, phone10, pin };
}

function sha256Hex(s) {
  return crypto.createHash("sha256").update(String(s)).digest("hex");
}

async function loadUserByPhone(prisma, phone10) {
  // We currently store phoneE164 and phoneRaw; phoneRaw for NANP is 10 digits.
  // E.164 derivation lives elsewhere; for POS we search phoneRaw first.
  const phoneRaw = normalizePhone10(phone10);
  if (phoneRaw.length !== 10) return null;

  // Find by phoneRaw (fast); fallback by phoneE164 (+1...).
  const byRaw = await prisma.user.findFirst({
    where: { phoneRaw, status: "active" },
    select: { id: true, email: true, status: true, systemRole: true, tokenVersion: true },
  });
  if (byRaw) return byRaw;

  const byE164 = await prisma.user.findFirst({
    where: { phoneE164: `+1${phoneRaw}`, status: "active" },
    select: { id: true, email: true, status: true, systemRole: true, tokenVersion: true },
  });
  return byE164 || null;
}

async function isPosOnlyUser(prisma, userId) {
  const full = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      systemRole: true,
      merchantUsers: { where: { status: "active" }, select: { merchantId: true, role: true, status: true } },
    },
  });
  if (!full) return { ok: false, reason: "no_user" };
  if (["pv_admin", "pv_ar_clerk"].includes(full.systemRole)) return { ok: false, reason: "platform_user" };

  const mus = Array.isArray(full.merchantUsers) ? full.merchantUsers : [];
  if (!mus.length) return { ok: false, reason: "no_memberships" };

  const roles = mus.map((m) => m?.role).filter(Boolean);
  if (!roles.length) return { ok: false, reason: "no_roles" };
  const posOnly = roles.every((r) => r === "pos_employee");
  return { ok: posOnly, reason: posOnly ? "ok" : "not_pos_only", merchantIds: mus.map((m) => m.merchantId) };
}

async function validateStoreAccess(prisma, userId, storeId) {
  const store = await prisma.store.findUnique({
    where: { id: storeId },
    select: { id: true, merchantId: true, status: true },
  });
  if (!store) return { ok: false, http: 404, code: "NOT_FOUND", message: "Store not found" };
  if (store.status && store.status !== "active") return { ok: false, http: 403, code: "FORBIDDEN", message: "Store is not active" };

  // Must have an active StoreUser assignment to this store via MerchantUser.
  const assignment = await prisma.storeUser.findFirst({
    where: {
      storeId: store.id,
      status: "active",
      merchantUser: { userId, status: "active" },
    },
    select: {
      id: true,
      permissionLevel: true,
      merchantUser: { select: { id: true, merchantId: true, role: true, status: true } },
    },
  });

  if (!assignment) return { ok: false, http: 403, code: "FORBIDDEN", message: "Store not allowed for this associate" };

  return {
    ok: true,
    storeId: store.id,
    merchantId: store.merchantId,
    storeUserId: assignment.id,
    permissionLevel: assignment.permissionLevel,
    merchantUserRole: assignment.merchantUser?.role || null,
  };
}

async function verifyPin(prisma, userId, pin, { bcrypt }) {
  // Returns: { ok, reason, lockedUntil }
  const cred = await prisma.posCredential.findUnique({
    where: { userId },
    select: { userId: true, pinHash: true, failedAttempts: true, lockedUntil: true },
  });

  if (!cred) return { ok: false, reason: "no_credential" };

  const now = Date.now();
  const lockedUntilMs = cred.lockedUntil ? new Date(cred.lockedUntil).getTime() : 0;
  if (lockedUntilMs && lockedUntilMs > now) {
    return { ok: false, reason: "locked", lockedUntil: cred.lockedUntil };
  }

  const pinStr = String(pin || "").trim();
  if (!/^\d{6}$/.test(pinStr)) return { ok: false, reason: "bad_pin" };

  let match = false;

  // Prefer bcrypt compare if available; otherwise accept pre-hashed pinHash as sha256Hex(pin) (transition support).
  if (bcrypt && typeof bcrypt.compare === "function") {
    try {
      match = await bcrypt.compare(pinStr, cred.pinHash);
    } catch {
      match = false;
    }
  } else {
    match = sha256Hex(pinStr) === String(cred.pinHash || "");
  }

  if (match) {
    // reset counters
    await prisma.posCredential.update({
      where: { userId },
      data: { failedAttempts: 0, lockedUntil: null },
    });
    return { ok: true, reason: "ok" };
  }

  // increment attempts, apply lockout at 5
  const nextAttempts = Number(cred.failedAttempts || 0) + 1;
  const lockNow = nextAttempts >= 5;
  const lockedUntil = lockNow ? new Date(Date.now() + 10 * 60 * 1000) : null;

  await prisma.posCredential.update({
    where: { userId },
    data: { failedAttempts: nextAttempts, lockedUntil },
  });

  return { ok: false, reason: "mismatch", lockedUntil };
}

function registerPosAuthDbRoutes(app, deps) {
  const { prisma, sendError, jwt, jwtSecret, jwtExpiresIn, emitPvHook, legacyVerifier, bcrypt } = deps || {};

  if (!app) throw new Error("registerPosAuthDbRoutes: app required");
  if (!prisma) throw new Error("registerPosAuthDbRoutes: prisma required");
  if (typeof sendError !== "function") throw new Error("registerPosAuthDbRoutes: sendError required");
  if (!jwt || typeof jwt.sign !== "function") throw new Error("registerPosAuthDbRoutes: jwt required");
  if (!jwtSecret) throw new Error("registerPosAuthDbRoutes: jwtSecret required");

  const hook = getHook(emitPvHook);

  app.post("/pos/auth/login", async (req, res) => {
    hook("pos.auth.db.login.requested.api", { tc: "TC-POS-AUTH-DB-01", sev: "info", stable: "pos:auth:login:db" });

    try {
      const body = req.body || {};
      const rawCode = String(body.code || "").trim();

      // Preferred: storeId + phone + pin (if UI supports)
      const storeIdFromBody = normalizeInt(body.storeId);
      const phoneFromBody = normalizePhone10(body.phone);
      const pinFromBody = String(body.pin || "").trim();

      let storeId = storeIdFromBody;
      let phone10 = phoneFromBody;
      let pin = pinFromBody;

      // Transitional: parse "<storeId>#<phone10>#<pin6>"
      if ((!storeId || !phone10 || !pin) && rawCode) {
        const parsed = parseTransitionalCode(rawCode);
        if (parsed.ok) {
          storeId = parsed.storeId;
          phone10 = parsed.phone10;
          pin = parsed.pin;
        }
      }

      // Legacy: allow "<storeId>#<pin4-8>" to be verified by legacy module (optional)
      if ((!storeId || !pin) && rawCode && typeof legacyVerifier === "function") {
        hook("pos.auth.db.login.fallback_legacy.attempt", {
          tc: "TC-POS-AUTH-DB-LEG-01",
          sev: "info",
          stable: "pos:auth:login:db",
        });
        return legacyVerifier(req, res);
      }

      if (!storeId) return sendError(res, 400, "VALIDATION_ERROR", "storeId is required");
      if (!phone10 || phone10.length !== 10) return sendError(res, 400, "VALIDATION_ERROR", "phone must be 10 digits");
      if (!/^\d{6}$/.test(String(pin || ""))) return sendError(res, 400, "VALIDATION_ERROR", "PIN must be 6 digits");

      const user = await loadUserByPhone(prisma, phone10);
      if (!user) {
        hook("pos.auth.db.login.failed.api", {
          tc: "TC-POS-AUTH-DB-02",
          sev: "warn",
          stable: "pos:auth:login:db",
          reason: "no_user_for_phone",
        });
        return sendError(res, 401, "UNAUTHORIZED", "Invalid credentials");
      }

      const posOnly = await isPosOnlyUser(prisma, user.id);
      if (!posOnly.ok) {
        hook("pos.auth.db.login.failed.api", {
          tc: "TC-POS-AUTH-DB-03",
          sev: "warn",
          stable: "pos:auth:login:db",
          reason: posOnly.reason,
          userId: user.id,
        });
        return sendError(res, 403, "FORBIDDEN", "Not a POS associate");
      }

      const storeGate = await validateStoreAccess(prisma, user.id, storeId);
      if (!storeGate.ok) {
        hook("pos.auth.db.login.failed.api", {
          tc: "TC-POS-AUTH-DB-04",
          sev: "warn",
          stable: "pos:auth:login:db",
          reason: "store_gate",
          userId: user.id,
          storeId,
        });
        return sendError(res, storeGate.http, storeGate.code, storeGate.message);
      }

      const pinOk = await verifyPin(prisma, user.id, pin, { bcrypt });
      if (!pinOk.ok) {
        hook("pos.auth.db.pin.failed.api", {
          tc: "TC-POS-AUTH-DB-05",
          sev: "warn",
          stable: "pos:auth:login:db",
          userId: user.id,
          storeId: storeGate.storeId,
          reason: pinOk.reason,
          lockedUntil: pinOk.lockedUntil ? new Date(pinOk.lockedUntil).toISOString() : null,
        });

        if (pinOk.reason === "locked") return sendError(res, 423, "LOCKED", "Account temporarily locked");
        return sendError(res, 401, "UNAUTHORIZED", "Invalid credentials");
      }

      const terminalId = String(body.terminalId || "").trim() || null;

      const accessToken = jwt.sign(
        {
          userId: user.id,
          tokenVersion: user.tokenVersion ?? 0,
          pos: 1,
          storeId: storeGate.storeId,
          merchantId: storeGate.merchantId,
          ...(terminalId ? { terminalId } : null),
        },
        jwtSecret,
        { expiresIn: jwtExpiresIn || "15m" }
      );

      hook("pos.auth.db.login.succeeded.api", {
        tc: "TC-POS-AUTH-DB-06",
        sev: "info",
        stable: "pos:auth:login:db",
        userId: user.id,
        storeId: storeGate.storeId,
        merchantId: storeGate.merchantId,
        terminalId: terminalId || null,
      });

      return res.json({
        accessToken,
        systemRole: user.systemRole,
        landing: "/merchant/pos",
        posSession: true,
        storeId: storeGate.storeId,
        merchantId: storeGate.merchantId,
      });
    } catch (e) {
      hook("pos.auth.db.login.failed.api", {
        tc: "TC-POS-AUTH-DB-07",
        sev: "error",
        stable: "pos:auth:login:db:error",
        error: e?.message || String(e),
      });
      return sendError(res, 500, "SERVER_ERROR", "POS login failed");
    }
  });

  return {};
}

module.exports = { registerPosAuthDbRoutes };
