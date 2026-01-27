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

function parsePosTimestamp(tsHeaderRaw) {
  const raw = String(tsHeaderRaw || "").trim();
  if (!raw) return { ok: false, reason: "empty" };

  // If purely digits, treat as epoch seconds or epoch ms
  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    if (!Number.isFinite(n)) return { ok: false, reason: "nan_numeric" };

    // Heuristic:
    // - 10 digits (or less) => seconds since epoch
    // - 13 digits (or more) => milliseconds since epoch
    // (also covers "1700000000" vs "1700000000000")
    const ms = raw.length <= 10 ? n * 1000 : n;

    if (!Number.isFinite(ms)) return { ok: false, reason: "nan_ms" };
    return { ok: true, ms, kind: raw.length <= 10 ? "epoch_seconds" : "epoch_ms" };
  }

  // Otherwise, try ISO / RFC / any Date.parse()-compatible string
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) return { ok: false, reason: "invalid_date" };

  return { ok: true, ms: parsed, kind: "date_string" };
}

module.exports.requireFreshTimestamp = function requireFreshTimestamp(req, res, next) {
  const sendError = getSendError(req, res);
  const hook = getHook(req);

  // Express header lookup is case-insensitive. Keep the canonical name used across the system.
  const tsHeader = req.header("X-POS-Timestamp");

  if (!tsHeader) {
    if (sendError) return sendError(res, 400, "VALIDATION_ERROR", "Missing X-POS-Timestamp");
    return res.status(400).json({ error: "Missing X-POS-Timestamp", code: "POS_TIMESTAMP_REQUIRED" });
  }

  const parsed = parsePosTimestamp(tsHeader);
  if (!parsed.ok) {
    if (hook) {
      hook("pos.replay.bad_timestamp", {
        header: String(tsHeader),
        reason: parsed.reason,
      });
    }

    if (sendError) return sendError(res, 400, "VALIDATION_ERROR", "Invalid X-POS-Timestamp");
    return res.status(400).json({ error: "Invalid X-POS-Timestamp", code: "POS_TIMESTAMP_INVALID" });
  }

  const tsMs = parsed.ms;
  const now = Date.now();
  const deltaMs = now - tsMs;
  const absDeltaMs = Math.abs(deltaMs);

  if (absDeltaMs > REPLAY_WINDOW_MS) {
    if (hook) {
      hook("pos.replay.reject", {
        now,
        ts: tsMs,
        tsKind: parsed.kind,
        deltaMs,
        absDeltaMs,
        windowMs: REPLAY_WINDOW_MS,
      });
    }

    if (sendError) return sendError(res, 409, "REPLAY_REJECTED", "Replay window exceeded");
    return res.status(409).json({
      error: "Replay window exceeded",
      code: "POS_REPLAY_REJECTED",
      now,
      ts: tsMs,
      tsKind: parsed.kind,
      deltaMs,
      windowMs: REPLAY_WINDOW_MS,
    });
  }

  next();
};
