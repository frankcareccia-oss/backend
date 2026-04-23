// src/consumer/consumer.auth.routes.js
//
// Consumer OTP authentication
//   POST /consumer/auth/otp/start   — send 6-digit code via SMS
//   POST /consumer/auth/otp/verify  — validate code → issue consumer JWT

"use strict";

const express = require("express");
const jwt = require("jsonwebtoken");
const { prisma } = require("../db/prisma");
const { sendError } = require("../utils/errors");
const { sendSms } = require("../utils/sms");
const { normalizePhone } = require("../../utils/phone");

const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-me";
const OTP_LENGTH = 6;

// Read a platform config value from DB; fall back to provided default if missing.
async function getPlatformConfig(key, defaultValue) {
  try {
    const row = await prisma.platformConfig.findUnique({ where: { key } });
    return row ? row.value : defaultValue;
  } catch {
    return defaultValue;
  }
}

function generateCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

// ──────────────────────────────────────────────
// POST /consumer/auth/otp/start
// Body: { phone }
// ──────────────────────────────────────────────
router.post("/consumer/auth/otp/start", async (req, res) => {
  try {
    const { phone } = req.body || {};
    if (!phone) return sendError(res, 400, "VALIDATION_ERROR", "phone is required");

    let normalized;
    try {
      normalized = normalizePhone(phone);
    } catch {
      return sendError(res, 400, "VALIDATION_ERROR", "Invalid phone number");
    }

    const otpMinutes = parseInt(await getPlatformConfig("consumer_otp_ttl_minutes", "15"), 10);
    const code = generateCode();
    const expiresAt = new Date(Date.now() + otpMinutes * 60 * 1000);

    await prisma.consumerOtpToken.create({
      data: { phoneE164: normalized.e164, code, expiresAt },
    });

    await sendSms({
      to: normalized.e164,
      body: `Your PerkValet code is ${code}. It expires in 10 minutes.`,
    });

    return res.json({ ok: true, hint: "Code sent" });
  } catch (err) {
    console.error("[consumer.auth] otp/start error:", err);
    return sendError(res, 500, "SERVER_ERROR", "Failed to send code");
  }
});

// ──────────────────────────────────────────────
// POST /consumer/auth/otp/verify
// Body: { phone, code }
// ──────────────────────────────────────────────
router.post("/consumer/auth/otp/verify", async (req, res) => {
  try {
    const { phone, code } = req.body || {};
    if (!phone || !code)
      return sendError(res, 400, "VALIDATION_ERROR", "phone and code are required");

    let normalized;
    try {
      normalized = normalizePhone(phone);
    } catch {
      return sendError(res, 400, "VALIDATION_ERROR", "Invalid phone number");
    }

    // Demo bypass: accept 000000 when SMS_PROVIDER=console (no real SMS)
    const isDemoBypass = process.env.SMS_PROVIDER === "console" && String(code).trim() === "000000";

    if (!isDemoBypass) {
      // Find the most recent unused, unexpired token for this phone
      const token = await prisma.consumerOtpToken.findFirst({
        where: {
          phoneE164: normalized.e164,
          usedAt: null,
          expiresAt: { gt: new Date() },
        },
        orderBy: { createdAt: "desc" },
      });

      if (!token || token.code !== String(code).trim()) {
        return sendError(res, 401, "INVALID_CODE", "Invalid or expired code");
      }

      // Mark token used
      await prisma.consumerOtpToken.update({
        where: { id: token.id },
        data: { usedAt: new Date() },
      });
    }

    // Upsert consumer by phoneE164
    const consumer = await prisma.consumer.upsert({
      where: { phoneE164: normalized.e164 },
      create: {
        phoneE164: normalized.e164,
        phoneRaw: normalized.raw,
        phoneCountry: "US",
        status: "active",
      },
      update: {},
    });

    const jwtPayload = {
      consumerId: consumer.id,
      phone: consumer.phoneE164,
      role: "consumer",
    };

    const jwtDays = parseInt(await getPlatformConfig("consumer_jwt_ttl_days", "90"), 10);
    const accessToken = jwt.sign(jwtPayload, JWT_SECRET, { expiresIn: `${jwtDays}d` });

    return res.json({
      ok: true,
      consumer: {
        id: consumer.id,
        phone: consumer.phoneE164,
        firstName: consumer.firstName,
        lastName: consumer.lastName,
        email: consumer.email,
      },
      token: accessToken,
    });
  } catch (err) {
    console.error("[consumer.auth] otp/verify error:", err);
    return sendError(res, 500, "SERVER_ERROR", "Verification failed");
  }
});

// ──────────────────────────────────────────────
// PATCH /consumer/profile
// Body: { firstName?, lastName? }
// ──────────────────────────────────────────────
const { requireConsumerJwt } = require("../middleware/auth");

router.patch("/consumer/profile", requireConsumerJwt, async (req, res) => {
  try {
    const consumerId = req.consumerId;
    const { firstName, lastName } = req.body || {};

    const data = {};
    if (firstName !== undefined) data.firstName = String(firstName).trim() || null;
    if (lastName !== undefined) data.lastName = String(lastName).trim() || null;

    if (Object.keys(data).length === 0) {
      return sendError(res, 400, "VALIDATION_ERROR", "Nothing to update");
    }

    const updated = await prisma.consumer.update({
      where: { id: consumerId },
      data,
    });

    return res.json({
      ok: true,
      consumer: {
        id: updated.id,
        phone: updated.phoneE164,
        firstName: updated.firstName,
        lastName: updated.lastName,
        email: updated.email,
      },
    });
  } catch (err) {
    console.error("[consumer.auth] profile update error:", err);
    return sendError(res, 500, "SERVER_ERROR", "Profile update failed");
  }
});

module.exports = router;
