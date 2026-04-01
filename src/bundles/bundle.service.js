// src/bundles/bundle.service.js
//
// Coordinator layer: DB access + normalizer + engine + events.
// Routes call service functions and map results to HTTP responses.
// The engine and normalizer have no knowledge of Express or Prisma.
//
// Return conventions (routes handle HTTP translation):
//   { bundle }        — success, single bundle
//   { bundles }       — success, list
//   { logs }          — success, audit log
//   { ok: true }      — success, no body needed
//   { errors }        — validation failure (400)
//   { notFound: true }     — record not found (404)
//   { invalidState: msg }  — state machine violation (409)

const { prisma }     = require("../db/prisma");
const normalizer     = require("./bundle.normalizer");
const engine         = require("./bundle.engine");
const events         = require("./bundle.events");
const { safeNormalizePhone } = require("../consumers/consumers.service");

const BUNDLE_INCLUDE = {};

function formatBundle(b) {
  return {
    ...b,
    price: b.price !== undefined && b.price !== null ? Number(b.price) : null,
  };
}

async function logAudit(bundleId, actorUserId, action, changes) {
  try {
    await prisma.bundleAuditLog.create({
      data: { bundleId, actorUserId: actorUserId || null, action, changes: changes || null },
    });
  } catch (e) {
    // Audit log failure must never break the main operation
    console.error("[bundle.audit] Failed to write audit log:", e?.message);
  }
}

// ── List ───────────────────────────────────────────────────────

async function listBundles(merchantId, { status } = {}) {
  const VALID_STATUSES = ["wip", "staged", "live", "suspended", "archived"];
  const where = { merchantId };
  if (status && VALID_STATUSES.includes(status)) where.status = status;

  const bundles = await prisma.bundle.findMany({
    where,
    include: BUNDLE_INCLUDE,
    orderBy: { createdAt: "desc" },
  });

  return { bundles: bundles.map(formatBundle) };
}

// ── Create ─────────────────────────────────────────────────────

async function createBundle(merchantId, body, actorUserId, actorRole) {
  const { errors, input } = normalizer.normalizeCreateInput(body);
  if (errors.length) return { errors };

  const bundle = await prisma.bundle.create({
    data: { merchantId, ...input, status: "wip" },
    include: BUNDLE_INCLUDE,
  });

  await logAudit(bundle.id, actorUserId, "created", {
    name: bundle.name, ruleTree: input.ruleTreeJson,
    price: Number(bundle.price), startAt: input.startAt, endAt: input.endAt, status: "wip",
  });

  events.onBundleCreated({ merchantId, bundleId: bundle.id, actorUserId, actorRole });
  return { bundle: formatBundle(bundle) };
}

// ── Update ─────────────────────────────────────────────────────

async function updateBundle(merchantId, bundleId, body, actorUserId, actorRole) {
  const existing = await prisma.bundle.findFirst({ where: { id: bundleId, merchantId } });
  if (!existing) return { notFound: true };

  const { data, auditChanges, errors } = normalizer.normalizePatchInput(body, existing);
  if (errors.length) return { errors };
  if (Object.keys(data).length === 0) return { bundle: formatBundle(existing) };

  const bundle = await prisma.bundle.update({
    where: { id: bundleId },
    data,
    include: BUNDLE_INCLUDE,
  });

  await logAudit(bundleId, actorUserId, "updated", auditChanges);
  events.onBundleUpdated({
    merchantId, bundleId, actorUserId, actorRole,
    changedFields: auditChanges.map(c => c.field),
  });

  return { bundle: formatBundle(bundle) };
}

// ── Delete ─────────────────────────────────────────────────────

