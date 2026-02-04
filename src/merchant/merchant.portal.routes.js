// backend/src/merchant/merchant.portal.routes.js
const express = require("express");

/**
 * Merchant portal routes (JWT only), extracted from index.js.
 *
 * IMPORTANT: Extraction-only step.
 * - No behavior changes intended.
 * - Keep existing route shapes, validation, and pvHook emissions.
 */
function buildMerchantPortalRouter(deps) {
  if (!deps) throw new Error("buildMerchantPortalRouter: deps is required");

  const {
    prisma,
    requireJwt,
    sendError,
    handlePrismaError,
    emitPvHook,
    parseIntParam,
    assertActiveMerchant,
    crypto,
    bcrypt,
  } = deps;

  if (!prisma) throw new Error("buildMerchantPortalRouter: prisma is required");
  if (!requireJwt) throw new Error("buildMerchantPortalRouter: requireJwt is required");
  if (!sendError) throw new Error("buildMerchantPortalRouter: sendError is required");
  if (!handlePrismaError) throw new Error("buildMerchantPortalRouter: handlePrismaError is required");
  if (!parseIntParam) throw new Error("buildMerchantPortalRouter: parseIntParam is required");

  const router = express.Router();

  /* -----------------------------
     Merchant portal (JWT only)
  -------------------------------- */

  function isPosOnlyMerchantUser(user) {
    // Treat as POS-only if the user has at least one active merchant membership
    // and ALL memberships are store_subadmin.
    const mus = Array.isArray(user?.merchantUsers) ? user.merchantUsers : [];
    if (!mus.length) return false;

    const roles = mus.map((m) => m?.role).filter(Boolean);
    if (!roles.length) return false;

    return roles.every((r) => r === "store_subadmin");
  }

  /**
   * Thread U — Merchant user management helpers
   */
  function canManageUsersForMerchant(user, merchantId) {
    const mus = Array.isArray(user?.merchantUsers) ? user.merchantUsers : [];
    const m = mus.find((x) => x.status === "active" && x.merchantId === merchantId);
    if (!m) return false;
    return m.role === "owner" || m.role === "merchant_admin";
  }

  function canManageStoresForMerchant(user, merchantId) {
    // Store management is restricted to owner/merchant_admin (same as user management)
    return canManageUsersForMerchant(user, merchantId);
  }

  async function requireMerchantStoreManager(req, res, merchantId) {
    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      select: {
        id: true,
        systemRole: true,
        merchantUsers: {
          where: { status: "active" },
          select: { merchantId: true, role: true, status: true },
        },
      },
    });

    if (!user) {
      sendError(res, 404, "NOT_FOUND", "User not found");
      return null;
    }
    if (user.systemRole === "pv_admin") {
      sendError(res, 403, "FORBIDDEN", "pv_admin does not use merchant portal");
      return null;
    }
    if (typeof isPosOnlyMerchantUser === "function" && isPosOnlyMerchantUser(user)) {
      sendError(res, 403, "FORBIDDEN", "POS associates cannot manage stores");
      return null;
    }
    if (!canManageStoresForMerchant(user, merchantId)) {
      sendError(res, 403, "FORBIDDEN", "Not authorized to manage stores for this merchant");
      return null;
    }

    return user;
  }

  function normalizeRole(role) {
    const r = String(role || "").trim();
    const allowed = ["owner", "merchant_admin", "store_admin", "store_subadmin"];
    return allowed.includes(r) ? r : null;
  }

  function normalizeMemberStatus(status) {
    const s = String(status || "").trim();
    const allowed = ["active", "suspended"];
    return allowed.includes(s) ? s : null;
  }

  async function requireMerchantUserManager(req, res, merchantId) {
    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      select: {
        id: true,
        systemRole: true,
        merchantUsers: {
          where: { status: "active" },
          select: { merchantId: true, role: true, status: true },
        },
      },
    });

    if (!user) {
      sendError(res, 404, "NOT_FOUND", "User not found");
      return null;
    }
    if (user.systemRole === "pv_admin") {
      sendError(res, 403, "FORBIDDEN", "pv_admin does not use merchant portal");
      return null;
    }
    if (isPosOnlyMerchantUser(user)) {
      sendError(res, 403, "FORBIDDEN", "POS associates cannot manage users");
      return null;
    }
    if (!canManageUsersForMerchant(user, merchantId)) {
      sendError(res, 403, "FORBIDDEN", "Not authorized to manage users for this merchant");
      return null;
    }

    return user;
  }

  router.get("/stores", requireJwt, async (req, res) => {
    try {
      const user = await prisma.user.findUnique({
        where: { id: req.userId },
        select: {
          id: true,
          systemRole: true,
          merchantUsers: { where: { status: "active" }, select: { merchantId: true } },
        },
      });

      if (!user) return sendError(res, 404, "NOT_FOUND", "User not found");
      if (user.systemRole === "pv_admin") return sendError(res, 403, "FORBIDDEN", "pv_admin does not use merchant portal");

      const merchantIds = user.merchantUsers.map((m) => m.merchantId);
      if (!merchantIds.length) return res.json({ items: [] });

      const stores = await prisma.store.findMany({
        where: { merchantId: { in: merchantIds }, status: "active" },
        orderBy: { createdAt: "desc" },
      });

      return res.json({ items: stores });
    } catch (err) {
      return handlePrismaError(err, res);
    }
  });

  /**
   * Merchant stores management (JWT only)
   * - POST  /merchant/stores           (create store under a merchant the user manages)
   * - PATCH /merchant/stores/:storeId  (update store status)
   *
   * NOTE: We intentionally keep these merchant-scoped routes separate from admin /stores APIs.
   */
  router.post("/stores", requireJwt, async (req, res) => {
    const { merchantId: midRaw, name, address1, city, state } = req.body || {};
    const merchantId = parseIntParam(midRaw);

    if (!merchantId) return sendError(res, 400, "VALIDATION_ERROR", "merchantId is required");

    const storeName = String(name || "").trim();
    if (!storeName) return sendError(res, 400, "VALIDATION_ERROR", "name is required");

    try {
      const acting = await requireMerchantStoreManager(req, res, merchantId);
      if (!acting) return;

      const result = await prisma.$transaction(async (tx) => {
        const merchant = await tx.merchant.findUnique({ where: { id: merchantId } });
        const gateErr = typeof assertActiveMerchant === "function" ? assertActiveMerchant(merchant) : null;
        if (gateErr) return { error: gateErr };

        const store = await tx.store.create({
          data: {
            merchantId,
            name: storeName,
            address1: address1 != null ? String(address1).trim() || null : null,
            city: city != null ? String(city).trim() || null : null,
            state: state != null ? String(state).trim() || null : null,
            status: "active",
          },
        });

        return { store };
      });

      if (result?.error) return sendError(res, result.error.http, result.error.code, result.error.message);

      if (typeof emitPvHook === "function") {
        emitPvHook("merchant.stores.create", {
          merchantId,
          actorUserId: acting.id,
          storeId: result.store.id,
        });
      }

      return res.status(201).json(result.store);
    } catch (err) {
      return handlePrismaError(err, res);
    }
  });

  router.patch("/stores/:storeId", requireJwt, async (req, res) => {
    const storeId = parseIntParam(req.params.storeId);
    const { status } = req.body || {};

    if (!storeId) return sendError(res, 400, "VALIDATION_ERROR", "Invalid storeId");

    const statusNorm = String(status || "").trim();
    if (!["active", "suspended", "archived"].includes(statusNorm)) {
      return sendError(res, 400, "VALIDATION_ERROR", "status must be active|suspended|archived");
    }

    try {
      const store = await prisma.store.findUnique({ where: { id: storeId }, select: { id: true, merchantId: true } });
      if (!store) return sendError(res, 404, "STORE_NOT_FOUND", "Store not found");

      const acting = await requireMerchantStoreManager(req, res, store.merchantId);
      if (!acting) return;

      const now = new Date();

      const updated = await prisma.store.update({
        where: { id: storeId },
        data: {
          status: statusNorm,
          statusUpdatedAt: now,
          suspendedAt: statusNorm === "suspended" ? now : null,
          archivedAt: statusNorm === "archived" ? now : null,
        },
      });

      if (typeof emitPvHook === "function") {
        emitPvHook("merchant.stores.status", {
          merchantId: store.merchantId,
          storeId,
          actorUserId: acting.id,
          status: statusNorm,
        });
      }

      return res.json(updated);
    } catch (err) {
      return handlePrismaError(err, res);
    }
  });

  /* -----------------------------
     Thread U — Merchant user management endpoints
  -------------------------------- */

  router.get("/users", requireJwt, async (req, res) => {
    const merchantId = parseIntParam(req.query.merchantId);
    if (!merchantId) return sendError(res, 400, "VALIDATION_ERROR", "merchantId is required");

    try {
      const acting = await requireMerchantUserManager(req, res, merchantId);
      if (!acting) return;

      const rows = await prisma.merchantUser.findMany({
        where: { merchantId },
        include: { user: { select: { id: true, email: true, status: true } } },
        orderBy: [{ userId: "asc" }],
        take: 500,
      });

      const items = rows.map((mu) => ({
        userId: mu.userId,
        email: mu.user?.email || null,
        role: mu.role,
        status: mu.status,
        userStatus: mu.user?.status || null,
      }));

      if (typeof emitPvHook === "function") {
        emitPvHook("merchant.users.list", { merchantId, actorUserId: acting.id, count: items.length });
      }

      return res.json({ items });
    } catch (err) {
      return handlePrismaError(err, res);
    }
  });

  router.post("/users", requireJwt, async (req, res) => {
    const { merchantId: midRaw, email, role, status } = req.body || {};
    const merchantId = parseIntParam(midRaw);
    if (!merchantId) return sendError(res, 400, "VALIDATION_ERROR", "merchantId is required");

    const emailNorm = String(email || "").trim().toLowerCase();
    if (!emailNorm) return sendError(res, 400, "VALIDATION_ERROR", "email is required");

    const roleNorm = normalizeRole(role);
    if (!roleNorm) return sendError(res, 400, "VALIDATION_ERROR", "role must be owner|merchant_admin|store_admin|store_subadmin");

    const statusNorm = normalizeMemberStatus(status || "active");
    if (!statusNorm) return sendError(res, 400, "VALIDATION_ERROR", "status must be active|suspended");

    try {
      const acting = await requireMerchantUserManager(req, res, merchantId);
      if (!acting) return;

      // Find existing user by email (schema has email unique, but keep findMany style consistent with your auth/login)
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

      // Upsert merchant membership (safe fallback: findFirst + update/create)
      const existingMu = await prisma.merchantUser.findFirst({
        where: { merchantId, userId: user.id },
      });

      if (existingMu) {
        await prisma.merchantUser.update({
          where: { id: existingMu.id },
          data: { role: roleNorm, status: statusNorm },
        });
      } else {
        await prisma.merchantUser.create({
          data: { merchantId, userId: user.id, role: roleNorm, status: statusNorm },
        });
      }

      if (typeof emitPvHook === "function") {
        emitPvHook("merchant.users.create_or_grant", {
          merchantId,
          actorUserId: acting.id,
          targetUserId: user.id,
          role: roleNorm,
          status: statusNorm,
          createdUser,
        });
      }

      return res.json({ ok: true, userId: user.id, createdUser, tempPassword });
    } catch (err) {
      return handlePrismaError(err, res);
    }
  });

  router.patch("/users/:userId", requireJwt, async (req, res) => {
    const userId = parseIntParam(req.params.userId);
    if (!userId) return sendError(res, 400, "VALIDATION_ERROR", "Invalid userId");

    const { merchantId: midRaw, role, status } = req.body || {};
    const merchantId = parseIntParam(midRaw);
    if (!merchantId) return sendError(res, 400, "VALIDATION_ERROR", "merchantId is required");

    const roleNorm = role !== undefined ? normalizeRole(role) : null;
    const statusNorm = status !== undefined ? normalizeMemberStatus(status) : null;

    if (role !== undefined && !roleNorm) {
      return sendError(res, 400, "VALIDATION_ERROR", "role must be owner|merchant_admin|store_admin|store_subadmin");
    }
    if (status !== undefined && !statusNorm) {
      return sendError(res, 400, "VALIDATION_ERROR", "status must be active|suspended");
    }
    if (role === undefined && status === undefined) {
      return sendError(res, 400, "VALIDATION_ERROR", "Provide role and/or status");
    }

    try {
      const acting = await requireMerchantUserManager(req, res, merchantId);
      if (!acting) return;

      const mu = await prisma.merchantUser.findFirst({
        where: { merchantId, userId },
      });

      if (!mu) return sendError(res, 404, "NOT_FOUND", "Membership not found");

      const updated = await prisma.merchantUser.update({
        where: { id: mu.id },
        data: {
          ...(roleNorm ? { role: roleNorm } : null),
          ...(statusNorm ? { status: statusNorm } : null),
        },
      });

      if (typeof emitPvHook === "function") {
        emitPvHook("merchant.users.update_membership", {
          merchantId,
          actorUserId: acting.id,
          targetUserId: userId,
          role: roleNorm || null,
          status: statusNorm || null,
        });
      }

      return res.json({ ok: true, membership: updated });
    } catch (err) {
      return handlePrismaError(err, res);
    }
  });

  router.get("/invoices", requireJwt, async (req, res) => {
    try {
      // NOTE: role included so we can enforce Thread U POS restriction
      const user = await prisma.user.findUnique({
        where: { id: req.userId },
        select: {
          id: true,
          systemRole: true,
          merchantUsers: { where: { status: "active" }, select: { merchantId: true, role: true } },
        },
      });

      if (!user) return sendError(res, 404, "NOT_FOUND", "User not found");
      if (user.systemRole === "pv_admin") return sendError(res, 403, "FORBIDDEN", "pv_admin does not use merchant portal");

      // Thread U: POS-only merchant users cannot access invoices
      if (isPosOnlyMerchantUser(user)) {
        return sendError(res, 403, "FORBIDDEN", "POS associates cannot access billing or invoices");
      }

      const merchantIds = user.merchantUsers.map((m) => m.merchantId);
      if (!merchantIds.length) return res.json({ items: [], nextCursor: null });

      const items = await prisma.invoice.findMany({
        where: { merchantId: { in: merchantIds } },
        orderBy: [{ createdAt: "desc" }],
        take: 200,
      });

      const mapped = items.map((inv) => ({
        id: inv.id,
        merchantId: inv.merchantId,
        billingAccountId: inv.billingAccountId,
        status: inv.status,
        issuedAt: inv.issuedAt ? inv.issuedAt.toISOString() : null,
        netTermsDays: inv.netTermsDays ?? null,
        dueAt: inv.dueAt ? inv.dueAt.toISOString() : null,
        subtotalCents: inv.subtotalCents,
        taxCents: inv.taxCents,
        totalCents: inv.totalCents,
        amountPaidCents: inv.amountPaidCents,
        relatedToInvoiceId: inv.relatedToInvoiceId ?? null,
      }));

      return res.json({ items: mapped, nextCursor: null });
    } catch (err) {
      return handlePrismaError(err, res);
    }
  });

  router.get("/invoices/:invoiceId", requireJwt, async (req, res) => {
    const invoiceId = parseIntParam(req.params.invoiceId);
    if (!invoiceId) return sendError(res, 400, "VALIDATION_ERROR", "Invalid invoiceId");

    try {
      // NOTE: role included so we can enforce Thread U POS restriction
      const user = await prisma.user.findUnique({
        where: { id: req.userId },
        select: {
          id: true,
          systemRole: true,
          merchantUsers: { where: { status: "active" }, select: { merchantId: true, role: true } },
        },
      });

      if (!user) return sendError(res, 404, "NOT_FOUND", "User not found");
      if (user.systemRole === "pv_admin") return sendError(res, 403, "FORBIDDEN", "pv_admin does not use merchant portal");

      // Thread U: POS-only merchant users cannot access invoice detail
      if (isPosOnlyMerchantUser(user)) {
        return sendError(res, 403, "FORBIDDEN", "POS associates cannot access billing or invoices");
      }

      const merchantIds = user.merchantUsers.map((m) => m.merchantId);
      if (!merchantIds.length) return sendError(res, 403, "FORBIDDEN", "No merchant memberships");

      const inv = await prisma.invoice.findUnique({
        where: { id: invoiceId },
        include: { lineItems: true, payments: true, relatedInvoices: true },
      });

      if (!inv) return sendError(res, 404, "INVOICE_NOT_FOUND", "Invoice not found");
      if (!merchantIds.includes(inv.merchantId)) return sendError(res, 403, "FORBIDDEN", "Invoice not accessible");

      return res.json({
        invoice: {
          id: inv.id,
          merchantId: inv.merchantId,
          billingAccountId: inv.billingAccountId,
          status: inv.status,
          issuedAt: inv.issuedAt ? inv.issuedAt.toISOString() : null,
          netTermsDays: inv.netTermsDays ?? null,
          dueAt: inv.dueAt ? inv.dueAt.toISOString() : null,
          subtotalCents: inv.subtotalCents,
          taxCents: inv.taxCents,
          totalCents: inv.totalCents,
          amountPaidCents: inv.amountPaidCents,
          relatedToInvoiceId: inv.relatedToInvoiceId ?? null,
          externalInvoiceId: inv.externalInvoiceId ?? null,
          generationVersion: inv.generationVersion,
        },
        lineItems: inv.lineItems,
        payments: inv.payments,
        relatedInvoices: (inv.relatedInvoices || []).map((x) => ({
          id: x.id,
          status: x.status,
          totalCents: x.totalCents,
          relatedToInvoiceId: x.relatedToInvoiceId ?? null,
        })),
      });
    } catch (err) {
      return handlePrismaError(err, res);
    }
  });

  return router;
}

module.exports = { buildMerchantPortalRouter };
