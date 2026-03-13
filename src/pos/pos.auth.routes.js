// backend/src/pos/pos.auth.routes.js
// POS Auth (NO-MIGRATIONS MODE)
// - POST /pos/auth/login
// Accepts:
//   - storeId#PIN  (PIN 4-8 digits)
//   - legacy code (exact match)
// Reads .pos-associates.json (NOT committed)
//
// File format supported (backward compatible):
// {
//   "associates": [
//     { "code": "5#7931", "userEmail": "a@b.com", "storeId": 5 },
//     { "pin": "7931",   "userEmail": "a@b.com", "storeId": 5 }
//   ]
// }

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");



function sha256Hex(input) {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function posPepper() {
  return process.env.POS_PIN_PEPPER || process.env.JWT_SECRET || "dev-secret-change-me";
}

function posPinHash(pin) {
  return sha256Hex(`${posPepper()}:${String(pin || "").trim()}`);
}

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

function safeJsonParse(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function resolveAssocFile() {
  return process.env.POS_ASSOC_FILE || path.join(process.cwd(), ".pos-associates.json");
}

function loadAssociates(filePath) {
  try {
    if (!fs.existsSync(filePath)) return [];
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = safeJsonParse(raw);
    const list = Array.isArray(parsed?.associates) ? parsed.associates : [];

    return list
      .map((x) => ({
        code: String(x?.code || "").trim(),
        pin: String(x?.pin || "").trim(), // optional
        userEmail: String(x?.userEmail || "").trim().toLowerCase(),
        storeId: Number.isInteger(x?.storeId) ? x.storeId : Number.parseInt(String(x?.storeId || ""), 10),
        status: String(x?.status || "active"),
      }))
      .filter((a) => a.userEmail && Number.isInteger(a.storeId) && a.storeId > 0 && a.status === "active");
  } catch (e) {
    return [];
  }
}

function resolveShiftCodesFile() {
  return process.env.POS_SHIFT_CODES_FILE || path.join(process.cwd(), ".pos-shift-codes.json");
}

function loadShiftCodes(filePath) {
  try {
    if (!fs.existsSync(filePath)) return [];
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = safeJsonParse(raw);
    const rows = Array.isArray(parsed?.codes) ? parsed.codes : [];

    return rows
      .map((x) => ({
        code: String(x?.code || "").trim(),
        storeId: Number.isInteger(x?.storeId)
          ? x.storeId
          : Number.parseInt(String(x?.storeId || ""), 10),
        merchantId: Number.isInteger(x?.merchantId)
          ? x.merchantId
          : Number.parseInt(String(x?.merchantId || ""), 10),
        userEmail: String(x?.userEmail || "").trim().toLowerCase(),
        pinHash: String(x?.pinHash || "").trim(),
        terminalId: x?.terminalId ? String(x.terminalId).trim() : null,
        status: String(x?.status || "active"),
      }))
      .filter(
        (x) =>
          x.code &&
          Number.isInteger(x.storeId) &&
          x.storeId > 0 &&
          x.userEmail &&
          x.pinHash &&
          x.status === "active"
      );
  } catch {
    return [];
  }
}


function parseStorePin(codeRaw) {
  const s = String(codeRaw || "").trim();
  if (!s.includes("#")) return { ok: false, reason: "no_hash" };
  const compact = s.replace(/\s+/g, "");
  const parts = compact.split("#");
  if (parts.length !== 2) return { ok: false, reason: "bad_format" };
  const storeId = normalizeInt(parts[0]);
  const pin = String(parts[1] || "").trim();

  if (!storeId) return { ok: false, reason: "bad_storeId" };
  if (!/^\d{4,8}$/.test(pin)) return { ok: false, reason: "bad_pin" };

  return { ok: true, storeId, pin, normalized: `${storeId}#${pin}` };
}

function isPosOnlyMerchantUser(user) {
  const mus = Array.isArray(user?.merchantUsers) ? user.merchantUsers : [];
  if (!mus.length) return false;
  const roles = mus.map((m) => m?.role).filter(Boolean);
  if (!roles.length) return false;
  return roles.every((r) => r === "store_subadmin");
}

function registerPosAuthRoutes(app, { prisma, sendError, jwt, jwtSecret, jwtExpiresIn, emitPvHook }) {
  if (!app) throw new Error("registerPosAuthRoutes: app required");
  if (!prisma) throw new Error("registerPosAuthRoutes: prisma required");
  if (typeof sendError !== "function") throw new Error("registerPosAuthRoutes: sendError required");
  if (!jwt || typeof jwt.sign !== "function") throw new Error("registerPosAuthRoutes: jwt required");
  if (!jwtSecret) throw new Error("registerPosAuthRoutes: jwtSecret required");

  const hook = getHook(emitPvHook);
  const assocFile = resolveAssocFile();

  app.post("/pos/auth/login", async (req, res) => {
    hook("pos.auth.login.requested.api", {
      tc: "TC-POS-AUTH-01",
      sev: "info",
      stable: "pos:auth:login",
    });

    try {
      const codeRaw = String(req.body?.code || "").trim();
      if (!codeRaw) return sendError(res, 400, "VALIDATION_ERROR", "code is required");

      
      const shiftCodesFile = resolveShiftCodesFile();
      const shiftCodes = loadShiftCodes(shiftCodesFile);

      const associates = loadAssociates(assocFile);

      // Prefer shift-code records first (POS-8C)
      let assoc = null;
      let storeId = null;
      let pin = null;

      const parsed = parseStorePin(codeRaw);

      if (parsed.ok) {
        storeId = parsed.storeId;
        pin = parsed.pin;

        const hashed = posPinHash(pin);

        const rec = shiftCodes.find(
          (c) =>
            (c.code === parsed.normalized ||
              (c.storeId === storeId && c.pinHash === hashed))
        );

        if (rec) {
          assoc = {
            code: rec.code,
            storeId: rec.storeId,
            userEmail: rec.userEmail,
          };
        }
      }

      // Legacy fallback (.pos-associates.json)
      if (!assoc) {
        assoc = associates.find((a) => a.code && a.code === codeRaw);

        if (!assoc && parsed.ok) {
          assoc = associates.find(
            (a) => a.storeId === storeId && a.pin && String(a.pin) === String(pin)
          );
          if (!assoc)
            assoc = associates.find(
              (a) => a.storeId === storeId && a.code && a.code === parsed.normalized
            );
        }
      }

      if (!assoc) {
        hook("pos.auth.login.failed.api", {
          tc: "TC-POS-AUTH-02",
          sev: "warn",
          stable: "pos:auth:login",
          reason: "invalid_code_or_pin",
          assocFile: path.basename(assocFile),
        });
        return sendError(res, 401, "UNAUTHORIZED", "Invalid code");
      }

      // Resolve user by email
      const users = await prisma.user.findMany({
        where: { email: assoc.userEmail },
        take: 1,
      });
      const user = Array.isArray(users) && users.length ? users[0] : null;
      if (!user) return sendError(res, 401, "UNAUTHORIZED", "Invalid code");
      if (user.status && user.status !== "active") return sendError(res, 403, "FORBIDDEN", "User is not active");

      // Load memberships and validate POS-only
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

      // Store validation
      const targetStoreId = normalizeInt(storeId != null ? storeId : assoc.storeId);
      if (!targetStoreId) return sendError(res, 400, "VALIDATION_ERROR", "Store resolution failed");

      const allowedMerchantIds = Array.isArray(full.merchantUsers)
        ? full.merchantUsers.map((m) => m.merchantId).filter(Boolean)
        : [];

      const store = await prisma.store.findUnique({
        where: { id: targetStoreId },
        select: { id: true, merchantId: true, status: true },
      });

      if (!store) return sendError(res, 404, "NOT_FOUND", "Store not found");
      if (store.status && store.status !== "active") return sendError(res, 403, "FORBIDDEN", "Store is not active");
      if (!allowedMerchantIds.includes(store.merchantId)) {
        return sendError(res, 403, "FORBIDDEN", "Store not allowed for this associate");
      }

      // OPTIONAL: accept terminalId if the UI sends it later (future-proof)
      const terminalId = String(req.body?.terminalId || "").trim() || null;

      const accessToken = jwt.sign(
        {
          userId: full.id,
          tokenVersion: full.tokenVersion ?? 0,
          pos: 1,
          storeId: store.id,
          merchantId: store.merchantId,
          ...(terminalId ? { terminalId } : null),
        },
        jwtSecret,
        { expiresIn: jwtExpiresIn || "15m" }
      );

      hook("pos.auth.login.succeeded.api", {
        tc: "TC-POS-AUTH-03",
        sev: "info",
        stable: "pos:auth:login",
        userId: full.id,
        storeId: store.id,
        merchantId: store.merchantId,
        terminalId: terminalId || null,
      });

      return res.json({
        accessToken,
        systemRole: full.systemRole,
        landing: "/merchant/pos",
        posSession: true,
        storeId: store.id,
        merchantId: store.merchantId,
      });
    } catch (e) {
      hook("pos.auth.login.failed.api", {
        tc: "TC-POS-AUTH-04",
        sev: "error",
        stable: "pos:auth:login:error",
        error: e?.message || String(e),
      });
      return sendError(res, 500, "SERVER_ERROR", "POS login failed");
    }
  });

  return { assocFile };
}

module.exports = { registerPosAuthRoutes };
