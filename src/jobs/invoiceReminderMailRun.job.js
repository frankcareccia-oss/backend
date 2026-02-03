// backend/src/jobs/invoiceReminderMailRun.job.js
//
// Mail-Flow-4: Invoice Reminder / Dunning Mail Run Job
// - Finds invoices eligible for reminders:
//   status = past_due AND dueAt <= now AND (totalCents - amountPaidCents) > 0
// - Uses dueAt to compute daysPastDue buckets (default: 1,7,14)
// - Ensures guest pay token exists (no rotation)
// - Sends reminder email exactly once per bucket using MailEvent idempotency:
//   triggerType=auto
//   idempotencyKey=invoice.reminder:d<bucket>:invoice:<invoiceId>
//
// Guardrails:
// - No refactors of mail system.
// - Fail-fast on unknown dependencies (no silent guessing).
// - Dry-run supported via caller (scheduler) or direct invocation.
//
// Exports: runInvoiceReminderMailRunJob({ prisma, publicBaseUrl, limit, dryRun, bucketDays })

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
    throw new Error(`${name} is required for invoiceReminderMailRun.job`);
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

function clampInt(n, min, max, fallback) {
  const x = safeInt(n, fallback);
  return Math.max(min, Math.min(max, x));
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
 * Parse "1,7,14" into [1,7,14]. Filters invalids, de-dupes, sorts ascending.
 */
function parseBucketDays(value, fallback = [1, 7, 14]) {
  if (value == null || String(value).trim() === "") return fallback;
  const parts = String(value)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const out = [];
  for (const p of parts) {
    const n = Number(p);
    if (!Number.isFinite(n)) continue;
    const d = Math.trunc(n);
    if (d < 0 || d > 3650) continue; // sane bounds
    out.push(d);
  }
  // de-dupe + sort
  return Array.from(new Set(out)).sort((a, b) => a - b);
}

/**
 * Attempts to extract a public payment URL from ensureActiveGuestPayToken result.
 * Supports multiple plausible shapes without silently lying:
 * - string (assumed url)
 * - { url } / { publicUrl } / { link } / { payUrl }
 * - { token } or { code } -> NOT constructed into a URL without a known route
 */
function extractGuestPayUrl(result) {
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
  }

  return null;
}

function dollars(cents) {
  const c = safeInt(cents, 0);
  return (c / 100).toFixed(2);
}

/**
 * Render a reminder email.
 * Intentionally plain + safe.
 */
function renderInvoiceReminderEmail({
  invoice,
  billingEmail,
  guestPayUrl,
  bucketDay,
  daysPastDue,
}) {
  const invId = invoice.id;
  const totalCents = safeInt(invoice.totalCents, 0);
  const paidCents = safeInt(invoice.amountPaidCents, 0);
  const dueCents = Math.max(0, totalCents - paidCents);

  const subject = `Reminder: PerkValet invoice #${invId} is past due`;

  const lines = [];
  lines.push(`Hello,`);
  lines.push(``);
  lines.push(`This is a reminder that your PerkValet invoice #${invId} is past due.`);
  lines.push(`Amount due: $${dollars(dueCents)}`);
  lines.push(`Days past due: ${daysPastDue}`);
  lines.push(``);
  if (guestPayUrl) {
    lines.push(`Pay securely here: ${guestPayUrl}`);
    lines.push(``);
  } else {
    lines.push(`Payment link is being prepared. If you need assistance, reply to this email.`);
    lines.push(``);
  }
  lines.push(`Billing contact: ${billingEmail}`);
  lines.push(``);
  lines.push(`Thank you,`);
  lines.push(`PerkValet Billing`);

  const text = lines.join("\n");

  const html = `
    <div style="font-family: Arial, sans-serif; line-height: 1.4;">
      <p>Hello,</p>
      <p>This is a reminder that your PerkValet invoice <strong>#${invId}</strong> is past due.</p>
      <p><strong>Amount due:</strong> $${dollars(dueCents)}<br/>
         <strong>Days past due:</strong> ${daysPastDue}</p>
      ${
        guestPayUrl
          ? `<p><a href="${guestPayUrl}">Pay securely here</a></p>`
          : `<p>Payment link is being prepared. If you need assistance, reply to this email.</p>`
      }
      <p style="color:#555;"><strong>Billing contact:</strong> ${billingEmail}</p>
      <p>Thank you,<br/>PerkValet Billing</p>
      <p style="color:#888; font-size: 12px;">Reminder cadence bucket: day ${bucketDay}</p>
    </div>
  `.trim();

  return { subject, text, html };
}

