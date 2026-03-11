const express = require("express");
const QRCode = require("qrcode");

function buildStoreRouter(deps) {
  const {
    prisma,
    sendError,
    handlePrismaError,
    parseIntParam,
    crypto,
    enforceStoreAndMerchantActive,
  } = deps;

  const router = express.Router();

  /* -----------------------------
     Public QR PNG
  -------------------------------- */

  router.get("/stores/:storeId/qr.png", async (req, res) => {
    const storeId = parseIntParam(req.params.storeId);
    if (!storeId) return sendError(res, 400, "VALIDATION_ERROR", "Invalid storeId");

    try {
      const activeQr = await prisma.storeQr.findFirst({
        where: { storeId, status: "active" },
        orderBy: { createdAt: "desc" },
        include: { store: true },
      });
      if (!activeQr) return sendError(res, 404, "QR_NOT_FOUND", "No active QR for this store");

      const payload = `pv:store:${activeQr.token}`;
      const pngBuffer = await QRCode.toBuffer(payload, {
        type: "png",
        errorCorrectionLevel: "M",
        margin: 2,
        scale: 8,
      });

      res.setHeader("Content-Type", "image/png");
      res.setHeader("Content-Disposition", `inline; filename="store-${storeId}-qr.png"`);
      res.setHeader("Cache-Control", "no-store");
      return res.send(pngBuffer);
    } catch (err) {
      return sendError(res, 500, "INTERNAL_ERROR", err?.message || "Failed to generate QR PNG");
    }
  });

  router.get("/stores/:storeId", async (req, res) => {
    const storeId = parseIntParam(req.params.storeId);
    if (!storeId) return sendError(res, 400, "VALIDATION_ERROR", "Invalid storeId");

    try {
      const store = await prisma.store.findUnique({
        where: { id: storeId },
        include: { merchant: true },
      });
      if (!store) return sendError(res, 404, "STORE_NOT_FOUND", "Store not found");
      return res.json(store);
    } catch (err) {
      return handlePrismaError(err, res);
    }
  });

  router.get("/stores/:storeId/qrs", async (req, res) => {
    const storeId = parseIntParam(req.params.storeId);
    if (!storeId) return sendError(res, 400, "VALIDATION_ERROR", "Invalid storeId");

    try {
      const qrs = await prisma.storeQr.findMany({
        where: { storeId },
        orderBy: { createdAt: "desc" },
      });
      return res.json(qrs);
    } catch (err) {
      return handlePrismaError(err, res);
    }
  });

  router.post("/stores/:storeId/qrs", async (req, res) => {
    const storeId = parseIntParam(req.params.storeId);
    if (!storeId) return sendError(res, 400, "VALIDATION_ERROR", "Invalid storeId");

    try {
      const now = new Date();

      const result = await prisma.$transaction(async (tx) => {
        const store = await tx.store.findUnique({
          where: { id: storeId },
          include: { merchant: true },
        });

        const gateErr = enforceStoreAndMerchantActive(store);
        if (gateErr) return { error: gateErr };

        await tx.storeQr.updateMany({
          where: { storeId, status: "active" },
          data: { status: "archived", updatedAt: now },
        });

        const token = crypto.randomBytes(16).toString("hex");

        const qr = await tx.storeQr.create({
          data: { storeId, merchantId: store.merchantId, token, status: "active", updatedAt: now },
        });

        return { qr };
      });

      if (result?.error) return sendError(res, result.error.http, result.error.code, result.error.message);

      const { qr } = result;
      return res.json({ ...qr, payload: `pv:store:${qr.token}`, pngUrl: `/stores/${storeId}/qr.png` });
    } catch (err) {
      return handlePrismaError(err, res);
    }
  });

  return router;
}

module.exports = buildStoreRouter;