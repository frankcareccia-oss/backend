const fs = require("fs");
const path = require("path");

function registerPosProvisioningRoutes(app, {
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
}) {
  const router = require("express").Router();

  const POS_ASSOC_FILE = path.join(process.cwd(), ".pos-associates.json"); // legacy POS-8A
  const POS_TERMINALS_FILE = path.join(process.cwd(), ".pos-terminals.json");
  const POS_SHIFT_CODES_FILE = path.join(process.cwd(), ".pos-shift-codes.json");

  function safeReadJsonFile(filePath, fallback) {
    try {
      if (!fs.existsSync(filePath)) return fallback;
      const raw = fs.readFileSync(filePath, "utf-8");
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : fallback;
    } catch (e) {
      console.warn("?? safeReadJsonFile failed:", filePath, e?.message || e);
      return fallback;
    }
  }

  function safeWriteJsonFile(filePath, obj) {
    try {
      fs.writeFileSync(filePath, JSON.stringify(obj, null, 2), "utf-8");
      return true;
    } catch (e) {
      console.warn("?? safeWriteJsonFile failed:", filePath, e?.message || e);
      return false;
    }
  }

  function posPepper() {
    return process.env.POS_PIN_PEPPER || JWT_SECRET || "dev-secret-change-me";
  }

  function posPinHash(pin) {
    return sha256Hex(`${posPepper()}:${String(pin || "").trim()}`);
  }

  function randomId(prefix) {
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
      console.warn("?? POS legacy loadPosAssociates failed:", e?.message || e);
      return [];
    }
  }

  function loadShiftCodes() {
    const parsed = safeReadJsonFile(POS_SHIFT_CODES_FILE, { codes: [] });
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

  router.post("/pos/provision", requireAdmin, async (req, res) => {
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

  router.post("/pos/auth/provision", requireAdmin, async (req, res) => {
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

      const full = await prisma.user.findUnique({
        where: { id: user.id },
        select: { id: true, systemRole: true },
      });
      if (full?.systemRole === "pv_admin") return sendError(res, 403, "FORBIDDEN", "pv_admin cannot be a POS associate");

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

      // Ensure store-scoped membership exists for POS authorization.
      const existingSu = await prisma.storeUser.findFirst({
        where: { storeId, userId: user.id },
        select: { id: true, permissionLevel: true, status: true },
      });

      if (existingSu) {
        await prisma.storeUser.update({
          where: { id: existingSu.id },
          data: {
            permissionLevel: "subadmin",
            status: "active",
          },
        });
      } else {
        await prisma.storeUser.create({
          data: {
            storeId,
            userId: user.id,
            permissionLevel: "subadmin",
            status: "active",
          },
        });
      }

      const code = `${storeId}#${pinNorm}`;
      const nowIso = new Date().toISOString();

      const codes = loadShiftCodes().filter((c) => c.code !== code);
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
        pin: pinNorm,
        createdUser,
        tempPassword,
      });
    } catch (err) {
      return handlePrismaError(err, res);
    }
  });

  router.post("/pos/auth/login", async (req, res) => {
    try {
      const { code } = req.body || {};
      const codeNorm = String(code || "").trim();
      if (!codeNorm) return sendError(res, 400, "VALIDATION_ERROR", "code is required");

      let assoc = null;

      const parsed = parseShiftCode(codeNorm);
      if (parsed) {
        const codes = loadShiftCodes();
        const rec = codes.find((c) => c.code === codeNorm && c.status === "active");
        if (rec) {
          if (posPinHash(parsed.pin) !== rec.pinHash) return sendError(res, 401, "UNAUTHORIZED", "Invalid code");
          assoc = { code: rec.code, userEmail: rec.userEmail, storeId: rec.storeId, merchantIdHint: rec.merchantId };
        } else {
          // Fall back to associates file — supports both pin: "1234" and code: "1#1234" formats
          const rawAssoc = safeReadJsonFile(POS_ASSOC_FILE, { associates: [] });
          const list = Array.isArray(rawAssoc?.associates) ? rawAssoc.associates : [];
          const match = list.find(
            (a) =>
              Number(a?.storeId) === parsed.storeId &&
              String(a?.status || "active") === "active" &&
              a?.userEmail &&
              (String(a?.pin || "") === parsed.pin || String(a?.code || "") === codeNorm)
          );
          if (!match) return sendError(res, 401, "UNAUTHORIZED", "Invalid code");
          assoc = { code: codeNorm, userEmail: String(match.userEmail).trim().toLowerCase(), storeId: parsed.storeId };
        }
      } else {
        assoc = loadPosAssociatesLegacy().find((a) => a.code === codeNorm) || null;
        if (!assoc) return sendError(res, 401, "UNAUTHORIZED", "Invalid code");
      }

      const users = await prisma.user.findMany({
        where: { email: assoc.userEmail },
        take: 1,
      });
      const user = Array.isArray(users) && users.length ? users[0] : null;

      if (!user) return sendError(res, 401, "UNAUTHORIZED", "Invalid code");
      if (user.status && user.status !== "active") return sendError(res, 403, "FORBIDDEN", "User is not active");

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

      const allowedMerchantIds = Array.isArray(full.merchantUsers)
        ? full.merchantUsers.map((m) => m.merchantId).filter(Boolean)
        : [];

      const store = await prisma.store.findUnique({
        where: { id: assoc.storeId },
        select: { id: true, merchantId: true, status: true },
      });

      if (!store) return sendError(res, 404, "NOT_FOUND", "Store not found");
      if (store.status && store.status !== "active") return sendError(res, 403, "FORBIDDEN", "Store is not active");
      if (!allowedMerchantIds.includes(store.merchantId)) {
        return sendError(res, 403, "FORBIDDEN", "Store not allowed for this associate");
      }

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

  return { router };
}

module.exports = { registerPosProvisioningRoutes };