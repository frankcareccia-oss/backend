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
const OTP_TTL_MS = 10 * 60 * 1000; // 10 minutes
const OTP_LENGTH = 6;

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

    const code = generateCode();
    const expiresAt = new Date(Date.now() + OTP_TTL_MS);

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

    const accessToken = jwt.sign(jwtPayload, JWT_SECRET, { expiresIn: "30d" });

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

module.exports = router;
