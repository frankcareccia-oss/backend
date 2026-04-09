// tests/hardening/auth.abuse.test.js — Auth login fuzzing, JWT abuse, password edge cases

const request = require("supertest");
const bcrypt = require("bcryptjs");
const { getApp, authHeader } = require("../helpers/setup");
const { prisma, resetDb } = require("../helpers/seed");

let app;

beforeAll(async () => {
  app = getApp();
  await resetDb();

  // Seed a real user for login tests
  const passwordHash = await bcrypt.hash("ValidPass2026!", 12);
  await prisma.user.create({
    data: { email: "auth-abuse@perkvalet.org", passwordHash, systemRole: "user" },
  });
}, 15000);

afterAll(async () => {
  await prisma.$disconnect();
});

describe("Login Fuzzing", () => {
  it("rejects SQL injection in email", async () => {
    const res = await request(app).post("/auth/login")
      .send({ email: "' OR 1=1 --", password: "anything" });
    expect(res.status).toBe(401);
  });

  it("rejects SQL injection in password", async () => {
    const res = await request(app).post("/auth/login")
      .send({ email: "auth-abuse@perkvalet.org", password: "' OR 1=1 --" });
    expect(res.status).toBe(401);
  });

  it("rejects XSS in email", async () => {
    const res = await request(app).post("/auth/login")
      .send({ email: '<script>alert("xss")</script>', password: "test" });
    expect(res.status).toBe(401);
  });

  it("rejects extremely long email", async () => {
    const res = await request(app).post("/auth/login")
      .send({ email: "a".repeat(10000) + "@test.com", password: "test" });
    expect(res.status).not.toBe(500);
  });

  it("rejects extremely long password", async () => {
    const res = await request(app).post("/auth/login")
      .send({ email: "test@test.com", password: "x".repeat(100000) });
    expect(res.status).not.toBe(500);
  });

  it("rejects null email", async () => {
    const res = await request(app).post("/auth/login")
      .send({ email: null, password: "test" });
    expect(res.status).toBe(400);
  });

  it("rejects number as email", async () => {
    const res = await request(app).post("/auth/login")
      .send({ email: 12345, password: "test" });
    expect(res.status).not.toBe(500);
  });

  it("rejects array as email", async () => {
    const res = await request(app).post("/auth/login")
      .send({ email: ["test@test.com"], password: "test" });
    expect(res.status).not.toBe(500);
  });

  it("rejects object as password", async () => {
    const res = await request(app).post("/auth/login")
      .send({ email: "test@test.com", password: { inject: true } });
    expect(res.status).not.toBe(500);
  });

  it("handles unicode email", async () => {
    const res = await request(app).post("/auth/login")
      .send({ email: "テスト@日本語.com", password: "test" });
    expect(res.status).not.toBe(500);
  });

  it("handles null bytes in email", async () => {
    const res = await request(app).post("/auth/login")
      .send({ email: "test\x00@test.com", password: "test" });
    expect(res.status).not.toBe(500);
  });

  it("does not leak password hash on wrong password", async () => {
    const res = await request(app).post("/auth/login")
      .send({ email: "auth-abuse@perkvalet.org", password: "wrongpass" });
    expect(res.status).toBe(401);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain("$2a$");
    expect(body).not.toContain("$2b$");
    expect(body).not.toContain("passwordHash");
  });

  it("does not leak user existence on wrong email", async () => {
    const res = await request(app).post("/auth/login")
      .send({ email: "nonexistent@perkvalet.org", password: "test" });
    expect(res.status).toBe(401);
    // Same error message for wrong email vs wrong password
    expect(res.body.error.message).toBe("Invalid credentials");
  });
});

describe("JWT Abuse", () => {
  it("rejects completely empty token", async () => {
    const res = await request(app).get("/me").set("Authorization", "Bearer ");
    expect(res.status).toBe(401);
  });

  it("rejects token with spaces", async () => {
    const res = await request(app).get("/me").set("Authorization", "Bearer a b c");
    expect(res.status).toBe(401);
  });

  it("rejects very long garbage token", async () => {
    const res = await request(app).get("/me").set("Authorization", "Bearer " + "x".repeat(10000));
    expect(res.status).toBe(401);
  });

  it("rejects token signed with wrong secret", async () => {
    const jwt = require("jsonwebtoken");
    const badToken = jwt.sign({ userId: 1 }, "wrong-secret", { expiresIn: "1h" });
    const res = await request(app).get("/me").set(authHeader(badToken));
    expect(res.status).toBe(401);
  });

  it("rejects expired token", async () => {
    const jwt = require("jsonwebtoken");
    const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-me";
    const expired = jwt.sign({ userId: 1 }, JWT_SECRET, { expiresIn: "-1s" });
    const res = await request(app).get("/me").set(authHeader(expired));
    expect(res.status).toBe(401);
  });

  it("rejects token with non-existent userId", async () => {
    const jwt = require("jsonwebtoken");
    const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-me";
    const token = jwt.sign({ userId: 999999 }, JWT_SECRET, { expiresIn: "1h" });
    const res = await request(app).get("/me").set(authHeader(token));
    expect(res.status).toBe(401);
  });

  it("rejects token with userId as string", async () => {
    const jwt = require("jsonwebtoken");
    const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-me";
    const token = jwt.sign({ userId: "not-a-number" }, JWT_SECRET, { expiresIn: "1h" });
    const res = await request(app).get("/me").set(authHeader(token));
    expect(res.status).not.toBe(200);
  });

  it("rejects Authorization without Bearer scheme", async () => {
    const res = await request(app).get("/me").set("Authorization", "Basic dXNlcjpwYXNz");
    expect(res.status).toBe(401);
  });
});

describe("Change Password Abuse", () => {
  it("rejects without auth", async () => {
    const res = await request(app).post("/auth/change-password")
      .send({ currentPassword: "x", newPassword: "y" });
    expect(res.status).toBe(401);
  });

  it("rejects with no body", async () => {
    const jwt = require("jsonwebtoken");
    const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-me";
    // Use the seeded user
    const users = await prisma.user.findMany({ take: 1 });
    const token = jwt.sign({ userId: users[0].id }, JWT_SECRET, { expiresIn: "1h" });
    const res = await request(app).post("/auth/change-password")
      .set(authHeader(token))
      .send({});
    expect(res.status).toBe(400);
  });
});
