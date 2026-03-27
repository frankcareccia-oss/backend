/**
 * Module: backend/src/merchant/merchant.users.routes.js
 *
 * Merchant Users Router (v1.1 - Zero Admin Guard)
 *
 * Responsibilities:
 *  - GET /merchant/users
 *  - POST /merchant/users
 *  - PATCH /merchant/users/:userId
 *
 * Enhancements:
 *  - 🔒 Enforces Ownership & Billing Authority Contract v1.0
 *  - Prevents orphaned merchant state
 *  - Blocks removal/demotion of last owner/merchant_admin
 *
 * Key Rule Enforced:
 *   A merchant MUST always have ≥1 active user with role ∈ [owner, merchant_admin]
 *
 * Notes:
 *  - Guard applies only when role or status changes
 *  - ap_clerk is NOT considered recovery-capable
 *  - Store-level roles are not considered
 */

const express = require("express");

function buildMerchantUsersRouter(deps) {
  console.log("Merchant Users Route loaded");

  const {
    prisma,
    requireJwt,
    sendError,
    handlePrismaError,
    emitPvHook,
    parseIntParam,
    assertActiveMerchant,
    requireMerchantUserManager
  } = deps;

  const router = express.Router();

  /*
   * GET /merchant/users
   */
  router.get("/", requireJwt, async (req, res) => {
    console.log("GET /merchant/users hit");
    try {
      const merchantId = parseIntParam(req.query.merchantId);
      if (!merchantId) {
        return sendError(res, 400, "VALIDATION_ERROR", "merchantId is required");
      }

      await assertActiveMerchant(req, merchantId);

      const users = await prisma.user.findMany({
        where: {
          merchantUsers: {
            some: { merchantId }
          }
        },
        include: {
          merchantUsers: true
        },
        orderBy: { id: "asc" }
      });

      res.json(users);
    } catch (err) {
      handlePrismaError(res, err);
    }
  });

  /*
   * POST /merchant/users
   */
  router.post("/", requireJwt, async (req, res) => {
    console.log("POST /merchant/users hit");
    try {
      const merchantId = parseIntParam(req.body.merchantId);
      if (!merchantId) {
        return sendError(res, 400, "VALIDATION_ERROR", "merchantId is required");
      }

      const acting = await requireMerchantUserManager(req, res, merchantId);
      if (!acting) return;

      const {
        email,
        firstName,
        lastName,
        phoneRaw,
        phoneE164,
        phoneCountry,
        role,
        status
      } = req.body;

      const normalizedEmail =
        typeof email === "string" ? email.trim().toLowerCase() : email;

      const user = await prisma.$transaction(async (tx) => {
        const created = await tx.user.create({
          data: {
            email: normalizedEmail,
            firstName,
            lastName,
            phoneRaw,
            phoneE164,
            phoneCountry
          }
        });

        await tx.merchantUser.create({
          data: {
            userId: created.id,
            merchantId,
            role,
            ...(status ? { status } : {})
          }
        });

        return created;
      });

      emitPvHook("merchant.user.created", {
        merchantId,
        userId: user.id
      });

      res.json(user);
    } catch (err) {
      handlePrismaError(res, err);
    }
  });

  /*
   * PATCH /merchant/users/:userId
   */
  router.patch("/:userId", requireJwt, async (req, res) => {
    console.log("PATCH route entered for userId:", req.params.userId);
    console.log("PATCH Request Payload:", req.body);

    try {
      const userId = parseIntParam(req.params.userId);
      const merchantId = parseIntParam(req.body.merchantId);

      if (!userId) {
        return sendError(res, 400, "VALIDATION_ERROR", "userId is required");
      }

      if (!merchantId) {
        return sendError(res, 400, "VALIDATION_ERROR", "merchantId is required");
      }

      const acting = await requireMerchantUserManager(req, res, merchantId);
      if (!acting) return;

      const {
        email,
        firstName,
        lastName,
        phoneRaw,
        phoneE164,
        phoneCountry,
        role,
        status
      } = req.body;

      const userData = {};
      if (email !== undefined) {
        userData.email =
          typeof email === "string" ? email.trim().toLowerCase() : email;
      }
      if (firstName !== undefined) userData.firstName = firstName;
      if (lastName !== undefined) userData.lastName = lastName;
      if (phoneRaw !== undefined) userData.phoneRaw = phoneRaw;
      if (phoneE164 !== undefined) userData.phoneE164 = phoneE164;
      if (phoneCountry !== undefined) userData.phoneCountry = phoneCountry;

      const membershipData = {};
      if (role !== undefined) membershipData.role = role;
      if (status !== undefined) membershipData.status = status;

      await prisma.$transaction(async (tx) => {

        // 🔒 ZERO-ADMIN GUARD
        if (role !== undefined || status !== undefined) {
          const currentMembership = await tx.merchantUser.findFirst({
            where: { userId, merchantId }
          });

          if (currentMembership) {
            const currentRole = currentMembership.role;
            const nextRole = role !== undefined ? role : currentRole;

            const currentStatus = currentMembership.status || "active";
            const nextStatus = status !== undefined ? status : currentStatus;

            const isCurrentlyAdmin =
              currentRole === "owner" || currentRole === "merchant_admin";

            const willRemainAdmin =
              (nextRole === "owner" || nextRole === "merchant_admin") &&
              nextStatus === "active";

            if (isCurrentlyAdmin && !willRemainAdmin) {
              const otherAdmins = await tx.merchantUser.count({
                where: {
                  merchantId,
                  userId: { not: userId },
                  role: { in: ["owner", "merchant_admin"] },
                  status: "active"
                }
              });

              if (otherAdmins === 0) {
                return sendError(
                  res,
                  400,
                  "INVALID_OPERATION",
                  "Cannot remove or demote the last merchant owner/admin."
                );
              }
            }
          }
        }

        // Apply updates
        if (Object.keys(userData).length > 0) {
          await tx.user.update({
            where: { id: userId },
            data: userData
          });
        }

        if (Object.keys(membershipData).length > 0) {
          await tx.merchantUser.updateMany({
            where: { userId, merchantId },
            data: membershipData
          });
        }
      });

      const membership = await prisma.merchantUser.findFirst({
        where: { userId, merchantId }
      });

      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          email: true,
          status: true,
          firstName: true,
          lastName: true,
          phoneRaw: true,
          phoneCountry: true,
          phoneE164: true
        }
      });

      emitPvHook("merchant.user.updated", {
        merchantId,
        userId
      });

      res.json({
        ok: true,
        userId,
        merchantId,
        membership,
        user
      });

    } catch (err) {
      handlePrismaError(res, err);
    }
  });

  return router;
}

module.exports = buildMerchantUsersRouter;