async function deleteBundle(merchantId, bundleId, actorUserId, actorRole) {
  const existing = await prisma.bundle.findFirst({ where: { id: bundleId, merchantId } });
  if (!existing) return { notFound: true };
  if (existing.status !== "wip")
    return { invalidState: `Only WIP bundles can be deleted (current: ${existing.status})` };

  await prisma.bundleAuditLog.deleteMany({ where: { bundleId } });
  await prisma.bundle.delete({ where: { id: bundleId } });

  events.onBundleDeleted({ merchantId, bundleId, actorUserId, actorRole });
  return { ok: true };
}

// ── Duplicate ──────────────────────────────────────────────────

async function duplicateBundle(merchantId, bundleId, actorUserId, actorRole) {
  const existing = await prisma.bundle.findFirst({ where: { id: bundleId, merchantId } });
  if (!existing) return { notFound: true };
  if (existing.status !== "archived")
    return { invalidState: "Only archived bundles can be duplicated" };

  const clone = await prisma.bundle.create({
    data: {
      merchantId,
      name:         existing.name,
      ruleTreeJson: existing.ruleTreeJson,
      price:        existing.price,
      startAt:      null,
      endAt:        null,
      status:       "wip",
    },
    include: BUNDLE_INCLUDE,
  });

  await logAudit(clone.id, actorUserId, "created", {
    duplicatedFromBundleId: bundleId,
    name: clone.name, ruleTree: clone.ruleTreeJson,
    price: Number(clone.price), status: "wip",
  });

  events.onBundleDuplicated({
    merchantId, sourceBundleId: bundleId, newBundleId: clone.id, actorUserId, actorRole,
  });

  return { bundle: formatBundle(clone) };
}

// ── Audit log ──────────────────────────────────────────────────

async function getAuditLog(merchantId, bundleId) {
  const bundle = await prisma.bundle.findFirst({ where: { id: bundleId, merchantId } });
  if (!bundle) return { notFound: true };

  const logs = await prisma.bundleAuditLog.findMany({
    where: { bundleId },
    orderBy: { createdAt: "desc" },
  });

  return { logs };
}

// ── Phase C — POS sell / redeem ───────────────────────────────

/**
 * List live bundles for a merchant (POS sell screen).
 */
async function listLiveBundlesForMerchant(merchantId) {
  const bundles = await prisma.bundle.findMany({
    where: { merchantId, status: "live" },
    orderBy: { name: "asc" },
  });
  return { bundles: bundles.map(formatBundle) };
}

/**
 * Look up a consumer by phone (E164 or raw) or email.
 * Returns { consumer } or { notFound: true }.
 */
async function lookupConsumer(identifier) {
  if (!identifier) return { notFound: true };
  const s = String(identifier).trim();

  // Normalize phone properly (handles country codes, formatting)
  const normalized = safeNormalizePhone(s);
  const digits = s.replace(/[^\d]/g, "");
  const wherePhone = normalized
    ? [{ phoneE164: normalized.e164 }]
    : digits.length >= 10
      ? [{ phoneE164: `+${digits}` }, { phoneE164: s }]
      : [];

  const consumer = await prisma.consumer.findFirst({
    where: {
      OR: [
        { email: s },
        ...wherePhone,
      ],
      status: "active",
    },
    select: { id: true, email: true, firstName: true, lastName: true, phoneE164: true, phoneRaw: true },
  });

  return consumer ? { consumer } : { notFound: true };
}

/**
 * List active BundleInstances for a consumer, scoped to a merchant.
 */
