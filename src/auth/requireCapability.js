// backend/src/auth/requireCapability.js
const { can } = require("./capabilities");

function requireCapability(capability, resolveScope) {
  return function (req, res, next) {
    try {
      const scope = typeof resolveScope === "function" ? resolveScope(req) : {};
      const allowed = can(req, capability, scope);

      if (!allowed) {
        return res.status(403).json({
          error: "Forbidden",
          missingCapability: capability,
        });
      }

      return next();
    } catch (err) {
      return next(err);
    }
  };
}

module.exports = {
  requireCapability,
};
