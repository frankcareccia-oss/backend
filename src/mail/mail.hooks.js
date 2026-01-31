// backend/src/mail/mail.hooks.js
// Mail-Web-1: structured hooks for QA / docs / support / chatbot.
// Must never throw. Safe for DEV. ASCII-only.

function pvMailHook(event, fields = {}) {
  try {
    const payload = {
      pvHook: event,
      domain: "mail",
      ts: new Date().toISOString(),

      // Standard audiences: QA, docs, support, chatbot (non-breaking)
      audiences: ["qa", "docs", "support", "chatbot"],

      ...fields,
    };
    // Single-line JSON for easy NDJSON scraping.
    console.log(JSON.stringify(payload));
  } catch {
    // Never break backend flow due to hook logging.
  }
}

module.exports = {
  pvMailHook,
};