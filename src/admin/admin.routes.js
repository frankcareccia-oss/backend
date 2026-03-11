// src/admin/admin.routes.js — PerkValet Admin Surface (pv_admin operations)

const express = require("express");

function buildAdminRouter(deps) {
  const {
    prisma,
    requireAdmin,
    sendError,
    handlePrismaError,
    parseIntParam,
    BILLING_POLICY,
    validateBillingPolicy,
    saveBillingPolicyToDisk,
    validateOverrides,
    getMerchantPolicyBundle,
    lateFeeEligibility,
    findExistingLateFeeInvoice
  } = deps;

  const router = express.Router();

  /* =========================================================
     ADMIN MERCHANT STORES
     ========================================================= */

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
        where: { id: merchantId }
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
          status: "active"
        }
      });

      return res.status(201).json(store);

    } catch (err) {
      return handlePrismaError(err, res);
    }
  });

  /* =========================================================
     BILLING POLICY (GLOBAL)
     ========================================================= */

  router.get("/admin/billing-policy", requireAdmin, (_req, res) => {
    res.json(BILLING_POLICY);
  });

  router.put("/admin/billing-policy", requireAdmin, (req, res) => {
    const v = validateBillingPolicy(req.body || {});
    if (!v.ok) return sendError(res, 400, "VALIDATION_ERROR", v.msg);

    // Preserve shared object reference from index.js
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

  /* =========================================================
     ADMIN INVOICE LIST
     ========================================================= */

  router.get("/admin/invoices", requireAdmin, async (req, res) => {
    try {
      const { status, merchantId } = req.query;

      const where = {};

      if (status) where.status = status;
      if (merchantId) where.merchantId = Number(merchantId);

      const items = await prisma.invoice.findMany({
        where,
        orderBy: { id: "desc" },
        take: 100
      });

      res.json({ items });

    } catch (err) {
      console.error(err);
      sendError(res, 500, "INTERNAL_ERROR", "Failed to list invoices");
    }
  });

  /* =========================================================
     ADMIN INVOICE DETAIL
     ========================================================= */

  router.get("/admin/invoices/:invoiceId", requireAdmin, async (req, res) => {
    const invoiceId = Number(req.params.invoiceId);

    if (!Number.isInteger(invoiceId)) {
      return sendError(res, 400, "VALIDATION_ERROR", "Invalid invoiceId");
    }

    try {
      const invoice = await prisma.invoice.findUnique({
        where: { id: invoiceId },
        include: {
          lineItems: true,
          payments: true
        }
      });

      if (!invoice) {
        return sendError(res, 404, "NOT_FOUND", "Invoice not found");
      }

      res.json({
        invoice,
        lineItems: invoice.lineItems,
        payments: invoice.payments
      });

    } catch (err) {
      console.error(err);
      sendError(res, 500, "INTERNAL_ERROR", "Failed to load invoice");
    }
  });

  /* =========================================================
     ISSUE INVOICE
     ========================================================= */

  router.post("/admin/invoices/:invoiceId/issue", requireAdmin, async (req, res) => {
    const invoiceId = Number(req.params.invoiceId);
    const { netTermsDays } = req.body || {};

    if (!Number.isInteger(invoiceId)) {
      return sendError(res, 400, "VALIDATION_ERROR", "Invalid invoiceId");
    }

    try {
      const invoice = await prisma.invoice.findUnique({
        where: { id: invoiceId }
      });

      if (!invoice) {
        return sendError(res, 404, "NOT_FOUND", "Invoice not found");
      }

      if (invoice.status !== "draft") {
        return sendError(res, 400, "INVALID_STATE", "Only draft invoices can be issued");
      }

      const terms = Number.isInteger(netTermsDays)
        ? netTermsDays
        : invoice.netTermsDays;

      const dueAt = new Date(Date.now() + terms * 24 * 60 * 60 * 1000);

      const updated = await prisma.invoice.update({
        where: { id: invoiceId },
        data: {
          status: "issued",
          issuedAt: new Date(),
          dueAt,
          netTermsDays: terms
        }
      });

      res.json({ invoice: updated });

    } catch (err) {
      console.error(err);
      sendError(res, 500, "INTERNAL_ERROR", "Failed to issue invoice");
    }
  });

  /* =========================================================
     VOID INVOICE
     ========================================================= */

  router.post("/admin/invoices/:invoiceId/void", requireAdmin, async (req, res) => {
    const invoiceId = Number(req.params.invoiceId);

    if (!Number.isInteger(invoiceId)) {
      return sendError(res, 400, "VALIDATION_ERROR", "Invalid invoiceId");
    }

    try {
      const invoice = await prisma.invoice.findUnique({
        where: { id: invoiceId }
      });

      if (!invoice) {
        return sendError(res, 404, "NOT_FOUND", "Invoice not found");
      }

      if (invoice.status === "paid") {
        return sendError(res, 400, "INVALID_STATE", "Paid invoices cannot be voided");
      }

      const updated = await prisma.invoice.update({
        where: { id: invoiceId },
        data: { status: "void" }
      });

      res.json(updated);

    } catch (err) {
      console.error(err);
      sendError(res, 500, "INTERNAL_ERROR", "Failed to void invoice");
    }
  });

  /* =========================================================
     MERCHANT BILLING POLICY
     ========================================================= */

  router.get("/admin/merchants/:merchantId/billing-policy", requireAdmin, async (req, res) => {
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
        effective: bundle.effective
      });

    } catch (err) {
      return handlePrismaError(err, res);
    }
  });

  /* =========================================================
     ADMIN MERCHANT USERS
     ========================================================= */

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
              phoneE164: true
            }
          }
        },
        orderBy: { id: "asc" }
      });

      const result = users.map(mu => ({
        merchantUserId: mu.id,
        role: mu.role,
        status: mu.status,
        userId: mu.user.id,
        email: mu.user.email,
        firstName: mu.user.firstName,
        lastName: mu.user.lastName,
        phone: mu.user.phoneE164
      }));

      res.json({ ok: true, users: result });

    } catch (err) {
      return handlePrismaError(err, res);
    }
  });

  return router;
}

module.exports = buildAdminRouter;