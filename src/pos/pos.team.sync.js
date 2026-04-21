/**
 * pos.team.sync.js — Read-only employee sync from POS systems
 *
 * Pulls employees from Clover/Square and maps them to PV Users + MerchantUsers.
 * NEVER writes back to POS. NEVER stores PINs, wages, or payroll data.
 *
 * Sync logic:
 *   1. Fetch employees from POS API
 *   2. For each employee:
 *      a. Match by POS employee ID (cloverEmployeeId / squareTeamMemberId)
 *      b. If no match, match by email
 *      c. If no match, create new User + MerchantUser
 *      d. If matched, update name/role if changed
 *   3. Deactivate PV users whose POS employee was removed (soft deactivate)
 *   4. Update PosConnection.lastTeamSyncAt + lastTeamSyncSummary
 */

"use strict";

const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const { prisma } = require("../db/prisma");
const { decrypt } = require("../utils/encrypt");

const CLOVER_API_BASE = process.env.CLOVER_API_BASE || "https://apisandbox.dev.clover.com";
const IS_SANDBOX = (process.env.SQUARE_APP_ID || "").startsWith("sandbox-");
const SQUARE_API_BASE = IS_SANDBOX
  ? "https://connect.squareupsandbox.com/v2"
  : "https://connect.squareup.com/v2";

// ── POS API Fetch Helpers ─────────────────────────────────────────────────

