// backend/src/mail/mail.events.js
// Mail-Flow-1: durable mail event store + idempotency helpers.
// SCHEMA-ALIGNED with prisma MailEvent:
// - category, triggerType, idempotencyKey
// - invoiceId, paymentId
// - actorRole, actorUserId
// - template, toEmail
// - status, error, transport, providerMessageId
// - createdAt, sentAt
//
// Notes:
// - Auto sends: set triggerType=auto + idempotencyKey (required for idempotency).
// - Manual sends: triggerType=manual; idempotencyKey may be null.
// - Idempotency gate should block only when status=sent.
// - Failures do NOT block retries.

const { pvMailHook } = require("./mail.hooks");

function safeString(v) {
  if (v === undefined || v === null) return "";
  return String(v);
}

async function hasSentByKey({ prisma, triggerType, idempotencyKey }) {
  if (!prisma) throw new Error("hasSentByKey: prisma required");
  const tt = safeString(triggerType);
  const key = safeString(idempotencyKey);

  if (!tt) throw new Error("hasSentByKey: triggerType required");
  if (!key) return false; // no key => cannot be idempotent

  const found = await prisma.mailEvent.findFirst({
    where: {
      triggerType: tt, // "auto" | "manual"
      idempotencyKey: key,
      status: "sent",
    },
    select: { id: true },
  });

  return Boolean(found);
}

/**
 * Create a MailEvent attempt record.
 * - For auto: pass idempotencyKey
 * - For manual: idempotencyKey may be null
 */
async function createAttempt({
  prisma,
  category,
  triggerType,
  idempotencyKey = null,
  invoiceId = null,
  paymentId = null,
  actorRole,
  actorUserId = null,
  template,
  toEmail,
}) {
  if (!prisma) throw new Error("createAttempt: prisma required");

  const data = {
    category: safeString(category),
    triggerType: safeString(triggerType), // enum MailTriggerType
    idempotencyKey: idempotencyKey ? safeString(idempotencyKey) : null,
    invoiceId: invoiceId != null ? Number(invoiceId) : null,
    paymentId: paymentId != null ? Number(paymentId) : null,
    actorRole: safeString(actorRole),
    actorUserId: actorUserId != null ? Number(actorUserId) : null,
    template: safeString(template),
    toEmail: safeString(toEmail),
    // status defaults to failed in schema; we leave it as-is and flip on success.
  };

  const ev = await prisma.mailEvent.create({ data });

  pvMailHook("mail.event.attempt_created", {
    mailEventId: ev.id,
    category: data.category,
    triggerType: data.triggerType,
    idempotencyKey: data.idempotencyKey,
    invoiceId: data.invoiceId,
    paymentId: data.paymentId,
    actorRole: data.actorRole,
    actorUserId: data.actorUserId,
    template: data.template,
    toEmail: data.toEmail,
  });

  return ev;
}

async function markSent({
  prisma,
  mailEventId,
  transport = null,
  providerMessageId = null,
}) {
  if (!prisma) throw new Error("markSent: prisma required");

  const ev = await prisma.mailEvent.update({
    where: { id: Number(mailEventId) },
    data: {
      status: "sent",
      sentAt: new Date(),
      transport: transport ? safeString(transport) : null,
      providerMessageId: providerMessageId ? safeString(providerMessageId) : null,
      error: null,
    },
  });

  pvMailHook("mail.event.sent", {
    mailEventId: ev.id,
    status: ev.status,
    transport: ev.transport,
    providerMessageId: ev.providerMessageId,
  });

  return ev;
}

async function markFailed({
  prisma,
  mailEventId,
  error,
  transport = null,
}) {
  if (!prisma) throw new Error("markFailed: prisma required");

  const ev = await prisma.mailEvent.update({
    where: { id: Number(mailEventId) },
    data: {
      status: "failed",
      error: error ? safeString(error) : "unknown_error",
      transport: transport ? safeString(transport) : null,
      // sentAt remains null
    },
  });

  pvMailHook("mail.event.failed", {
    mailEventId: ev.id,
    status: ev.status,
    transport: ev.transport,
    error: ev.error,
  });

  return ev;
}

module.exports = {
  hasSentByKey,
  createAttempt,
  markSent,
  markFailed,
};
