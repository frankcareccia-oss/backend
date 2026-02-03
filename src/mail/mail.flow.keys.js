// backend/src/mail/mail.flow.keys.js
// Mail-Flow-1 — deterministic idempotency keys
// Additive only. No side effects. No imports from payments.

/*
Rules:
- Keys MUST be deterministic
- Keys MUST be stable across retries
- Keys MUST change when business meaning changes
*/

function clean(v) {
  return String(v ?? "")
    .trim()
    .replace(/\s+/g, "_")
    .replace(/[^a-zA-Z0-9._:-]/g, "");
}

// Guest-pay token minted (auto)
function keyGuestPayTokenMinted({ invoiceId, tokenId }) {
  return `mail:auto:invoice.guest_pay_token.minted:invoice:${clean(
    invoiceId
  )}:token:${clean(tokenId)}`;
}

// Guest-pay token regenerated (auto)
function keyGuestPayTokenRegenerated({ invoiceId, tokenId }) {
  return `mail:auto:invoice.guest_pay_token.regenerated:invoice:${clean(
    invoiceId
  )}:token:${clean(tokenId)}`;
}

// Payment succeeded (auto)
function keyInvoicePaymentSucceeded({ invoiceId, paymentId }) {
  return `mail:auto:invoice.payment.succeeded:invoice:${clean(
    invoiceId
  )}:payment:${clean(paymentId)}`;
}

// Payment failed (auto)
function keyInvoicePaymentFailed({ invoiceId, paymentId }) {
  return `mail:auto:invoice.payment.failed:invoice:${clean(
    invoiceId
  )}:payment:${clean(paymentId)}`;
}

// Manual resend (explicitly non-idempotent vs auto)
function keyManualResend({ originalKey, resendId }) {
  return `mail:manual:resend:${clean(originalKey)}:id:${clean(resendId)}`;
}

module.exports = {
  keyGuestPayTokenMinted,
  keyGuestPayTokenRegenerated,
  keyInvoicePaymentSucceeded,
  keyInvoicePaymentFailed,
  keyManualResend,
};
