// src/utils/hooks.js
// Central hook emitter — QA, docs, and support chat instrumentation.

function emitPvHook(event, extras = {}) {
  try {
    if (typeof globalThis.pvHook === "function") return globalThis.pvHook(event, extras);
  } catch {}
  if (process.env.PV_HOOKS_LOG === "1") {
    console.log(`[pvHook] ${event}`, extras);
  }
}

module.exports = { emitPvHook };
