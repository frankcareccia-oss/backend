// backend/src/merchant/merchant.users.routes.js

const express = require("express");

function buildMerchantUsersRouter(deps) {
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
        role
      } = req.body;

      const user = await prisma.$transaction(async (tx) => {
        const created = await tx.user.create({
          data: {
            email,
            firstName,
            lastName,
            phoneRaw,
            phoneE164
          }
        });

        await tx.merchantUser.create({
          data: {
            userId: created.id,
            merchantId,
            role
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
        firstName,
        lastName,
        phoneRaw,
        phoneE164,
        role
      } = req.body;

      const result = await prisma.$transaction(async (tx) => {
        await tx.user.update({
          where: { id: userId },
          data: {
            firstName,
            lastName,
            phoneRaw,
            phoneE164
          }
        });

        if (role) {
          await tx.merchantUser.updateMany({
            where: {
              userId,
              merchantId
            },
            data: { role }
          });
        }
      });

      emitPvHook("merchant.user.updated", {
        merchantId,
        userId
      });

      res.json({ success: true });
    } catch (err) {
      handlePrismaError(res, err);
    }
  });

  return router;
}

module.exports = buildMerchantUsersRouter;