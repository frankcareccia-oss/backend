// backend/src/payments/guestToken.js
const crypto = require("crypto");

function base64url(buf) {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

/**
 * Create a URL-safe raw token. We hash it for storage.
 */
function mintRawToken(bytes = 32) {
  return base64url(crypto.randomBytes(bytes));
}

function sha256Hex(input) {
  return crypto.createHash("sha256").update(String(input)).digest("hex");
}

/**
 * Expiry = min(days from now, dueAt) if dueAt exists; else days from now.
 * Default days = 7.
 */
function computeGuestTokenExpiry({ dueAt, days = 7 }) {
  const n = Number.isFinite(Number(days)) ? Number(days) : 7;
  const ttl = new Date(Date.now() + n * 24 * 60 * 60 * 1000);

  if (!dueAt) return ttl;

  const d = new Date(dueAt);
  if (Number.isNaN(d.getTime())) return ttl;

  return ttl.getTime() <= d.getTime() ? ttl : d;
}

function now() {
  return new Date();
}

module.exports = {
  mintRawToken,
  sha256Hex,
  computeGuestTokenExpiry,
  now,
};
