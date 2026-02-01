// backend/scripts/mail_smoke.js
// DEV smoke test for Mail-Web-1 templates + transport.
// Usage: node scripts/mail_smoke.js

require("dotenv").config({ path: require("path").resolve(__dirname, "..", ".env") });

const { sendMail, MAIL_CATEGORIES } = require("../src/mail");

async function main() {
  // Force safe behavior in smoke (even if user env has it set).
  process.env.ENABLE_REAL_EMAIL = "false";

  const res = await sendMail({
    category: MAIL_CATEGORIES.INVOICE,
    to: ["devdude@perkvalet.local"],
    subject: "Mail-Web-1 smoke: invoice guest pay template",
    template: "invoice.guest_pay.stub",
    data: {
      invoiceId: "inv_smoke_001",
      externalInvoiceId: "INV-SMOKE-001",
      amountDueCents: 12345,
      amountPaidCents: 0,
      totalCents: 12345,
      merchantName: "Smoke Merchant",
      payUrl: "http://localhost:3001/pay/SMOKE_TOKEN",
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    },
    meta: {
      purpose: "smoke",
      thread: "mail-web-1",
    },
  });

  console.log("[mail_smoke] result:", res);
  console.log("[mail_smoke] open the JSON file and confirm it includes: rendered.subject + rendered.text");
}

main().catch((err) => {
  console.error("[mail_smoke] failed:", err && err.stack ? err.stack : err);
  process.exit(1);
});
