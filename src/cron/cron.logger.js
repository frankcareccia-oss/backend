/**
 * cron.logger.js — Wraps cron job functions with automatic logging to CronJobLog.
 *
 * Usage:
 *   const { withCronLog } = require('./cron.logger');
 *   cron.schedule('0 2 * * *', withCronLog('reporting', async () => { ... }));
 */

"use strict";

const { prisma } = require("../db/prisma");

/**
 * Wrap a cron job function with automatic logging.
 * @param {string} jobName — identifier for this job
 * @param {function} fn — async function to execute. Should return a summary object.
 * @returns {function} — wrapped function
 */
function withCronLog(jobName, fn) {
  return async () => {
    const startedAt = new Date();
    let status = "ok";
    let summary = null;
    let error = null;

    try {
      const result = await fn();
      summary = result || null;
    } catch (e) {
      status = "failed";
      error = e?.message || String(e);
      console.error(`[CronLog] ${jobName} FAILED:`, error);
    }

    const completedAt = new Date();
    const durationMs = completedAt.getTime() - startedAt.getTime();

    try {
      await prisma.cronJobLog.create({
        data: { jobName, status, startedAt, completedAt, durationMs, summary, error },
      });
    } catch (logErr) {
      console.error(`[CronLog] could not write log for ${jobName}:`, logErr?.message);
    }

    console.log(`[CronLog] ${jobName}: ${status} in ${durationMs}ms`);
  };
}

module.exports = { withCronLog };
