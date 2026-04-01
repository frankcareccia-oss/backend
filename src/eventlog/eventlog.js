// src/eventlog/eventlog.js
// Append-only audit ledger writer.
// Fire-and-forget — never throws, never blocks the calling flow.
// Failures are logged to stderr only; they must not affect the user response.

/**
 * Write one row to EventLog.
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {object} fields  — must include eventType, merchantId, storeId, source
 */
async function writeEventLog(prisma, fields = {}) {
  try {
    await prisma.eventLog.create({ data: fields });
  } catch (e) {
    console.error("[EventLog] write failed:", e?.message || String(e), "| fields:", JSON.stringify(fields));
  }
}

module.exports = { writeEventLog };
