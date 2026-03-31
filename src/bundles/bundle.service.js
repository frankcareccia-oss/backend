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

const BUNDLE_INCLUDE = { category: true };

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

async function verifyCategoryMerchant(categoryId, merchantId) {
  return prisma.productCategory.findFirst({
    where: { id: categoryId, merchantId, status: "active" },
  });
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

  const cat = await verifyCategoryMerchant(input.categoryId, merchantId);
  if (!cat) return { errors: ["Category not found or inactive"] };

  const bundle = await prisma.bundle.create({
    data: { merchantId, ...input, status: "wip" },
    include: BUNDLE_INCLUDE,
  });

  await logAudit(bundle.id, actorUserId, "created", {
    name: bundle.name, categoryId: input.categoryId,
    quantity: bundle.quantity, price: Number(bundle.price),
    startAt: input.startAt, endAt: input.endAt, status: "wip",
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
  const existing = await prisma.bundle.findFirst({
    where: { id: bundleId, merchantId },
    include: { category: true },
  });
  if (!existing) return { notFound: true };
  if (existing.status !== "archived")
    return { invalidState: "Only archived bundles can be duplicated" };

  const clone = await prisma.bundle.create({
    data: {
      merchantId,
      categoryId: existing.categoryId,
      name:       existing.name,
      quantity:   existing.quantity,
      price:      existing.price,
      startAt:    null,
      endAt:      null,
      status:     "wip",
    },
    include: { category: true },
  });

  await logAudit(clone.id, actorUserId, "created", {
    duplicatedFromBundleId: bundleId,
    name: clone.name, categoryId: clone.categoryId,
    quantity: clone.quantity, price: Number(clone.price), status: "wip",
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

// ── Engine passthroughs (Phase B/C) ───────────────────────────
//
// Routes will call these once consumer identity and POS transaction
// payloads exist. The normalizer converts the raw payload; the engine
// evaluates it; the service persists the result and fires events.

async function previewRedemption(rawInput, instance) {
  const transactionInput = normalizer.normalizeTransactionInput(rawInput);
  return engine.preview(transactionInput, instance);
}

async function consumeRedemption(rawInput, instance) {
  const transactionInput = normalizer.normalizeTransactionInput(rawInput);
  return engine.consume(transactionInput, instance);
}

module.exports = {
  listBundles,
  createBundle,
  updateBundle,
  deleteBundle,
  duplicateBundle,
  getAuditLog,
  previewRedemption,
  consumeRedemption,
};
