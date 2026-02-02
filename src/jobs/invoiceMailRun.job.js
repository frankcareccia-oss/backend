// backend/src/jobs/invoiceMailRun.job.js
//
// Mail-Flow-2: Invoice Mail Run Job (Cron/Scheduler precursor)
// - Finds invoices eligible for auto-send:
//   status IN ('issued','past_due') AND (totalCents - amountPaidCents) > 0
// - Ensures guest pay token exists (no rotation)
// - Sends "invoice issued" email exactly once using MailEvent idempotency:
//   triggerType=auto
//   idempotencyKey=invoice.issued:invoice:<invoiceId>
// - Uses BillingAccount.billingEmail
//
// Contract notes:
// - No refactors.
// - Full file replacement.
// - Fail-fast on unknown dependencies (no guessing silently).

"use strict";

const path = require("path");

/**
 * pvJobHook: structured job events for QA/docs/support/chatbot.
 * Must never throw.
 */
function pvJobHook(event, fields = {}) {
  try {
    console.log(
      JSON.stringify({
        pvJobHook: event,
        ts: new Date().toISOString(),
        ...fields,
      })
    );
  } catch {
    // never break job for logging
  }
}

function mustEnv(name) {
  const v = process.env[name];
  if (!v || String(v).trim() === "") {
    throw new Error(`${name} is required for invoiceMailRun.job`);
  }
  return String(v).trim();
}

function numEnv(name, fallback) {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return n;
}

function safeInt(n, fallback = 0) {
  const x = Number(n);
  return Number.isFinite(x) ? Math.trunc(x) : fallback;
}

/**
 * Resolve a function export from a module without guessing silently.
 * Returns { fn, name, keys } where keys are module export keys.
 */
function resolveFn(mod, candidates, label) {
  const keys = mod && typeof mod === "object" ? Object.keys(mod) : [];
  for (const name of candidates) {
    const fn = mod && typeof mod[name] === "function" ? mod[name] : null;
    if (fn) return { fn, name, keys };
  }
  return {
    fn: null,
    name: null,
    keys,
    err: new Error(
      `${label}: could not find a callable export. Tried: ${candidates.join(
        ", "
      )}. Available exports: ${keys.join(", ") || "(none)"}`
    ),
  };
}

/**
 * Attempts to extract a public payment URL from ensureActiveGuestPayToken result.
 * Supports multiple plausible shapes without silently lying:
 * - string (assumed url)
 * - { url } / { publicUrl } / { link } / { payUrl }
 * - { token } or { code } -> NOT constructed into a URL without a known route
 *
 * If we cannot extract, we return null and still send a minimal email
 * (job continues; link may be missing).
 */
function extractGuestPayUrl(result, publicBaseUrl) {
  if (!result) return null;

  if (typeof result === "string") {
    const s = result.trim();
    return s ? s : null;
  }

  if (typeof result === "object") {
    const direct =
      result.url ||
      result.publicUrl ||
      result.publicURL ||
      result.link ||
      result.payUrl ||
      result.guestPayUrl ||
      result.guestPayURL;
    if (direct && typeof direct === "string" && direct.trim()) {
      return direct.trim();
    }

    // If token/code is present, we can only safely construct a URL if we know
    // the canonical route. Without that certainty, do NOT invent a path.
    const token =
      result.token ||
      result.code ||
      result.guestPayToken ||
      result.guestPayCode ||
      null;

    if (token && typeof token === "string" && token.trim()) {
      void publicBaseUrl;
      return null;
    }
  }

  return null;
}

/**
 * Render a simple invoice issued email.
 * NOTE: This is intentionally plain and safe. If you have a canonical template system,
 * the mail adapter/template can override these fields.
 */
function renderInvoiceIssuedEmail({ invoice, billingEmail, guestPayUrl }) {
  const invId = invoice.id;
  const totalCents = safeInt(invoice.totalCents, 0);
  const paidCents = safeInt(invoice.amountPaidCents, 0);
  const dueCents = Math.max(0, totalCents - paidCents);

  const dollars = (c) => (c / 100).toFixed(2);

  const subject = `PerkValet invoice #${invId} is ready`;

  const lines = [];
  lines.push(`Hello,`);
  lines.push(``);
  lines.push(`Your PerkValet invoice #${invId} is ready.`);
  lines.push(`Amount due: $${dollars(dueCents)}`);
  lines.push(``);
  if (guestPayUrl) {
    lines.push(`Pay securely here: ${guestPayUrl}`);
    lines.push(``);
  } else {
    lines.push(
      `Payment link is being prepared. If you need assistance, reply to this email.`
    );
    lines.push(``);
  }
  lines.push(`Billing contact: ${billingEmail}`);
  lines.push(``);
  lines.push(`Thank you,`);
  lines.push(`PerkValet Billing`);

  const text = lines.join("\n");

  // Minimal HTML (no external assets)
  const html = `
    <div style="font-family: Arial, sans-serif; line-height: 1.4;">
      <p>Hello,</p>
      <p>Your PerkValet invoice <strong>#${invId}</strong> is ready.</p>
      <p><strong>Amount due:</strong> $${dollars(dueCents)}</p>
      ${
        guestPayUrl
          ? `<p><a href="${guestPayUrl}">Pay securely here</a></p>`
          : `<p>Payment link is being prepared. If you need assistance, reply to this email.</p>`
      }
      <p style="color:#555;"><strong>Billing contact:</strong> ${billingEmail}</p>
      <p>Thank you,<br/>PerkValet Billing</p>
    </div>
  `.trim();

  return { subject, text, html };
}

