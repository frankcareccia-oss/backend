/**
 * Module: backend/src/merchant/merchant.routes.js
 *
 * PerkValet Merchant Surface
 *
 * Responsibilities:
 *  - Merchant portal: stores, merchant users, invoices
 *  - Admin merchant list/detail/status
 *  - Admin merchant creation
 *
 * Fixes in this version:
 *  - Adds missing POST /merchants route
 *  - Applies status filter in GET /merchants
 */

const express = require("express");
const { requireMerchantRole } = require("../middleware/auth");

const VALID_MERCHANT_TYPES = [
  "coffee_shop", "restaurant", "fitness", "salon_spa", "retail",
  "grocery", "pet_services", "automotive", "specialty_food", "education_kids",
];

function buildMerchantRouter(deps) {
  const router = express.Router();

  const {
    prisma,
    requireJwt,
    requireAdmin,
    sendError,
    handlePrismaError,
    parseIntParam,
    emitPvHook,
    requireMerchantUserManager,
    normalizeRole,
    normalizeMemberStatus,
    crypto,
    bcrypt,
    isPosOnlyMerchantUser,
    canAccessInvoicesForMerchant,
    ensureBillingAccountForMerchant,
  } = deps;

  /* -----------------------------
     Merchant Stores
  -------------------------------- */

  router.get("/merchant/stores", requireJwt, async (req, res) => {
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
      if (user.systemRole === "pv_admin") {
        return sendError(res, 403, "FORBIDDEN", "pv_admin does not use merchant portal");
      }

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

  router.post("/merchant/stores", requireJwt, async (req, res) => {
    const { merchantId, name, address1, city, state, postal, status, phone } = req.body || {};

    const mid = parseIntParam(merchantId);
    if (!mid) return sendError(res, 400, "VALIDATION_ERROR", "merchantId is required");
    if (!name || !String(name).trim()) return sendError(res, 400, "VALIDATION_ERROR", "name is required");

    try {
      const user = await prisma.user.findUnique({
        where: { id: req.userId },
        select: {
          id: true,
          systemRole: true,
          merchantUsers: { where: { merchantId: mid, status: "active" }, select: { merchantId: true, role: true } },
        },
      });

      if (!user) return sendError(res, 404, "NOT_FOUND", "User not found");
      if (user.systemRole === "pv_admin") {
        return sendError(res, 403, "FORBIDDEN", "pv_admin does not use merchant portal");
      }
      if (!user.merchantUsers.length) {
        return sendError(res, 403, "FORBIDDEN", "Not a member of this merchant");
      }

      const merchant = await prisma.merchant.findUnique({ where: { id: mid } });
      if (!merchant) return sendError(res, 404, "NOT_FOUND", "Merchant not found");
      if (merchant.status !== "active") {
        return sendError(res, 409, "INVALID_STATE", `Merchant is ${merchant.status}`);
      }

      const store = await prisma.store.create({
        data: {
          merchantId: mid,
          name: String(name).trim(),
          address1: address1 ? String(address1).trim() : null,
          city: city ? String(city).trim() : null,
          state: state ? String(state).trim().toUpperCase() : null,
          postal: postal ? String(postal).trim() : null,
          status: status || "active",
          phoneRaw: phone ? String(phone).trim() : "",
          phoneCountry: "US",
        },
      });

      emitPvHook("merchant.store.created", {
        tc: "TC-MERCHANT-STORE-CREATE-01",
        sev: "info",
        stable: "merchant:store:create",
        merchantId: mid,
        storeId: store.id,
      });

      return res.status(201).json(store);
    } catch (err) {
      return handlePrismaError(err, res);
    }
  });

  /* -----------------------------
     Merchant Users
  -------------------------------- */

  router.get("/merchant/users", requireJwt, async (req, res) => {
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
              phoneCountry: true,
              phoneE164: true,
            },
          },
        },
        orderBy: [{ userId: "asc" }],
        take: 500,
      });

      const items = rows.map((mu) => ({
        merchantUserId: mu.id,
        userId: mu.userId,
        email: mu.user?.email || null,
        role: mu.role,
        status: mu.status,
        userStatus: mu.user?.status || null,
        firstName: mu.user?.firstName ?? null,
        lastName: mu.user?.lastName ?? null,
        phoneRaw: mu.user?.phoneRaw ?? null,
        phoneCountry: mu.user?.phoneCountry ?? null,
        phoneE164: mu.user?.phoneE164 ?? null,
      }));

      emitPvHook("merchant.users.list", {
        merchantId,
        actorUserId: acting.id,
        count: items.length,
      });

      return res.json({ items });
    } catch (err) {
      return handlePrismaError(err, res);
    }
  });

  router.post("/merchant/users", requireJwt, async (req, res) => {
    const {
      merchantId: midRaw,
      email,
      role,
      status,
      firstName,
      lastName,
      phoneRaw,
      phoneCountry,
    } = req.body || {};

    const merchantIdRaw =
      req.query && req.query.merchantId != null ? req.query.merchantId : midRaw;
    const merchantId = Number(merchantIdRaw);

    if (!Number.isInteger(merchantId) || merchantId <= 0) {
      return sendError(res, 400, "VALIDATION_ERROR", "merchantId is required");
    }

    const emailNorm = String(email || "").trim().toLowerCase();
    if (!emailNorm) return sendError(res, 400, "VALIDATION_ERROR", "email is required");

    const roleNorm = normalizeRole(role);
    if (!roleNorm) {
      return sendError(
        res,
        400,
        "VALIDATION_ERROR",
        "role must be owner|merchant_admin|ap_clerk|merchant_employee|store_admin|store_subadmin"
      );
    }

    const statusNorm = normalizeMemberStatus(status || "active");
    if (!statusNorm) {
      return sendError(res, 400, "VALIDATION_ERROR", "status must be active|suspended");
    }

    const firstNameNorm = firstName == null ? null : String(firstName).trim() || null;
    const lastNameNorm = lastName == null ? null : String(lastName).trim() || null;
    const phoneRawNorm =
      phoneRaw == null ? null : String(phoneRaw).replace(/\D/g, "") || null;
    const phoneCountryNorm =
      phoneCountry == null ? "US" : String(phoneCountry).trim().toUpperCase() || "US";

    try {
      const acting = await requireMerchantUserManager(req, res, merchantId);
      if (!acting) return;

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
            firstName: firstNameNorm,
            lastName: lastNameNorm,
            phoneRaw: phoneRawNorm,
            phoneCountry: phoneCountryNorm,
          },
        });

        createdUser = true;
      }

      const membership = await prisma.merchantUser.upsert({
        where: {
          merchantId_userId: {
            merchantId,
            userId: user.id,
          },
        },
        update: {
          role: roleNorm,
          status: statusNorm,
        },
        create: {
          merchantId,
          userId: user.id,
          role: roleNorm,
          status: statusNorm,
        },
      });

      emitPvHook("merchant.users.upsert", {
        merchantId,
        actorUserId: acting.id,
        targetUserId: user.id,
        createdUser,
        role: roleNorm,
        status: statusNorm,
      });

      return res.status(createdUser ? 201 : 200).json({
        ok: true,
        createdUser,
        userId: user.id,
        email: user.email,
        membership,
        tempPassword,
      });
    } catch (err) {
      return handlePrismaError(err, res);
    }
  });

  router.patch("/merchant/users/:userId", requireJwt, async (req, res) => {
    const userId = parseIntParam(req.params.userId);
    if (!userId) return sendError(res, 400, "VALIDATION_ERROR", "Invalid userId");

    const {
      email,
      role,
      status,
      firstName,
      lastName,
      phoneRaw,
      phoneCountry,
    } = req.body || {};

    const merchantIdRaw = req.query.merchantId ?? req.body?.merchantId;
    const merchantId = Number(merchantIdRaw);

    if (!Number.isInteger(merchantId) || merchantId <= 0) {
      return sendError(res, 400, "VALIDATION_ERROR", "merchantId is required");
    }

    const acting = await requireMerchantUserManager(req, res, merchantId);
    if (!acting) return;

    const fn = firstName == null ? undefined : String(firstName).trim();
    const ln = lastName == null ? undefined : String(lastName).trim();
    const em = email == null ? undefined : String(email).trim().toLowerCase();
    const pr = phoneRaw == null ? undefined : String(phoneRaw).replace(/\D/g, "");
    const pc =
      phoneCountry == null ? "US" : String(phoneCountry).trim().toUpperCase();

    try {
      const result = await prisma.$transaction(async (tx) => {
        const membershipUpdate = {};
        if (role != null && String(role).trim()) membershipUpdate.role = String(role).trim();
        if (status != null && String(status).trim()) {
          membershipUpdate.status = String(status).trim();
        }

        let mu;
        if (Object.keys(membershipUpdate).length) {
          mu = await tx.merchantUser.update({
            where: { merchantId_userId: { merchantId, userId } },
            data: membershipUpdate,
          });
        } else {
          mu = await tx.merchantUser.findUnique({
            where: { merchantId_userId: { merchantId, userId } },
          });
        }

        const userUpdate = {};
        if (em !== undefined) userUpdate.email = em || null;
        if (fn !== undefined) userUpdate.firstName = fn || null;
        if (ln !== undefined) userUpdate.lastName = ln || null;
        if (pr !== undefined) userUpdate.phoneRaw = pr || null;
        if (pc !== undefined) userUpdate.phoneCountry = pc || "US";

        let user = null;
        if (Object.keys(userUpdate).length) {
          user = await tx.user.update({
            where: { id: userId },
            data: userUpdate,
            select: {
              id: true,
              email: true,
              status: true,
              firstName: true,
              lastName: true,
              phoneRaw: true,
              phoneCountry: true,
              phoneE164: true,
            },
          });
        } else {
          user = await tx.user.findUnique({
            where: { id: userId },
            select: {
              id: true,
              email: true,
              status: true,
              firstName: true,
              lastName: true,
              phoneRaw: true,
              phoneCountry: true,
              phoneE164: true,
            },
          });
        }

        return { mu, user };
      });

      emitPvHook("merchant.users.patch", {
        merchantId,
        actorUserId: acting.id,
        targetUserId: userId,
      });

      return res.json({
        ok: true,
        userId,
        merchantId,
        membership: result.mu,
        user: result.user,
      });
    } catch (err) {
      return handlePrismaError(err, res);
    }
  });

  /* -----------------------------
     Merchant Invoices
  -------------------------------- */

  router.get("/merchant/invoices", requireJwt, async (req, res) => {
    try {
      const user = await prisma.user.findUnique({
        where: { id: req.userId },
        select: {
          id: true,
          systemRole: true,
          merchantUsers: { where: { status: "active" }, select: { merchantId: true, role: true, status: true } },
        },
      });

      if (!user) return sendError(res, 404, "NOT_FOUND", "User not found");
      if (user.systemRole === "pv_admin") {
        return sendError(res, 403, "FORBIDDEN", "pv_admin does not use merchant portal");
      }

      if (isPosOnlyMerchantUser(user)) {
        return sendError(res, 403, "FORBIDDEN", "POS associates cannot access billing or invoices");
      }

      const merchantIds = user.merchantUsers
        .filter((m) => canAccessInvoicesForMerchant(user, m.merchantId))
        .map((m) => m.merchantId);

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
        createdAt: inv.createdAt ? inv.createdAt.toISOString() : null,
        updatedAt: inv.updatedAt ? inv.updatedAt.toISOString() : null,
      }));

      return res.json({ items: mapped, nextCursor: null });
    } catch (err) {
      return handlePrismaError(err, res);
    }
  });

  router.get("/merchant/invoices/:invoiceId", requireJwt, async (req, res) => {
    const invoiceId = parseIntParam(req.params.invoiceId);
    if (!invoiceId) return sendError(res, 400, "VALIDATION_ERROR", "Invalid invoiceId");

    try {
      const user = await prisma.user.findUnique({
        where: { id: req.userId },
        select: {
          id: true,
          systemRole: true,
          merchantUsers: { where: { status: "active" }, select: { merchantId: true, role: true, status: true } },
        },
      });

      if (!user) return sendError(res, 404, "NOT_FOUND", "User not found");
      if (user.systemRole === "pv_admin") {
        return sendError(res, 403, "FORBIDDEN", "pv_admin does not use merchant portal");
      }

      if (isPosOnlyMerchantUser(user)) {
        return sendError(res, 403, "FORBIDDEN", "POS associates cannot access billing or invoices");
      }

      const merchantIds = user.merchantUsers
        .filter((m) => canAccessInvoicesForMerchant(user, m.merchantId))
        .map((m) => m.merchantId);

      if (!merchantIds.length) {
        return sendError(res, 403, "FORBIDDEN", "Not authorized for merchant billing");
      }

      const inv = await prisma.invoice.findUnique({
        where: { id: invoiceId },
        include: { lineItems: true, payments: true, relatedInvoices: true },
      });

      if (!inv) return sendError(res, 404, "INVOICE_NOT_FOUND", "Invoice not found");
      if (!merchantIds.includes(inv.merchantId)) {
        return sendError(res, 403, "FORBIDDEN", "Invoice not accessible");
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
          createdAt: inv.createdAt ? inv.createdAt.toISOString() : null,
          updatedAt: inv.updatedAt ? inv.updatedAt.toISOString() : null,
        },
        lineItems: inv.lineItems || [],
        payments: inv.payments || [],
        relatedInvoices: inv.relatedInvoices || [],
      });
    } catch (err) {
      return handlePrismaError(err, res);
    }
  });

  /* -----------------------------
     Admin Merchant List / Detail
  -------------------------------- */

  function normalizeAdminMerchantStatus(status) {
    const s = String(status ?? "").trim().toLowerCase();
    if (!s || s === "live" || s === "enabled") return "active";
    if (s === "active" || s === "suspended" || s === "archived") return s;
    return s || "active";
  }

  function applyNormalizedMerchantStatus(merchant) {
    if (!merchant || typeof merchant !== "object") return merchant;
    return {
      ...merchant,
      status: normalizeAdminMerchantStatus(merchant.status),
    };
  }

  router.get("/merchants", requireJwt, requireAdmin, async (req, res) => {
    try {
      const statusFilterRaw = req.query?.status;
      const statusFilter = normalizeAdminMerchantStatus(statusFilterRaw);

      const where = {};
      if (statusFilterRaw != null && String(statusFilterRaw).trim() !== "") {
        where.status = statusFilter;
      }

      const merchants = await prisma.merchant.findMany({
        where,
        include: {
          stores: { select: { id: true } },
          billingAccount: { select: { pvAccountNumber: true } },
        },
        orderBy: { id: "asc" },
        take: 200,
      });

      console.log("[admin /merchants] statusFilter =", statusFilterRaw ?? null);
      console.log("[admin /merchants] count =", merchants.length);
      console.log(
        "[admin /merchants] rows =",
        merchants.map((m) => ({
          id: m.id,
          name: m.name,
          status: m.status,
          storeCount: Array.isArray(m.stores) ? m.stores.length : 0,
        }))
      );

      return res.json({
        items: merchants.map((m) => ({
          ...applyNormalizedMerchantStatus(m),
          pvAccountNumber: m.billingAccount?.pvAccountNumber ?? null,
          storeCount: m.stores?.length ?? 0,
        })),
      });
    } catch (err) {
      return handlePrismaError(err, res);
    }
  });

  router.post("/merchants", requireJwt, requireAdmin, async (req, res) => {
    try {
      const name = String(req.body?.name || "").trim();
      if (!name) {
        return sendError(res, 400, "VALIDATION_ERROR", "name is required");
      }

      const VALID_MERCHANT_TYPES = [
        "coffee_shop", "restaurant", "fitness", "salon_spa", "retail",
        "grocery", "pet_services", "automotive", "specialty_food", "education_kids",
      ];
      const merchantType = req.body?.merchantType ?? null;
      if (merchantType !== null && !VALID_MERCHANT_TYPES.includes(merchantType)) {
        return sendError(res, 400, "VALIDATION_ERROR", `merchantType must be one of: ${VALID_MERCHANT_TYPES.join(", ")}`);
      }

      const merchant = await prisma.merchant.create({
        data: {
          name,
          status: "active",
          ...(merchantType ? { merchantType } : {}),
        },
      });

      // Auto-create BillingAccount so invoicing works immediately
      await ensureBillingAccountForMerchant(merchant.id);

      // Auto-create the protected "Store Visit" category for visit-based promotions
      await prisma.productCategory.create({
        data: { merchantId: merchant.id, name: "Store Visit", categoryType: "visit", status: "active" },
      });

      emitPvHook("admin.merchant.created", {
        actorUserId: req.userId,
        merchantId: merchant.id,
        name: merchant.name,
      });

      return res.status(201).json(applyNormalizedMerchantStatus(merchant));
    } catch (err) {
      return handlePrismaError(err, res);
    }
  });

  router.get("/merchants/:merchantId", requireJwt, requireAdmin, async (req, res) => {
    const merchantId = parseIntParam(req.params.merchantId);
    if (!merchantId) return sendError(res, 400, "VALIDATION_ERROR", "Invalid merchantId");

    try {
      const merchant = await prisma.merchant.findUnique({
        where: { id: merchantId },
        include: {
          stores: true,
          billingAccount: { select: { pvAccountNumber: true, status: true } },
        },
      });

      if (!merchant) return sendError(res, 404, "MERCHANT_NOT_FOUND", "Merchant not found");
      return res.json(applyNormalizedMerchantStatus(merchant));
    } catch (err) {
      return handlePrismaError(err, res);
    }
  });

  router.patch("/merchants/:merchantId", requireJwt, requireAdmin, async (req, res) => {
    const merchantId = parseIntParam(req.params.merchantId);
    const { status, statusReason, merchantType } = req.body || {};

    if (!merchantId) return sendError(res, 400, "VALIDATION_ERROR", "Invalid merchantId");

    const VALID_MERCHANT_TYPES = [
      "coffee_shop", "restaurant", "fitness", "salon_spa", "retail",
      "grocery", "pet_services", "automotive", "specialty_food", "education_kids",
    ];

    // Allow merchantType-only update (no status required)
    const updatingStatus = Boolean(status);
    const updatingType   = merchantType !== undefined;

    if (updatingStatus && !["active", "suspended", "archived"].includes(status)) {
      return sendError(res, 400, "VALIDATION_ERROR", "status must be active|suspended|archived");
    }
    if (updatingType && merchantType !== null && !VALID_MERCHANT_TYPES.includes(merchantType)) {
      return sendError(res, 400, "VALIDATION_ERROR", `merchantType must be one of: ${VALID_MERCHANT_TYPES.join(", ")}`);
    }
    if (!updatingStatus && !updatingType) {
      return sendError(res, 400, "VALIDATION_ERROR", "Provide status or merchantType to update");
    }

    try {
      const now = new Date();
      const data = {};

      if (updatingStatus) {
        data.status          = status;
        data.statusReason    = statusReason ?? null;
        data.statusUpdatedAt = now;
        data.suspendedAt     = status === "suspended" ? now : null;
        data.archivedAt      = status === "archived"  ? now : null;
      }
      if (updatingType) {
        data.merchantType = merchantType; // null clears it
      }

      const merchant = await prisma.merchant.update({
        where: { id: merchantId },
        data,
      });

      return res.json(applyNormalizedMerchantStatus(merchant));
    } catch (err) {
      return handlePrismaError(err, res);
    }
  });

  // PATCH /merchant/type — merchant owner/admin sets their own merchant type
  router.patch("/merchant/type", requireJwt, requireMerchantRole("owner", "merchant_admin"), async (req, res) => {
    const { merchantType } = req.body || {};
    if (merchantType !== null && merchantType !== undefined && !VALID_MERCHANT_TYPES.includes(merchantType)) {
      return sendError(res, 400, "VALIDATION_ERROR", `merchantType must be one of: ${VALID_MERCHANT_TYPES.join(", ")}`);
    }
    try {
      const merchant = await prisma.merchant.update({
        where: { id: req.merchantId },
        data: { merchantType: merchantType ?? null },
      });
      emitPvHook("merchant.type.updated", {
        merchantId: req.merchantId,
        actorUserId: req.userId,
        merchantType: merchantType ?? null,
      });
      return res.json({ merchant });
    } catch (err) {
      return handlePrismaError(err, res);
    }
  });

  // ─── Duplicate Customer Alerts ────────────────────────────────────────────
  // GET /merchants/me/alerts/duplicate-customers — pending alerts for this merchant
  router.get("/merchants/me/alerts/duplicate-customers", requireJwt, requireMerchantRole("merchant_admin", "store_admin", "cashier"), async (req, res) => {
    try {
      const alerts = await prisma.duplicateCustomerAlert.findMany({
        where: { merchantId: req.merchantId, status: "pending" },
        orderBy: { createdAt: "desc" },
      });
      return res.json({ alerts });
    } catch (err) {
      return handlePrismaError(err, res);
    }
  });

  // PATCH /merchants/me/alerts/duplicate-customers/:id — resolve or dismiss
  router.patch("/merchants/me/alerts/duplicate-customers/:id", requireJwt, requireMerchantRole("merchant_admin", "store_admin"), async (req, res) => {
    try {
      const alertId = parseInt(req.params.id, 10);
      const { status } = req.body; // "resolved" or "dismissed"
      if (!["resolved", "dismissed"].includes(status)) {
        return sendError(res, 400, "VALIDATION_ERROR", 'status must be "resolved" or "dismissed"');
      }

      const alert = await prisma.duplicateCustomerAlert.findFirst({
        where: { id: alertId, merchantId: req.merchantId },
      });
      if (!alert) return sendError(res, 404, "NOT_FOUND", "Alert not found");

      const updated = await prisma.duplicateCustomerAlert.update({
        where: { id: alertId },
        data: { status, resolvedAt: new Date() },
      });
      return res.json({ alert: updated });
    } catch (err) {
      return handlePrismaError(err, res);
    }
  });

  return router;
}

module.exports = buildMerchantRouter;