// src/auth/auth.routes.js — PerkValet Auth Surface (login, password, device trust, /me)

const { sendMail } = require("../utils/mail");

const express = require("express");

function buildAuthRouter(deps) {
  const router = express.Router();

  const {
    prisma,
    sendError,
    handlePrismaError,
    emitPvHook,
    requireJwt,
    jwt,
    JWT_SECRET,
    JWT_EXPIRES_IN,
    bcrypt,
    crypto,
    sha256Hex,
    buildResetUrl,
  } = deps;

  /* -----------------------------
     Login
  -------------------------------- */

  router.post("/auth/login", async (req, res) => {
    try {
      const { email, password } = req.body || {};
      const emailNorm = String(email || "").trim().toLowerCase();
      const passwordRaw = String(password || "");

      if (!emailNorm || !passwordRaw) {
        return sendError(res, 400, "VALIDATION_ERROR", "email and password are required");
      }

      const users = await prisma.user.findMany({
        where: { email: emailNorm },
        take: 1,
      });

      const user = Array.isArray(users) && users.length ? users[0] : null;

      if (!user) return sendError(res, 401, "UNAUTHORIZED", "Invalid credentials");
      if (user.status && user.status !== "active") return sendError(res, 403, "FORBIDDEN", "User is not active");

      const ok = await bcrypt.compare(passwordRaw, user.passwordHash);
      if (!ok) return sendError(res, 401, "UNAUTHORIZED", "Invalid credentials");

      const accessToken = jwt.sign(
        { userId: user.id, tokenVersion: user.tokenVersion ?? 0 },
        JWT_SECRET,
        { expiresIn: JWT_EXPIRES_IN }
      );

      const landing = user.systemRole === "pv_admin" ? "/admin" : "/merchant";

      return res.json({
        accessToken,
        systemRole: user.systemRole,
        landing,
      });

    } catch (err) {
      return handlePrismaError(err, res);
    }
  });

  /* -----------------------------
     Device Trust Status
  -------------------------------- */

  router.get("/auth/device/status", requireJwt, async (req, res) => {
    try {
      const deviceId = String(req.get("x-pv-device-id") || "").trim();
      const deviceIdShort = deviceId ? `${deviceId.slice(0, 8)}…` : null;

      emitPvHook("auth.device.status", {
        stable: "auth:device_status",
        ok: true,
        trusted: true,
        deviceIdShort,
        userId: req.user?.id ?? null,
        systemRole: req.user?.systemRole ?? null,
      });

      return res.json({
        ok: true,
        trusted: true,
        requiresDeviceVerification: false,
        deviceIdShort,
      });

    } catch (err) {

      emitPvHook("auth.device.status_error", {
        stable: "auth:device_status",
        ok: false,
        message: String(err?.message || err),
      });

      return sendError(res, 500, "INTERNAL_ERROR", "Device status failed");
    }
  });

  /* -----------------------------
     Forgot Password
  -------------------------------- */

  router.post("/auth/forgot-password", async (req, res) => {
    try {
      const { email } = req.body || {};
      const emailNorm = String(email || "").trim().toLowerCase();

      if (!emailNorm) {
        return sendError(res, 400, "VALIDATION_ERROR", "email is required");
      }

      const user = await prisma.user.findUnique({
        where: { email: emailNorm },
        select: { id: true, status: true },
      });

      const genericOk = {
        ok: true,
        message: "If an account exists, a reset email has been sent.",
      };

      if (!user) return res.json(genericOk);
      if (user.status && user.status !== "active") return res.json(genericOk);

      const token = crypto.randomBytes(32).toString("hex");

      const pepper = process.env.RESET_TOKEN_PEPPER || JWT_SECRET;
      const tokenHash = sha256Hex(`${pepper}:${token}`);

      const minutes = Number(process.env.RESET_TOKEN_MINUTES || 45);
      const expiresAt = new Date(Date.now() + minutes * 60 * 1000);

      await prisma.passwordResetToken.create({
        data: {
          userId: user.id,
          tokenHash,
          expiresAt,
        },
      });

      const resetUrl = buildResetUrl(req, token);

      await sendMail({
        to: emailNorm,
        subject: "Reset your PerkValet password",
        text: `You requested a password reset.

Click the link below to set a new password:

${resetUrl}

This link expires at ${expiresAt.toISOString()}.

If you did not request this, you can ignore this email.`,
      });

      return res.json(genericOk);

    } catch (err) {
      return handlePrismaError(err, res);
    }
  });

  /* -----------------------------
     Reset Password
  -------------------------------- */

  router.post("/auth/reset-password", async (req, res) => {
    try {
      const { token, newPassword } = req.body || {};

      const tokenRaw = String(token || "").trim();
      const pw = String(newPassword || "");

      if (!tokenRaw || !pw) {
        return sendError(res, 400, "VALIDATION_ERROR", "token and newPassword are required");
      }

      if (pw.length < 10) {
        return sendError(res, 400, "VALIDATION_ERROR", "Password must be at least 10 characters");
      }

      const pepper = process.env.RESET_TOKEN_PEPPER || JWT_SECRET;
      const tokenHash = sha256Hex(`${pepper}:${tokenRaw}`);

      const prt = await prisma.passwordResetToken.findUnique({
        where: { tokenHash },
        include: { user: { select: { id: true, status: true } } },
      });

      if (!prt) return sendError(res, 400, "INVALID_TOKEN", "Invalid or expired token");
      if (prt.usedAt) return sendError(res, 400, "INVALID_TOKEN", "Invalid or expired token");

      if (new Date(prt.expiresAt).getTime() < Date.now()) {
        return sendError(res, 400, "INVALID_TOKEN", "Invalid or expired token");
      }

      if (prt.user?.status && prt.user.status !== "active") {
        return sendError(res, 403, "FORBIDDEN", "User is not active");
      }

      const passwordHash = await bcrypt.hash(pw, 12);
      const now = new Date();

      await prisma.$transaction(async (tx) => {

        await tx.user.update({
          where: { id: prt.userId },
          data: {
            passwordHash,
            passwordUpdatedAt: now,
            tokenVersion: { increment: 1 },
          },
        });

        await tx.passwordResetToken.update({
          where: { id: prt.id },
          data: { usedAt: now },
        });

      });

      return res.json({ ok: true });

    } catch (err) {
      return handlePrismaError(err, res);
    }
  });

  /* -----------------------------
     Change Password
  -------------------------------- */

  router.post("/auth/change-password", requireJwt, async (req, res) => {

    try {

      const { currentPassword, newPassword } = req.body || {};

      const cur = String(currentPassword || "");
      const nextPw = String(newPassword || "");

      if (!cur || !nextPw) {
        return sendError(res, 400, "VALIDATION_ERROR", "currentPassword and newPassword are required");
      }

      if (nextPw.length < 10) {
        return sendError(res, 400, "VALIDATION_ERROR", "Password must be at least 10 characters");
      }

      const user = await prisma.user.findUnique({
        where: { id: req.userId },
        select: { id: true, passwordHash: true, status: true },
      });

      if (!user) return sendError(res, 404, "NOT_FOUND", "User not found");
      if (user.status && user.status !== "active") return sendError(res, 403, "FORBIDDEN", "User is not active");

      const ok = await bcrypt.compare(cur, user.passwordHash);

      if (!ok) return sendError(res, 401, "UNAUTHORIZED", "Invalid current password");

      const passwordHash = await bcrypt.hash(nextPw, 12);

      const now = new Date();

      await prisma.user.update({
        where: { id: user.id },
        data: {
          passwordHash,
          passwordUpdatedAt: now,
          tokenVersion: { increment: 1 },
        },
      });

      return res.json({ ok: true });

    } catch (err) {
      return handlePrismaError(err, res);
    }

  });

  /* -----------------------------
     Current User
  -------------------------------- */

  router.get("/me", requireJwt, async (req, res) => {

    try {

      const user = await prisma.user.findUnique({
        where: { id: req.userId },
        select: {
          id: true,
          email: true,
          systemRole: true,
          status: true,
          merchantUsers: {
            select: {
              merchantId: true,
              role: true,
              status: true,
              merchant: {
                select: {
                  id: true,
                  name: true,
                  merchantType: true,
                },
              },
            },
          },
        },
      });

      if (!user) return sendError(res, 404, "NOT_FOUND", "User not found");

      const landing = user.systemRole === "pv_admin" ? "/admin" : "/merchant";

      const merchantName =
        Array.isArray(user.merchantUsers) && user.merchantUsers.length
          ? user.merchantUsers[0]?.merchant?.name || null
          : null;

      return res.json({
        user,
        memberships: user.merchantUsers,
        merchantName,
        landing,
      });

    } catch (err) {
      return handlePrismaError(err, res);
    }

  });

  return router;
}

module.exports = buildAuthRouter;