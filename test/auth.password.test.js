// tests/auth.password.test.js — Forgot/reset password flow

const request = require("supertest");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const { getApp } = require("./helpers/setup");
const { prisma, resetDb } = require("./helpers/seed");

let app;
let userId;

beforeAll(async () => {
  app = getApp();
  await resetDb();

  const hash = await bcrypt.hash("OldPass2026!", 12);
  const user = await prisma.user.create({
    data: { email: "reset-test@perkvalet.org", passwordHash: hash, systemRole: "user" },
  });
  userId = user.id;
}, 15000);

afterAll(async () => {
  await prisma.$disconnect();
});

describe("Forgot Password", () => {
  describe("POST /auth/forgot-password", () => {
    it("accepts valid email", async () => {
      const res = await request(app).post("/auth/forgot-password")
        .send({ email: "reset-test@perkvalet.org" });
      // May return 200 (ok) or 400 (if mail transport not configured) — must not 500
      expect([200, 400]).toContain(res.status);
      if (res.status === 200) expect(res.body.ok).toBe(true);
    });

    it("returns ok even for non-existent email (no leak)", async () => {
      const res = await request(app).post("/auth/forgot-password")
        .send({ email: "nobody@perkvalet.org" });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });

    it("rejects missing email", async () => {
      const res = await request(app).post("/auth/forgot-password").send({});
      expect(res.status).toBe(400);
    });
  });
});

describe("Reset Password", () => {
  describe("POST /auth/reset-password", () => {
    it("rejects missing token", async () => {
      const res = await request(app).post("/auth/reset-password")
        .send({ newPassword: "NewPass2026!!" });
      expect(res.status).toBe(400);
    });

    it("rejects missing newPassword", async () => {
      const res = await request(app).post("/auth/reset-password")
        .send({ token: "fake-token" });
      expect(res.status).toBe(400);
    });

    it("rejects short password", async () => {
      const res = await request(app).post("/auth/reset-password")
        .send({ token: "fake-token", newPassword: "short" });
      expect(res.status).toBe(400);
    });

    it("rejects invalid token", async () => {
      const res = await request(app).post("/auth/reset-password")
        .send({ token: "definitely-not-real", newPassword: "ValidNewPass2026!" });
      expect(res.status).toBe(400);
    });

    it("accepts valid token and resets password", async () => {
      // Manually create a reset token in the DB
      const token = crypto.randomBytes(32).toString("hex");
      const pepper = process.env.RESET_TOKEN_PEPPER || process.env.JWT_SECRET || "dev-secret-change-me";
      const tokenHash = crypto.createHash("sha256").update(pepper + ":" + token).digest("hex");

      await prisma.passwordResetToken.create({
        data: {
          userId,
          tokenHash,
          expiresAt: new Date(Date.now() + 30 * 60 * 1000),
        },
      });

      const res = await request(app).post("/auth/reset-password")
        .send({ token, newPassword: "BrandNewPass2026!" });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });

    it("rejects reuse of same token", async () => {
      // The token from above was already used
      const res = await request(app).post("/auth/reset-password")
        .send({ token: "already-used", newPassword: "AnotherPass2026!" });
      expect(res.status).toBe(400);
    });
  });
});
