/**
 * encrypt.js — AES-256-GCM symmetric encryption for POS OAuth tokens at rest.
 *
 * Requires TOKEN_ENCRYPTION_KEY env var: 64 hex chars (32 bytes).
 * Generate once: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 */

const crypto = require("crypto");

const ALGORITHM = "aes-256-gcm";
const IV_LEN = 12;   // 96-bit IV (recommended for GCM)
const TAG_LEN = 16;  // 128-bit auth tag

function getKey() {
  const hex = process.env.TOKEN_ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error("TOKEN_ENCRYPTION_KEY must be a 64-char hex string (32 bytes)");
  }
  return Buffer.from(hex, "hex");
}

/**
 * Encrypt plaintext → "iv:ciphertext:tag" (all base64, colon-delimited).
 * Returns a string safe to store in a VARCHAR column.
 */
function encrypt(plaintext) {
  const key = getKey();
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString("base64"), encrypted.toString("base64"), tag.toString("base64")].join(":");
}

/**
 * Decrypt "iv:ciphertext:tag" → plaintext string.
 * Throws if the message has been tampered with (GCM auth tag mismatch).
 */
function decrypt(ciphertext) {
  const key = getKey();
  const parts = ciphertext.split(":");
  if (parts.length !== 3) throw new Error("Invalid ciphertext format");
  const [ivB64, encB64, tagB64] = parts;
  const iv = Buffer.from(ivB64, "base64");
  const encrypted = Buffer.from(encB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(encrypted) + decipher.final("utf8");
}

module.exports = { encrypt, decrypt };
