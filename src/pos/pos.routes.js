// backend/src/pos/pos.routes.js
const express = require("express");
const fs = require("fs");
const path = require("path");

const { requireFreshTimestamp } = require("./pos.replay");
const { requireIdempotency } = require("./pos.idempotency");

const posPersist = require("./pos.persist");
const { persistVisit, persistReward } = posPersist;

const posRead = require("./pos.read");
const { getVisitByPosVisitId, getRewardById } = posRead;

/**
 * POS routes (NO-MIGRATIONS MODE)
 *
 * Endpoints:
 * - POST /pos/visit
 * - POST /pos/reward
 * - GET  /pos/visit/:posVisitId
 * - GET  /pos/reward/:rewardId
 *
 * POS-9 Customer Identity:
 * - POST /pos/customer/preview
 * - POST /pos/customer/create
 *
 * POS Dashboard:
 * - GET  /pos/stats/today              (aliases: /pos/today)
 * - GET  /pos/activity/recent          (aliases: /pos/activity)
 *
 * Hooks (Docs/QA/Support/Chatbot):
 * - Structured JSON lines with { pvHook, ts, tc, sev, stable, ...fields }
 * - Hooks must never throw.
 */

function pvHook(event, fields = {}) {
  try {
    console.log(
      JSON.stringify({
        pvHook: event,
        ts: new Date().toISOString(),
        ...fields,
      })
    );
  } catch {
    // never throw from hooks
  }
}

function getHook(req) {
  return typeof req?.pvHook === "function" ? req.pvHook : pvHook;
}

function maskIdentifier(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;

  if (s.includes("@")) {
    const [u, d] = s.split("@");
    const uMasked = u ? `${u.slice(0, 2)}***` : "***";
    return `${uMasked}@${d || "***"}`;
  }

  const digits = s.replace(/[^\d]/g, "");
  if (digits.length >= 10 && digits.length <= 15) {
    const last4 = digits.slice(-4);
    return `***-***-${last4 || "****"}`;
  }

  return s.length <= 6 ? "***" : `${s.slice(0, 3)}***${s.slice(-2)}`;
}

function validateIdentifier(raw) {
  const s = String(raw || "").trim();
  if (!s) return { ok: false, reason: "missing" };

  // Email (basic sanity)
  if (s.includes("@")) {
    const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
    return emailOk ? { ok: true, kind: "email" } : { ok: false, reason: "bad_email" };
  }

  // Phone: allow 10–15 digits after stripping punctuation
  const digits = s.replace(/[^\d]/g, "");
  if (digits.length >= 10 && digits.length <= 15) return { ok: true, kind: "phone" };

  // Token/QR: permissive but bounded
  if (/^[A-Za-z0-9:_\-\.\=]{6,128}$/.test(s)) return { ok: true, kind: "token" };

  return { ok: false, reason: "unrecognized_format" };
}

/* -----------------------------
   NDJSON support (NO-MIGRATIONS MODE)
-------------------------------- */

