const express = require("express");

function buildDeviceRouter({
  prisma,
  requireJwt,
  sendError,
  handlePrismaError,
  parseIntParam,
  emitPvHook,
  PUBLIC_BASE_URL,
  APP_BASE_URL,
  mailer,
  crypto,
}) {
  const router = express.Router();

  function deviceVerifyBaseUrl() {
    return String(APP_BASE_URL || PUBLIC_BASE_URL || "http://localhost:5173").replace(/\/$/, "");
  }

  function makeVerifyToken() {
    return crypto.randomBytes(24).toString("base64url");
  }

  async function getTrustedDevicesForUser(userId) {
    if (!prisma?.trustedDevice) return [];
    return prisma.trustedDevice.findMany({
      where: { userId },
      orderBy: { updatedAt: "desc" },
      select: {
        id: true,
        userId: true,
        deviceId: true,
        label: true,
        status: true,
        trustedAt: true,
        lastSeenAt: true,
        expiresAt: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  }

  async function findTrustedDevice(userId, deviceId) {
    if (!prisma?.trustedDevice || !deviceId) return null;
    return prisma.trustedDevice.findFirst({
      where: { userId, deviceId },
      orderBy: { updatedAt: "desc" },
    });
  }

  function isTrustedDeviceActive(row) {
    if (!row) return false;
    if (row.status !== "active") return false;
    if (row.expiresAt && new Date(row.expiresAt).getTime() < Date.now()) return false;
    return true;
  }

  router.get("/auth/device/status", requireJwt, async (req, res) => {
    try {
      const deviceId = String(req.get("X-PV-Device-Id") || "").trim();
      if (!deviceId) {
        return res.json({
          ok: true,
          trusted: false,
          deviceIdPresent: false,
          deviceVerificationRequired: true,
        });
      }

      const row = await findTrustedDevice(req.userId, deviceId);
      const trusted = isTrustedDeviceActive(row);

      return res.json({
        ok: true,
        trusted,
        deviceIdPresent: true,
        deviceVerificationRequired: !trusted,
        trustedDevice: row
          ? {
              id: row.id,
              deviceId: row.deviceId,
              label: row.label || null,
              status: row.status,
              trustedAt: row.trustedAt,
              lastSeenAt: row.lastSeenAt,
              expiresAt: row.expiresAt,
            }
          : null,
      });
    } catch (err) {
      return handlePrismaError(err, res);
    }
  });

  router.post("/auth/device/start", requireJwt, async (req, res) => {
    try {
      const deviceId = String(req.get("X-PV-Device-Id") || req.body?.deviceId || "").trim();
      const returnTo = String(req.body?.returnTo || req.query?.returnTo || "").trim();

      if (!deviceId) {
        return sendError(res, 400, "VALIDATION_ERROR", "X-PV-Device-Id is required");
      }

      const user = await prisma.user.findUnique({
        where: { id: req.userId },
        select: {
          id: true,
          email: true,
          systemRole: true,
          status: true,
        },
      });

      if (!user) return sendError(res, 404, "NOT_FOUND", "User not found");
      if (user.status && user.status !== "active") {
        return sendError(res, 403, "FORBIDDEN", "User is not active");
      }

      const existing = await findTrustedDevice(user.id, deviceId);
      if (isTrustedDeviceActive(existing)) {
        return res.json({
          ok: true,
          alreadyTrusted: true,
          trusted: true,
          deviceVerificationRequired: false,
        });
      }

      if (!prisma?.deviceVerifyToken) {
        return sendError(res, 500, "SERVER_MISCONFIG", "Device verification token model is not available");
      }

      const token = makeVerifyToken();
      const expiresAt = new Date(Date.now() + 1000 * 60 * 30); // 30 min

      await prisma.deviceVerifyToken.create({
        data: {
          userId: user.id,
          deviceId,
          token,
          status: "pending",
          expiresAt,
        },
      });

      const verifyUrl = `${deviceVerifyBaseUrl()}/device/verify?token=${encodeURIComponent(token)}${
        returnTo ? `&returnTo=${encodeURIComponent(returnTo)}` : ""
      }`;

      if (mailer?.sendMail && user.email) {
        try {
          await mailer.sendMail({
            to: user.email,
            subject: "Verify your device",
            text: `Open this link to verify your device: ${verifyUrl}`,
            html: `<p>Open this link to verify your device:</p><p><a href="${verifyUrl}">${verifyUrl}</a></p>`,
          });
        } catch (mailErr) {
          console.warn("device verify email failed:", mailErr?.message || mailErr);
        }
      }

      emitPvHook("auth.device.start", {
        tc: "TC-AUTH-DEVICE-START-01",
        sev: "info",
        userId: user.id,
        deviceId,
      });

      return res.json({
        ok: true,
        deviceVerificationRequired: true,
        tokenIssued: true,
        expiresAt,
        verifyUrl, // okay for dev/testing
      });
    } catch (err) {
      return handlePrismaError(err, res);
    }
  });

  router.get("/auth/device/list", requireJwt, async (req, res) => {
    try {
      const rows = await getTrustedDevicesForUser(req.userId);
      return res.json({ ok: true, devices: rows });
    } catch (err) {
      return handlePrismaError(err, res);
    }
  });

  router.post("/auth/device/revoke/:deviceId", requireJwt, async (req, res) => {
    try {
      const deviceId = String(req.params.deviceId || "").trim();
      if (!deviceId) return sendError(res, 400, "VALIDATION_ERROR", "deviceId is required");
      if (!prisma?.trustedDevice) {
        return sendError(res, 500, "SERVER_MISCONFIG", "Trusted device model is not available");
      }

      await prisma.trustedDevice.updateMany({
        where: { userId: req.userId, deviceId, status: "active" },
        data: { status: "revoked" },
      });

      emitPvHook("auth.device.revoked", {
        tc: "TC-AUTH-DEVICE-REVOKE-01",
        sev: "info",
        userId: req.userId,
        deviceId,
      });

      return res.json({ ok: true, revoked: true, deviceId });
    } catch (err) {
      return handlePrismaError(err, res);
    }
  });

  router.get("/auth/device/debug/:userId", async (req, res) => {
    try {
      const userId = parseIntParam(req.params.userId);
      if (!userId) return sendError(res, 400, "VALIDATION_ERROR", "userId must be a valid integer");

      const devices = await getTrustedDevicesForUser(userId);
      const verifyTokens = prisma?.deviceVerifyToken
        ? await prisma.deviceVerifyToken.findMany({
            where: { userId },
            orderBy: { createdAt: "desc" },
            take: 20,
          })
        : [];

      return res.json({
        ok: true,
        userId,
        devices,
        verifyTokens,
      });
    } catch (err) {
      return handlePrismaError(err, res);
    }
  });

  return { router };
}

module.exports = { buildDeviceRouter };