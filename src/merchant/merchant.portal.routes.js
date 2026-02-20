// backend/src/merchant/merchant.portal.routes.js
const express = require("express");
const { ensureActiveGuestPayToken } = require("../billing/guestPayToken.service");

/**
 * Merchant portal routes (JWT only), extracted from index.js.
 *
 * IMPORTANT: Extraction-only step.
 * - No behavior changes intended.
 * - Keep existing route shapes, validation, and pvHook emissions.
 *
 * NOTE (Billing UI enablement):
 * We add a minimal "payCode/payUrl" enrichment on merchant invoice detail so the
 * existing merchant UI can show "Pay Now" when appropriate.
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
    // and ALL memberships are pos_employee.
    const mus = Array.isArray(user?.merchantUsers) ? user.merchantUsers : [];
    if (!mus.length) return false;

    const roles = mus.map((m) => m?.role).filter(Boolean);
    if (!roles.length) return false;

    return roles.every((r) => r === "pos_employee");
  }

  function getPublicBaseUrl(req) {
    // Prefer explicit env; fallback to request host (good for localhost).
    const env = String(process.env.PUBLIC_BASE_URL || "").trim();
    if (env) return env.replace(/\/+$/, "");
    const proto = (req.headers["x-forwarded-proto"] || req.protocol || "http").toString().split(",")[0].trim();
    const host = (req.headers["x-forwarded-host"] || req.get("host") || "").toString().split(",")[0].trim();
    return `${proto}://${host}`.replace(/\/+$/, "");
  }

  function extractPayCodeFromPayUrl(payUrl) {
    // expected: http(s)://host/p/<code>
    if (!payUrl || typeof payUrl !== "string") return "";
    const idx = payUrl.lastIndexOf("/p/");
    if (idx < 0) return "";
    return String(payUrl.slice(idx + 3)).trim();
  }

  /**
   * Thread U — Merchant user management helpers
   */
  function canManageUsersForMerchant(user, merchantId) {
    const mus = Array.isArray(user?.merchantUsers) ? user.merchantUsers : [];
    const m = mus.find((x) => x.status === "active" && x.merchantId === merchantId);
    if (!m) return false;
    return m.role === "owner" || m.role === "merchant_admin" || m.role === "merchant_ap_clerk";
  }

  function canManageStoresForMerchant(user, merchantId) {
    // Store management is restricted to owner/merchant_admin (same as user management)
    return canManageUsersForMerchant(user, merchantId);
  }

  // IMPORTANT: store_admin does NOT pay invoices (PerkValet rule).
  function canPayInvoicesForMerchant(user, merchantId) {
    const mus = Array.isArray(user?.merchantUsers) ? user.merchantUsers : [];
    const m = mus.find((x) => x.status === "active" && x.merchantId === merchantId);
    if (!m) return false;
    return m.role === "owner" || m.role === "merchant_admin" || m.role === "merchant_ap_clerk";
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
    if (["pv_admin", "pv_ar_clerk"].includes(user.systemRole)) {
      sendError(res, 403, "FORBIDDEN", "platform users do not use merchant portal");
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
    const allowed = ["owner", "merchant_admin", "merchant_ap_clerk", "store_admin", "pos_employee"];
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
    if (["pv_admin", "pv_ar_clerk"].includes(user.systemRole)) {
      sendError(res, 403, "FORBIDDEN", "platform users do not use merchant portal");
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
      if (["pv_admin", "pv_ar_clerk"].includes(user.systemRole)) return sendError(res, 403, "FORBIDDEN", "platform users do not use merchant portal");

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
    const { merchantId: midRaw, name, address1, city, state, postal } = req.body || {};
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
            postal: postal != null ? String(postal).trim() || null : null,
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

  // T5: Merchant store profile editing (merchant_admin only)
  // PATCH /merchant/stores/:storeId/profile
  // Body supports: name, address1, city, state, postal
  router.patch("/stores/:storeId/profile", requireJwt, async (req, res) => {
    const storeId = parseIntParam(req.params.storeId);
    if (!storeId) return sendError(res, 400, "VALIDATION_ERROR", "Invalid storeId");

    const { name, address1, city, state, postal } = req.body || {};

    function normOptString(v, { maxLen, upper } = {}) {
      if (v === undefined) return undefined; // not provided
      if (v === null) return null;
      const s0 = String(v).trim();
      if (!s0) return null;
      const s = upper ? s0.toUpperCase() : s0;
      if (maxLen && s.length > maxLen) return s.slice(0, maxLen);
      return s;
    }

    const nameNorm = normOptString(name, { maxLen: 200 });

    if (name !== undefined && !nameNorm) {
      return sendError(res, 400, "VALIDATION_ERROR", "name cannot be empty");
    }
    const address1Norm = normOptString(address1, { maxLen: 200 });
    const cityNorm = normOptString(city, { maxLen: 120 });
    const stateNorm = normOptString(state, { maxLen: 8, upper: true });
    const postalNorm = normOptString(postal, { maxLen: 20 });

    const hasAny =
      name !== undefined ||
      address1 !== undefined ||
      city !== undefined ||
      state !== undefined ||
      postal !== undefined;

    if (!hasAny) {
      return sendError(res, 400, "VALIDATION_ERROR", "Provide at least one profile field to update");
    }

    try {
      const store = await prisma.store.findUnique({
        where: { id: storeId },
        select: { id: true, merchantId: true },
      });
      if (!store) return sendError(res, 404, "STORE_NOT_FOUND", "Store not found");

      const acting = await requireMerchantStoreManager(req, res, store.merchantId);
      if (!acting) return;

      const updated = await prisma.store.update({
        where: { id: storeId },
        data: {
          ...(name !== undefined ? { name: nameNorm } : null),
          ...(address1 !== undefined ? { address1: address1Norm } : null),
          ...(city !== undefined ? { city: cityNorm } : null),
          ...(state !== undefined ? { state: stateNorm } : null),
          ...(postal !== undefined ? { postal: postalNorm } : null),
        },
      });

      if (typeof emitPvHook === "function") {
        emitPvHook("merchant.stores.profile", {
          merchantId: store.merchantId,
          storeId,
          actorUserId: acting.id,
          fields: {
            ...(name !== undefined ? { name: Boolean(nameNorm) } : null),
            ...(address1 !== undefined ? { address1: Boolean(address1Norm) } : null),
            ...(city !== undefined ? { city: Boolean(cityNorm) } : null),
            ...(state !== undefined ? { state: Boolean(stateNorm) } : null),
            ...(postal !== undefined ? { postal: Boolean(postalNorm) } : null),
          },
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
        include: {
          user: {
            select: {
              id: true,
              email: true,
              status: true,
              firstName: true,
              lastName: true,
              phoneRaw: true,
              phoneE164: true,
              phoneCountry: true,
            },
          },
        },
        orderBy: [{ userId: "asc" }],
        take: 500,
      });

      const items = rows.map((mu) => ({
        userId: mu.userId,
        email: mu.user?.email || null,
        role: mu.role,
        status: mu.status,
        statusReason: mu.statusReason ?? null,

        // Identity (person-level; may be null)
        firstName: mu.user?.firstName ?? null,
        lastName: mu.user?.lastName ?? null,
        phoneRaw: mu.user?.phoneRaw ?? null,
        phoneE164: mu.user?.phoneE164 ?? null,
        phoneCountry: mu.user?.phoneCountry ?? null,

        // Legacy fields (do not edit; kept for backward compatibility)
        contactEmail: mu.contactEmail ?? null,
        // Legacy phone surface area: prefer person-level phone if present
        contactPhone: (mu.user?.phoneRaw ?? mu.user?.phoneE164 ?? mu.contactPhone) ?? null,

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
    if (!roleNorm) return sendError(res, 400, "VALIDATION_ERROR", "role must be owner|merchant_admin|merchant_ap_clerk|store_admin|pos_employee");

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

    const {
      merchantId: midRaw,

      // Membership (MerchantUser)
      role,
      status,
      statusReason,
      // Legacy alias from earlier UI iterations
      reason,

      // Identity (User)
      firstName,
      lastName,
      phoneRaw,
      phoneE164,
      phoneCountry,
      // Legacy aliases from earlier UI iterations
      contactPhone,
      phone,
    } = req.body || {};

    const merchantId = parseIntParam(midRaw);
    if (!merchantId) return sendError(res, 400, "VALIDATION_ERROR", "merchantId is required");

    const roleNorm = role !== undefined ? normalizeRole(role) : null;
    const statusNorm = status !== undefined ? normalizeMemberStatus(status) : null;

    function normOptString(v, { maxLen, upper } = {}) {
      if (v === undefined) return undefined; // means "not provided"
      if (v === null) return null;
      const s0 = String(v).trim();
      if (!s0) return null;
      const s = upper ? s0.toUpperCase() : s0;
      if (maxLen && s.length > maxLen) return s.slice(0, maxLen);
      return s;
    }

    // MerchantUser fields
    const statusReasonNorm = normOptString(statusReason !== undefined ? statusReason : reason, { maxLen: 200 });

    // User identity fields
    const firstNameNorm = normOptString(firstName, { maxLen: 80 });
    const lastNameNorm = normOptString(lastName, { maxLen: 80 });
    const phoneRawNorm = normOptString(phoneRaw !== undefined ? phoneRaw : (contactPhone !== undefined ? contactPhone : phone), { maxLen: 32 });
    const phoneE164Norm = normOptString(phoneE164, { maxLen: 20 });
    const phoneCountryNorm = normOptString(phoneCountry, { maxLen: 8, upper: true });

    const statusReasonProvided = statusReason !== undefined || reason !== undefined;
    const phoneRawProvided = phoneRaw !== undefined || contactPhone !== undefined || phone !== undefined;

    const hasMembershipPatch = role !== undefined || status !== undefined || statusReason !== undefined || reason !== undefined;
    const hasUserPatch =
      firstName !== undefined ||
      lastName !== undefined ||
      phoneRaw !== undefined ||
      phoneE164 !== undefined ||
      phoneCountry !== undefined ||
      contactPhone !== undefined ||
      phone !== undefined;

    if (role !== undefined && !roleNorm) {
      return sendError(res, 400, "VALIDATION_ERROR", "role must be owner|merchant_admin|merchant_ap_clerk|store_admin|pos_employee");
    }
    if (status !== undefined && !statusNorm) {
      return sendError(res, 400, "VALIDATION_ERROR", "status must be active|suspended");
    }
    if (!hasMembershipPatch && !hasUserPatch) {
      return sendError(res, 400, "VALIDATION_ERROR", "Provide membership and/or identity fields");
    }

    try {
      const acting = await requireMerchantUserManager(req, res, merchantId);
      if (!acting) return;

      const mu = await prisma.merchantUser.findFirst({
        where: { merchantId, userId },
      });

      if (!mu) return sendError(res, 404, "NOT_FOUND", "Membership not found");

      // STRICT OWNERSHIP:
      // - User identity fields update User
      // - Membership fields update MerchantUser
      let updatedMembership = null;

      await prisma.$transaction(async (tx) => {
        if (hasUserPatch) {
          const userData = {
            ...(firstName !== undefined ? { firstName: firstNameNorm } : null),
            ...(lastName !== undefined ? { lastName: lastNameNorm } : null),
            ...(phoneRawProvided ? { phoneRaw: phoneRawNorm } : null),
            ...(phoneE164 !== undefined ? { phoneE164: phoneE164Norm } : null),
            ...(phoneCountry !== undefined ? { phoneCountry: phoneCountryNorm ?? "US" } : null),
          };

          // If caller explicitly sets phoneCountry to null/empty, normalize back to default "US"
          if (phoneCountry !== undefined && !userData.phoneCountry) {
            userData.phoneCountry = "US";
          }

          await tx.user.update({
            where: { id: userId },
            data: userData,
          });
        }

        if (hasMembershipPatch) {
          const membershipData = {
            ...(role !== undefined ? { role: roleNorm } : null),
            ...(status !== undefined ? { status: statusNorm } : null),
            ...(statusReasonProvided ? { statusReason: statusReasonNorm } : null),
            ...(status !== undefined ? { statusUpdatedAt: new Date() } : null),
            ...(status !== undefined && statusNorm === "suspended" ? { suspendedAt: new Date() } : null),
            ...(status !== undefined && statusNorm === "active" ? { suspendedAt: null } : null),
          };

          updatedMembership = await tx.merchantUser.update({
            where: { id: mu.id },
            data: membershipData,
          });
        }
      });

      if (typeof emitPvHook === "function") {
        emitPvHook("merchant.users.update_membership_or_identity", {
          merchantId,
          actorUserId: acting.id,
          targetUserId: userId,
          changed: {
            membership: Boolean(hasMembershipPatch),
            identity: Boolean(hasUserPatch),
          },
        });
      }

      return res.json({ ok: true, membership: updatedMembership });
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
      if (["pv_admin", "pv_ar_clerk"].includes(user.systemRole)) return sendError(res, 403, "FORBIDDEN", "platform users do not use merchant portal");

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
          merchantUsers: { where: { status: "active" }, select: { merchantId: true, role: true, status: true } },
        },
      });

      if (!user) return sendError(res, 404, "NOT_FOUND", "User not found");
      if (["pv_admin", "pv_ar_clerk"].includes(user.systemRole)) return sendError(res, 403, "FORBIDDEN", "platform users do not use merchant portal");

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

      // Enrich with payCode/payUrl when eligible.
      let payCode = null;
      let payUrl = null;
      let payExpiresAt = null;

      const unpaid = Number(inv.totalCents || 0) > Number(inv.amountPaidCents || 0);
      const issued = String(inv.status || "").toLowerCase() === "issued";

      if (issued && unpaid && canPayInvoicesForMerchant(user, inv.merchantId)) {
        try {
          const result = await ensureActiveGuestPayToken({
            prisma,
            invoiceId: inv.id,
            publicBaseUrl: getPublicBaseUrl(req),
            forceRotate: false,
          });

          payUrl = result?.payUrl || null;
          payExpiresAt = result?.expiresAt || null;
          const code = extractPayCodeFromPayUrl(payUrl);
          payCode = code ? code : null;
        } catch (e) {
          // Non-fatal: invoice detail still returns; UI just won’t show Pay Now.
          // Keep this quiet; callers can inspect logs if needed.
          // (We intentionally do NOT emit pvHook here to preserve existing emissions contract.)
        }
      }

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

          // UI enablement (MerchantInvoiceDetail.jsx reads these)
          payCode,
          payUrl,
          payExpiresAt,
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
