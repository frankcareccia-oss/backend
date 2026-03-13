// backend/src/pos/pos.auth.provision.routes.js
// POS Auth Provisioning (NO-MIGRATIONS MODE)
// - POST /pos/auth/provision
// Provisions a POS associate shift code without DB migrations.
// Writes .pos-shift-codes.json (NOT committed)

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");

function sha256Hex(input) {
  return crypto.createHash("sha256").update(input).digest("hex");
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

function normalizeEmail(email) {
  const e = String(email || "").trim().toLowerCase();
  return e && e.includes("@") ? e : "";
}

function normalizePin(pin) {
  const p = String(pin || "").trim();
  if (!/^\d{4,8}$/.test(p)) return "";
  return p;
}

function posPepper(jwtSecret) {
  return process.env.POS_PIN_PEPPER || jwtSecret || "dev-secret-change-me";
}

function posPinHash(pin, jwtSecret) {
  return sha256Hex(`${posPepper(jwtSecret)}:${String(pin || "").trim()}`);
}

function safeJsonParse(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function readFileJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = safeJsonParse(raw);
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function writeFileJson(filePath, obj) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(obj, null, 2), "utf8");
    return true;
  } catch {
    return false;
  }
}

function resolveShiftCodesFile() {
  return process.env.POS_SHIFT_CODES_FILE || path.join(process.cwd(), ".pos-shift-codes.json");
}

function loadShiftCodes(filePath) {
  const parsed = readFileJson(filePath, { codes: [] });
  const rows = Array.isArray(parsed?.codes) ? parsed.codes : [];
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

function saveShiftCodes(filePath, codes) {
  return writeFileJson(filePath, { codes });
}

function registerPosAuthProvisionRoutes(app, {
  prisma,
  sendError,
  requireAdmin,
  emitPvHook,
  jwtSecret,
}) {
  if (!app) throw new Error("registerPosAuthProvisionRoutes: app required");
  if (!prisma) throw new Error("registerPosAuthProvisionRoutes: prisma required");
  if (typeof sendError !== "function") throw new Error("registerPosAuthProvisionRoutes: sendError required");
  if (typeof requireAdmin !== "function") throw new Error("registerPosAuthProvisionRoutes: requireAdmin required");
  if (!jwtSecret) throw new Error("registerPosAuthProvisionRoutes: jwtSecret required");

  const hook = getHook(emitPvHook);
  const shiftCodesFile = resolveShiftCodesFile();

  app.post("/pos/auth/provision", requireAdmin, async (req, res) => {
    try {
      const { storeId: sidRaw, userEmail, pin, terminalId } = req.body || {};
      const storeId = normalizeInt(sidRaw);
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
      if (store.status && store.status !== "active") {
        return sendError(res, 403, "FORBIDDEN", "Store is not active");
      }

      const users = await prisma.user.findMany({
        where: { email: emailNorm },
        take: 1,
      });
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

      const full = await prisma.user.findUnique({
        where: { id: user.id },
        select: { id: true, systemRole: true },
      });

      if (full?.systemRole === "pv_admin") {
        return sendError(res, 403, "FORBIDDEN", "pv_admin cannot be a POS associate");
      }

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
          data: {
            merchantId: store.merchantId,
            userId: user.id,
            role: "store_subadmin",
            status: "active",
          },
        });
      }

      const code = `${storeId}#${pinNorm}`;
      const codes = loadShiftCodes(shiftCodesFile).filter((c) => c.code !== code);
      codes.unshift({
        code,
        storeId,
        merchantId: store.merchantId,
        userEmail: emailNorm,
        pinHash: posPinHash(pinNorm, jwtSecret),
        terminalId: terminalId ? String(terminalId).trim() : null,
        status: "active",
        createdAt: nowIso(),
      });

      const ok = saveShiftCodes(shiftCodesFile, codes);
      if (!ok) {
        return sendError(res, 500, "PERSIST_FAILED", "Failed to persist shift codes");
      }

      hook("pos.auth.provisioned.api", {
        tc: "TC-POS-AUTH-PROVISION-01",
        sev: "info",
        stable: "pos:auth:provision",
        storeId,
        merchantId: store.merchantId,
        userEmail: emailNorm,
        code,
        createdUser,
        shiftCodesFile: path.basename(shiftCodesFile),
      });

      return res.json({
        ok: true,
        storeId,
        merchantId: store.merchantId,
        userEmail: emailNorm,
        code,
        pin: pinNorm,
        createdUser,
        tempPassword,
      });
    } catch (e) {
      hook("pos.auth.provision.failed.api", {
        tc: "TC-POS-AUTH-PROVISION-02",
        sev: "error",
        stable: "pos:auth:provision:error",
        error: e?.message || String(e),
      });
      return sendError(res, 500, "SERVER_ERROR", "POS auth provision failed");
    }
  });

  return { shiftCodesFile };
}

module.exports = { registerPosAuthProvisionRoutes };