function startOfLocalDay(d = new Date()) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function safeJsonParse(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function extractStoreId(rec) {
  if (!rec || typeof rec !== "object") return null;
  const direct = rec.storeId ?? rec.store_id ?? rec.storeID;
  if (direct != null) return String(direct);

  const ctxStore = rec.ctx?.storeId ?? rec.ctx?.store_id ?? rec.ctx?.storeID;
  if (ctxStore != null) return String(ctxStore);

  const nested = rec.store?.id ?? rec.store?.storeId ?? rec.store?.store_id;
  if (nested != null) return String(nested);

  return null;
}

function extractMerchantId(rec) {
  if (!rec || typeof rec !== "object") return null;
  const direct = rec.merchantId ?? rec.merchant_id ?? rec.merchantID;
  if (direct != null) return String(direct);

  const ctxMerchant = rec.ctx?.merchantId ?? rec.ctx?.merchant_id ?? rec.ctx?.merchantID;
  if (ctxMerchant != null) return String(ctxMerchant);

  return null;
}

function extractWhen(rec) {
  if (!rec || typeof rec !== "object") return null;

  const candidates = [
    // observed / common
    rec.timestamp,
    rec.createdAt,
    rec.created_at,
    rec.ts,
    rec.at,              // IMPORTANT: allow top-level "at"
    rec.time,
    rec.eventAt,

    // nested
    rec.ctx?.timestamp,
    rec.ctx?.createdAt,
    rec.ctx?.ts,
    rec.ctx?.at,         // IMPORTANT: your persist* passes ctx.at
    rec.meta?.timestamp,
    rec.meta?.ts,
    rec.meta?.at,
  ];

  for (const v of candidates) {
    if (!v) continue;
    const dt = new Date(v);
    if (!Number.isNaN(dt.getTime())) return dt;
  }
  return null;
}

function fileExists(p) {
  try {
    return Boolean(p) && fs.existsSync(p) && fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function normalizePath(p) {
  try {
    return path.resolve(p);
  } catch {
    return p;
  }
}

function readNdjsonTail(filePath, { maxLines = 2000 } = {}) {
  if (!fileExists(filePath)) return [];
  let raw = "";
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return [];
  }
  const lines = raw.split(/\r?\n/).filter(Boolean);
  const tail = lines.length > maxLines ? lines.slice(lines.length - maxLines) : lines;

  const out = [];
  for (const line of tail) {
    const rec = safeJsonParse(line);
    if (rec) out.push(rec);
  }
  return out;
}

// Walk repo and collect ndjson/jsonl candidates (bounded).
function listNdjsonCandidates(rootDir) {
  const out = [];
  const exts = /\.(ndjson|ndjsonl|jsonl)$/i;

  function walk(dir, depth) {
    if (depth > 6) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const ent of entries) {
      const name = ent.name;
      if (name === "node_modules" || name === ".git" || name === "dist" || name === "build")
        continue;

      const full = path.join(dir, name);
      if (ent.isFile() && exts.test(name)) {
        try {
          const st = fs.statSync(full);
          out.push({ full: normalizePath(full), mtimeMs: st.mtimeMs, size: st.size });
        } catch {
          // ignore
        }
      }
    }

    for (const ent of entries) {
      const name = ent.name;
      if (name === "node_modules" || name === ".git" || name === "dist" || name === "build")
        continue;

      const full = path.join(dir, name);
      if (ent.isDirectory()) walk(full, depth + 1);
    }
  }

  walk(rootDir, 0);

  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

// Content-based NDJSON detection: pick the most recently updated file whose tail contains markers.
function findNdjsonByContent(kind) {
  const cwd = process.cwd();

  // Allow explicit override (best practice once known)
  const envKey = kind === "visits" ? "POS_VISITS_NDJSON" : "POS_REWARDS_NDJSON";
  const envPath = process.env[envKey];
  if (envPath && fileExists(envPath)) return normalizePath(envPath);

  const candidates = listNdjsonCandidates(cwd).slice(0, 60); // most recent only
  if (!candidates.length) return null;

  // Markers observed / expected
  const markers =
    kind === "visits"
      ? ['"pvHook":"pos.visit.persisted"', '"visitId"', '"posVisitId"', '"vis_', "pos.visit.persisted"]
      : ['"pvHook":"pos.reward.persisted"', '"rewardId"', '"rew_', "pos.reward.persisted"];

  for (const c of candidates) {
    let rawTail = "";
    try {
      // read last ~256KB max to keep fast
      const buf = fs.readFileSync(c.full);
      const start = Math.max(0, buf.length - 262144);
      rawTail = buf.slice(start).toString("utf8");
    } catch {
      continue;
    }

    const hit = markers.some((m) => rawTail.includes(m));
    if (!hit) continue;

    return c.full;
  }

  // Fallback: most recent ndjson anyway
  return candidates[0].full;
}

async function computeTodayStats(ctx, hook) {
  const visitsPath = findNdjsonByContent("visits");
  const rewardsPath = findNdjsonByContent("rewards");

  const storeIdStr = String(ctx.storeId);
  const merchantIdStr = String(ctx.merchantId);
  const dayStartMs = startOfLocalDay(new Date()).getTime();

  const visits = visitsPath ? readNdjsonTail(visitsPath, { maxLines: 50000 }) : [];
  const rewards = rewardsPath ? readNdjsonTail(rewardsPath, { maxLines: 50000 }) : [];

  let visitsCount = 0;
  let rewardsCount = 0;
  let latestMs = 0;

  for (const rec of visits) {
    const sid = extractStoreId(rec);
    if (!sid || sid !== storeIdStr) continue;

    const mid = extractMerchantId(rec);
    if (mid && mid !== merchantIdStr) continue;

    const when = extractWhen(rec);
    if (!when) continue;
    const ms = when.getTime();
    if (ms < dayStartMs) continue;

    const isVisit =
      rec.pvHook === "pos.visit.persisted" ||
      rec.visitId ||
      rec.posVisitId ||
      (typeof rec.pvHook === "string" && rec.pvHook.includes("visit"));
    if (!isVisit) continue;

    visitsCount += 1;
    if (ms > latestMs) latestMs = ms;
  }

  for (const rec of rewards) {
    const sid = extractStoreId(rec);
    if (!sid || sid !== storeIdStr) continue;

    const mid = extractMerchantId(rec);
    if (mid && mid !== merchantIdStr) continue;

    const when = extractWhen(rec);
    if (!when) continue;
    const ms = when.getTime();
    if (ms < dayStartMs) continue;

    const isReward =
      rec.pvHook === "pos.reward.persisted" ||
      rec.rewardId ||
      (typeof rec.pvHook === "string" && rec.pvHook.includes("reward"));
    if (!isReward) continue;

    rewardsCount += 1;
    if (ms > latestMs) latestMs = ms;
  }

  const lastUpdatedAt = latestMs ? new Date(latestMs).toISOString() : null;

  hook("pos.stats.today.computed.api", {
    tc: "TC-POS-STATS-01",
    sev: "info",
    stable: `store:${ctx.storeId}`,
    storeId: ctx.storeId,
    merchantId: ctx.merchantId,
    visitsCount,
    rewardsCount,
    lastUpdatedAt,
    source: "ndjson",
    visitsPathFound: Boolean(visitsPath),
    rewardsPathFound: Boolean(rewardsPath),
    visitsFile: visitsPath ? path.basename(visitsPath) : null,
    rewardsFile: rewardsPath ? path.basename(rewardsPath) : null,
    visitsRecordsRead: visits.length,
    rewardsRecordsRead: rewards.length,
  });

  return { visitsCount, rewardsCount, lastUpdatedAt };
}

async function computeRecentActivity(ctx, hook, limit) {
  const visitsPath = findNdjsonByContent("visits");
  const rewardsPath = findNdjsonByContent("rewards");

  const storeIdStr = String(ctx.storeId);
  const merchantIdStr = String(ctx.merchantId);

  const visits = visitsPath ? readNdjsonTail(visitsPath, { maxLines: 50000 }) : [];
  const rewards = rewardsPath ? readNdjsonTail(rewardsPath, { maxLines: 50000 }) : [];

  const items = [];

  for (const rec of visits) {
    const sid = extractStoreId(rec);
    if (!sid || sid !== storeIdStr) continue;

    const mid = extractMerchantId(rec);
    if (mid && mid !== merchantIdStr) continue;

    const when = extractWhen(rec);
    if (!when) continue;

    const isVisit =
      rec.pvHook === "pos.visit.persisted" ||
      rec.visitId ||
      rec.posVisitId ||
      (typeof rec.pvHook === "string" && rec.pvHook.includes("visit"));
    if (!isVisit) continue;

    const identifier = rec.identifier ?? rec.posIdentifier ?? rec.body?.identifier ?? rec.payload?.identifier;

    const idVal = String(rec.posVisitId ?? rec.visitId ?? rec.id ?? "");

    items.push({
      type: "visit",
      at: when.toISOString(),
      id: idVal,
      posVisitId: idVal,
      identifierMasked: maskIdentifier(identifier),
    });
  }

  for (const rec of rewards) {
    const sid = extractStoreId(rec);
    if (!sid || sid !== storeIdStr) continue;

    const mid = extractMerchantId(rec);
    if (mid && mid !== merchantIdStr) continue;

    const when = extractWhen(rec);
    if (!when) continue;

    const isReward =
      rec.pvHook === "pos.reward.persisted" ||
      rec.rewardId ||
      (typeof rec.pvHook === "string" && rec.pvHook.includes("reward"));
    if (!isReward) continue;

    const identifier = rec.identifier ?? rec.posIdentifier ?? rec.body?.identifier ?? rec.payload?.identifier;

    const rewardId = String(rec.rewardId ?? rec.id ?? "");
    const posVisitId = rec.posVisitId ? String(rec.posVisitId) : rec.visitId ? String(rec.visitId) : null;

    items.push({
      type: "reward",
      at: when.toISOString(),
      id: rewardId,
      rewardId,
      posVisitId,
      identifierMasked: maskIdentifier(identifier),
    });
  }

  items.sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0));

  const cap = Math.max(1, Math.min(200, Number(limit) || 25));
  const sliced = items.slice(0, cap);

  hook("pos.activity.recent.computed.api", {
    tc: "TC-POS-ACT-01",
    sev: "info",
    stable: `store:${ctx.storeId}`,
    storeId: ctx.storeId,
    merchantId: ctx.merchantId,
    count: sliced.length,
    source: "ndjson",
    visitsPathFound: Boolean(visitsPath),
    rewardsPathFound: Boolean(rewardsPath),
    visitsFile: visitsPath ? path.basename(visitsPath) : null,
    rewardsFile: rewardsPath ? path.basename(rewardsPath) : null,
    visitsRecordsRead: visits.length,
    rewardsRecordsRead: rewards.length,
  });

  return sliced;
}

