function buildVisitsRateLimiters(createRateLimiter) {
  const scanLimiter = createRateLimiter({
    keyPrefix: "scan",
    windowMs: Number(process.env.RL_SCAN_WINDOW_MS || 60_000),
    max: Number(process.env.RL_SCAN_MAX || 30),
  });

  const visitsWriteLimiter = createRateLimiter({
    keyPrefix: "visits_post",
    windowMs: Number(process.env.RL_VISITS_POST_WINDOW_MS || 60_000),
    max: Number(process.env.RL_VISITS_POST_MAX || 60),
  });

  return {
    scanLimiter,
    visitsWriteLimiter,
  };
}

module.exports = {
  buildVisitsRateLimiters,
};