async function cloverFetch(conn, path) {
  const token = decrypt(conn.accessTokenEnc);
  const url = `${CLOVER_API_BASE}/v3/merchants/${conn.externalMerchantId}${path}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Clover API ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

async function squareFetch(conn, path, opts = {}) {
  const token = decrypt(conn.accessTokenEnc);
  const url = `${SQUARE_API_BASE}${path}`;
  const res = await fetch(url, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      "Square-Version": "2024-01-18",
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Square API ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

// ── Fetch Employees from POS ──────��───────────────────────────────────────

/**
 * Fetch all employees from Clover.
 * GET /v3/merchants/{mId}/employees?filter=deleted=false
 * Returns: [{ id, name, email, role }]
 */
async function fetchCloverEmployees(conn) {
  const data = await cloverFetch(conn, "/employees?filter=deleted%3Dfalse&expand=roles");
  const elements = data?.elements || [];

  return elements.map((emp) => ({
    posEmployeeId: emp.id,
    firstName: emp.name?.split(" ")[0] || emp.name || null,
    lastName: emp.name?.split(" ").slice(1).join(" ") || null,
    email: emp.email || null,
    posRole: emp.role || (emp.roles?.elements?.[0]?.name) || null,
    isOwner: emp.isOwner === true,
  }));
}

/**
 * Fetch all team members from Square.
 * POST /v2/team-members/search (paginated)
 * Returns: [{ id, firstName, lastName, email, posRole }]
 */
async function fetchSquareEmployees(conn) {
  const employees = [];
  let cursor = undefined;

  // Paginate through all team members
  for (let page = 0; page < 20; page++) {
    const body = {
      query: { filter: { status: { members: ["ACTIVE"] } } },
      limit: 100,
    };
    if (cursor) body.cursor = cursor;

    const data = await squareFetch(conn, "/team-members/search", {
      method: "POST",
      body,
    });

    for (const tm of data.team_members || []) {
      employees.push({
        posEmployeeId: tm.id,
        firstName: tm.given_name || null,
        lastName: tm.family_name || null,
        email: tm.email_address || null,
        posRole: tm.is_owner ? "OWNER" : (tm.status || "ACTIVE"),
        isOwner: tm.is_owner === true,
      });
    }

    cursor = data.cursor;
    if (!cursor) break;
  }

  return employees;
}

// ── Core Sync Logic ───────────────────────────────────────────────────────

/**
 * Sync employees from a POS connection into PV.
 *
 * @param {number} posConnectionId
 * @returns {{ created: number, updated: number, deactivated: number, total: number, skipped: number }}
 */
async function syncTeamFromPos(posConnectionId) {
  const conn = await prisma.posConnection.findUnique({
    where: { id: posConnectionId },
    include: { merchant: { select: { id: true, teamSetupMode: true, teamSyncEnabled: true } } },
  });

  if (!conn || conn.status !== "active") {
    throw new Error(`PosConnection ${posConnectionId} not found or not active`);
  }

  // Fetch employees from POS
  let posEmployees;
  if (conn.posType === "clover") {
    posEmployees = await fetchCloverEmployees(conn);
  } else if (conn.posType === "square") {
    posEmployees = await fetchSquareEmployees(conn);
  } else {
    throw new Error(`Unsupported POS type for team sync: ${conn.posType}`);
  }

  const merchantId = conn.merchantId;
  const posIdField = conn.posType === "clover" ? "cloverEmployeeId" : "squareTeamMemberId";

  // Get existing PV users for this merchant
  const existingMUs = await prisma.merchantUser.findMany({
    where: { merchantId },
    include: { user: true },
  });

  const stats = { created: 0, updated: 0, deactivated: 0, skipped: 0, total: posEmployees.length };

  for (const emp of posEmployees) {
    // Skip POS owners — they should already be the merchant owner in PV
    if (emp.isOwner) {
      // Try to link the POS ID to existing owner if not already linked
      const ownerMU = existingMUs.find((mu) => mu.role === "owner");
      if (ownerMU && !ownerMU.user[posIdField]) {
        await prisma.user.update({
          where: { id: ownerMU.userId },
          data: { [posIdField]: String(emp.posEmployeeId), posRole: emp.posRole },
        });
        stats.updated++;
      } else {
        stats.skipped++;
      }
      continue;
    }

    // 1. Try match by POS employee ID
    let matchedMU = existingMUs.find(
      (mu) => mu.user[posIdField] === String(emp.posEmployeeId)
    );

    // 2. Try match by email
    if (!matchedMU && emp.email) {
      matchedMU = existingMUs.find(
        (mu) => mu.user.email?.toLowerCase() === emp.email.toLowerCase()
      );
    }

    if (matchedMU) {
      // Update existing user if anything changed
      const user = matchedMU.user;
      const updates = {};
      if (emp.firstName && emp.firstName !== user.firstName) updates.firstName = emp.firstName;
      if (emp.lastName && emp.lastName !== user.lastName) updates.lastName = emp.lastName;
      if (String(emp.posEmployeeId) !== user[posIdField]) updates[posIdField] = String(emp.posEmployeeId);
      if (emp.posRole && emp.posRole !== user.posRole) updates.posRole = emp.posRole;

      if (Object.keys(updates).length > 0) {
        await prisma.user.update({ where: { id: user.id }, data: updates });
        stats.updated++;
      } else {
        stats.skipped++;
      }
    } else {
      // Create new user + merchant user
      const tempPassword = crypto.randomBytes(16).toString("hex");
      const passwordHash = await bcrypt.hash(tempPassword, 10);
      const email = emp.email || `pos-${conn.posType}-${emp.posEmployeeId}@placeholder.perksvalet.com`;

      try {
        await prisma.$transaction(async (tx) => {
          const newUser = await tx.user.create({
            data: {
              email,
              passwordHash,
              firstName: emp.firstName,
              lastName: emp.lastName,
              [posIdField]: String(emp.posEmployeeId),
              posRole: emp.posRole,
            },
          });

          await tx.merchantUser.create({
            data: {
              merchantId,
              userId: newUser.id,
              role: "merchant_employee",
            },
          });
        });
        stats.created++;
      } catch (err) {
        // Unique constraint on email — employee may already exist
        if (err.code === "P2002") {
          console.warn(`[team.sync] Duplicate email skipped: ${email}`);
          stats.skipped++;
        } else {
          throw err;
        }
      }
    }
  }

  // Deactivate users who are no longer in POS (soft deactivate)
  const posIds = new Set(posEmployees.map((e) => String(e.posEmployeeId)));
  for (const mu of existingMUs) {
    const userPosId = mu.user[posIdField];
    // Only deactivate users that were POS-synced (have a POS ID) and are no longer in POS
    if (userPosId && !posIds.has(userPosId) && mu.user.status === "active" && mu.role !== "owner") {
      await prisma.user.update({
        where: { id: mu.userId },
        data: { status: "inactive" },
      });
      stats.deactivated++;
    }
  }

  // Update sync tracking
  await prisma.posConnection.update({
    where: { id: posConnectionId },
    data: {
      lastTeamSyncAt: new Date(),
      lastTeamSyncSummary: stats,
    },
  });

  console.log(JSON.stringify({
    pvHook: "pos.team.sync.complete",
    tc: "TC-TEAM-SYNC",
    posConnectionId,
    merchantId,
    posType: conn.posType,
    ...stats,
    ts: new Date().toISOString(),
  }));

  return stats;
}

module.exports = { syncTeamFromPos, fetchCloverEmployees, fetchSquareEmployees };
