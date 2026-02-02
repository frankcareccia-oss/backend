// backend/src/mail/mail.adapter.js
// Pluggable adapter. DEV-safe default. No vendor lock.
//
// Baseline preserved:
// - MAIL_MODE=dev|smtp
// - Always write DEV artifact (best-effort)
// - SMTP best-effort; failures never break API flows
// - Emits pvMailHook events
//
// Mail-Flow-1 additions (controlled):
// - Optional MailEvent persistence (requires input.meta.prisma)
// - Optional idempotency skip for auto sends with idempotencyKey (requires prisma)
//
// Mail-Flow-1 FIX:
// - Never serialize prisma (or other non-JSON-safe objects) into DEV artifacts.

const { MAIL_CATEGORIES, assertValidMailCategory } = require("./mail.categories");
const { sendViaDevTransport } = require("./mail.dev.transport");
const { sendViaSmtpTransport } = require("./mail.smtp.transport");
const { pvMailHook } = require("./mail.hooks");
const { renderTemplate } = require("./templateRegistry");

const { hasSentByKey, createAttempt, markSent, markFailed } = require("./mail.events");

function normalizeTo(to) {
  if (Array.isArray(to)) return to.map(String);
  return [String(to)];
}

function assertNonEmptyString(name, value) {
  if (!value || String(value).trim().length === 0) {
    throw new Error(`${name} is required`);
  }
}

function getMailMode() {
  const mode = String(process.env.MAIL_MODE || "").trim().toLowerCase();
  if (mode === "smtp") return "smtp";
  if (mode === "dev") return "dev";

  const legacyEnable = String(process.env.ENABLE_REAL_EMAIL || "").trim().toLowerCase() === "true";
  if (legacyEnable) return "smtp";

  return "dev";
}

function summarizeErr(e) {
  return e?.message || String(e);
}

function safeString(v) {
  if (v === undefined || v === null) return "";
  return String(v);
}

function getMeta(input) {
  const meta = input && input.meta && typeof input.meta === "object" ? input.meta : {};
  return meta;
}

/**
 * Make meta safe for JSON.stringify in DEV artifacts.
 * - Removes meta.prisma
 * - Replaces any non-primitive values with a short string marker
 */
function sanitizeMetaForJson(meta) {
  if (!meta || typeof meta !== "object") return {};

  const out = {};
  for (const [k, v] of Object.entries(meta)) {
    if (k === "prisma") continue;

    const t = typeof v;
    if (v === null || t === "string" || t === "number" || t === "boolean") {
      out[k] = v;
      continue;
    }

    if (Array.isArray(v)) {
      out[k] = v.map((x) => {
        const tx = typeof x;
        if (x === null || tx === "string" || tx === "number" || tx === "boolean") return x;
        return "[nonjson]";
      });
      continue;
    }

    out[k] = "[nonjson]";
  }
  return out;
}

function getMailFlow(meta) {
  const triggerType = safeString(meta.triggerType || meta.mailTriggerType || "manual"); // "auto" | "manual"
  const idempotencyKey = meta.idempotencyKey ? safeString(meta.idempotencyKey) : null;

  const actorRole = safeString(meta.actorRole || (triggerType === "auto" ? "system" : "operator") || "operator");
  const actorUserId =
    meta.actorUserId !== undefined && meta.actorUserId !== null ? Number(meta.actorUserId) : null;

  const invoiceId =
    meta.invoiceId !== undefined && meta.invoiceId !== null ? Number(meta.invoiceId) : null;
  const paymentId =
    meta.paymentId !== undefined && meta.paymentId !== null ? Number(meta.paymentId) : null;

  const prisma = meta.prisma || null;

  return { triggerType, idempotencyKey, actorRole, actorUserId, invoiceId, paymentId, prisma };
}

/**
 * Main entrypoint
 */
