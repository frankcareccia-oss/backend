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
    requireBillingStaff,
    requirePlatformRole,
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

  router.get("/merchants", requireJwt, requirePlatformRole, async (req, res) => {
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

      // Optional owner info — create user + membership in one flow
      const ownerEmail = req.body?.ownerEmail ? String(req.body.ownerEmail).trim().toLowerCase() : null;
      const ownerFirstName = req.body?.ownerFirstName ? String(req.body.ownerFirstName).trim() : null;
      const ownerLastName = req.body?.ownerLastName ? String(req.body.ownerLastName).trim() : null;
      const ownerPhone = req.body?.ownerPhone ? String(req.body.ownerPhone).trim() : null;

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

      // Create owner if email provided
      let ownerResult = null;
      if (ownerEmail) {
        let user = await prisma.user.findFirst({ where: { email: ownerEmail } });
        let tempPassword = null;

        if (!user) {
          tempPassword = crypto.randomBytes(6).toString("base64url");
          const bcryptLib = require("bcryptjs");
          const passwordHash = await bcryptLib.hash(tempPassword, 12);
          user = await prisma.user.create({
            data: {
              email: ownerEmail,
              passwordHash,
              systemRole: "user",
              status: "active",
              ...(ownerFirstName ? { firstName: ownerFirstName } : {}),
              ...(ownerLastName ? { lastName: ownerLastName } : {}),
              ...(ownerPhone ? { phoneRaw: ownerPhone } : {}),
            },
          });
        }

        await prisma.merchantUser.create({
          data: {
            merchantId: merchant.id,
            userId: user.id,
            role: "owner",
            status: "active",
          },
        });

        ownerResult = {
          userId: user.id,
          email: ownerEmail,
          firstName: ownerFirstName,
          lastName: ownerLastName,
          tempPassword,
          created: !!tempPassword,
        };
      }

      emitPvHook("admin.merchant.created", {
        actorUserId: req.userId,
        merchantId: merchant.id,
        name: merchant.name,
        ownerEmail: ownerEmail || null,
      });

      return res.status(201).json({
        ...applyNormalizedMerchantStatus(merchant),
        owner: ownerResult,
      });
    } catch (err) {
      return handlePrismaError(err, res);
    }
  });

  router.get("/merchants/:merchantId", requireJwt, requirePlatformRole, async (req, res) => {
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

  // ─── Billing Status ───────────────────────────────────────────────────────
  // GET /merchant/billing — returns plan, billing source, trial, and upgrade info
  router.get("/merchant/billing", requireJwt, requireMerchantRole("owner", "merchant_admin"), async (req, res) => {
    try {
      const merchant = await prisma.merchant.findUnique({
        where: { id: req.merchantId },
        select: {
          id: true,
          planTier: true,
          acquisitionPath: true,
          billingSource: true,
          cloverSubscriptionId: true,
          cloverPlanId: true,
          cloverBillingStatus: true,
          cloverBillingUpdatedAt: true,
          trialStartedAt: true,
          trialEndsAt: true,
          trialExpired: true,
          discountPercent: true,
          discountExpiresAt: true,
        },
      });
      if (!merchant) return sendError(res, 404, "NOT_FOUND", "Merchant not found");

      const now = new Date();
      const inTrial = merchant.trialEndsAt && merchant.trialEndsAt > now && !merchant.trialExpired;
      const trialDaysLeft = inTrial ? Math.ceil((merchant.trialEndsAt - now) / (24 * 60 * 60 * 1000)) : 0;

      // Determine billing display mode
      const managedByMarketplace = merchant.billingSource === "clover" || merchant.billingSource === "square";

      // Compute dashboard state for frontend rendering
      // TRIAL → VALUE_ADDED → BASE → GRACE → LAPSED
      const billingStatus = merchant.cloverBillingStatus || null;
      let dashboardState;
      if (inTrial) {
        dashboardState = "trial";
      } else if (merchant.trialExpired && merchant.planTier !== "value_added" && merchant.planTier !== "base") {
        dashboardState = "trial_ended";
      } else if (billingStatus === "lapsed" || billingStatus === "cancelled") {
        // Grace period: cloverBillingUpdatedAt + 30 days total (7 grace + 23 lapsed)
        const lapsedAt = merchant.cloverBillingUpdatedAt || now;
        const graceDaysElapsed = Math.floor((now - new Date(lapsedAt)) / (24 * 60 * 60 * 1000));
        dashboardState = graceDaysElapsed <= 7 ? "grace" : "lapsed";
        // Days until suspension (day 31)
        var suspensionDaysLeft = Math.max(0, 30 - graceDaysElapsed);
      } else if (merchant.planTier === "value_added") {
        dashboardState = "value_added";
      } else {
        dashboardState = "base";
      }

      const { canAccess, canCreatePromotion, upgradeRoute, BASE_LIMITS, TIER_TINT, buildFeatureManifest } = require("../utils/feature.gate");
      const activePromoCount = await prisma.promotion.count({
        where: { merchantId: req.merchantId, status: "active" },
      });

      emitPvHook("merchant.billing.viewed", {
        tc: "TC-BILL-01",
        sev: "info",
        stable: "merchant:billing:" + req.merchantId,
        merchantId: req.merchantId,
        planTier: merchant.planTier,
        billingSource: merchant.billingSource,
      });

      return res.json({
        dashboardState,
        ...(suspensionDaysLeft != null ? { suspensionDaysLeft } : {}),
        planTier: merchant.planTier,
        acquisitionPath: merchant.acquisitionPath,
        billingSource: merchant.billingSource,
        managedByMarketplace,
        marketplaceName: merchant.billingSource === "clover" ? "Clover" : merchant.billingSource === "square" ? "Square" : null,

        // Trial
        inTrial,
        trialDaysLeft,
        trialEndsAt: merchant.trialEndsAt,
        trialExpired: merchant.trialExpired,

        // Clover-specific (only if relevant)
        ...(merchant.billingSource === "clover" ? {
          cloverBillingStatus: merchant.cloverBillingStatus,
          cloverBillingUpdatedAt: merchant.cloverBillingUpdatedAt,
        } : {}),

        // Discount (Path B/C)
        ...(merchant.discountPercent ? {
          discountPercent: merchant.discountPercent,
          discountExpiresAt: merchant.discountExpiresAt,
          discountActive: merchant.discountExpiresAt ? merchant.discountExpiresAt > now : true,
        } : {}),

        // Usage / limits
        activePromotions: activePromoCount,
        promoLimit: merchant.planTier === "value_added" ? null : BASE_LIMITS.activePromotions,

        // Upgrade info
        upgrade: merchant.planTier !== "value_added" ? upgradeRoute(merchant) : null,

        // Tier tinting — colors for card rendering
        tint: TIER_TINT[merchant.planTier] || TIER_TINT.base,

        // Feature manifest — per-card allowed/locked status with tint
        features: buildFeatureManifest(merchant),
      });
    } catch (err) {
      return handlePrismaError(err, res);
    }
  });

  // ─── Your Plan helpers ────────────────────────────────────────────────────
  const MERCHANT_TYPE_LABELS = {
    coffee_shop: "a coffee shop", restaurant: "a restaurant", fitness: "a fitness studio",
    salon_spa: "a salon or spa", retail: "a retail store", grocery: "a grocery store",
    pet_services: "a pet services business", automotive: "an automotive shop",
    specialty_food: "a specialty food business", education_kids: "an education business",
    bakery: "a bakery",
  };
  function friendlyMerchantType(t) { return MERCHANT_TYPE_LABELS[t] || "a business like yours"; }

  // ─── Your Plan — personalized insights ────────────────────────────────────
  // GET /merchant/plan — plan identity, activity stats, and personalized insight cards
  router.get("/merchant/plan", requireJwt, requireMerchantRole("owner", "merchant_admin"), async (req, res) => {
    try {
      const merchant = await prisma.merchant.findUnique({
        where: { id: req.merchantId },
        select: {
          id: true, name: true, merchantType: true, planTier: true,
          acquisitionPath: true, billingSource: true,
          trialStartedAt: true, trialEndsAt: true, trialExpired: true,
          createdAt: true,
          stores: { select: { id: true, name: true } },
          posConnections: { select: { posType: true }, take: 1 },
        },
      });
      const posType = merchant?.posConnections?.[0]?.posType || null;
      if (!merchant) return sendError(res, 404, "NOT_FOUND", "Merchant not found");

      const now = new Date();
      const thirtyDaysAgo = new Date(now - 30 * 24 * 60 * 60 * 1000);
      const inTrial = merchant.trialEndsAt && merchant.trialEndsAt > now && !merchant.trialExpired;
      const trialDaysLeft = inTrial ? Math.ceil((merchant.trialEndsAt - now) / (24 * 60 * 60 * 1000)) : 0;
      const tier = merchant.planTier || "base";

      // ── Activity stats from pre-aggregated tables ──
      const dailySummaries = await prisma.merchantDailySummary.findMany({
        where: { merchantId: req.merchantId, storeId: null, date: { gte: thirtyDaysAgo } },
      });

      const stampsIssued = dailySummaries.reduce((s, r) => s + (r.stampsIssued || 0), 0);
      const totalTransactions = dailySummaries.reduce((s, r) => s + (r.totalTransactions || 0), 0);
      const attributedTransactions = dailySummaries.reduce((s, r) => s + (r.attributedTransactions || 0), 0);
      const rewardsRedeemed = dailySummaries.reduce((s, r) => s + (r.rewardsRedeemed || 0), 0);
      const newEnrollments = dailySummaries.reduce((s, r) => s + (r.newEnrollments || 0), 0);
      const captureRate = totalTransactions > 0 ? attributedTransactions / totalTransactions : 0;

      const activePromotions = await prisma.promotion.count({
        where: { merchantId: req.merchantId, status: "active" },
      });

      // Engagement snapshot for repeat rate
      let repeatVisitRate = 0;
      const engagement = await prisma.consumerEngagementSummary.findFirst({
        where: { merchantId: req.merchantId, storeId: null },
        orderBy: { date: "desc" },
      }).catch(() => null);
      if (engagement) {
        const total = (engagement.visitedOnce || 0) + (engagement.visited2to3 || 0)
          + (engagement.visited4to7 || 0) + (engagement.visited8plus || 0);
        const repeat = (engagement.visited2to3 || 0) + (engagement.visited4to7 || 0) + (engagement.visited8plus || 0);
        repeatVisitRate = total > 0 ? repeat / total : 0;
      }

      // Peak/slowest hour from raw orders
      let peakHour = null;
      let slowestHour = null;
      if (totalTransactions > 0) {
        const orders = await prisma.posOrder.findMany({
          where: { merchantId: req.merchantId, createdAt: { gte: thirtyDaysAgo } },
          select: { createdAt: true },
        });
        if (orders.length > 10) {
          const byHour = Array.from({ length: 24 }, () => 0);
          for (const o of orders) byHour[new Date(o.createdAt).getUTCHours()]++;
          // Only consider business hours (6am-10pm)
          let maxH = 6, minH = 6, maxC = 0, minC = Infinity;
          for (let h = 6; h <= 22; h++) {
            if (byHour[h] > maxC) { maxC = byHour[h]; maxH = h; }
            if (byHour[h] < minC && byHour[h] > 0) { minC = byHour[h]; minH = h; }
          }
          const fmt = (h) => `${h > 12 ? h - 12 : h}${h >= 12 ? "pm" : "am"}-${(h + 2) > 12 ? (h + 2) - 12 : h + 2}${(h + 2) >= 12 ? "pm" : "am"}`;
          peakHour = fmt(maxH);
          slowestHour = fmt(minH);
        }
      }

      // ── Personalized insights ──
      const candidates = [];
      const locationCount = merchant.stores.length;

      // MULTI-LOCATION — stamp sharing
      if (locationCount > 1 && tier === "base") {
        candidates.push({
          priority: 10, emoji: "\uD83D\uDCCD",
          observation: `You have ${locationCount} locations, but stamps don't transfer between them yet.`,
          opportunity: "Customers who visit any of your stores could earn toward the same reward \u2014 making your whole footprint feel like one place.",
          feature: "Multi-location stamp sharing",
          cta: "See how multi-location works \u2192",
        });
      }

      // HIGH CAPTURE RATE — team leaderboard
      if (captureRate > 0.5 && tier === "base") {
        candidates.push({
          priority: 9, emoji: "\u2B50",
          observation: `Your team is capturing phone numbers ${Math.round(captureRate * 100)}% of the time \u2014 that's strong.`,
          opportunity: "Team attribution would show you exactly which staff member is driving that. Most merchants use it as a friendly leaderboard at the counter.",
          feature: "Team performance tracking",
          cta: "See team attribution \u2192",
        });
      }

      // LOW CAPTURE RATE — leaderboard as solution
      if (captureRate < 0.3 && captureRate > 0 && tier === "base") {
        candidates.push({
          priority: 8, emoji: "\uD83D\uDCF1",
          observation: `About ${Math.round((1 - captureRate) * 100)}% of your transactions aren't being captured yet.`,
          opportunity: "The associate leaderboard makes phone capture into a friendly competition. Most merchants see their capture rate jump within the first week.",
          feature: "Associate leaderboard",
          cta: "See how the leaderboard works \u2192",
        });
      }

      // SLOW PERIOD — time-based promotions
      if (slowestHour && tier === "base") {
        candidates.push({
          priority: 7, emoji: "\u23F0",
          observation: `Your quietest time is around ${slowestHour}.`,
          opportunity: "Double stamps during that window \u2014 or a happy hour special \u2014 can shift some of your peak traffic into slower periods.",
          feature: "Time-based promotions",
          cta: "See time-based promotions \u2192",
        });
      }

      // AT PROMOTION LIMIT — unlimited programs
      if (activePromotions >= 1 && tier === "base") {
        candidates.push({
          priority: 6, emoji: "\uD83C\uDFAF",
          observation: "You're running your one active promotion right now.",
          opportunity: "A morning special alongside your main loyalty program, or a separate program for your top regulars \u2014 Value-Added unlocks unlimited programs.",
          feature: "Unlimited promotions",
          cta: "See what's possible \u2192",
        });
      }

      // GOOD REPEAT RATE — show them it's working
      if (repeatVisitRate > 0.4 && tier === "base") {
        candidates.push({
          priority: 5, emoji: "\uD83D\uDD04",
          observation: `${Math.round(repeatVisitRate * 100)}% of your enrolled customers have visited more than once. Your loyalty program is working.`,
          opportunity: "Advanced analytics would show you which promotions are driving that repeat behavior \u2014 and which ones to double down on.",
          feature: "Advanced analytics",
          cta: "See advanced analytics \u2192",
        });
      }

      // NEW MERCHANT — no data yet
      if (stampsIssued === 0) {
        candidates.push({
          priority: 1, emoji: "\uD83D\uDE80",
          observation: "You're just getting started \u2014 your insights will appear here after your first transactions.",
          opportunity: `In the meantime, explore Growth Advisor \u2014 it'll suggest the right promotion type for ${friendlyMerchantType(merchant.merchantType)}.`,
          feature: "Growth Advisor",
          cta: "Open Growth Advisor \u2192",
        });
      }

      const insights = candidates.sort((a, b) => b.priority - a.priority).slice(0, 3);

      // VA merchants get appreciation instead of upsell
      const vaAppreciation = tier === "value_added" ? {
        activeFeatures: [
          insights.length > 0 ? null : "Your Growth Advisor has suggestions waiting for you",
          "Your Weekly Briefing arrives every Monday",
          "Your team leaderboard updates daily",
        ].filter(Boolean),
      } : null;

      const { upgradeRoute, BASE_LIMITS } = require("../utils/feature.gate");

      emitPvHook("plan.page.viewed", {
        tc: "TC-PLAN-01", sev: "info",
        stable: "merchant:plan:" + req.merchantId,
        merchantId: req.merchantId,
        planTier: tier, inTrial,
      });

      return res.json({
        // Section 1: Plan identity
        merchantName: merchant.name,
        businessType: merchant.merchantType || null,
        businessTypeLabel: friendlyMerchantType(merchant.merchantType),
        planTier: tier,
        acquisitionPath: merchant.acquisitionPath,
        billingSource: merchant.billingSource,
        posType,
        stores: merchant.stores,
        locationCount,
        inTrial,
        trialDaysLeft,
        trialEndsAt: merchant.trialEndsAt,
        activeSince: merchant.createdAt,

        // Section 2: Activity stats (last 30 days)
        activity: {
          stampsIssued,
          consumersEnrolled: newEnrollments,
          captureRate: Math.round(captureRate * 100),
          activePromotions,
          rewardsRedeemed,
          repeatVisitRate: Math.round(repeatVisitRate * 100),
          peakHour,
          slowestHour,
        },

        // Section 3: Insights
        insights: tier === "value_added" ? [] : insights,
        vaAppreciation,

        // Section 4: Upgrade info
        upgrade: tier !== "value_added" ? upgradeRoute(merchant) : null,
        promoLimit: tier === "value_added" ? null : BASE_LIMITS.activePromotions,
      });
    } catch (err) {
      return handlePrismaError(err, res);
    }
  });

  // ─── Plan Upgrade — create invoice + send pay-now email ──────────────────
  router.post("/merchant/plan/upgrade", requireJwt, requireMerchantRole("owner"), async (req, res) => {
    try {
      const merchant = await prisma.merchant.findUnique({
        where: { id: req.merchantId },
        select: {
          id: true, name: true, planTier: true, acquisitionPath: true, billingSource: true,
          discountPercent: true, discountCycles: true, discountCyclesUsed: true,
          stores: { select: { id: true } },
          billingAccount: { select: { id: true } },
          posConnections: { select: { posType: true }, take: 1 },
        },
      });
      if (!merchant) return sendError(res, 404, "NOT_FOUND", "Merchant not found");

      // Already VA
      if (merchant.planTier === "value_added") {
        return sendError(res, 409, "ALREADY_UPGRADED", "You're already on the Value-Added plan.");
      }

      // Marketplace merchants upgrade through their marketplace
      if (merchant.billingSource === "clover" || merchant.billingSource === "square") {
        return sendError(res, 409, "MARKETPLACE_BILLING", "Your plan is managed through your POS marketplace. Please upgrade there.");
      }

      if (!merchant.billingAccount) {
        return sendError(res, 400, "NO_BILLING_ACCOUNT", "Billing account not set up. Contact support.");
      }

      // ── Calculate price from PlatformConfig ──
      const configRows = await prisma.platformConfig.findMany();
      const cfg = {};
      for (const r of configRows) cfg[r.key] = r.value;

      const locationCount = merchant.stores.length || 1;
      const isStandalone = !merchant.posConnections?.[0]?.posType;

      // Pick the right price keys
      const singleKey = isStandalone ? "price_va_standalone_single_cents" : "price_va_single_cents";
      const additionalKey = isStandalone ? "price_va_standalone_additional_cents" : "price_va_additional_cents";

      const singleCents = Number(cfg[singleKey]) || Number(cfg["price_va_single_cents"]) || 0;
      const additionalCents = Number(cfg[additionalKey]) || Number(cfg["price_va_additional_cents"]) || 0;

      if (singleCents === 0) {
        return sendError(res, 503, "PRICING_NOT_SET", "Plan pricing has not been configured yet. Contact hello@perksvalet.com.");
      }

      const listPriceCents = singleCents + (Math.max(0, locationCount - 1) * additionalCents);

      // Apply merchant discount
      let discountCents = 0;
      let discountActive = false;
      if (merchant.discountPercent && merchant.discountPercent > 0) {
        const cyclesLeft = (merchant.discountCycles || 0) - (merchant.discountCyclesUsed || 0);
        if (cyclesLeft > 0 || !merchant.discountCycles) {
          discountCents = Math.round(listPriceCents * (merchant.discountPercent / 100));
          discountActive = true;
        }
      }

      const netCents = listPriceCents - discountCents;

      // ── Create invoice ──
      const now = new Date();
      const dueAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000); // due in 7 days

      const lineItems = [
        {
          description: `Value-Added Plan — ${locationCount === 1 ? "1 location" : locationCount + " locations"}`,
          quantity: 1,
          unitPriceCents: listPriceCents,
          amountCents: listPriceCents,
          sourceType: "plan_upgrade",
        },
      ];

      if (discountActive && discountCents > 0) {
        lineItems.push({
          description: `Discount (${merchant.discountPercent}% off)`,
          quantity: 1,
          unitPriceCents: -discountCents,
          amountCents: -discountCents,
          sourceType: "plan_discount",
        });
      }

      const invoice = await prisma.invoice.create({
        data: {
          merchantId: merchant.id,
          billingAccountId: merchant.billingAccount.id,
          status: "issued",
          issuedAt: now,
          netTermsDays: 7,
          dueAt,
          subtotalCents: netCents,
          taxCents: 0,
          totalCents: netCents,
          amountPaidCents: 0,
          lineItems: { create: lineItems },
        },
      });

      // ── Mint guest pay token ──
      const { mintRawToken, sha256Hex, computeGuestTokenExpiry } = require("../payments/guestToken");
      const raw = mintRawToken(32);
      const tokenHash = sha256Hex(raw);
      const tokenExpiry = computeGuestTokenExpiry({ dueAt });

      await prisma.guestPayToken.create({
        data: { invoiceId: invoice.id, tokenHash, expiresAt: tokenExpiry },
      });

      const PUBLIC_BASE = String(process.env.PUBLIC_BASE_URL || "http://localhost:3001").replace(/\/+$/, "");
      const payUrl = `${PUBLIC_BASE}/pay/${encodeURIComponent(raw)}`;

      // ── Send pay-now email ──
      const { sendMail } = require("../utils/mail");
      const { upgradeInvoice } = require("../utils/mail.templates");

      // Find merchant owner email + name
      const ownerUser = await prisma.merchantUser.findFirst({
        where: { merchantId: merchant.id, role: "owner" },
        include: { user: { select: { email: true, firstName: true } } },
      });
      const toEmail = ownerUser?.user?.email;

      if (toEmail) {
        const emailData = upgradeInvoice({
          merchantName: merchant.name,
          firstName: ownerUser.user.firstName,
          locationCount,
          invoiceNumber: invoice.id,
          totalCents: netCents,
          dueAt,
          payUrl,
          lineItems: lineItems.map(li => ({ description: li.description, amountCents: li.amountCents })),
        });
        await sendMail({ to: toEmail, ...emailData }).catch(e => {
          console.warn("[plan.upgrade] email send failed:", e?.message);
        });
      }

      emitPvHook("plan.upgrade.requested", {
        tc: "TC-PLAN-UPG-01", sev: "info",
        stable: "merchant:upgrade:" + merchant.id,
        merchantId: merchant.id,
        invoiceId: invoice.id,
        listPriceCents, discountCents, netCents,
        locationCount, discountPercent: merchant.discountPercent || 0,
      });

      return res.json({
        ok: true,
        invoiceId: invoice.id,
        totalCents: netCents,
        payUrl,
        emailSent: !!toEmail,
        message: toEmail
          ? `We've sent a payment link to ${toEmail}. Complete payment to activate Value-Added.`
          : "Invoice created. Contact hello@perksvalet.com for payment options.",
      });
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
  // Note: Square does not expose a customer merge API — merging must be done
  // manually in the Square Dashboard. This endpoint just tracks the alert status.
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