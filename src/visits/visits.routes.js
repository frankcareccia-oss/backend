const express = require("express");

function buildVisitsRouter(deps) {
  const {
    prisma,
    sendError,
    handlePrismaError,
    loadActiveQrWithStore,
    enforceStoreAndMerchantActive,
    normalizePhone,
    visitsWriteLimiter,
    scanLimiter,
  } = deps;

  const router = express.Router();

  router.post("/visits", visitsWriteLimiter, async (req, res) => {
    const { token, source, metadata } = req.body;

    try {
      if (!token) return sendError(res, 400, "VALIDATION_ERROR", "token is required");

      const allowedSources = ["qr_scan", "manual", "import"];
      const src = source ?? "qr_scan";
      if (!allowedSources.includes(src)) {
        return sendError(res, 400, "VALIDATION_ERROR", `source must be one of: ${allowedSources.join(", ")}`);
      }

      const qr = await loadActiveQrWithStore(token);
      if (!qr) return sendError(res, 404, "QR_NOT_FOUND", "Invalid or inactive QR");

      const gateErr = enforceStoreAndMerchantActive(qr.store);
      if (gateErr) return sendError(res, gateErr.http, gateErr.code, gateErr.message);

      const visit = await prisma.visit.create({
        data: { storeId: qr.storeId, qrId: qr.id, merchantId: qr.store.merchantId, source: src, metadata: metadata ?? undefined },
      });

      return res.json({ visitId: visit.id, store: qr.store });
    } catch (err) {
      return handlePrismaError(err, res);
    }
  });

  router.post("/scan", scanLimiter, async (req, res) => {
    const { token, phone, email, firstName, lastName, metadata } = req.body;

    try {
      if (!token) return sendError(res, 400, "VALIDATION_ERROR", "token is required");

      const qr = await loadActiveQrWithStore(token);
      if (!qr) return sendError(res, 404, "QR_NOT_FOUND", "Invalid or inactive QR");

      const gateErr = enforceStoreAndMerchantActive(qr.store);
      if (gateErr) return sendError(res, gateErr.http, gateErr.code, gateErr.message);

      if (!phone) return sendError(res, 400, "VALIDATION_ERROR", "phone is required");

      const normalized = normalizePhone(phone, "US");
      if (!normalized?.e164) return sendError(res, 400, "VALIDATION_ERROR", "Invalid phone number");

      const consumer = await prisma.consumer.upsert({
        where: { phoneE164: normalized.e164 },
        update: {
          email: email ?? undefined,
          firstName: firstName ?? undefined,
          lastName: lastName ?? undefined,
          phoneRaw: normalized.raw,
          phoneCountry: normalized.country || "US",
        },
        create: {
          email: email || null,
          firstName: firstName || null,
          lastName: lastName || null,
          phoneRaw: normalized.raw,
          phoneE164: normalized.e164,
          phoneCountry: normalized.country || "US",
        },
      });

      const visit = await prisma.visit.create({
        data: { storeId: qr.storeId, qrId: qr.id, consumerId: consumer.id, merchantId: qr.store.merchantId, source: "qr_scan", metadata: metadata ?? undefined },
      });

      return res.json({ store: qr.store, consumerId: consumer.id, visitId: visit.id });
    } catch (err) {
      return handlePrismaError(err, res);
    }
  });

  return router;
}

module.exports = buildVisitsRouter;
