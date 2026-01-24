// backend/src/pos/pos.replay.js
const { REPLAY_WINDOW_MS } = require("./pos.constants");

function getHook(req) {
  // Prefer request-scoped hook if supplied by routes, fallback to global
  return req?.pvHook || global.pvHook || null;
}

function getSendError(req, res) {
  // Prefer routes-supplied sendError via res.locals
  return res?.locals?.sendError || req?.sendError || null;
}

module.exports.requireFreshTimestamp = function requireFreshTimestamp(req, res, next) {
  const sendError = getSendError(req, res);
  const hook = getHook(req);

  const tsHeader = req.header("X-POS-Timestamp");
  if (!tsHeader) {
    if (sendError) return sendError(res, 400, "VALIDATION_ERROR", "Missing X-POS-Timestamp");
    return res.status(400).json({ error: "Missing X-POS-Timestamp", code: "POS_TIMESTAMP_REQUIRED" });
  }

  const ts = Number(tsHeader) || Date.parse(tsHeader);
  if (!ts || Number.isNaN(ts)) {
    if (sendError) return sendError(res, 400, "VALIDATION_ERROR", "Invalid X-POS-Timestamp");
    return res.status(400).json({ error: "Invalid X-POS-Timestamp", code: "POS_TIMESTAMP_INVALID" });
  }

  const now = Date.now();
  if (Math.abs(now - ts) > REPLAY_WINDOW_MS) {
    if (hook) {
      hook("pos.replay.reject", {
        now,
        ts,
        deltaMs: now - ts,
      });
    }

    if (sendError) return sendError(res, 409, "REPLAY_REJECTED", "Replay window exceeded");
    return res.status(409).json({ error: "Replay window exceeded", code: "POS_REPLAY_REJECTED" });
  }

  next();
};
