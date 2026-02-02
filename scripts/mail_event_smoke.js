// backend/scripts/mail_event_smoke.js
// Mail-Flow-1: smoke test for MailEvent persistence + idempotency skip.
//
// Usage (from backend root):
//   node scripts/mail_event_smoke.js
//
// Expectations:
// - First call creates MailEvent attempt + marks it sent (dev or smtp)
// - Second call with SAME idempotencyKey returns { skipped: true }
// - Prints recent MailEvents

const { prisma } = require("../src/db/prisma");
const { sendMail, MAIL_CATEGORIES } = require("../src/mail/mail.adapter");

async function main() {
  const mailKey = `invoice.issued:invoice:SMOKE_${Date.now()}`;

  const baseInput = {
    category: MAIL_CATEGORIES.INVOICE,
    to: "qa@perkvalet.local",
    subject: "MailEvent smoke test",
    template: "invoice.payment_succeeded.stub",
    data: {
      invoiceId: "SMOKE",
      amountCents: 1234,
      note: "MailEvent smoke test payload",
    },
    meta: {
      // Mail-Flow-1 fields consumed by mail.adapter.js
      prisma,
      triggerType: "auto",
      idempotencyKey: mailKey,
      actorRole: "system",
      actorUserId: null,
      invoiceId: null,
      paymentId: null,
    },
  };

  console.log("MAIL_MODE=", process.env.MAIL_MODE || "(unset => dev)");
  console.log("idempotencyKey=", mailKey);

  console.log("\n--- First send (should create MailEvent + send) ---");
  const r1 = await sendMail(baseInput);
  console.log("result1:", r1);

  console.log("\n--- Second send SAME key (should skip) ---");
  const r2 = await sendMail(baseInput);
  console.log("result2:", r2);

  console.log("\n--- Recent MailEvents (top 10) ---");
  const rows = await prisma.mailEvent.findMany({
    orderBy: { createdAt: "desc" },
    take: 10,
    select: {
      id: true,
      createdAt: true,
      sentAt: true,
      category: true,
      triggerType: true,
      idempotencyKey: true,
      status: true,
      template: true,
      toEmail: true,
      transport: true,
      error: true,
      providerMessageId: true,
      actorRole: true,
      actorUserId: true,
      invoiceId: true,
      paymentId: true,
    },
  });

  for (const ev of rows) {
    console.log({
      id: ev.id,
      createdAt: ev.createdAt,
      sentAt: ev.sentAt,
      category: ev.category,
      triggerType: ev.triggerType,
      status: ev.status,
      idempotencyKey: ev.idempotencyKey,
      transport: ev.transport,
      toEmail: ev.toEmail,
      template: ev.template,
      error: ev.error,
      providerMessageId: ev.providerMessageId,
      actorRole: ev.actorRole,
      actorUserId: ev.actorUserId,
      invoiceId: ev.invoiceId,
      paymentId: ev.paymentId,
    });
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("mail_event_smoke failed:", e && e.message ? e.message : e);
    process.exit(1);
  });
