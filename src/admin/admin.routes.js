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
    sendError,
    handlePrismaError,
    parseIntParam,
    BILLING_POLICY,
    validateBillingPolicy,
    saveBillingPolicyToDisk,
    getMerchantPolicyBundle,
  } = deps;

  const router = express.Router();

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

  router.get("/admin/billing-policy", requireAdmin, (_req, res) => {
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

      if (String(currentMembership.role || "").toLowerCase() !== "merchant_admin") {
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
                role: "merchant_admin",
                status: "active",
                statusReason: null,
              },
            })
          : await tx.merchantUser.create({
              data: {
                merchantId,
                userId: newUser.id,
                role: "merchant_admin",
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

  return router;
}

module.exports = buildAdminRouter;