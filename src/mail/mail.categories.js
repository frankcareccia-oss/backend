// backend/src/mail/mail.categories.js
// Mail-Web-1: stable categories (future-proof). Keep as ASCII-only.

const MAIL_CATEGORIES = Object.freeze({
  INVOICE: "invoice",
  SUPPORT: "support",
  MARKETING: "marketing",
  SECURITY: "security",
  SYSTEM: "system",
});

function assertValidMailCategory(category) {
  const values = Object.values(MAIL_CATEGORIES);
  if (!values.includes(category)) {
    throw new Error(`Invalid mail category: ${String(category)}`);
  }
}

module.exports = {
  MAIL_CATEGORIES,
  assertValidMailCategory,
};