/**
 * Main job runner.
 *
 * @param {object} args
 * @param {object} args.prisma - Prisma client (required)
 * @param {string} [args.publicBaseUrl] - Canonical base URL (defaults to process.env.PUBLIC_BASE_URL)
 * @param {number} [args.limit] - Max invoices to process in one run
 * @param {boolean} [args.dryRun] - If true, do not actually send email; logs only
 * @param {number[]} [args.bucketDays] - Days past due buckets to send (e.g., [1,7,14])
 */
async function runInvoiceReminderMailRunJob({
  prisma,
  publicBaseUrl = null,
  limit = 50,
  dryRun = false,
  bucketDays = null,
} = {}) {
  if (!prisma) throw new Error("runInvoiceReminderMailRunJob: prisma is required");

  const baseUrl = (publicBaseUrl || process.env.PUBLIC_BASE_URL || "").trim();
  if (!baseUrl) {
    throw new Error(
      "PUBLIC_BASE_URL is required (canonical base URL for email links). Set process.env.PUBLIC_BASE_URL."
    );
  }

  const buckets =
    Array.isArray(bucketDays) && bucketDays.length
      ? bucketDays
      : parseBucketDays(process.env.INVOICE_REMINDER_BUCKET_DAYS, [1, 7, 14]);

  pvJobHook("invoiceReminderMailRun.start", {
    limit,
    dryRun: !!dryRun,
    publicBaseUrl: baseUrl,
    bucketDays: buckets,
  });

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
  const hasSentResolved = resolveFn(mailEvents, ["hasSentByKey"], "mail.events");
  if (!hasSentResolved.fn) throw hasSentResolved.err;

  // Load mail adapter
  const mailAdapter = require(path.join("..", "mail", "mail.adapter"));
  const mailFnResolved = resolveFn(mailAdapter, ["sendMail"], "mail.adapter");
  if (!mailFnResolved.fn) throw mailFnResolved.err;

  // We only consider invoices already past due, and with dueAt set.
  const now = new Date();

  const candidates = await prisma.invoice.findMany({
    where: {
      status: "past_due",
      dueAt: { not: null, lte: now },
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

    const dueAt = inv.dueAt ? new Date(inv.dueAt) : null;
    if (!dueAt || Number.isNaN(dueAt.getTime())) {
      pvJobHook("invoiceReminderMailRun.skip_no_dueAt", {
        invoiceId: inv.id,
        status: inv.status,
      });
      skipped += 1;
      continue;
    }

    const totalCents = safeInt(inv.totalCents, 0);
    const paidCents = safeInt(inv.amountPaidCents, 0);
    const dueCents = Math.max(0, totalCents - paidCents);

    if (dueCents <= 0) {
      pvJobHook("invoiceReminderMailRun.skip_no_due_balance", {
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
      pvJobHook("invoiceReminderMailRun.skip_no_billing_email", {
        invoiceId: inv.id,
        status: inv.status,
      });
      skipped += 1;
      continue;
    }

    // Compute days past due (floor of day difference)
    const msPast = now.getTime() - dueAt.getTime();
    const daysPastDue = clampInt(Math.floor(msPast / 86400000), 0, 3650, 0);

    // Only send on configured bucket days
    if (!buckets.includes(daysPastDue)) {
      pvJobHook("invoiceReminderMailRun.skip_not_bucket_day", {
        invoiceId: inv.id,
        toEmail: billingEmail,
        daysPastDue,
        bucketDays: buckets,
      });
      skipped += 1;
      continue;
    }

    eligible += 1;

    const bucketDay = daysPastDue;
    const idempotencyKey = `invoice.reminder:d${bucketDay}:invoice:${inv.id}`;

    // Pre-check idempotency
    try {
      const alreadySent = await hasSentResolved.fn({
        prisma,
        triggerType: "auto",
        idempotencyKey,
      });

      if (alreadySent) {
        pvJobHook("invoiceReminderMailRun.skip_idempotent", {
          invoiceId: inv.id,
          toEmail: billingEmail,
          idempotencyKey,
          dueCents,
          daysPastDue,
        });
        skipped += 1;
        continue;
      }
    } catch (e) {
      pvJobHook("invoiceReminderMailRun.idempotency_check_error", {
        invoiceId: inv.id,
        idempotencyKey,
        err: String(e && e.message ? e.message : e),
      });
      // Continue; adapter + MailEvent uniqueness still protects best-effort
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
      pvJobHook("invoiceReminderMailRun.guestPayToken.error", {
        invoiceId: inv.id,
        err: String(e && e.message ? e.message : e),
      });
      // Continue; email can still be sent without link
    }

    const guestPayUrl = extractGuestPayUrl(guestResult);

    const rendered = renderInvoiceReminderEmail({
      invoice: inv,
      billingEmail,
      guestPayUrl,
      bucketDay,
      daysPastDue,
    });

    const msg = {
      category: "invoice",
      template: "invoice.reminder",
      toEmail: billingEmail,
      to: billingEmail,

      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,

      meta: {
        triggerType: "auto",
        idempotencyKey,
        actorRole: "system",
        actorUserId: null,
        invoiceId: inv.id,
        prisma,
        reminderBucketDay: bucketDay,
        daysPastDue,
      },
    };

    pvJobHook("invoiceReminderMailRun.attempt", {
      invoiceId: inv.id,
      toEmail: billingEmail,
      idempotencyKey,
      dueCents,
      daysPastDue,
      hasGuestPayUrl: !!guestPayUrl,
      dryRun: !!dryRun,
    });

    if (dryRun) {
      skipped += 1;
      continue;
    }

    try {
      await mailFnResolved.fn(msg);
      sent += 1;
      pvJobHook("invoiceReminderMailRun.sent", {
        invoiceId: inv.id,
        toEmail: billingEmail,
        idempotencyKey,
        daysPastDue,
      });
    } catch (e) {
      failed += 1;
      pvJobHook("invoiceReminderMailRun.failed", {
        invoiceId: inv.id,
        toEmail: billingEmail,
        idempotencyKey,
        daysPastDue,
        err: String(e && e.message ? e.message : e),
      });
    }
  }

  const summary = { scanned, eligible, sent, skipped, failed };
  pvJobHook("invoiceReminderMailRun.done", summary);
  return summary;
}

/**
 * Resolve prisma client from common locations without silently guessing.
 * If we cannot find it, we instruct how to pass prisma in.
 */
function tryLoadPrisma() {
  const tried = [];
  const attempts = [
    () => require(path.join("..", "db", "prisma")),
    () => require(path.join("..", "db", "prisma.client")),
    () => require(path.join("..", "db", "client")),
    () => require(path.join("..", "prisma", "client")),
    () => require("@prisma/client"),
  ];

  for (const fn of attempts) {
    try {
      const mod = fn();
      if (mod && mod.PrismaClient) {
        const prisma = new mod.PrismaClient();
        return { prisma, tried };
      }
      if (mod && mod.prisma) return { prisma: mod.prisma, tried };
      if (mod && typeof mod === "object") return { prisma: mod, tried };
    } catch (e) {
      tried.push(String(e && e.message ? e.message : e));
    }
  }

  return { prisma: null, tried };
}

// Script mode: allows manual runs before wiring scheduler.
if (require.main === module) {
  (async () => {
    try {
      const baseUrl = mustEnv("PUBLIC_BASE_URL");
      const limit = numEnv("INVOICE_REMINDER_LIMIT", 50);
      const dryRun = String(process.env.INVOICE_REMINDER_DRY_RUN || "").trim() === "1";
      const bucketDays = parseBucketDays(process.env.INVOICE_REMINDER_BUCKET_DAYS, [1, 7, 14]);

      const { prisma } = tryLoadPrisma();
      if (!prisma) {
        throw new Error(
          "Could not auto-load prisma client. Run this job from within the backend app where prisma is available, or modify script mode to import your prisma module explicitly."
        );
      }

      const result = await runInvoiceReminderMailRunJob({
        prisma,
        publicBaseUrl: baseUrl,
        limit,
        dryRun,
        bucketDays,
      });

      if (prisma && typeof prisma.$disconnect === "function") {
        await prisma.$disconnect();
      }

      process.exitCode = 0;
      void result;
    } catch (e) {
      pvJobHook("invoiceReminderMailRun.fatal", {
        err: String(e && e.message ? e.message : e),
      });
      try {
        console.error(e);
      } catch {}
      process.exitCode = 1;
    }
  })();
}

module.exports = {
  runInvoiceReminderMailRunJob,
};
