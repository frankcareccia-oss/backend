/**
 * Module: backend/src/admin/admin.routes.js
 *
 * PerkValet Admin Surface (pv_admin operations)
 */

const express = require("express");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");

function buildAdminRouter(deps) {
  const {
    prisma,
    requireAdmin,
    requireJwt,
    requireBillingStaff,
    sendError,
    handlePrismaError,
    parseIntParam,
    BILLING_POLICY,
    validateBillingPolicy,
    saveBillingPolicyToDisk,
    getMerchantPolicyBundle,
  } = deps;

  const router = express.Router();

  function toIsoOrNull(value) {
    return value ? new Date(value).toISOString() : null;
  }

  function mapInvoiceSummary(inv) {
    return {
      id: inv.id,
      merchantId: inv.merchantId,
      merchantName: inv.merchant?.name || null,
      billingAccountId: inv.billingAccountId,
      status: inv.status,
      issuedAt: toIsoOrNull(inv.issuedAt),
      netTermsDays: inv.netTermsDays ?? null,
      dueAt: toIsoOrNull(inv.dueAt),
      subtotalCents: inv.subtotalCents,
      taxCents: inv.taxCents,
      totalCents: inv.totalCents,
      amountPaidCents: inv.amountPaidCents,
      createdAt: toIsoOrNull(inv.createdAt),
      updatedAt: toIsoOrNull(inv.updatedAt),
    };
  }

  function parseMoneyToCents(raw, rawCents) {
    if (rawCents !== undefined && rawCents !== null && rawCents !== "") {
      const cents = Number(rawCents);
      if (!Number.isFinite(cents) || cents < 0) return null;
      return Math.round(cents);
    }

    if (raw === undefined || raw === null || raw === "") return 0;

    const normalized = String(raw).replace(/[$,\s]/g, "").trim();
    if (!normalized) return 0;

    const amount = Number(normalized);
    if (!Number.isFinite(amount) || amount < 0) return null;

    return Math.round(amount * 100);
  }

  function parseOptionalPositiveInt(raw) {
    if (raw === undefined || raw === null || raw === "") return null;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0) return null;
    return n;
  }

  router.post("/admin/merchants/:merchantId/stores", requireAdmin, async (req, res) => {
    const merchantId = parseIntParam(req.params.merchantId);
    const { name } = req.body || {};

    if (!merchantId) {
      return sendError(res, 400, "VALIDATION_ERROR", "Invalid merchantId");
    }

    const storeName = String(name || "").trim();
    if (!storeName) {
      return sendError(res, 400, "VALIDATION_ERROR", "name is required");
    }

    try {
      const merchant = await prisma.merchant.findUnique({
        where: { id: merchantId },
      });

      if (!merchant) {
        return sendError(res, 404, "NOT_FOUND", "Merchant not found");
      }

      if (merchant.status !== "active") {
        return sendError(res, 400, "INVALID_STATE", "Merchant is not active");
      }

      const store = await prisma.store.create({
        data: {
          merchantId,
          name: storeName,
          status: "active",
        },
      });

      return res.status(201).json(store);
    } catch (err) {
      return handlePrismaError(err, res);
    }
  });

  // ── Platform Config ──────────────────────────────────────────────────────
  // Known keys and their defaults. Add new settings here — they'll be seeded
  // automatically on first GET if missing from the DB.
  const PLATFORM_CONFIG_DEFAULTS = {
    consumer_jwt_ttl_days:    "90",
    consumer_otp_ttl_minutes: "15",
  };

  const PLATFORM_CONFIG_META = {
    consumer_jwt_ttl_days:    { label: "Consumer session length (days)", type: "number", min: 1, max: 365 },
    consumer_otp_ttl_minutes: { label: "SMS code validity (minutes)",    type: "number", min: 1, max: 60  },
  };

  // Ensure all known keys exist in DB (upsert defaults on first use)
  async function seedPlatformConfigDefaults() {
    for (const [key, value] of Object.entries(PLATFORM_CONFIG_DEFAULTS)) {
      await prisma.platformConfig.upsert({
        where: { key },
        create: { key, value },
        update: {},   // never overwrite an existing value
      });
    }
  }

  router.get("/admin/platform/config", requireAdmin, async (_req, res) => {
    try {
      await seedPlatformConfigDefaults();
      const rows = await prisma.platformConfig.findMany({ orderBy: { key: "asc" } });
      const config = {};
      for (const r of rows) config[r.key] = r.value;
      return res.json({ config, meta: PLATFORM_CONFIG_META });
    } catch (err) {
      return handlePrismaError(err, res);
    }
  });

  router.put("/admin/platform/config", requireAdmin, async (req, res) => {
    try {
      const updates = req.body || {};
      const allowedKeys = new Set(Object.keys(PLATFORM_CONFIG_DEFAULTS));
      const errors = {};

      for (const [key, rawValue] of Object.entries(updates)) {
        if (!allowedKeys.has(key)) { errors[key] = "Unknown config key"; continue; }
        const meta = PLATFORM_CONFIG_META[key];
        const val = String(rawValue ?? "").trim();
        if (meta?.type === "number") {
          const n = Number(val);
          if (!Number.isInteger(n) || n < meta.min || n > meta.max) {
            errors[key] = `Must be an integer between ${meta.min} and ${meta.max}`;
          }
        }
      }

      if (Object.keys(errors).length) {
        return sendError(res, 400, "VALIDATION_ERROR", "Invalid config values", { fields: errors });
      }

      for (const [key, rawValue] of Object.entries(updates)) {
        if (!allowedKeys.has(key)) continue;
        await prisma.platformConfig.upsert({
          where: { key },
          create: { key, value: String(rawValue).trim(), updatedBy: req.userId },
          update: { value: String(rawValue).trim(), updatedBy: req.userId },
        });
      }

      const rows = await prisma.platformConfig.findMany({ orderBy: { key: "asc" } });
      const config = {};
      for (const r of rows) config[r.key] = r.value;
      return res.json({ ok: true, config });
    } catch (err) {
      return handlePrismaError(err, res);
    }
  });
  // ─────────────────────────────────────────────────────────────────────────

  router.get("/admin/billing-policy", requireBillingStaff, (_req, res) => {
    res.json(BILLING_POLICY);
  });

  router.put("/admin/billing-policy", requireAdmin, (req, res) => {
    const v = validateBillingPolicy(req.body || {});
    if (!v.ok) return sendError(res, 400, "VALIDATION_ERROR", v.msg);

    Object.assign(BILLING_POLICY, v.policy);

    const ok = saveBillingPolicyToDisk(BILLING_POLICY);
    if (!ok) {
      return sendError(
        res,
        500,
        "PERSIST_FAILED",
        "Policy saved in memory but failed to persist to disk"
      );
    }

    return res.json(BILLING_POLICY);
  });

  router.post("/admin/billing/generate-invoice", requireAdmin, async (req, res) => {
    try {
      const merchantId = parseIntParam(req.body?.merchantId);
      const subtotalCents = parseMoneyToCents(
        req.body?.total ??
        req.body?.amount ??
        req.body?.totalAmount ??
        req.body?.totalDollars ??
        req.body?.subtotal,
        req.body?.totalCents ??
        req.body?.amountCents ??
        req.body?.subtotalCents
      );
      const netTermsDays = parseOptionalPositiveInt(
        req.body?.netTermsDays ?? req.body?.terms ?? req.body?.netTerms
      );

      if (!merchantId) {
        return sendError(res, 400, "VALIDATION_ERROR", "merchantId is required");
      }

      if (subtotalCents === null) {
        return sendError(
          res,
          400,
          "VALIDATION_ERROR",
          "Total amount must be a valid non-negative number"
        );
      }

      const bundle = await getMerchantPolicyBundle(merchantId);
      if (bundle?.error) {
        return sendError(
          res,
          bundle.error.http,
          bundle.error.code,
          bundle.error.message
        );
      }

      if (!bundle?.accountId) {
        return sendError(
          res,
          400,
          "INVALID_STATE",
          "Merchant billing account not found"
        );
      }

      const invoice = await prisma.invoice.create({
        data: {
          merchantId,
          billingAccountId: bundle.accountId,
          status: "draft",
          issuedAt: null,
          netTermsDays,
          dueAt: null,
          subtotalCents,
          taxCents: 0,
          totalCents: subtotalCents,
          amountPaidCents: 0,

          // 🔥 THIS IS THE NEW PART
          lineItems: {
            create: [
              {
                description: "Platform Fee",
                quantity: 1,
                unitPriceCents: subtotalCents,
                amountCents: subtotalCents,
                sourceType: "platform_fee",
              },
            ],
          },
        },
      });

      return res.status(201).json({
        ok: true,
        invoiceId: invoice.id,
        invoice: mapInvoiceSummary(invoice),
      });
    } catch (err) {
      return handlePrismaError(err, res);
    }
  });

  router.get("/admin/merchants/:merchantId/billing-policy", requireBillingStaff, async (req, res) => {
    const merchantId = parseIntParam(req.params.merchantId);

    if (!merchantId) {
      return sendError(res, 400, "VALIDATION_ERROR", "Invalid merchantId");
    }

    try {
      const bundle = await getMerchantPolicyBundle(merchantId);

      if (bundle.error) {
        return sendError(
          res,
          bundle.error.http,
          bundle.error.code,
          bundle.error.message
        );
      }

      return res.json({
        merchantId,
        billingAccountId: bundle.accountId,
        global: bundle.global,
        overrides: bundle.overrides,
        effective: bundle.effective,
      });
    } catch (err) {
      return handlePrismaError(err, res);
    }
  });

  router.get("/admin/merchants/:merchantId/users", requireAdmin, async (req, res) => {
    try {
      const merchantId = parseIntParam(req.params.merchantId);

      if (!merchantId) {
        return sendError(res, 400, "VALIDATION_ERROR", "Invalid merchantId");
      }

      const users = await prisma.merchantUser.findMany({
        where: { merchantId },
        include: {
          user: {
            select: {
              id: true,
              email: true,
              firstName: true,
              lastName: true,
              phoneE164: true,
            },
          },
        },
        orderBy: { id: "asc" },
      });

      const merchant = await prisma.merchant.findUnique({
        where: { id: merchantId },
        select: { id: true, name: true },
      });

      const result = users.map((mu) => ({
        merchantUserId: mu.id,
        id: mu.id,
        role: mu.role,
        status: mu.status,
        statusReason: mu.statusReason ?? null,
        userId: mu.user.id,
        email: mu.user.email,
        firstName: mu.user.firstName,
        lastName: mu.user.lastName,
        phone: mu.user.phoneE164,
      }));

      res.json({
        ok: true,
        merchantId,
        merchantName: merchant?.name || "",
        users: result,
      });
    } catch (err) {
      return handlePrismaError(err, res);
    }
  });

  router.get("/admin/merchant-users/:merchantUserId", requireAdmin, async (req, res) => {
    try {
      const merchantUserId = parseIntParam(req.params.merchantUserId);

      if (!merchantUserId) {
        return sendError(res, 400, "VALIDATION_ERROR", "Invalid merchantUserId");
      }

      const mu = await prisma.merchantUser.findUnique({
        where: { id: merchantUserId },
        include: {
          user: true,
        },
      });

      if (!mu) {
        return sendError(res, 404, "NOT_FOUND", "Merchant user not found");
      }

      return res.json({
        merchantUserId: mu.id,
        role: mu.role,
        status: mu.status,
        statusReason: mu.statusReason ?? null,
        createdAt: mu.createdAt ?? null,
        updatedAt: mu.updatedAt ?? null,
        user: {
          id: mu.user?.id ?? null,
          email: mu.user?.email ?? null,
          status: mu.user?.status ?? null,
          firstName: mu.user?.firstName ?? null,
          lastName: mu.user?.lastName ?? null,
          phoneRaw: mu.user?.phoneRaw ?? null,
          phoneE164: mu.user?.phoneE164 ?? null,
        },
      });
    } catch (err) {
      return handlePrismaError(err, res);
    }
  });

  router.post("/admin/merchants/:merchantId/users", requireAdmin, async (req, res) => {
    try {
      const merchantId = parseIntParam(req.params.merchantId);
      const email = String(req.body?.email || "").trim().toLowerCase();
      const firstName = String(req.body?.firstName || "").trim() || null;
      const lastName = String(req.body?.lastName || "").trim() || null;

      if (!merchantId) {
        return sendError(res, 400, "VALIDATION_ERROR", "Invalid merchantId");
      }

      if (!email) {
        return sendError(res, 400, "VALIDATION_ERROR", "email is required");
      }

      let user = await prisma.user.findFirst({ where: { email } });

      let tempPassword = null;
      let createdUser = false;

      if (!user) {
        tempPassword = crypto.randomBytes(6).toString("base64url");
        const passwordHash = await bcrypt.hash(tempPassword, 12);

        user = await prisma.user.create({
          data: {
            email,
            passwordHash,
            systemRole: "user",
            status: "active",
            tokenVersion: 0,
            ...(firstName && { firstName }),
            ...(lastName && { lastName }),
          },
        });

        createdUser = true;
      } else if (firstName || lastName) {
        const nameUpdate = {};
        if (firstName) nameUpdate.firstName = firstName;
        if (lastName) nameUpdate.lastName = lastName;
        user = await prisma.user.update({ where: { id: user.id }, data: nameUpdate });
      }

      const membership = await prisma.merchantUser.upsert({
        where: {
          merchantId_userId: {
            merchantId,
            userId: user.id,
          },
        },
        update: {
          role: "merchant_admin",
          status: "active",
          statusReason: null,
        },
        create: {
          merchantId,
          userId: user.id,
          role: "merchant_admin",
          status: "active",
        },
      });

      return res.status(201).json({
        ok: true,
        createdUser,
        email: user.email,
        userId: user.id,
        membership,
        tempPassword,
      });
    } catch (err) {
      return handlePrismaError(err, res);
    }
  });

  // PATCH /admin/merchants/:merchantId/team-setup — set team setup mode (pv_admin)
  router.patch("/admin/merchants/:merchantId/team-setup", requireAdmin, async (req, res) => {
    try {
      const merchantId = parseIntParam(req.params.merchantId);
      if (!merchantId) return sendError(res, 400, "VALIDATION_ERROR", "Invalid merchantId");

      const { teamSetupMode } = req.body || {};
      const validModes = ["individual", "shared", "solo", "external"];
      if (!validModes.includes(teamSetupMode)) {
        return sendError(res, 400, "VALIDATION_ERROR", `teamSetupMode must be one of: ${validModes.join(", ")}`);
      }

      const merchant = await prisma.merchant.update({
        where: { id: merchantId },
        data: {
          teamSetupMode,
          teamSetupComplete: true,
        },
        select: { id: true, name: true, teamSetupMode: true, teamSetupComplete: true },
      });

      console.log(JSON.stringify({
        pvHook: "admin.merchant.team_setup_updated",
        merchantId, teamSetupMode, ts: new Date().toISOString(),
      }));

      return res.json(merchant);
    } catch (err) {
      return handlePrismaError(err, res);
    }
  });

  // POST /admin/merchants/:merchantId/team-sync — trigger POS employee sync (pv_admin)
  router.post("/admin/merchants/:merchantId/team-sync", requireAdmin, async (req, res) => {
    try {
      const merchantId = parseIntParam(req.params.merchantId);
      if (!merchantId) return sendError(res, 400, "VALIDATION_ERROR", "Invalid merchantId");

      const { syncTeamFromPos } = require("../pos/pos.team.sync");

      const conn = await prisma.posConnection.findFirst({
        where: { merchantId, status: "active", posType: { in: ["clover", "square"] } },
      });
      if (!conn) return sendError(res, 400, "NO_POS_CONNECTION", "No active POS connection for this merchant");

      const stats = await syncTeamFromPos(conn.id);

      await prisma.merchant.update({
        where: { id: merchantId },
        data: { teamSyncEnabled: true, teamSyncedAt: new Date() },
      });

      return res.json({ success: true, ...stats });
    } catch (err) {
      return handlePrismaError(err, res);
    }
  });

  // PATCH /admin/merchants/:merchantId/users/:userId — edit user profile (pv_admin)
  router.patch("/admin/merchants/:merchantId/users/:userId", requireAdmin, async (req, res) => {
    try {
      const merchantId = parseIntParam(req.params.merchantId);
      const userId = parseIntParam(req.params.userId);
      if (!merchantId || !userId) return sendError(res, 400, "VALIDATION_ERROR", "Invalid merchantId or userId");

      // Verify user belongs to this merchant
      const mu = await prisma.merchantUser.findFirst({
        where: { merchantId, userId },
      });
      if (!mu) return sendError(res, 404, "NOT_FOUND", "User not found in this merchant");

      const { firstName, lastName, phoneRaw } = req.body || {};
      const data = {};
      if (firstName !== undefined) data.firstName = String(firstName).trim() || null;
      if (lastName !== undefined) data.lastName = String(lastName).trim() || null;
      if (phoneRaw !== undefined) data.phoneRaw = String(phoneRaw).trim() || null;

      if (Object.keys(data).length === 0) {
        return sendError(res, 400, "VALIDATION_ERROR", "No fields to update");
      }

      const updated = await prisma.user.update({ where: { id: userId }, data });

      return res.json({
        userId: updated.id,
        email: updated.email,
        firstName: updated.firstName,
        lastName: updated.lastName,
        phoneRaw: updated.phoneRaw,
      });
    } catch (err) {
      return handlePrismaError(err, res);
    }
  });

  router.post("/admin/merchant/ownership-transfer", requireAdmin, async (req, res) => {
    try {
      const merchantId = parseIntParam(req.body?.merchantId);
      const currentOwnerEmail = String(req.body?.currentOwnerEmail || "").trim().toLowerCase();
      const newOwnerEmail = String(req.body?.newOwnerEmail || "").trim().toLowerCase();
      const reason = String(req.body?.reason || "").trim();
      const oldOwnerAction = String(req.body?.oldOwnerAction || "").trim().toLowerCase();

      if (!merchantId) {
        return sendError(res, 400, "VALIDATION_ERROR", "merchantId is required");
      }

      if (!currentOwnerEmail) {
        return sendError(res, 400, "VALIDATION_ERROR", "currentOwnerEmail is required");
      }

      if (!newOwnerEmail) {
        return sendError(res, 400, "VALIDATION_ERROR", "newOwnerEmail is required");
      }

      if (currentOwnerEmail === newOwnerEmail) {
        return sendError(
          res,
          400,
          "VALIDATION_ERROR",
          "currentOwnerEmail and newOwnerEmail cannot be the same"
        );
      }

      const allowedActions = new Set(["suspend", "demote", "keep"]);
      if (!allowedActions.has(oldOwnerAction)) {
        return sendError(
          res,
          400,
          "VALIDATION_ERROR",
          "oldOwnerAction must be one of: suspend, demote, keep"
        );
      }

      const merchant = await prisma.merchant.findUnique({
        where: { id: merchantId },
      });

      if (!merchant) {
        return sendError(res, 404, "NOT_FOUND", "Merchant not found");
      }

      const [currentUser, newUser] = await Promise.all([
        prisma.user.findFirst({ where: { email: currentOwnerEmail } }),
        prisma.user.findFirst({ where: { email: newOwnerEmail } }),
      ]);

      if (!currentUser) {
        return sendError(res, 404, "NOT_FOUND", "Current owner user not found");
      }

      if (!newUser) {
        return sendError(res, 404, "NOT_FOUND", "New owner user not found");
      }

      const [currentMembership, newMembership] = await Promise.all([
        prisma.merchantUser.findFirst({
          where: {
            merchantId,
            userId: currentUser.id,
          },
        }),
        prisma.merchantUser.findFirst({
          where: {
            merchantId,
            userId: newUser.id,
          },
        }),
      ]);

      if (!currentMembership) {
        return sendError(
          res,
          404,
          "NOT_FOUND",
          "Current owner membership not found for this merchant"
        );
      }

      if (!["owner", "merchant_admin"].includes(String(currentMembership.role || "").toLowerCase())) {
        return sendError(
          res,
          409,
          "INVALID_STATE",
          "Current owner membership is not owner-capable"
        );
      }

      if (String(currentMembership.status || "").toLowerCase() !== "active") {
        return sendError(
          res,
          409,
          "INVALID_STATE",
          "Current owner must be active to transfer ownership"
        );
      }

      const result = await prisma.$transaction(async (tx) => {
        const promoted = newMembership
          ? await tx.merchantUser.update({
            where: { id: newMembership.id },
            data: {
              role: "owner",
              status: "active",
              statusReason: null,
            },
          })
          : await tx.merchantUser.create({
            data: {
              merchantId,
              userId: newUser.id,
              role: "owner",
              status: "active",
              statusReason: null,
            },
          });

        let priorOwnerResult = null;

        if (oldOwnerAction === "suspend") {
          priorOwnerResult = await tx.merchantUser.update({
            where: { id: currentMembership.id },
            data: {
              status: "suspended",
              statusReason: reason || "ownership_transfer",
            },
          });
        } else if (oldOwnerAction === "demote") {
          priorOwnerResult = await tx.merchantUser.update({
            where: { id: currentMembership.id },
            data: {
              role: "merchant_employee",
              status: "active",
              statusReason: reason || "ownership_transfer",
            },
          });
        } else {
          priorOwnerResult = await tx.merchantUser.update({
            where: { id: currentMembership.id },
            data: {
              statusReason: reason || currentMembership.statusReason || null,
            },
          });
        }

        return {
          promoted,
          priorOwnerResult,
        };
      });

      return res.json({
        ok: true,
        merchantId,
        currentOwnerEmail,
        newOwnerEmail,
        oldOwnerAction,
        reason: reason || null,
        promotedMerchantUserId: result.promoted.id,
        previousOwnerMerchantUserId: result.priorOwnerResult.id,
      });
    } catch (err) {
      return handlePrismaError(err, res);
    }
  });

  router.get("/admin/invoices", requireBillingStaff, async (req, res) => {
    try {
      const where = {};

      const rawStatus = String(req.query?.status || "").trim();
      if (rawStatus && rawStatus !== "any") {
        where.status = rawStatus;
      }

      const rawMerchantId =
        req.query?.merchantId ??
        req.query?.merchant ??
        req.query?.merchant_id;

      if (rawMerchantId !== undefined && rawMerchantId !== null && rawMerchantId !== "") {
        const merchantId = parseIntParam(rawMerchantId);
        if (merchantId) {
          where.merchantId = merchantId;
        }
      }

      const items = await prisma.invoice.findMany({
        where,
        orderBy: [{ createdAt: "desc" }],
        take: 200,
        include: { merchant: { select: { id: true, name: true } } },
      });

      const mapped = items.map(mapInvoiceSummary);

      return res.json({ items: mapped, nextCursor: null });
    } catch (err) {
      return handlePrismaError(err, res);
    }
  });

  router.get("/admin/invoices/:invoiceId", requireBillingStaff, async (req, res) => {
    const invoiceId = parseIntParam(req.params.invoiceId);
    if (!invoiceId) return sendError(res, 400, "VALIDATION_ERROR", "Invalid invoiceId");

    try {
      const inv = await prisma.invoice.findUnique({
        where: { id: invoiceId },
        include: { lineItems: true, payments: true, relatedInvoices: true, merchant: { select: { id: true, name: true } } },
      });

      if (!inv) return sendError(res, 404, "INVOICE_NOT_FOUND", "Invoice not found");

      return res.json({
        invoice: mapInvoiceSummary(inv),
        lineItems: inv.lineItems || [],
        payments: inv.payments || [],
        relatedInvoices: inv.relatedInvoices || [],
      });
    } catch (err) {
      return handlePrismaError(err, res);
    }
  });

  router.get("/admin/invoices/:invoiceId/late-fee-preview", requireBillingStaff, async (req, res) => {
    const invoiceId = parseIntParam(req.params.invoiceId);
    if (!invoiceId) return sendError(res, 400, "VALIDATION_ERROR", "Invalid invoiceId");

    try {
      const inv = await prisma.invoice.findUnique({
        where: { id: invoiceId },
      });

      if (!inv) return sendError(res, 404, "INVOICE_NOT_FOUND", "Invoice not found");

      const now = new Date();
      const dueAt = inv.dueAt ? new Date(inv.dueAt) : null;
      const isLate = !!(dueAt && dueAt < now);

      return res.json({
        invoiceId: inv.id,
        status: inv.status,
        dueAt: toIsoOrNull(inv.dueAt),
        asOf: now.toISOString(),
        isLate,
        lateFeeCents: 0,
        preview: true,
      });
    } catch (err) {
      return handlePrismaError(err, res);
    }
  });

  router.post("/admin/invoices/:invoiceId/issue", requireJwt, requireAdmin, async (req, res) => {
    const invoiceId = parseIntParam(req.params.invoiceId);
    if (!invoiceId) return sendError(res, 400, "VALIDATION_ERROR", "Invalid invoiceId");

    const { netTermsDays } = req.body || {};

    try {
      const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } });
      if (!invoice) return sendError(res, 404, "NOT_FOUND", "Invoice not found");

      if (invoice.status !== "draft")
        return sendError(res, 400, "INVALID_STATE", "Only draft invoices can be issued");

      const terms = Number.isInteger(netTermsDays) ? netTermsDays : invoice.netTermsDays;
      const dueAt = new Date(Date.now() + terms * 24 * 60 * 60 * 1000);

      const updated = await prisma.invoice.update({
        where: { id: invoiceId },
        data: {
          status: "issued",
          issuedAt: new Date(),
          dueAt,
          netTermsDays: terms,
        },
      });

      return res.json({ invoice: updated });
    } catch (err) {
      return handlePrismaError(err, res);
    }
  });

  // GET billing account — pv_admin + pv_ar_clerk
  router.get("/admin/merchants/:merchantId/billing-account", requireJwt, requireBillingStaff, async (req, res) => {
    const merchantId = parseIntParam(req.params.merchantId);
    if (!merchantId) return sendError(res, 400, "VALIDATION_ERROR", "Invalid merchantId");

    try {
      const account = await prisma.billingAccount.findUnique({
        where: { merchantId },
      });
      if (!account) return sendError(res, 404, "NOT_FOUND", "Billing account not found");

      return res.json({ billingAccount: account });
    } catch (err) {
      return handlePrismaError(err, res);
    }
  });

  // PATCH billing account — pv_admin + pv_ar_clerk (pvAccountNumber is admin-only)
  router.patch("/admin/merchants/:merchantId/billing-account", requireJwt, requireBillingStaff, async (req, res) => {
    const merchantId = parseIntParam(req.params.merchantId);
    if (!merchantId) return sendError(res, 400, "VALIDATION_ERROR", "Invalid merchantId");

    const {
      billingName,
      billingEmail,
      billingPhone,
      billingAddress1,
      billingCity,
      billingState,
      billingPostal,
      policyOverridesJson,
      pvAccountNumber,
    } = req.body || {};

    // pvAccountNumber is admin-only
    if (pvAccountNumber !== undefined && req.systemRole !== "pv_admin") {
      return sendError(res, 403, "FORBIDDEN", "Only pv_admin may set pvAccountNumber");
    }

    try {
      const existing = await prisma.billingAccount.findUnique({ where: { merchantId } });
      if (!existing) return sendError(res, 404, "NOT_FOUND", "Billing account not found");

      const data = {};
      if (billingName !== undefined)     data.billingName     = String(billingName).trim() || null;
      if (billingEmail !== undefined)    data.billingEmail    = String(billingEmail).trim().toLowerCase();
      if (billingPhone !== undefined)    data.billingPhone    = String(billingPhone).trim() || null;
      if (billingAddress1 !== undefined) data.billingAddress1 = String(billingAddress1).trim() || null;
      if (billingCity !== undefined)     data.billingCity     = String(billingCity).trim() || null;
      if (billingState !== undefined)    data.billingState    = String(billingState).trim().toUpperCase() || null;
      if (billingPostal !== undefined)   data.billingPostal   = String(billingPostal).trim() || null;
      if (policyOverridesJson !== undefined) data.policyOverridesJson = policyOverridesJson;
      if (pvAccountNumber !== undefined) data.pvAccountNumber = String(pvAccountNumber).trim() || null;

      if (data.billingEmail !== undefined && !data.billingEmail) {
        return sendError(res, 400, "VALIDATION_ERROR", "billingEmail cannot be empty");
      }

      const updated = await prisma.billingAccount.update({
        where: { merchantId },
        data,
      });

      return res.json({ billingAccount: updated });
    } catch (err) {
      return handlePrismaError(err, res);
    }
  });

  router.post("/admin/invoices/:invoiceId/void", requireJwt, requireAdmin, async (req, res) => {
    const invoiceId = parseIntParam(req.params.invoiceId);
    if (!invoiceId) return sendError(res, 400, "VALIDATION_ERROR", "Invalid invoiceId");

    try {
      const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } });
      if (!invoice) return sendError(res, 404, "NOT_FOUND", "Invoice not found");

      if (invoice.status === "paid")
        return sendError(res, 400, "INVALID_STATE", "Paid invoices cannot be voided");

      const updated = await prisma.invoice.update({
        where: { id: invoiceId },
        data: { status: "void" },
      });

      return res.json(updated);
    } catch (err) {
      return handlePrismaError(err, res);
    }
  });

  // ══════════════════════════════════════════════════════════════
  // PV TEAM — Platform user management (pv_admin only)
  // ══════════════════════════════════════════════════════════════

  const PV_SYSTEM_ROLES = ["pv_admin", "support", "pv_ar_clerk", "pv_ap_clerk"];

  // GET /admin/team — list all platform users (non-merchant system roles)
  router.get("/admin/team", requireAdmin, async (req, res) => {
    try {
      const users = await prisma.user.findMany({
        where: { systemRole: { in: PV_SYSTEM_ROLES } },
        select: {
          id: true, email: true, firstName: true, lastName: true,
          phoneRaw: true, systemRole: true, status: true,
          createdAt: true, passwordUpdatedAt: true,
        },
        orderBy: { createdAt: "asc" },
      });
      return res.json({ users });
    } catch (err) {
      return handlePrismaError(err, res);
    }
  });

  // POST /admin/team — create a new platform user
  router.post("/admin/team", requireAdmin, async (req, res) => {
    try {
      const { email, firstName, lastName, phoneRaw, systemRole } = req.body || {};

      if (!email || !String(email).includes("@"))
        return sendError(res, 400, "VALIDATION_ERROR", "Valid email required");
      if (!firstName)
        return sendError(res, 400, "VALIDATION_ERROR", "First name required");
      if (!systemRole || !PV_SYSTEM_ROLES.includes(systemRole))
        return sendError(res, 400, "VALIDATION_ERROR", `systemRole must be one of: ${PV_SYSTEM_ROLES.join(", ")}`);

      // Check email uniqueness
      const existing = await prisma.user.findUnique({ where: { email: email.toLowerCase().trim() } });
      if (existing) return sendError(res, 409, "DUPLICATE_EMAIL", "A user with this email already exists");

      // Generate temp password
      const tempPassword = crypto.randomBytes(8).toString("hex");
      const passwordHash = await bcrypt.hash(tempPassword, 10);

      const user = await prisma.user.create({
        data: {
          email: email.toLowerCase().trim(),
          passwordHash,
          firstName: String(firstName).trim(),
          lastName: lastName ? String(lastName).trim() : null,
          phoneRaw: phoneRaw ? String(phoneRaw).trim() : null,
          systemRole,
        },
        select: {
          id: true, email: true, firstName: true, lastName: true,
          phoneRaw: true, systemRole: true, status: true, createdAt: true,
        },
      });

      console.log(JSON.stringify({
        pvHook: "admin.team.user_created",
        userId: user.id, email: user.email, systemRole,
        ts: new Date().toISOString(),
      }));

      return res.status(201).json({ user, tempPassword });
    } catch (err) {
      return handlePrismaError(err, res);
    }
  });

  // PATCH /admin/team/:userId — update a platform user
  router.patch("/admin/team/:userId", requireAdmin, async (req, res) => {
    try {
      const userId = parseIntParam(req.params.userId);
      if (!userId) return sendError(res, 400, "VALIDATION_ERROR", "Invalid userId");

      const existing = await prisma.user.findUnique({ where: { id: userId } });
      if (!existing) return sendError(res, 404, "NOT_FOUND", "User not found");
      if (!PV_SYSTEM_ROLES.includes(existing.systemRole) && existing.systemRole !== "user")
        return sendError(res, 403, "FORBIDDEN", "Cannot edit non-platform users here");

      const { firstName, lastName, phoneRaw, systemRole, status } = req.body || {};
      const data = {};

      if (firstName !== undefined) data.firstName = String(firstName).trim() || null;
      if (lastName !== undefined) data.lastName = String(lastName).trim() || null;
      if (phoneRaw !== undefined) data.phoneRaw = String(phoneRaw).trim() || null;
      if (systemRole !== undefined) {
        if (!PV_SYSTEM_ROLES.includes(systemRole))
          return sendError(res, 400, "VALIDATION_ERROR", `systemRole must be one of: ${PV_SYSTEM_ROLES.join(", ")}`);
        data.systemRole = systemRole;
      }
      if (status !== undefined) {
        if (!["active", "inactive"].includes(status))
          return sendError(res, 400, "VALIDATION_ERROR", "status must be active or inactive");
        data.status = status;
      }

      if (Object.keys(data).length === 0)
        return sendError(res, 400, "VALIDATION_ERROR", "No fields to update");

      const user = await prisma.user.update({
        where: { id: userId },
        data,
        select: {
          id: true, email: true, firstName: true, lastName: true,
          phoneRaw: true, systemRole: true, status: true, createdAt: true,
        },
      });

      return res.json({ user });
    } catch (err) {
      return handlePrismaError(err, res);
    }
  });

  // POST /admin/team/:userId/reset-password — generate new temp password
  router.post("/admin/team/:userId/reset-password", requireAdmin, async (req, res) => {
    try {
      const userId = parseIntParam(req.params.userId);
      if (!userId) return sendError(res, 400, "VALIDATION_ERROR", "Invalid userId");

      const existing = await prisma.user.findUnique({ where: { id: userId } });
      if (!existing) return sendError(res, 404, "NOT_FOUND", "User not found");

      const tempPassword = crypto.randomBytes(8).toString("hex");
      const passwordHash = await bcrypt.hash(tempPassword, 10);

      await prisma.user.update({
        where: { id: userId },
        data: { passwordHash, tokenVersion: { increment: 1 } },
      });

      return res.json({ tempPassword });
    } catch (err) {
      return handlePrismaError(err, res);
    }
  });

  return router;
}

module.exports = buildAdminRouter;