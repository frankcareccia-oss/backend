// backend/src/jobs/invoiceReminderMailRun.scheduler.js
//
// Mail-Flow-4: Invoice Reminder / Dunning Scheduler
//
// Responsibilities:
// - Read env flags
// - Start interval loop (no cron deps)
// - Prevent overlapping runs (in-process lock)
// - Invoke runInvoiceReminderMailRunJob
//
// Env vars:
// - INVOICE_REMINDER_ENABLED=0|1 (default 0)
// - INVOICE_REMINDER_INTERVAL_SECONDS=300
// - INVOICE_REMINDER_LIMIT=50
// - INVOICE_REMINDER_DRY_RUN=0|1
// - INVOICE_REMINDER_BUCKET_DAYS=1,7,14
//

"use strict";

const { runInvoiceReminderMailRunJob } = require("./invoiceReminderMailRun.job");

/**
 * pvHook: structured scheduler events for QA/docs/support/chatbot.
 * Must never throw.
 */
function pvHook(event, fields = {}) {
  try {
    console.log(
      JSON.stringify({
        pvHook: event,
        ts: new Date().toISOString(),
        ...fields,
      })
    );
  } catch {
    // never break scheduler for logging
  }
}

function numEnv(name, fallback) {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return n;
}

function boolEnv(name, fallback = false) {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === "") return fallback;
  return String(raw).trim() === "1";
}

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
    if (d < 0 || d > 3650) continue;
    out.push(d);
  }
  return Array.from(new Set(out)).sort((a, b) => a - b);
}

let started = false;
let running = false;
let timer = null;
let tick = 0;

/**
 * Start the invoice reminder scheduler.
 *
 * @param {object} args
 * @param {object} args.prisma - Prisma client (required)
 * @param {string} args.publicBaseUrl - Canonical base URL
 */
function startInvoiceReminderMailRunScheduler({ prisma, publicBaseUrl }) {
  if (started) return;
  started = true;

  const enabled = boolEnv("INVOICE_REMINDER_ENABLED", false);
  const intervalSeconds = Math.max(
    10,
    numEnv("INVOICE_REMINDER_INTERVAL_SECONDS", 300)
  );
  const limit = Math.max(1, numEnv("INVOICE_REMINDER_LIMIT", 50));
  const dryRun = boolEnv("INVOICE_REMINDER_DRY_RUN", false);
  const bucketDays = parseBucketDays(
    process.env.INVOICE_REMINDER_BUCKET_DAYS,
    [1, 7, 14]
  );

  if (!enabled) {
    pvHook("invoice_reminder_scheduler_disabled", {
      enabled: 0,
      intervalSeconds,
      limit,
      dryRun: dryRun ? 1 : 0,
      bucketDays,
    });
    return;
  }

  if (!prisma) {
    throw new Error(
      "startInvoiceReminderMailRunScheduler: prisma is required"
    );
  }

  pvHook("invoice_reminder_scheduler_started", {
    enabled: 1,
    intervalSeconds,
    limit,
    dryRun: dryRun ? 1 : 0,
    bucketDays,
    hasPublicBaseUrl: publicBaseUrl ? 1 : 0,
  });

  timer = setInterval(async () => {
    tick += 1;

    if (running) {
      pvHook("invoice_reminder_scheduler_skip_overlap", { tick });
      return;
    }

    running = true;
    const start = Date.now();

    pvHook("invoice_reminder_scheduler_tick_start", {
      tick,
      limit,
      dryRun: dryRun ? 1 : 0,
      intervalSeconds,
    });

    try {
      const result = await runInvoiceReminderMailRunJob({
        prisma,
        publicBaseUrl,
        limit,
        dryRun,
        bucketDays,
      });

      pvHook("invoice_reminder_scheduler_tick_ok", {
        tick,
        ms: Date.now() - start,
        result,
      });
    } catch (e) {
      pvHook("invoice_reminder_scheduler_tick_failed", {
        tick,
        err: String(e && e.message ? e.message : e),
      });
    } finally {
      running = false;
    }
  }, intervalSeconds * 1000);

  // Allow clean shutdown
  if (timer && typeof timer.unref === "function") {
    timer.unref();
  }
}

module.exports = {
  startInvoiceReminderMailRunScheduler,
};