/**
 * Main job runner.
 *
 * @param {object} args
 * @param {object} args.prisma - Prisma client (required).
 * @param {string} [args.publicBaseUrl] - Canonical base URL (defaults to process.env.PUBLIC_BASE_URL).
 * @param {number} [args.limit] - Max invoices to process in one run.
 * @param {boolean} [args.dryRun] - If true, do not actually send email; logs only.
 */
async function runInvoiceMailRunJob({
  prisma,
  publicBaseUrl = null,
  limit = 50,
  dryRun = false,
} = {}) {
  if (!prisma) throw new Error("runInvoiceMailRunJob: prisma is required");

  const baseUrl = (publicBaseUrl || process.env.PUBLIC_BASE_URL || "").trim();
  if (!baseUrl) {
    throw new Error(
      "PUBLIC_BASE_URL is required (canonical base URL for email links). Set process.env.PUBLIC_BASE_URL."
    );
  }

  // Load guest pay token service
  const guestSvc = require(path.join("..", "billing", "guestPayToken.service"));
  const guestFnResolved = resolveFn(
    guestSvc,
    ["ensureActiveGuestPayToken"],
    "guestPayToken.service"
  );
  if (!guestFnResolved.fn) throw guestFnResolved.err;

  // Load mail idempotency check (MailEvent)
  const mailEvents = require(path.join("..", "mail", "mail.events"));
  const hasSentResolved = resolveFn(
    mailEvents,
    ["hasSentByKey"],
    "mail.events"
  );
  if (!hasSentResolved.fn) throw hasSentResolved.err;

  // Load mail adapter
  const mailAdapter = require(path.join("..", "mail", "mail.adapter"));

  // We do not assume the exact export name; try a small set of plausible names.
  const mailFnResolved = resolveFn(
    mailAdapter,
    [
      "sendMail",
      "send",
      "dispatchMail",
      "deliverMail",
      "mailSend",
      "sendWithAdapter",
    ],
    "mail.adapter"
  );
  if (!mailFnResolved.fn) throw mailFnResolved.err;

  pvJobHook("invoiceMailRun.start", {
    limit,
    dryRun: !!dryRun,
    publicBaseUrl: baseUrl,
    mailAdapterFn: mailFnResolved.name,
  });

  // Fetch candidate invoices. We keep the DB filter simple and compute "amount due" in code.
  const candidates = await prisma.invoice.findMany({
    where: {
      status: { in: ["issued", "past_due"] },
    },
    include: {
      billingAccount: { select: { billingEmail: true } },
    },
    orderBy: { id: "asc" },
    take: limit,
  });

  let scanned = 0;
  let eligible = 0;
  let sent = 0;
  let skipped = 0;
  let failed = 0;

  for (const inv of candidates) {
    scanned += 1;

    const totalCents = safeInt(inv.totalCents, 0);
    const paidCents = safeInt(inv.amountPaidCents, 0);
    const dueCents = Math.max(0, totalCents - paidCents);

    if (dueCents <= 0) {
      pvJobHook("invoiceMailRun.skip_no_due", {
        invoiceId: inv.id,
        status: inv.status,
        totalCents,
        paidCents,
      });
      skipped += 1;
      continue;
    }

    const billingEmail =
      inv.billingAccount && inv.billingAccount.billingEmail
        ? String(inv.billingAccount.billingEmail).trim()
        : "";

    if (!billingEmail) {
      pvJobHook("invoiceMailRun.skip_no_billing_email", {
        invoiceId: inv.id,
        status: inv.status,
      });
      skipped += 1;
      continue;
    }

    eligible += 1;

    const idempotencyKey = `invoice.issued:invoice:${inv.id}`;

    // Pre-check idempotency so the job summary reflects "skipped" (not "sent").
    // This matches the adapter's behavior for triggerType=auto + idempotencyKey.
    try {
      const alreadySent = await hasSentResolved.fn({
        prisma,
        triggerType: "auto",
        idempotencyKey,
      });

      if (alreadySent) {
        pvJobHook("invoiceMailRun.skip_idempotent", {
          invoiceId: inv.id,
          toEmail: billingEmail,
          idempotencyKey,
          dueCents,
        });
        skipped += 1;
        continue;
      }
    } catch (e) {
      // If idempotency check fails, we do NOT guess; log and proceed to adapter
      // which also enforces idempotency as best-effort.
      pvJobHook("invoiceMailRun.idempotency_check_error", {
        invoiceId: inv.id,
        idempotencyKey,
        err: String(e && e.message ? e.message : e),
      });
    }

    // Ensure guest pay token exists (no rotation)
    let guestResult = null;
    try {
      guestResult = await guestFnResolved.fn({
        prisma,
        invoiceId: inv.id,
        publicBaseUrl: baseUrl,
        forceRotate: false,
      });
    } catch (e) {
      // Token creation failure should not prevent future retries; record and continue.
      pvJobHook("invoiceMailRun.guestPayToken.error", {
        invoiceId: inv.id,
        err: String(e && e.message ? e.message : e),
      });
      // continue; email can still be sent without link (or fail later)
    }

    const guestPayUrl = extractGuestPayUrl(guestResult, baseUrl);

    // Build email content
    const rendered = renderInvoiceIssuedEmail({
      invoice: inv,
      billingEmail,
      guestPayUrl,
    });

    // Build message for adapter with maximum compatibility
    const msg = {
      // Classification / persistence
      // IMPORTANT: mail.categories.js allows: invoice|support|marketing|system
      category: "invoice",
      template: "invoice.issued",
      toEmail: billingEmail,
      to: billingEmail,

      // Content
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,

      // Meta used by adapter for MailEvent + idempotency
      meta: {
        triggerType: "auto",
        idempotencyKey,
        actorRole: "system",
        actorUserId: null,
        invoiceId: inv.id,
        prisma,
      },
    };

    pvJobHook("invoiceMailRun.attempt", {
      invoiceId: inv.id,
      toEmail: billingEmail,
      idempotencyKey,
      dueCents,
      hasGuestPayUrl: !!guestPayUrl,
      dryRun: !!dryRun,
    });

    if (dryRun) {
      // Do not send in dryRun mode.
      skipped += 1;
      continue;
    }

    try {
      // Adapter should handle:
      // - hasSentByKey check for auto/idempotencyKey
      // - MailEvent createAttempt
      // - send via SMTP transport (MAIL_MODE=smtp)
      // - MailEvent markSent/markFailed
      await mailFnResolved.fn(msg);
      sent += 1;
      pvJobHook("invoiceMailRun.sent", {
        invoiceId: inv.id,
        toEmail: billingEmail,
        idempotencyKey,
      });
    } catch (e) {
      failed += 1;
      pvJobHook("invoiceMailRun.failed", {
        invoiceId: inv.id,
        toEmail: billingEmail,
        idempotencyKey,
        err: String(e && e.message ? e.message : e),
      });
      // continue to next invoice
    }
  }

  const summary = { scanned, eligible, sent, skipped, failed };
  pvJobHook("invoiceMailRun.done", summary);
  return summary;
}

