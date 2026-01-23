/**
 * Centralized system hook emitter.
 * Safe to call anywhere. No side effects by default.
 */
function emitSystemHook(event) {
  if (!event || typeof event !== "object") return;

  const normalized = {
    ...event,
    timestamp: event.timestamp ? event.timestamp : new Date(),
  };

  // Ensure JSON output is stable and readable
  const payloadForLog = {
    ...normalized,
    timestamp:
      normalized.timestamp instanceof Date
        ? normalized.timestamp.toISOString()
        : normalized.timestamp,
  };

  // QA hook
  if (process.env.ENABLE_QA_HOOKS === "1") {
    console.log("[QA_HOOK]", JSON.stringify(payloadForLog));
  }

  // Chatbot hook (future: queue / vector store / webhook)
  if (process.env.ENABLE_CHATBOT_HOOKS === "1") {
    // noop for now — intentional
  }

  // Docs / audit hook
  if (process.env.ENABLE_DOC_HOOKS === "1") {
    // noop for now
  }
}

module.exports = { emitSystemHook };