function registerPosRoutes(app, { prisma, sendError, requireAuth }) {
  if (!app) throw new Error("registerPosRoutes: app required");
  if (!prisma) throw new Error("registerPosRoutes: prisma required");
  if (!sendError) throw new Error("registerPosRoutes: sendError required");
  if (typeof requireAuth !== "function")
    throw new Error("registerPosRoutes: requireAuth middleware required");

  const router = express.Router();
  router.use(express.json());

  router.use((req, res, next) => {
    req.pvHook = pvHook;
    res.locals.sendError = sendError;
    next();
  });

  async function requirePosContext(req, res) {
    const hook = getHook(req);

    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      select: {
        id: true,
        systemRole: true,
        merchantUsers: {
          where: { status: "active" },
          select: {
            id: true,
            role: true,
            merchantId: true,
            storeUsers: {
              where: { status: "active" },
              select: { storeId: true, permissionLevel: true },
            },
          },
        },
      },
    });

    if (!user) {
      hook("pos.auth.context.failed.api", {
        tc: "TC-POS-AUTH-CTX-01",
        sev: "warn",
        stable: "pos:auth:context",
        reason: "user_not_found",
      });
      sendError(res, 404, "NOT_FOUND", "User not found");
      return null;
    }

    if (user.systemRole === "pv_admin") {
      hook("pos.auth.context.failed.api", {
        tc: "TC-POS-AUTH-CTX-02",
        sev: "warn",
        stable: "pos:auth:context",
        reason: "pv_admin_forbidden",
      });
      sendError(res, 403, "FORBIDDEN", "pv_admin does not use POS");
      return null;
    }

    let storeId = null;
    let merchantId = null;

    for (const mu of user.merchantUsers || []) {
      if (mu.role !== "store_subadmin") continue;
      const su = (mu.storeUsers || []).find((s) => s.permissionLevel === "subadmin");
      if (su) {
        storeId = su.storeId;
        merchantId = mu.merchantId;
        break;
      }
    }

    if (!storeId || !merchantId) {
      hook("pos.auth.context.failed.api", {
        tc: "TC-POS-AUTH-CTX-03",
        sev: "warn",
        stable: "pos:auth:context",
        reason: "pos_associate_required",
      });
      sendError(res, 403, "FORBIDDEN", "POS associate required");
      return null;
    }

    return { userId: user.id, merchantId, storeId };
  }

  // ===============================
  // POS-9: Customer identity helpers
  // ===============================

  function requireNonEmptyString(value, fieldName) {
    if (typeof value !== "string" || !value.trim()) {
      const err = new Error(`${fieldName}_required`);
      err.statusCode = 400;
      err.code = `${fieldName}_required`;
      throw err;
    }
    return value.trim();
  }

  function normalizePhoneE164(raw) {
    const s = requireNonEmptyString(raw, "identityValue");
    const digits = s.replace(/[^\d]/g, "");
    if (digits.length < 10 || digits.length > 15) {
      const err = new Error("invalid_phone");
      err.statusCode = 400;
      err.code = "invalid_phone";
      throw err;
    }
    return `+${digits}`;
  }

  function requireFirstName(raw) {
    return requireNonEmptyString(raw, "firstName");
  }

  function formatConsumerDisplayName(consumer) {
    const first = String(consumer?.firstName || "").trim();
    const last = String(consumer?.lastName || "").trim();
    if (!first) return "Customer";
    return last ? `${first} ${last.charAt(0)}.` : first;
  }

  async function isConsumerAssociatedToStore({ prisma, storeId, consumerId }) {
    const sc = await prisma.storeConsumer.findUnique({
      where: { storeId_consumerId: { storeId: Number(storeId), consumerId: Number(consumerId) } },
      select: { id: true, status: true },
    });
    return Boolean(sc && sc.status === "active");
  }

  // -----------------------------
  // READ endpoints
  // -----------------------------

  // POS-9: Customer Preview (read-only, store-scoped)
  router.post("/pos/customer/preview", requireAuth, async (req, res) => {
    const hook = getHook(req);

    hook("pos.customer.preview.requested.api", {
      tc: "TC-POS-CUST-01",
      sev: "info",
      stable: "pos:customer:preview",
      identifierMasked: maskIdentifier(req.body?.identityValue),
    });

    try {
      const ctx = await requirePosContext(req, res);
      if (!ctx) return;

      const identityValueRaw = req.body?.identityValue;
      if (!identityValueRaw) {
        hook("pos.customer.preview.failed.api", {
          tc: "TC-POS-CUST-02",
          sev: "warn",
          stable: "pos:customer:preview:validation",
          reason: "identityValue_required",
        });
        return sendError(res, 400, "VALIDATION_ERROR", "identityValue is required");
      }

      const v = validateIdentifier(identityValueRaw);
      if (!v.ok || v.kind !== "phone") {
        hook("pos.customer.preview.failed.api", {
          tc: "TC-POS-CUST-02",
          sev: "warn",
          stable: "pos:customer:preview:validation",
          reason: "phone_required",
          detail: v.ok ? `kind:${v.kind}` : v.reason,
          identifierMasked: maskIdentifier(identityValueRaw),
        });
        return sendError(res, 400, "VALIDATION_ERROR", "phone identityValue is required");
      }

      const phoneE164 = normalizePhoneE164(identityValueRaw);

      const consumer = await prisma.consumer.findUnique({
        where: { phoneE164 },
        select: { id: true, firstName: true, lastName: true, createdAt: true, status: true, archivedAt: true, suspendedAt: true },
      });

      // Store-scoped visibility: if not associated with this store, treat as not found.
      if (!consumer || consumer.status !== "active") {
        hook("pos.customer.preview.not_found.api", {
          tc: "TC-POS-CUST-03",
          sev: "info",
          stable: `store:${ctx.storeId}`,
          merchantId: ctx.merchantId,
          storeId: ctx.storeId,
          phoneE164Masked: maskIdentifier(phoneE164),
          reason: consumer ? "not_active" : "no_consumer",
        });
        return res.json({ ok: true, found: false });
      }

      const associated = await isConsumerAssociatedToStore({
        prisma,
        storeId: ctx.storeId,
        consumerId: consumer.id,
      });

      if (!associated) {
        hook("pos.customer.preview.not_found.api", {
          tc: "TC-POS-CUST-03",
          sev: "info",
          stable: `store:${ctx.storeId}`,
          merchantId: ctx.merchantId,
          storeId: ctx.storeId,
          phoneE164Masked: maskIdentifier(phoneE164),
          reason: "not_associated_to_store",
        });
        return res.json({ ok: true, found: false });
      }

      const displayName = formatConsumerDisplayName(consumer);

      hook("pos.customer.preview.succeeded.api", {
        tc: "TC-POS-CUST-04",
        sev: "info",
        stable: `store:${ctx.storeId}`,
        merchantId: ctx.merchantId,
        storeId: ctx.storeId,
        consumerId: consumer.id,
        displayName,
      });

      return res.json({
        ok: true,
        found: true,
        customer: {
          consumerId: consumer.id,
          displayName,
          createdAt: consumer.createdAt,
        },
      });
    } catch (e) {
      hook("pos.customer.preview.failed.api", {
        tc: "TC-POS-CUST-05",
        sev: "error",
        stable: "pos:customer:preview:error",
        error: e?.message || String(e),
      });
      return sendError(res, 500, "SERVER_ERROR", "Error");
    }
  });

  router.get("/pos/visit/:posVisitId", requireAuth, async (req, res) => {
    const hook = getHook(req);
    const { posVisitId } = req.params;

    hook("pos.read.visit.requested.api", {
      tc: "TC-POS-READ-01",
      sev: "info",
      stable: "pos:read:visit",
      posVisitId: String(posVisitId),
    });

    try {
      const ctx = await requirePosContext(req, res);
      if (!ctx) return;

      const visit = await getVisitByPosVisitId(String(posVisitId), { pvHook: hook });

      if (!visit) {
        hook("pos.read.visit.not_found.api", {
          tc: "TC-POS-READ-02",
          sev: "info",
          stable: `store:${ctx.storeId}`,
          merchantId: ctx.merchantId,
          storeId: ctx.storeId,
          posVisitId: String(posVisitId),
        });
        return sendError(res, 404, "NOT_FOUND", "Visit not found");
      }

      if (String(visit.storeId) !== String(ctx.storeId)) {
        hook("pos.read.visit.failed.api", {
          tc: "TC-POS-READ-03",
          sev: "warn",
          stable: "pos:read:visit:forbidden",
          reason: "store_scope_mismatch",
          posVisitId: String(posVisitId),
          storeId: ctx.storeId,
        });
        return sendError(res, 403, "FORBIDDEN", "Forbidden");
      }

      hook("pos.read.visit.succeeded.api", {
        tc: "TC-POS-READ-04",
        sev: "info",
        stable: `store:${ctx.storeId}`,
        merchantId: ctx.merchantId,
        storeId: ctx.storeId,
        posVisitId: String(posVisitId),
        visitPk: visit.id,
        identifierMasked: maskIdentifier(visit.posIdentifier),
      });

      return res.json({ ok: true, visit });
    } catch (e) {
      hook("pos.read.visit.failed.api", {
        tc: "TC-POS-READ-05",
        sev: "error",
        stable: "pos:read:visit:error",
        posVisitId: String(posVisitId),
        error: e?.message || String(e),
      });
      return sendError(res, 500, "SERVER_ERROR", "Error");
    }
  });

  router.get("/pos/reward/:rewardId", requireAuth, async (req, res) => {
    const hook = getHook(req);
    const { rewardId } = req.params;

    hook("pos.read.reward.requested.api", {
      tc: "TC-POS-READ-06",
      sev: "info",
      stable: "pos:read:reward",
      rewardId: String(rewardId),
    });

    try {
      const ctx = await requirePosContext(req, res);
      if (!ctx) return;

      const reward = await getRewardById(String(rewardId), { pvHook: hook });

      if (!reward) {
        hook("pos.read.reward.not_found.api", {
          tc: "TC-POS-READ-07",
          sev: "info",
          stable: `store:${ctx.storeId}`,
          merchantId: ctx.merchantId,
          storeId: ctx.storeId,
          rewardId: String(rewardId),
        });
        return sendError(res, 404, "NOT_FOUND", "Reward not found");
      }

      if (String(reward.storeId) !== String(ctx.storeId)) {
        hook("pos.read.reward.failed.api", {
          tc: "TC-POS-READ-08",
          sev: "warn",
          stable: "pos:read:reward:forbidden",
          reason: "store_scope_mismatch",
          rewardId: String(rewardId),
          storeId: ctx.storeId,
        });
        return sendError(res, 403, "FORBIDDEN", "Forbidden");
      }

      hook("pos.read.reward.succeeded.api", {
        tc: "TC-POS-READ-09",
        sev: "info",
        stable: `store:${ctx.storeId}`,
        merchantId: ctx.merchantId,
        storeId: ctx.storeId,
        rewardId: String(rewardId),
        posVisitId: reward.posVisitId || null,
        identifierMasked: maskIdentifier(reward.identifier),
      });

      return res.json({ ok: true, reward });
    } catch (e) {
      hook("pos.read.reward.failed.api", {
        tc: "TC-POS-READ-10",
        sev: "error",
        stable: "pos:read:reward:error",
        rewardId: String(rewardId),
        error: e?.message || String(e),
      });
      return sendError(res, 500, "SERVER_ERROR", "Error");
    }
  });

  // -----------------------------
  // Dashboard endpoints (GET)
  // -----------------------------

  async function handleTodayStats(req, res) {
    const hook = getHook(req);
    try {
      res.setHeader("Cache-Control", "no-store");
    } catch {}

    hook("pos.stats.today.requested.api", {
      tc: "TC-POS-STATS-01",
      sev: "info",
      stable: "pos:stats:today",
    });

    try {
      const ctx = await requirePosContext(req, res);
      if (!ctx) return;

      const stats = await computeTodayStats(ctx, hook);

      hook("pos.stats.today.succeeded.api", {
        tc: "TC-POS-STATS-02",
        sev: "info",
        stable: `store:${ctx.storeId}`,
        merchantId: ctx.merchantId,
        storeId: ctx.storeId,
        visitsCount: stats.visitsCount,
        rewardsCount: stats.rewardsCount,
        lastUpdatedAt: stats.lastUpdatedAt || null,
        source: "ndjson",
      });

      return res.json({
        ok: true,
        today: {
          visitsCount: stats.visitsCount,
          rewardsCount: stats.rewardsCount,
          lastUpdatedAt: stats.lastUpdatedAt,
          source: "ndjson",
        },
      });
    } catch (e) {
      hook("pos.stats.today.failed.api", {
        tc: "TC-POS-STATS-03",
        sev: "error",
        stable: "pos:stats:today:error",
        error: e?.message || String(e),
      });
      return sendError(res, 500, "SERVER_ERROR", e?.message ? String(e.message) : "Error");
    }
  }

  async function handleRecentActivity(req, res) {
    const hook = getHook(req);
    try {
      res.setHeader("Cache-Control", "no-store");
    } catch {}

    hook("pos.activity.recent.requested.api", {
      tc: "TC-POS-ACT-01",
      sev: "info",
      stable: "pos:activity:recent",
    });

    try {
      const ctx = await requirePosContext(req, res);
      if (!ctx) return;

      const items = await computeRecentActivity(ctx, hook, req.query?.limit);

      hook("pos.activity.recent.succeeded.api", {
        tc: "TC-POS-ACT-02",
        sev: "info",
        stable: `store:${ctx.storeId}`,
        merchantId: ctx.merchantId,
        storeId: ctx.storeId,
        activityCount: items.length,
      });

      return res.json({ ok: true, activity: { items } });
    } catch (e) {
      hook("pos.activity.recent.failed.api", {
        tc: "TC-POS-ACT-03",
        sev: "error",
        stable: "pos:activity:recent:error",
        error: e?.message || String(e),
      });
      return sendError(res, 500, "SERVER_ERROR", e?.message ? String(e.message) : "Error");
    }
  }

  router.get("/pos/stats/today", requireAuth, handleTodayStats);
  router.get("/pos/activity/recent", requireAuth, handleRecentActivity);
  router.get("/pos/today", requireAuth, handleTodayStats);
  router.get("/pos/activity", requireAuth, handleRecentActivity);

  // -----------------------------
  // WRITE endpoints (POST)
  // -----------------------------

  // POS-9: Customer Create (idempotent)
  router.post("/pos/customer/create", requireAuth, async (req, res) => {
    const hook = getHook(req);

    hook("pos.customer.create.requested.api", {
      tc: "TC-POS-CUST-06",
      sev: "info",
      stable: "pos:customer:create",
      identifierMasked: maskIdentifier(req.body?.identityValue),
    });

    try {
      const ctx = await requirePosContext(req, res);
      if (!ctx) return;

      const identityValueRaw = req.body?.identityValue;
      if (!identityValueRaw) {
        hook("pos.customer.create.failed.api", {
          tc: "TC-POS-CUST-07",
          sev: "warn",
          stable: "pos:customer:create:validation",
          reason: "identityValue_required",
        });
        return sendError(res, 400, "VALIDATION_ERROR", "identityValue is required");
      }

      const v = validateIdentifier(identityValueRaw);
      if (!v.ok || v.kind !== "phone") {
        hook("pos.customer.create.failed.api", {
          tc: "TC-POS-CUST-07",
          sev: "warn",
          stable: "pos:customer:create:validation",
          reason: "phone_required",
          detail: v.ok ? `kind:${v.kind}` : v.reason,
          identifierMasked: maskIdentifier(identityValueRaw),
        });
        return sendError(res, 400, "VALIDATION_ERROR", "phone identityValue is required");
      }

      let firstName = null;
      let lastName = null;

      try {
        firstName = requireFirstName(req.body?.firstName);
        lastName = typeof req.body?.lastName === "string" ? req.body.lastName.trim() : null;
      } catch (e) {
        hook("pos.customer.create.failed.api", {
          tc: "TC-POS-CUST-07",
          sev: "warn",
          stable: "pos:customer:create:validation",
          reason: e?.code || "name_validation",
        });
        return sendError(res, 400, "VALIDATION_ERROR", "firstName is required");
      }

      const phoneE164 = normalizePhoneE164(identityValueRaw);
      const phoneRaw = String(identityValueRaw || "").trim();

      // Idempotent create: first check if consumer exists.
      let consumer = await prisma.consumer.findUnique({
        where: { phoneE164 },
        select: { id: true, firstName: true, lastName: true, createdAt: true, status: true },
      });

      let created = false;

      if (!consumer) {
        try {
          consumer = await prisma.consumer.create({
            data: {
              firstName,
              lastName: lastName || null,
              phoneRaw,
              phoneE164,
              phoneCountry: "US",
            },
            select: { id: true, firstName: true, lastName: true, createdAt: true, status: true },
          });
          created = true;
        } catch (e) {
          // Handle race: unique constraint on phoneE164
          if (e && (e.code === "P2002" || String(e.message || "").includes("Unique constraint"))) {
            consumer = await prisma.consumer.findUnique({
              where: { phoneE164 },
              select: { id: true, firstName: true, lastName: true, createdAt: true, status: true },
            });
            created = false;
          } else {
            throw e;
          }
        }
      }

      if (!consumer || consumer.status !== "active") {
        hook("pos.customer.create.failed.api", {
          tc: "TC-POS-CUST-08",
          sev: "warn",
          stable: "pos:customer:create:not_active",
          reason: consumer ? "consumer_not_active" : "consumer_missing_after_create",
          phoneE164Masked: maskIdentifier(phoneE164),
        });
        return sendError(res, 409, "CONFLICT", "Consumer is not active");
      }

      // Ensure store+merchant associations (no-op if already exists)
      await prisma.$transaction(async (tx) => {
        await tx.merchantConsumer.upsert({
          where: { merchantId_consumerId: { merchantId: Number(ctx.merchantId), consumerId: Number(consumer.id) } },
          create: { merchantId: Number(ctx.merchantId), consumerId: Number(consumer.id) },
          update: {},
        });

        await tx.storeConsumer.upsert({
          where: { storeId_consumerId: { storeId: Number(ctx.storeId), consumerId: Number(consumer.id) } },
          create: { storeId: Number(ctx.storeId), consumerId: Number(consumer.id) },
          update: {},
        });
      });

      const displayName = formatConsumerDisplayName(consumer);

      hook("pos.customer.create.succeeded.api", {
        tc: "TC-POS-CUST-09",
        sev: "info",
        stable: `store:${ctx.storeId}`,
        merchantId: ctx.merchantId,
        storeId: ctx.storeId,
        consumerId: consumer.id,
        created,
        displayName,
      });

      return res.json({
        ok: true,
        created,
        customer: {
          consumerId: consumer.id,
          displayName,
          createdAt: consumer.createdAt,
        },
      });
    } catch (e) {
      hook("pos.customer.create.failed.api", {
        tc: "TC-POS-CUST-10",
        sev: "error",
        stable: "pos:customer:create:error",
        error: e?.message || String(e),
      });
      return sendError(res, 500, "SERVER_ERROR", "Error");
    }
  });

  router.post(
    "/pos/visit",
    requireAuth,
    requireFreshTimestamp,
    requireIdempotency,
    async (req, res) => {
      const hook = getHook(req);
      const identifier = req.body?.identifier;

      hook("pos.visit.requested.api", {
        tc: "TC-POS-API-01",
        sev: "info",
        stable: "pos:visit",
        identifierMasked: maskIdentifier(identifier),
      });

      if (!identifier) {
        hook("pos.visit.failed.api", {
          tc: "TC-POS-API-02",
          sev: "warn",
          stable: "pos:visit:validation",
          reason: "identifier_required",
        });
        return sendError(res, 400, "VALIDATION_ERROR", "identifier is required");
      }

      const v = validateIdentifier(identifier);
      if (!v.ok) {
        hook("pos.visit.failed.api", {
          tc: "TC-POS-API-02",
          sev: "warn",
          stable: "pos:visit:validation",
          reason: "identifier_invalid_format",
          detail: v.reason,
          identifierMasked: maskIdentifier(identifier),
        });
        return sendError(res, 400, "VALIDATION_ERROR", "identifier format is invalid");
      }

      try {
        const ctx = await requirePosContext(req, res);
        if (!ctx) return;

        const result = await persistVisit({
          ctx: { ...ctx, pvHook: hook, at: new Date().toISOString() },
          body: req.body,
          idempotencyKey: req.headers["x-pos-idempotency-key"],
        });

        hook("pos.visit.succeeded.api", {
          tc: "TC-POS-API-03",
          sev: "info",
          stable: `store:${ctx.storeId}`,
          merchantId: ctx.merchantId,
          storeId: ctx.storeId,
          visitId: result.visitId,
        });

        return res.json({ ok: true, visitId: result.visitId, identifier: String(identifier) });
      } catch (e) {
        hook("pos.visit.failed.api", {
          tc: "TC-POS-API-04",
          sev: "error",
          stable: "pos:visit:error",
          error: e?.message || String(e),
        });
        return sendError(res, 500, "SERVER_ERROR", "Error");
      }
    }
  );

  router.post(
    "/pos/reward",
    requireAuth,
    requireFreshTimestamp,
    requireIdempotency,
    async (req, res) => {
      const hook = getHook(req);
      const identifier = req.body?.identifier;

      hook("pos.reward.requested.api", {
        tc: "TC-POS-API-05",
        sev: "info",
        stable: "pos:reward",
        identifierMasked: maskIdentifier(identifier),
      });

      if (!identifier) {
        hook("pos.reward.failed.api", {
          tc: "TC-POS-API-06",
          sev: "warn",
          stable: "pos:reward:validation",
          reason: "identifier_required",
        });
        return sendError(res, 400, "VALIDATION_ERROR", "identifier is required");
      }

      const v = validateIdentifier(identifier);
      if (!v.ok) {
        hook("pos.reward.failed.api", {
          tc: "TC-POS-API-06",
          sev: "warn",
          stable: "pos:reward:validation",
          reason: "identifier_invalid_format",
          detail: v.reason,
          identifierMasked: maskIdentifier(identifier),
        });
        return sendError(res, 400, "VALIDATION_ERROR", "identifier format is invalid");
      }

      try {
        const ctx = await requirePosContext(req, res);
        if (!ctx) return;

        const result = await persistReward({
          ctx: { ...ctx, pvHook: hook, at: new Date().toISOString() },
          body: req.body,
          idempotencyKey: req.headers["x-pos-idempotency-key"],
        });

        hook("pos.reward.succeeded.api", {
          tc: "TC-POS-API-07",
          sev: "info",
          stable: `store:${ctx.storeId}`,
          merchantId: ctx.merchantId,
          storeId: ctx.storeId,
          rewardId: result.rewardId,
        });

        return res.json({ ok: true, rewardId: result.rewardId, identifier: String(identifier) });
      } catch (e) {
        hook("pos.reward.failed.api", {
          tc: "TC-POS-API-08",
          sev: "error",
          stable: "pos:reward:error",
          error: e?.message || String(e),
        });
        return sendError(res, 500, "SERVER_ERROR", "Error");
      }
    }
  );

  return { router };
}

module.exports = { registerPosRoutes };
