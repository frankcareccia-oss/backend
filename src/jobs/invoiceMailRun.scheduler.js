// backend/src/jobs/invoiceMailRun.scheduler.js
//
// Thread Mail-Flow-3: Invoice Mail Scheduler (Cron Wiring)
//
// Responsibilities:
// - Read env flags
// - setInterval loop (no cron deps)
// - Call runInvoiceMailRunJob({ prisma, publicBaseUrl, limit, dryRun })
// - In-memory lock to prevent overlap
//
// Guardrails:
// - OFF by default (INVOICE_MAILRUN_ENABLED=1 to enable)
// - Safe defaults
// - Never throws on tick; logs instead

"use strict";

const { runInvoiceMailRunJob } = require("./invoiceMailRun.job");

/**
 * Tiny helper: parse env bool.
 */
function envBool(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  const v = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(v)) return true;
  if (["0", "false", "no", "n", "off"].includes(v)) return false;
  return fallback;
}

/**
 * Tiny helper: parse env int.
 */
function envInt(value, fallback) {
  const n = Number.parseInt(String(value), 10);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Structured log hook (QA/support-friendly).
 * Must never throw.
 */
function pvHook(event, fields = {}) {
  try {
    // Keep log shape stable and grep-friendly
    console.log(
      JSON.stringify({
        pvHook: event,
        ts: new Date().toISOString(),
        ...fields,
      })
    );
  } catch {
    // never break runtime for logging
  }
}

/**
 * Start the invoice mail run scheduler.
 *
 * @param {object} deps
 * @param {object} deps.prisma - Prisma client instance (required when enabled)
 * @param {string} [deps.publicBaseUrl] - Base URL used in emails/links (optional; can come from env)
 *
 * @returns {object} control handle { stop, isEnabled }
 */
function startInvoiceMailRunScheduler({ prisma, publicBaseUrl } = {}) {
  const enabled = envBool(process.env.INVOICE_MAILRUN_ENABLED, false);

  // Safe defaults (as per thread opener)
  const intervalSeconds = envInt(process.env.INVOICE_MAILRUN_INTERVAL_SECONDS, 300);
  const limit = envInt(process.env.INVOICE_MAILRUN_LIMIT, 50);
  const dryRun = envBool(process.env.INVOICE_MAILRUN_DRY_RUN, false);

  // Optional: allow URL via env if not passed
  const resolvedPublicBaseUrl =
    publicBaseUrl ||
    process.env.PUBLIC_BASE_URL ||
    process.env.PUBLIC_BASEURL ||
    "";

  if (!enabled) {
    pvHook("invoice_mailrun_scheduler_disabled", {
      enabled: 0,
      intervalSeconds,
      limit,
      dryRun: dryRun ? 1 : 0,
    });
    return {
      isEnabled: false,
      stop: () => {},
    };
  }

  if (!prisma) {
    // Hard stop if enabled but prisma not provided: do not crash boot, but do not run.
    pvHook("invoice_mailrun_scheduler_error", {
      reason: "missing_prisma",
      enabled: 1,
    });
    return {
      isEnabled: true,
      stop: () => {},
    };
  }

  if (!Number.isFinite(intervalSeconds) || intervalSeconds < 5) {
    pvHook("invoice_mailrun_scheduler_error", {
      reason: "invalid_interval_seconds",
      intervalSeconds,
    });
  }

  let timer = null;
  let running = false;
  let tickCount = 0;

  async function tick() {
    tickCount += 1;

    if (running) {
      pvHook("invoice_mailrun_scheduler_skip_overlap", {
        tick: tickCount,
      });
      return;
    }

    running = true;
    const startedAt = Date.now();

    pvHook("invoice_mailrun_scheduler_tick_start", {
      tick: tickCount,
      limit,
      dryRun: dryRun ? 1 : 0,
      intervalSeconds,
    });

    try {
      const result = await runInvoiceMailRunJob({
        prisma,
        publicBaseUrl: resolvedPublicBaseUrl,
        limit,
        dryRun,
      });

      pvHook("invoice_mailrun_scheduler_tick_ok", {
        tick: tickCount,
        ms: Date.now() - startedAt,
        // Result shape is owned by Mail-Flow-2; we do not assume fields,
        // but we include it when present for QA visibility.
        result: result && typeof result === "object" ? result : undefined,
      });
    } catch (err) {
      pvHook("invoice_mailrun_scheduler_tick_fail", {
        tick: tickCount,
        ms: Date.now() - startedAt,
        err: err ? String(err.message || err) : "unknown_error",
      });
    } finally {
      running = false;
    }
  }

  // Start interval loop
  timer = setInterval(() => {
    // Fire-and-forget; tick handles its own try/catch
    tick();
  }, Math.max(1, intervalSeconds) * 1000);

  // Keep Node alive only if the rest of the server is alive.
  // (This is safe and common for background intervals.)
  if (typeof timer.unref === "function") timer.unref();

  pvHook("invoice_mailrun_scheduler_started", {
    enabled: 1,
    intervalSeconds,
    limit,
    dryRun: dryRun ? 1 : 0,
    hasPublicBaseUrl: resolvedPublicBaseUrl ? 1 : 0,
  });

  return {
    isEnabled: true,
    stop: () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
        pvHook("invoice_mailrun_scheduler_stopped", {});
      }
    },
  };
}

module.exports = {
  startInvoiceMailRunScheduler,
};
