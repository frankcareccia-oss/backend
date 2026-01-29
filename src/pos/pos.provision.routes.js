// backend/src/pos/pos.provision.routes.js
// POS Provisioning (NO-MIGRATIONS MODE)
// - POST /pos/provision
// - Persists terminalId pairing to a local JSON file (NOT committed)

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

function safeJsonParse(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function readFileJson(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, "utf8");
    return safeJsonParse(raw);
  } catch {
    return null;
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

function nowIso() {
  return new Date().toISOString();
}

function normalizeInt(n) {
  const x = Number(n);
  return Number.isInteger(x) ? x : null;
}

function normalizeLabel(s) {
  const v = String(s || "").trim();
  if (!v) return "Terminal";
  return v.slice(0, 64);
}

function genTerminalId() {
  // stable-ish short id safe for headers/storage
  return `term_${crypto.randomBytes(9).toString("base64url")}`;
}

function defaultHook(event, fields = {}) {
  try {
    console.log(JSON.stringify({ pvHook: event, ts: nowIso(), ...fields }));
  } catch {
    // never throw from hooks
  }
}

function getHook(emitPvHook) {
  return typeof emitPvHook === "function" ? emitPvHook : defaultHook;
}

function resolveTerminalsFile() {
  // Keep in backend working dir
  return (
    process.env.POS_TERMINALS_FILE ||
    path.join(process.cwd(), ".pos-terminals.json")
  );
}

function loadTerminals(filePath) {
  const raw = readFileJson(filePath);
  const list = Array.isArray(raw?.terminals) ? raw.terminals : [];
  const normalized = list
    .map((t) => ({
      terminalId: String(t?.terminalId || "").trim(),
      storeId: normalizeInt(t?.storeId),
      terminalLabel: String(t?.terminalLabel || "").trim(),
      createdAt: t?.createdAt || null,
      lastProvisionedAt: t?.lastProvisionedAt || null,
      status: String(t?.status || "active"),
    }))
    .filter((t) => t.terminalId && Number.isInteger(t.storeId) && t.storeId > 0);
  return { version: raw?.version || 1, terminals: normalized };
}

function saveTerminals(filePath, terminalsObj) {
  const payload = {
    version: terminalsObj?.version || 1,
    updatedAt: nowIso(),
    terminals: Array.isArray(terminalsObj?.terminals) ? terminalsObj.terminals : [],
  };
  return writeFileJson(filePath, payload);
}

function findExisting(terminals, { storeId, terminalLabel }) {
  const labelNorm = String(terminalLabel || "").trim();
  return (terminals || []).find(
    (t) => t.storeId === storeId && String(t.terminalLabel || "").trim() === labelNorm
  );
}

function findByTerminalId(terminals, terminalId) {
  const id = String(terminalId || "").trim();
  if (!id) return null;
  return (terminals || []).find((t) => t.terminalId === id);
}

function registerPosProvisionRoutes(app, { prisma, sendError, emitPvHook }) {
  if (!app) throw new Error("registerPosProvisionRoutes: app required");
  if (!prisma) throw new Error("registerPosProvisionRoutes: prisma required");
  if (typeof sendError !== "function") throw new Error("registerPosProvisionRoutes: sendError required");

  const hook = getHook(emitPvHook);
  const filePath = resolveTerminalsFile();

  // Public provisioning endpoint
  // Body: { storeId, terminalLabel, terminalId? }
  app.post("/pos/provision", async (req, res) => {
    hook("pos.provision.requested.api", {
      tc: "TC-POS-PROV-01",
      sev: "info",
      stable: "pos:provision",
    });

    try {
      const storeId = normalizeInt(req.body?.storeId);
      const terminalLabel = normalizeLabel(req.body?.terminalLabel);
      const suppliedTerminalId = String(req.body?.terminalId || "").trim() || null;

      if (!storeId) return sendError(res, 400, "VALIDATION_ERROR", "storeId is required (integer)");

      // Validate store exists and is active
      const store = await prisma.store.findUnique({
        where: { id: storeId },
        select: { id: true, merchantId: true, status: true },
      });
      if (!store) return sendError(res, 404, "NOT_FOUND", "Store not found");
      if (store.status && store.status !== "active") {
        return sendError(res, 409, "STORE_NOT_ACTIVE", `Store is ${store.status}`);
      }

      const db = loadTerminals(filePath);
      const terminals = db.terminals || [];

      let terminalId = null;

      // If they supplied terminalId, prefer it and upsert/update pairing.
      if (suppliedTerminalId) {
        terminalId = suppliedTerminalId;
        const existing = findByTerminalId(terminals, terminalId);
        if (existing) {
          existing.storeId = storeId;
          existing.terminalLabel = terminalLabel;
          existing.lastProvisionedAt = nowIso();
          existing.status = "active";
        } else {
          terminals.push({
            terminalId,
            storeId,
            terminalLabel,
            createdAt: nowIso(),
            lastProvisionedAt: nowIso(),
            status: "active",
          });
        }
      } else {
        // Otherwise, reuse existing pairing for this store+label (stable)
        const existing = findExisting(terminals, { storeId, terminalLabel });
        if (existing) {
          terminalId = existing.terminalId;
          existing.lastProvisionedAt = nowIso();
          existing.status = "active";
        } else {
          terminalId = genTerminalId();
          terminals.push({
            terminalId,
            storeId,
            terminalLabel,
            createdAt: nowIso(),
            lastProvisionedAt: nowIso(),
            status: "active",
          });
        }
      }

      const ok = saveTerminals(filePath, { version: db.version || 1, terminals });
      if (!ok) {
        hook("pos.provision.failed.api", {
          tc: "TC-POS-PROV-02",
          sev: "error",
          stable: "pos:provision",
          reason: "persist_failed",
          filePath: path.basename(filePath),
        });
        return sendError(res, 500, "PERSIST_FAILED", "Failed to persist terminal provisioning");
      }

      hook("pos.provision.succeeded.api", {
        tc: "TC-POS-PROV-03",
        sev: "info",
        stable: "pos:provision",
        storeId,
        merchantId: store.merchantId,
        terminalId,
        terminalLabel,
        file: path.basename(filePath),
      });

      return res.json({
        ok: true,
        storeId,
        merchantId: store.merchantId,
        terminalId,
        terminalLabel,
      });
    } catch (e) {
      hook("pos.provision.failed.api", {
        tc: "TC-POS-PROV-04",
        sev: "error",
        stable: "pos:provision:error",
        error: e?.message || String(e),
      });
      return sendError(res, 500, "SERVER_ERROR", "Provision failed");
    }
  });

  return { filePath };
}

module.exports = { registerPosProvisionRoutes };
