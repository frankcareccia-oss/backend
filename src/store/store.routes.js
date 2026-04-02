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
    requireJwt,
    requireAdmin,
    publicBaseUrl,
  } = deps;

  const router = express.Router();

  /* -----------------------------
     Admin: Create Store
  -------------------------------- */

  router.patch("/stores/:storeId", requireJwt, requireAdmin, async (req, res) => {
    const storeId = parseIntParam(req.params.storeId);
    if (!storeId) return sendError(res, 400, "VALIDATION_ERROR", "Invalid storeId");

    const { name, address1, city, state, postal, status, statusReason } = req.body || {};

    // Determine what kind of patch this is
    const isProfilePatch = name !== undefined || address1 !== undefined || city !== undefined || state !== undefined || postal !== undefined;
    const isStatusPatch = status !== undefined;

    if (!isProfilePatch && !isStatusPatch) {
      return sendError(res, 400, "VALIDATION_ERROR", "No fields to update");
    }

    if (isProfilePatch) {
      if (!name || !String(name).trim()) return sendError(res, 400, "VALIDATION_ERROR", "name is required");
      if (!address1 || !String(address1).trim()) return sendError(res, 400, "VALIDATION_ERROR", "address is required");
      if (!city || !String(city).trim()) return sendError(res, 400, "VALIDATION_ERROR", "city is required");
      if (!state || !String(state).trim()) return sendError(res, 400, "VALIDATION_ERROR", "state is required");
    }

    const VALID_STORE_STATUSES = ["active", "suspended", "archived"];
    if (isStatusPatch && !VALID_STORE_STATUSES.includes(status)) {
      return sendError(res, 400, "VALIDATION_ERROR", `status must be one of: ${VALID_STORE_STATUSES.join(", ")}`);
    }

    try {
      const existing = await prisma.store.findUnique({ where: { id: storeId } });
      if (!existing) return sendError(res, 404, "NOT_FOUND", "Store not found");

      const data = {};
      if (isProfilePatch) {
        data.name = String(name).trim();
        data.address1 = String(address1).trim();
        data.city = String(city).trim();
        data.state = String(state).trim().toUpperCase();
        data.postal = postal ? String(postal).trim() : null;
      }
      if (isStatusPatch) {
        data.status = status;
        data.statusReason = statusReason ?? null;
      }

      const updated = await prisma.store.update({
        where: { id: storeId },
        data,
        include: { merchant: true },
      });

      return res.json(updated);
    } catch (err) {
      return handlePrismaError(err, res);
    }
  });

  router.post("/stores", requireJwt, requireAdmin, async (req, res) => {
    const { merchantId, name, address1, city, state, postal } = req.body || {};

    const mid = parseIntParam(merchantId);
    if (!mid) return sendError(res, 400, "VALIDATION_ERROR", "merchantId is required");
    if (!name || !String(name).trim()) return sendError(res, 400, "VALIDATION_ERROR", "name is required");
    if (!address1 || !String(address1).trim()) return sendError(res, 400, "VALIDATION_ERROR", "address is required");
    if (!city || !String(city).trim()) return sendError(res, 400, "VALIDATION_ERROR", "city is required");
    if (!state || !String(state).trim()) return sendError(res, 400, "VALIDATION_ERROR", "state is required");

    try {
      const merchant = await prisma.merchant.findUnique({ where: { id: mid } });
      if (!merchant) return sendError(res, 404, "NOT_FOUND", "Merchant not found");
      if (merchant.status !== "active") {
        return sendError(res, 409, "INVALID_STATE", `Merchant is ${merchant.status}`);
      }

      const store = await prisma.store.create({
        data: {
          merchantId: mid,
          name: String(name).trim(),
          address1: String(address1).trim(),
          city: String(city).trim(),
          state: String(state).trim().toUpperCase(),
          postal: postal ? String(postal).trim() : null,
          status: "active",
          phoneRaw: "",
          phoneCountry: "US",
        },
      });

      return res.status(201).json(store);
    } catch (err) {
      return handlePrismaError(err, res);
    }
  });

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

      const base = String(publicBaseUrl || process.env.PUBLIC_BASE_URL || "http://localhost:5175").replace(/\/$/, "");
      const payload = `${base}/scan/${activeQr.token}`;
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

  /* -----------------------------
     Admin: Store Team
  -------------------------------- */

  router.get("/stores/:storeId/team", requireJwt, requireAdmin, async (req, res) => {
    const storeId = parseIntParam(req.params.storeId);
    if (!storeId) return sendError(res, 400, "VALIDATION_ERROR", "Invalid storeId");

    try {
      const store = await prisma.store.findUnique({
        where: { id: storeId },
        select: { id: true, merchantId: true },
      });
      if (!store) return sendError(res, 404, "NOT_FOUND", "Store not found");

      const storeUsers = await prisma.storeUser.findMany({
        where: { storeId, status: "active" },
        include: {
          merchantUser: {
            include: {
              user: {
                select: {
                  id: true,
                  email: true,
                  firstName: true,
                  lastName: true,
                },
              },
            },
          },
        },
        orderBy: { id: "asc" },
      });

      return res.json({
        storeId: store.id,
        merchantId: store.merchantId,
        team: storeUsers.map((su) => ({
          storeUserId: su.id,
          merchantUserId: su.merchantUserId,
          userId: su.merchantUser?.user?.id || null,
          email: su.merchantUser?.user?.email || null,
          firstName: su.merchantUser?.user?.firstName || null,
          lastName: su.merchantUser?.user?.lastName || null,
          role: su.merchantUser?.role || null,
          permissionLevel: su.permissionLevel,
          status: su.status,
        })),
      });
    } catch (err) {
      return handlePrismaError(err, res);
    }
  });

  router.post("/stores/:storeId/team/assign", requireJwt, requireAdmin, async (req, res) => {
    const storeId = parseIntParam(req.params.storeId);
    if (!storeId) return sendError(res, 400, "VALIDATION_ERROR", "Invalid storeId");

    const merchantUserId = parseIntParam(req.body?.merchantUserId);
    if (!merchantUserId) return sendError(res, 400, "VALIDATION_ERROR", "merchantUserId is required");

    const VALID_LEVELS = ["store_admin", "store_subadmin", "pos_access"];
    const permissionLevel = String(req.body?.permissionLevel || "").trim();
    if (!VALID_LEVELS.includes(permissionLevel)) {
      return sendError(res, 400, "VALIDATION_ERROR", "permissionLevel must be store_admin, store_subadmin, or pos_access");
    }

    try {
      const store = await prisma.store.findUnique({ where: { id: storeId }, select: { id: true, merchantId: true } });
      if (!store) return sendError(res, 404, "NOT_FOUND", "Store not found");

      const mu = await prisma.merchantUser.findFirst({
        where: { id: merchantUserId, merchantId: store.merchantId, status: "active" },
        select: { id: true },
      });
      if (!mu) return sendError(res, 404, "NOT_FOUND", "Merchant user not found for this store's merchant");

      const su = await prisma.storeUser.upsert({
        where: { storeId_merchantUserId: { storeId, merchantUserId } },
        update: { permissionLevel, status: "active" },
        create: { storeId, merchantUserId, permissionLevel, status: "active" },
        select: { id: true, storeId: true, merchantUserId: true, permissionLevel: true, status: true },
      });

      return res.json({ ok: true, storeUser: su });
    } catch (err) {
      return handlePrismaError(err, res);
    }
  });

  router.delete("/stores/team/:storeUserId", requireJwt, requireAdmin, async (req, res) => {
    const storeUserId = parseIntParam(req.params.storeUserId);
    if (!storeUserId) return sendError(res, 400, "VALIDATION_ERROR", "Invalid storeUserId");

    try {
      const existing = await prisma.storeUser.findUnique({
        where: { id: storeUserId },
        select: { id: true, storeId: true },
      });
      if (!existing) return sendError(res, 404, "NOT_FOUND", "Store team member not found");

      await prisma.storeUser.delete({ where: { id: storeUserId } });

      return res.json({ ok: true, storeUserId });
    } catch (err) {
      return handlePrismaError(err, res);
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