async function sendMail(input) {
  pvMailHook("mail.send.requested", {
    category: input && input.category,
    template: input && input.template,
  });

  if (!input) throw new Error("sendMail input is required");

  const category = String(input.category);
  assertValidMailCategory(category);

  const to = normalizeTo(input.to);
  if (!to.length) throw new Error("to is required");

  assertNonEmptyString("subject", input.subject);
  assertNonEmptyString("template", input.template);

  const meta = getMeta(input);
  const flow = getMailFlow(meta);
  const metaSafe = sanitizeMetaForJson(meta);

  // Idempotency skip (auto only)
  if (flow.prisma && flow.triggerType === "auto" && flow.idempotencyKey) {
    try {
      const alreadySent = await hasSentByKey({
        prisma: flow.prisma,
        triggerType: flow.triggerType,
        idempotencyKey: flow.idempotencyKey,
      });

      if (alreadySent) {
        pvMailHook("mail.send.skipped_idempotent", {
          tc: "TC-MAIL-FLOW-10",
          sev: "info",
          stable: `mailkey:${flow.idempotencyKey}`,
          category,
          template: String(input.template),
        });

        return { ok: true, skipped: true, transport: "idempotent_skip" };
      }
    } catch (e) {
      pvMailHook("mail.idempotency.check_failed", {
        tc: "TC-MAIL-FLOW-11",
        sev: "warn",
        stable: flow.idempotencyKey ? `mailkey:${flow.idempotencyKey}` : "mailkey:none",
        error: summarizeErr(e),
      });
    }
  }

  // Template rendering (best-effort)
  let rendered = null;
  try {
    rendered = renderTemplate(String(input.template), input.data || {});
  } catch (e) {
    pvMailHook("mail.template.render_failed", {
      sev: "warn",
      category,
      template: input && input.template,
      error: summarizeErr(e),
    });
    rendered = null;
  }

  const msg = {
    category,
    to,
    subject: String(input.subject),
    template: String(input.template),
    rendered,
    data: input.data || {},
    meta: metaSafe, // SAFE for JSON.stringify in dev transport
  };

  const mode = getMailMode();

  pvMailHook("mail.send.attempt", {
    tc: "TC-MAIL-01",
    sev: "info",
    stable: `mailmode:${mode}`,
    mode,
    category,
    template: msg.template,
    toCount: msg.to.length,
  });

  // Create MailEvent attempt (best-effort)
  let mailEventId = null;
  if (flow.prisma) {
    try {
      const ev = await createAttempt({
        prisma: flow.prisma,
        category: category,
        triggerType: flow.triggerType,
        idempotencyKey: flow.idempotencyKey,
        invoiceId: flow.invoiceId,
        paymentId: flow.paymentId,
        actorRole: flow.actorRole,
        actorUserId: flow.actorUserId,
        template: msg.template,
        toEmail: msg.to[0] ? String(msg.to[0]) : "",
      });
      mailEventId = ev && ev.id ? ev.id : null;
    } catch (e) {
      pvMailHook("mail.event.create_failed", {
        tc: "TC-MAIL-FLOW-12",
        sev: "warn",
        stable: flow.idempotencyKey ? `mailkey:${flow.idempotencyKey}` : "mailkey:none",
        error: summarizeErr(e),
      });
      mailEventId = null;
    }
  }

  // Always write DEV artifact (best-effort)
  try {
    await sendViaDevTransport(msg);
  } catch (e) {
    pvMailHook("mail.dev.write_failed", {
      tc: "TC-MAIL-02",
      sev: "warn",
      stable: `mailmode:${mode}`,
      error: summarizeErr(e),
    });
  }

  if (mode === "smtp") {
    try {
      const result = await sendViaSmtpTransport(msg);

      pvMailHook("mail.send.success", {
        tc: "TC-MAIL-03",
        sev: "info",
        stable: `mailmode:${mode}`,
        mode,
        category,
        transport: result.transport,
        ok: result.ok,
        messageId: result.messageId || null,
      });

      if (flow.prisma && mailEventId) {
        try {
          await markSent({
            prisma: flow.prisma,
            mailEventId,
            transport: result.transport || "smtp",
            providerMessageId: result.messageId || null,
          });
        } catch (e) {
          pvMailHook("mail.event.mark_sent_failed", {
            tc: "TC-MAIL-FLOW-13",
            sev: "warn",
            stable: `mailEvent:${mailEventId}`,
            error: summarizeErr(e),
          });
        }
      }

      return result;
    } catch (e) {
      pvMailHook("mail.send.failure", {
        tc: "TC-MAIL-04",
        sev: "error",
        stable: `mailmode:${mode}`,
        mode,
        category,
        error: summarizeErr(e),
      });

      if (flow.prisma && mailEventId) {
        try {
          await markFailed({
            prisma: flow.prisma,
            mailEventId,
            error: summarizeErr(e),
            transport: "smtp",
          });
        } catch (e2) {
          pvMailHook("mail.event.mark_failed_failed", {
            tc: "TC-MAIL-FLOW-14",
            sev: "warn",
            stable: `mailEvent:${mailEventId}`,
            error: summarizeErr(e2),
          });
        }
      }

      return {
        ok: false,
        transport: "smtp",
        error: summarizeErr(e),
      };
    }
  }

  pvMailHook("mail.send.completed", {
    tc: "TC-MAIL-05",
    sev: "info",
    stable: `mailmode:${mode}`,
    category,
    transport: "dev",
    ok: true,
  });

  if (flow.prisma && mailEventId) {
    try {
      await markSent({
        prisma: flow.prisma,
        mailEventId,
        transport: "dev",
        providerMessageId: null,
      });
    } catch (e) {
      pvMailHook("mail.event.mark_sent_failed", {
        tc: "TC-MAIL-FLOW-13",
        sev: "warn",
        stable: `mailEvent:${mailEventId}`,
        error: summarizeErr(e),
      });
    }
  }

  return { ok: true, transport: "dev" };
}

module.exports = {
  sendMail,
  MAIL_CATEGORIES,
};
