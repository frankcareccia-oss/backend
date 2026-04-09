// tests/helpers/setup.js
//
// Shared test utilities — JWT generation, app instance, DB helpers.
// All tests use the real database (no mocks) per project rules.

"use strict";

const jwt = require("jsonwebtoken");
const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-me";

/**
 * Generate a merchant admin JWT for testing.
 */
function merchantToken(overrides = {}) {
  return jwt.sign(
    { userId: 12, systemRole: "merchant_admin", merchantId: 2, merchantRole: "merchant_admin", ...overrides },
    JWT_SECRET,
    { expiresIn: "1h" }
  );
}

/**
 * Generate a pv_admin JWT for testing.
 */
function adminToken(overrides = {}) {
  return jwt.sign(
    { userId: 1, systemRole: "pv_admin", ...overrides },
    JWT_SECRET,
    { expiresIn: "1h" }
  );
}

/**
 * Generate a consumer JWT for testing.
 */
function consumerToken(overrides = {}) {
  return jwt.sign(
    { consumerId: 1, phone: "+14085551212", role: "consumer", ...overrides },
    JWT_SECRET,
    { expiresIn: "1h" }
  );
}

/**
 * Auth header helper — returns { Authorization: "Bearer <token>" }
 */
function authHeader(token) {
  return { Authorization: `Bearer ${token}` };
}

// Lazy-load app to avoid circular deps and allow env setup before require
let _app = null;
function getApp() {
  if (!_app) {
    _app = require("../../index");
  }
  return _app;
}

module.exports = {
  merchantToken,
  adminToken,
  consumerToken,
  authHeader,
  getApp,
  JWT_SECRET,
};
