// backend/src/pos/pos.constants.js
// POS-3 constants (no env required yet)

module.exports = {
  IDEMPOTENCY_TTL_MS: 5 * 60 * 1000, // 5 minutes
  REPLAY_WINDOW_MS: 5 * 60 * 1000, // ±5 minutes
};
