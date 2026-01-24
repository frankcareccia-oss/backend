// backend/src/pos/pos.idempotency.js
const { IDEMPOTENCY_TTL_MS } = require("./pos.constants");

const cache = new Map();
/**
 * key -> { ts, bodyHash, response }
 */

function cleanup() {
  const now = Date.now();
  for (const [key, entry] of cache.entries()) {
    if (now - entry.ts > IDEMPOTENCY_TTL_MS) cache.delete(key);
  }
}

function getHook(req) {
  return req?.pvHook || global.pvHook || null;
}

function getSendError(req, res) {
  return res?.locals?.sendError || req?.sendError || null;
}

module.exports.requireIdempotency = function requireIdempotency(req, res, next) {
  cleanup();

  const sendError = getSendError(req, res);
  const hook = getHook(req);

  const key = req.header("X-POS-Idempotency-Key");
  if (!key) {
    if (sendError) return sendError(res, 400, "VALIDATION_ERROR", "Missing X-POS-Idempotency-Key");
    return res.status(400).json({ error: "Missing X-POS-Idempotency-Key", code: "POS_IDEMPOTENCY_REQUIRED" });
  }

  const bodyHash = JSON.stringify(req.body || {});
  const existing = cache.get(key);

  if (existing) {
    // Same key, different payload => conflict
    if (existing.bodyHash !== bodyHash) {
      if (hook) hook("pos.idempotency.conflict", { key });

      if (sendError) return sendError(res, 409, "IDEMPOTENCY_CONFLICT", "Idempotency key reuse with different payload");
      return res
        .status(409)
        .json({ error: "Idempotency key reuse with different payload", code: "POS_IDEMPOTENCY_CONFLICT" });
    }

    // Same key + same payload => replay; return original response
    if (hook) hook("pos.idempotency.replay", { key });
    return res.json(existing.response);
  }

  // First-time: intercept res.json so we can cache the response payload
  const originalJson = res.json.bind(res);
  res.json = (payload) => {
    cache.set(key, { ts: Date.now(), bodyHash, response: payload });
    if (hook) hook("pos.idempotency.accept", { key });
    return originalJson(payload);
  };

  next();
};