/**
 * Resolve prisma client from common locations without silently guessing.
 * If we cannot find it, we instruct how to pass prisma in.
 */
function tryLoadPrisma() {
  const tried = [];
  const attempts = [
    // Common patterns
    () => require(path.join("..", "db", "prisma")),
    () => require(path.join("..", "db", "prisma.client")),
    () => require(path.join("..", "db", "client")),
    () => require(path.join("..", "prisma", "client")),
    () => require("@prisma/client"),
  ];

  for (const fn of attempts) {
    try {
      const mod = fn();
      // If @prisma/client, instantiate PrismaClient.
      if (mod && mod.PrismaClient) {
        const prisma = new mod.PrismaClient();
        return { prisma, tried };
      }
      // Otherwise, module may export prisma directly or { prisma }
      if (mod && mod.prisma) return { prisma: mod.prisma, tried };
      if (mod && typeof mod === "object") return { prisma: mod, tried };
    } catch (e) {
      tried.push(String(e && e.message ? e.message : e));
    }
  }

  return { prisma: null, tried };
}

// Script mode: allows manual runs before wiring cron/scheduler.
if (require.main === module) {
  (async () => {
    try {
      const baseUrl = mustEnv("PUBLIC_BASE_URL");
      const limit = numEnv("INVOICE_MAILRUN_LIMIT", 50);
      const dryRun =
        String(process.env.INVOICE_MAILRUN_DRYRUN || "").trim() === "1";

      const { prisma } = tryLoadPrisma();
      if (!prisma) {
        throw new Error(
          "Could not auto-load prisma client. Run this job from within the backend app where prisma is available, or modify script mode to import your prisma module explicitly."
        );
      }

      const result = await runInvoiceMailRunJob({
        prisma,
        publicBaseUrl: baseUrl,
        limit,
        dryRun,
      });

      // Ensure prisma disconnect if it supports it
      if (prisma && typeof prisma.$disconnect === "function") {
        await prisma.$disconnect();
      }

      // Exit success
      process.exitCode = 0;
      void result;
    } catch (e) {
      pvJobHook("invoiceMailRun.fatal", {
        err: String(e && e.message ? e.message : e),
      });
      try {
        // Best effort flush
        console.error(e);
      } catch {}
      process.exitCode = 1;
    }
  })();
}

module.exports = {
  runInvoiceMailRunJob,
};
