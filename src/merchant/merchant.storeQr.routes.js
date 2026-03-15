// src/merchant/merchant.storeQr.routes.js

const express = require("express");

function buildMerchantStoreQrRouter({
  prisma,
  requireJwt,
  sendError,
  handlePrismaError,
  parseIntParam,
  crypto,
  QRCode,
  emitPvHook,
  isPosOnlyMerchantUser,
  publicBaseUrl,
}) {
  const router = express.Router();

  function resolveQrModel() {
    const candidates = ["qrCode", "storeQrCode", "storeQr", "qrToken"];
    for (const key of candidates) {
      if (prisma && prisma[key]) return prisma[key];
    }
    return null;
  }

  function buildScanUrl(token) {
    const base = String(publicBaseUrl || process.env.PUBLIC_BASE_URL || "http://localhost:3001").replace(/\/$/, "");
    return `${base}/scan/${encodeURIComponent(token)}`;
  }

  function makeQrToken() {
    return `pv_${crypto.randomBytes(18).toString("base64url")}`;
  }

  function canGenerateQrForMerchant(user, merchantId) {
    const memberships = Array.isArray(user?.merchantUsers) ? user.merchantUsers : [];
    const allowedRoles = new Set(["owner", "merchant_admin", "store_admin"]);
    return memberships.some(
      (m) => m && m.status === "active" && m.merchantId === merchantId && allowedRoles.has(String(m.role || ""))
    );
  }

  router.post("/merchant/stores/:storeId/qr/generate", requireJwt, async (req, res) => {
    try {
      const storeId = parseIntParam(req.params.storeId);
      if (!storeId) return sendError(res, 400, "VALIDATION_ERROR", "storeId must be a valid integer");

      const qrModel = resolveQrModel();
      if (!qrModel) {
        return sendError(
          res,
          500,
          "SERVER_MISCONFIG",
          "No QR Prisma model found. Expected one of: qrCode, storeQrCode, storeQr, qrToken"
        );
      }

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

      if (!user) return sendError(res, 404, "NOT_FOUND", "User not found");
      if (user.systemRole === "pv_admin") {
        return sendError(res, 403, "FORBIDDEN", "pv_admin does not use merchant QR generation");
      }
      if (typeof isPosOnlyMerchantUser === "function" && isPosOnlyMerchantUser(user)) {
        return sendError(res, 403, "FORBIDDEN", "POS associates cannot generate store QR codes");
      }

      const store = await prisma.store.findUnique({
        where: { id: storeId },
        select: {
          id: true,
          name: true,
          status: true,
          merchantId: true,
          merchant: {
            select: { id: true, name: true, status: true },
          },
        },
      });

      if (!store) return sendError(res, 404, "NOT_FOUND", "Store not found");
      if (store.status && store.status !== "active") {
        return sendError(res, 409, "STORE_NOT_ACTIVE", `Store is ${store.status}`);
      }
      if (store.merchant?.status && store.merchant.status !== "active") {
        return sendError(res, 409, "MERCHANT_NOT_ACTIVE", `Merchant is ${store.merchant.status}`);
      }
      if (!canGenerateQrForMerchant(user, store.merchantId)) {
        return sendError(res, 403, "FORBIDDEN", "Not authorized to generate QR for this store");
      }

      const qrToken = makeQrToken();

      await prisma.$transaction(async (tx) => {
        const txQrModel = resolveQrModel() || qrModel;

        await txQrModel.updateMany({
          where: { storeId, status: "active" },
          data: { status: "archived" },
        });

        await txQrModel.create({
          data: {
            storeId,
            merchantId: store.merchantId,
            token: qrToken,
            status: "active",
          },
        });
      });

      const qrUrl = buildScanUrl(qrToken);
      const qrImageDataUrl = await QRCode.toDataURL(qrUrl);

      if (typeof emitPvHook === "function") {
        emitPvHook("merchant.store.qr.generated", {
          sev: "info",
          stable: "merchant:store_qr_generate",
          userId: req.userId,
          merchantId: store.merchantId,
          storeId: store.id,
        });
      }

      return res.json({
        ok: true,
        merchantId: store.merchantId,
        merchantName: store.merchant?.name || null,
        storeId: store.id,
        storeName: store.name || null,
        qrToken,
        qrUrl,
        qrImageDataUrl,
        status: "active",
      });
    } catch (err) {
      return handlePrismaError(err, res);
    }
  });

  return router;
}

module.exports = { buildMerchantStoreQrRouter };