async function listConsumerBundleInstances(consumerId, merchantId) {
  const instances = await prisma.bundleInstance.findMany({
    where: { consumerId, status: "active", bundle: { merchantId } },
    include: {
      bundle: { select: { id: true, name: true, price: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  return {
    instances: instances.map((inst) => ({
      ...inst,
      remaining: engine.describeRemaining(inst),
    })),
  };
}

/**
 * Sell a bundle — creates a BundleInstance for a consumer.
 * consumerId is optional (anonymous sale supported).
 */
async function sellBundle(merchantId, storeId, bundleId, consumerId, actorUserId) {
  const bundle = await prisma.bundle.findFirst({
    where: { id: bundleId, merchantId, status: "live" },
  });
  if (!bundle) return { notFound: true };

  if (consumerId) {
    const consumer = await prisma.consumer.findUnique({
      where: { id: consumerId },
      select: { id: true, status: true },
    });
    if (!consumer || consumer.status !== "active") {
      return { errors: ["Consumer not found or inactive"] };
    }
  }

  const instance = await prisma.bundleInstance.create({
    data: {
      bundleId,
      consumerId: consumerId || null,
      storeId: storeId || null,
      soldByUserId: actorUserId || null,
      originalRuleTreeJson: bundle.ruleTreeJson,
      remainingRuleTreeJson: bundle.ruleTreeJson,
      status: "active",
    },
    include: { bundle: { select: { id: true, name: true, price: true } } },
  });

  await logAudit(bundleId, actorUserId, "sold", {
    instanceId: instance.id,
    consumerId: consumerId || null,
    storeId: storeId || null,
    price: Number(bundle.price),
  });

  return {
    instance: { ...instance, remaining: engine.describeRemaining(instance) },
  };
}

/**
 * Redeem one set from a bundle instance (simple mode).
 * idempotencyKey prevents double-redeem on network retry.
 */
async function redeemBundleInstance(instanceId, merchantId, actorUserId, idempotencyKey) {
  const instance = await prisma.bundleInstance.findFirst({
    where: { id: instanceId, bundle: { merchantId } },
    include: { bundle: { select: { id: true, name: true, merchantId: true } } },
  });

  if (!instance) return { notFound: true };
  if (instance.status !== "active") {
    return { invalidState: `Bundle instance is already ${instance.status}` };
  }

  // Idempotency check
  if (idempotencyKey) {
    const existing = await prisma.bundleInstanceEventMarker.findUnique({
      where: {
        bundleInstanceId_eventType_eventKey: {
          bundleInstanceId: instanceId,
          eventType: "redeem",
          eventKey: String(idempotencyKey),
        },
      },
    });
    if (existing) {
      return { instance: { ...instance, remaining: engine.describeRemaining(instance) }, idempotent: true };
    }
  }

  const result = engine.consume(instance);
  if (!result.success) {
    return { invalidState: "Bundle instance has no remaining uses" };
  }

  const now = new Date();
  const ops = [
    prisma.bundleInstance.update({
      where: { id: instanceId },
      data: {
        remainingRuleTreeJson: result.updatedRemaining,
        status: result.status,
        ...(result.status === "redeemed" ? { redeemedAt: now } : {}),
      },
      include: { bundle: { select: { id: true, name: true } } },
    }),
  ];
  if (idempotencyKey) {
    ops.push(
      prisma.bundleInstanceEventMarker.create({
        data: { bundleInstanceId: instanceId, eventType: "redeem", eventKey: String(idempotencyKey) },
      })
    );
  }

  const [updated] = await prisma.$transaction(ops);

  await logAudit(instance.bundle.id, actorUserId, "redeemed", {
    instanceId,
    newStatus: result.status,
    idempotencyKey: idempotencyKey || null,
  });

  return { instance: { ...updated, remaining: engine.describeRemaining(updated) } };
}

/**
 * Preview a redemption (dry-run, no DB write).
 */
async function previewRedemption(instanceId, merchantId) {
  const instance = await prisma.bundleInstance.findFirst({
    where: { id: instanceId, bundle: { merchantId } },
  });
  if (!instance) return { notFound: true };
  return engine.preview(instance);
}

module.exports = {
  listBundles,
  createBundle,
  updateBundle,
  deleteBundle,
  duplicateBundle,
  getAuditLog,
  // Phase C
  listLiveBundlesForMerchant,
  lookupConsumer,
  listConsumerBundleInstances,
  sellBundle,
  redeemBundleInstance,
  previewRedemption,
};
