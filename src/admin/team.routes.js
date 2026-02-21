/**
 * PV Org Surface — Team Routes
 * Mount: /admin/team (index.js mounts this)
 *
 * Contract:
 * - Option A listing: staff-only (systemRole != "user")
 * - Provide GET/POST/PATCH
 * - Keep /admin middleware chain protection (no auth here)
 * - pv_qa disabled in production
 */

const express = require("express");
const crypto = require("crypto");
const router = express.Router();

// Prisma client resolution (supports common project patterns)
let prisma;
try {
  prisma = require("../prisma").prisma || require("../prisma");
} catch {
  prisma = require("../db/prisma").prisma || require("../db/prisma");
}

// --- safe hook logger (never throw)
function pvHook(event, fields = {}) {
  try {
    console.log(
      JSON.stringify({
        pvHook: event,
        ts: new Date().toISOString(),
        ...fields,
      })
    );
  } catch {}
}

const STAFF_ROLES = new Set(["pv_admin", "pv_support", "pv_qa"]);
const isProd = String(process.env.NODE_ENV || "").toLowerCase() === "production";

function denyPvQaInProd(role) {
  return isProd && String(role) === "pv_qa";
}

// IMPORTANT: User.id is Int in Prisma schema; normalize route param.
function normalizeUserId(idParam) {
  const s = String(idParam || "").trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) return Number(s);
  return s; // fallback if schema ever changes to string ids
}

async function hashPassword(plain) {
  const pw = String(plain || "");
  if (pw.length < 10) {
    const e = new Error("password must be at least 10 characters");
    e.status = 400;
    throw e;
  }

  try {
    const argon2 = require("argon2");
    return await argon2.hash(pw);
  } catch {}

  try {
    const bcryptjs = require("bcryptjs");
    const salt = await bcryptjs.genSalt(12);
    return await bcryptjs.hash(pw, salt);
  } catch {}

  try {
    const bcrypt = require("bcrypt");
    const salt = await bcrypt.genSalt(12);
    return await bcrypt.hash(pw, salt);
  } catch {}

  const e = new Error("no password hashing library available (argon2/bcryptjs/bcrypt)");
  e.status = 500;
  throw e;
}

function badRequest(res, message, extra = {}) {
  return res.status(400).json({ error: message, ...extra });
}
function forbidden(res, message) {
  return res.status(403).json({ error: message });
}
function notFound(res, message) {
  return res.status(404).json({ error: message });
}

// GET /admin/team
router.get("/", async (req, res) => {
  const rid = crypto.randomUUID();
  pvHook("admin.team.list.start", { rid });

  try {
    const rows = await prisma.user.findMany({
      where: { NOT: { systemRole: "user" } },
      orderBy: [{ createdAt: "asc" }],
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        systemRole: true,
        department: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    pvHook("admin.team.list.ok", { rid, count: rows.length });
    return res.json(rows);
  } catch (err) {
    pvHook("admin.team.list.err", { rid, message: String(err?.message || err) });
    return res.status(500).json({ error: "Failed to list team" });
  }
});

// POST /admin/team
router.post("/", async (req, res) => {
  const rid = crypto.randomUUID();
  pvHook("admin.team.create.start", { rid });

  try {
    const body = req.body || {};
    const email = String(body.email || "").trim().toLowerCase();
    const password = body.password;
    const firstName = body.firstName == null ? null : String(body.firstName).trim();
    const lastName = body.lastName == null ? null : String(body.lastName).trim();
    const systemRole = String(body.systemRole || "").trim();
    const department = body.department == null ? null : String(body.department).trim();

    if (!email) return badRequest(res, "email is required");
    if (!systemRole) return badRequest(res, "systemRole is required");
    if (!STAFF_ROLES.has(systemRole)) return badRequest(res, "systemRole must be pv_admin | pv_support | pv_qa");
    if (denyPvQaInProd(systemRole)) return forbidden(res, "pv_qa is disabled in production");

    const passwordHash = await hashPassword(password);

    const created = await prisma.user.create({
      data: { email, passwordHash, firstName, lastName, systemRole, department },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        systemRole: true,
        department: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    pvHook("admin.team.create.ok", { rid, userId: created.id, systemRole: created.systemRole });
    return res.status(201).json(created);
  } catch (err) {
    const msg = String(err?.message || err);
    pvHook("admin.team.create.err", { rid, message: msg });

    if (msg.toLowerCase().includes("unique") || msg.toLowerCase().includes("p2002")) {
      return res.status(409).json({ error: "User with that email already exists" });
    }

    const status = err?.status || 500;
    return res.status(status).json({ error: status === 500 ? "Failed to create team member" : msg });
  }
});

// PATCH /admin/team/:userId
router.patch("/:userId", async (req, res) => {
  const rid = crypto.randomUUID();
  const userId = normalizeUserId(req.params.userId);
  pvHook("admin.team.patch.start", { rid, userId });

  try {
    if (userId == null) return badRequest(res, "userId is required");

    const existing = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, systemRole: true },
    });
    if (!existing) return notFound(res, "User not found");

    const body = req.body || {};
    const data = {};

    if (body.firstName !== undefined) data.firstName = body.firstName == null ? null : String(body.firstName).trim();
    if (body.lastName !== undefined) data.lastName = body.lastName == null ? null : String(body.lastName).trim();
    if (body.department !== undefined) data.department = body.department == null ? null : String(body.department).trim();

    if (body.systemRole !== undefined) {
      const systemRole = String(body.systemRole || "").trim();
      if (!systemRole) return badRequest(res, "systemRole cannot be empty");
      if (systemRole === "user") return badRequest(res, "systemRole cannot be set to user via /admin/team");
      if (!STAFF_ROLES.has(systemRole)) return badRequest(res, "systemRole must be pv_admin | pv_support | pv_qa");
      if (denyPvQaInProd(systemRole)) return forbidden(res, "pv_qa is disabled in production");
      data.systemRole = systemRole;
    }

    if (body.password !== undefined) {
      data.passwordHash = await hashPassword(body.password);
    }

    if (Object.keys(data).length === 0) return badRequest(res, "No updatable fields provided");

    const updated = await prisma.user.update({
      where: { id: userId },
      data,
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        systemRole: true,
        department: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    pvHook("admin.team.patch.ok", { rid, userId: updated.id });
    return res.json(updated);
  } catch (err) {
    const msg = String(err?.message || err);
    pvHook("admin.team.patch.err", { rid, userId, message: msg });

    const status = err?.status || 500;
    return res.status(status).json({ error: status === 500 ? "Failed to update team member" : msg });
  }
});

module.exports = router;
