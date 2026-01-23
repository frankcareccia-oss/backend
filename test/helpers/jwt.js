// backend/test/helpers/jwt.js
const jwt = require("jsonwebtoken");

function signUserJwt(userId, { secret = process.env.JWT_SECRET || "dev-secret-change-me" } = {}) {
  return jwt.sign({ userId }, secret, { expiresIn: "1h" });
}

module.exports = { signUserJwt };
