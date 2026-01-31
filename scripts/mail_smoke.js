// backend/scripts/mail_smoke.js
// DEV smoke test for Mail-Web-1.
// Usage: node scripts/mail_smoke.js

const { sendMail, MAIL_CATEGORIES } = require("../src/mail");

async function main() {
  // Force safe behavior in smoke (even if user env has it set).
  process.env.ENABLE_REAL_EMAIL = "false";

  const res = await sendMail({
    category: MAIL_CATEGORIES.INVOICE,
    to: ["devnull@perkvalet.local"],
    subject: "Mail-Web-1 smoke: invoice stub",
    template: "invoice.stub",
    data: {
      invoiceId: "inv_smoke_001",
      amountCents: 12345,
      merchantName: "Smoke Merchant",
    },
    meta: {
      purpose: "smoke",
      thread: "mail-web-1",
    },
  });

  console.log("[mail_smoke] result:", res);
}

main().catch((err) => {
  console.error("[mail_smoke] failed:", err && err.stack ? err.stack : err);
  process.exit(1);
});